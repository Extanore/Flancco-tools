// validate-vat — public VIES BTW-validatie endpoint (Slot O1).
// ─────────────────────────────────────────────────────────────────────
// Validatie-pipeline:
//   1. Format-check: regex per land (BE/NL/FR/DE/LU)
//   2. Primair: vatcomply.com (gratis REST-wrapper rond VIES, sneller + JSON)
//   3. Fallback: VIES SOAP direct bij vatcomply-uitval
//   4. Timeout: 10s op upstream — bij timeout retourneren we
//      `{ valid: null, error: 'upstream_timeout' }` zodat klant manueel
//      kan doortikken zonder geblokkeerd te zijn.
//
// Security:
//   - verify_jwt = false (anon-calculator gebruikt het — geen login vereist)
//   - Rate-limit 30/min per IP (in-memory bucket per Deno-isolate;
//     bij schaal → migreren naar Supabase rate-limit-tabel of CF KV)
//   - Geen PII in logs: btw-nr wordt SHA-256 hashed voor logging,
//     alleen valid-flag + landcode + timestamp worden plain gelogd
//   - CORS-whitelist via ALLOWED_ORIGINS env (zelfde lijst als handle-opt-out)
//   - Geen DB-call: stateless validation; DB-write gebeurt vanaf client bij submit
//   - Strict body-size limit (1 KB) tegen oversized payloads

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS")
  || "https://app.flancco-platform.be,https://calculator.flancco-platform.be,https://flancco-platform.be,https://www.flancco-platform.be,https://extanore.github.io"
).split(",").map((s) => s.trim()).filter(Boolean);

const RATE_LIMIT_PER_MIN = parseInt(Deno.env.get("VAT_RATE_LIMIT") || "30", 10);
const UPSTREAM_TIMEOUT_MS = parseInt(Deno.env.get("VAT_UPSTREAM_TIMEOUT_MS") || "10000", 10);
const MAX_BODY_BYTES = 1024;

// Per-land regex (gestandaardiseerd, hoofdletters, geen punten/spaties).
// Coverage: alle Benelux + DE + FR (de relevante markten voor Flancco).
// Extra: pre-clean strip van punten/spaties/koppeltekens vóór match.
const VAT_FORMATS: Record<string, RegExp> = {
  BE: /^BE\d{10}$/,
  NL: /^NL\d{9}B\d{2}$/,
  FR: /^FR[A-Z0-9]{2}\d{9}$/,
  DE: /^DE\d{9}$/,
  LU: /^LU\d{8}$/,
};

// In-memory rate-limit bucket (per Deno-isolate). Voldoende voor lage volumes;
// bij schaling → Supabase-rate-limit-tabel of Cloudflare KV.
const ipBuckets = new Map<string, { count: number; resetAt: number }>();

function rateLimit(ip: string): boolean {
  const now = Date.now();
  const bucket = ipBuckets.get(ip);
  if (!bucket || bucket.resetAt < now) {
    ipBuckets.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (bucket.count >= RATE_LIMIT_PER_MIN) return false;
  bucket.count++;
  return true;
}

function corsFor(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function clientIp(req: Request): string {
  return (
    req.headers.get("CF-Connecting-IP") ||
    (req.headers.get("X-Forwarded-For") || "").split(",")[0].trim() ||
    "unknown"
  );
}

function jsonResponse(body: unknown, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizeVat(raw: string): { country: string | null; clean: string | null } {
  // Strip spaces, dots, hyphens, lowercase → uppercase
  const cleaned = String(raw || "")
    .replace(/[\s.\-]/g, "")
    .toUpperCase();
  if (cleaned.length < 4) return { country: null, clean: null };
  const country = cleaned.slice(0, 2);
  if (!VAT_FORMATS[country]) return { country, clean: cleaned };
  return { country, clean: cleaned };
}

function isValidFormat(clean: string, country: string): boolean {
  const re = VAT_FORMATS[country];
  return !!re && re.test(clean);
}

async function sha256Hex(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface ViesResult {
  valid: boolean;
  naam?: string | null;
  adres?: string | null;
  postcode?: string | null;
  gemeente?: string | null;
  raw?: unknown;
  source: "vatcomply" | "vies_soap";
}

// Parse Belgisch/Vlaams/Nederlands adres uit één string.
// VIES geeft het adres als één multi-line text-blok terug; voor BE/NL is de
// laatste regel typisch "POSTCODE GEMEENTE" — we splitsen daarop.
function parseAddress(raw: string | null | undefined): {
  adres: string | null;
  postcode: string | null;
  gemeente: string | null;
} {
  if (!raw || typeof raw !== "string") return { adres: null, postcode: null, gemeente: null };
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { adres: null, postcode: null, gemeente: null };

  // Laatste regel: postcode + gemeente (BE: 4 cijfers, NL: 4 cijfers + 2 letters,
  // DE: 5 cijfers, FR: 5 cijfers, LU: 4 cijfers). Eenvoudige split: eerste woord is postcode-kandidaat.
  const last = lines[lines.length - 1];
  const pcMatch = last.match(/^(\d{4,5}(?:\s?[A-Z]{2})?)\s+(.+)$/i);
  let postcode: string | null = null;
  let gemeente: string | null = null;
  let adresLines = lines;
  if (pcMatch) {
    postcode = pcMatch[1].replace(/\s+/g, "");
    gemeente = pcMatch[2].trim();
    adresLines = lines.slice(0, -1);
  }
  const adres = adresLines.join(", ") || null;
  return { adres, postcode, gemeente };
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Primary path: vatcomply (gratis, snel, JSON-response, wrapt VIES)
async function viaVatcomply(country: string, number: string): Promise<ViesResult | null> {
  try {
    const url = `https://api.vatcomply.com/vat?vat_number=${encodeURIComponent(country + number)}`;
    const resp = await fetchWithTimeout(url, {
      method: "GET",
      headers: { "Accept": "application/json", "User-Agent": "Flancco-Platform/1.0 (vat-validation)" },
    }, UPSTREAM_TIMEOUT_MS);
    if (!resp.ok) return null;
    const data = await resp.json();
    // vatcomply response: { country_code, vat_number, valid, name, address, ... }
    const valid = data?.valid === true;
    const parsed = parseAddress(data?.address);
    return {
      valid,
      naam: typeof data?.name === "string" ? data.name : null,
      adres: parsed.adres,
      postcode: parsed.postcode,
      gemeente: parsed.gemeente,
      raw: { country_code: data?.country_code, vat_number: data?.vat_number, valid: data?.valid, name: data?.name, address: data?.address },
      source: "vatcomply",
    };
  } catch (_err) {
    return null;
  }
}

// Fallback path: VIES SOAP direct
async function viaViesSoap(country: string, number: string): Promise<ViesResult | null> {
  try {
    const soapBody =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns1="urn:ec.europa.eu:taxud:vies:services:checkVat:types">` +
      `<soapenv:Header/><soapenv:Body><tns1:checkVat>` +
      `<tns1:countryCode>${country}</tns1:countryCode>` +
      `<tns1:vatNumber>${number}</tns1:vatNumber>` +
      `</tns1:checkVat></soapenv:Body></soapenv:Envelope>`;

    const resp = await fetchWithTimeout("https://ec.europa.eu/taxation_customs/vies/services/checkVatService", {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8", "SOAPAction": "" },
      body: soapBody,
    }, UPSTREAM_TIMEOUT_MS);
    if (!resp.ok) return null;
    const text = await resp.text();
    // Lichte XML-parse zonder dependency (we extracten enkel velden die we nodig hebben).
    const validMatch = text.match(/<valid>([^<]+)<\/valid>/i);
    const nameMatch = text.match(/<name>([\s\S]*?)<\/name>/i);
    const addressMatch = text.match(/<address>([\s\S]*?)<\/address>/i);
    const valid = validMatch ? validMatch[1].trim().toLowerCase() === "true" : false;
    const naam = nameMatch ? nameMatch[1].trim() : null;
    const adresRaw = addressMatch ? addressMatch[1].trim() : null;
    const parsed = parseAddress(adresRaw);
    return {
      valid,
      naam: naam && naam !== "---" ? naam : null,
      adres: parsed.adres,
      postcode: parsed.postcode,
      gemeente: parsed.gemeente,
      raw: { valid, name: naam, address: adresRaw },
      source: "vies_soap",
    };
  } catch (_err) {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  const corsHeaders = corsFor(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  const ip = clientIp(req);
  if (!rateLimit(ip)) {
    return jsonResponse({ valid: false, error: "rate_limited" }, 429, corsHeaders);
  }

  // Body-size check (defensief — mag nooit > 1 KB voor één BTW-nr)
  const contentLen = parseInt(req.headers.get("Content-Length") || "0", 10);
  if (contentLen > MAX_BODY_BYTES) {
    return jsonResponse({ valid: false, error: "payload_too_large" }, 413, corsHeaders);
  }

  let bodyText: string;
  try {
    bodyText = await req.text();
  } catch {
    return jsonResponse({ valid: false, error: "invalid_body" }, 400, corsHeaders);
  }
  if (bodyText.length > MAX_BODY_BYTES) {
    return jsonResponse({ valid: false, error: "payload_too_large" }, 413, corsHeaders);
  }

  let parsed: { btw_nummer?: unknown };
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return jsonResponse({ valid: false, error: "invalid_json" }, 400, corsHeaders);
  }

  const rawNr = typeof parsed?.btw_nummer === "string" ? parsed.btw_nummer : "";
  if (!rawNr) {
    return jsonResponse({ valid: false, error: "missing_btw_nummer" }, 400, corsHeaders);
  }

  const { country, clean } = normalizeVat(rawNr);
  if (!country || !clean) {
    return jsonResponse({ valid: false, error: "invalid_format" }, 200, corsHeaders);
  }
  if (!VAT_FORMATS[country]) {
    return jsonResponse({ valid: false, error: "unsupported_country", country }, 200, corsHeaders);
  }
  if (!isValidFormat(clean, country)) {
    return jsonResponse({ valid: false, error: "invalid_format", country }, 200, corsHeaders);
  }

  const numberOnly = clean.slice(2);

  // Privacy: log uitsluitend hash + landcode + valid-flag + timestamp.
  // Het volledige BTW-nummer of de bedrijfsnaam komen NOOIT in logs.
  const hash = await sha256Hex(clean);

  // Try primair → fallback
  let result: ViesResult | null = null;
  try {
    result = await viaVatcomply(country, numberOnly);
    if (!result) {
      result = await viaViesSoap(country, numberOnly);
    }
  } catch (err) {
    console.error(JSON.stringify({
      event: "vat_validation_upstream_error",
      country,
      hash,
      message: err instanceof Error ? err.message : String(err),
      ts: new Date().toISOString(),
    }));
  }

  if (!result) {
    // Beide upstreams falen → soft-fail zodat klant manueel kan doortikken
    console.log(JSON.stringify({
      event: "vat_validation_unavailable",
      country,
      hash,
      ts: new Date().toISOString(),
    }));
    return jsonResponse({ valid: null, error: "upstream_timeout", country }, 200, corsHeaders);
  }

  console.log(JSON.stringify({
    event: "vat_validation",
    country,
    hash,
    valid: result.valid,
    source: result.source,
    ts: new Date().toISOString(),
  }));

  return jsonResponse({
    valid: result.valid,
    naam: result.valid ? result.naam : null,
    adres: result.valid ? result.adres : null,
    postcode: result.valid ? result.postcode : null,
    gemeente: result.valid ? result.gemeente : null,
    country,
    source: result.source,
    raw: result.valid ? result.raw : null,
    ts: new Date().toISOString(),
  }, 200, corsHeaders);
});
