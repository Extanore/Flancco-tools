// generate-pdf — Slot P (shared PDF-engine)
//
// Single Edge Function endpoint that renders any of the platform's PDF documents
// using pdf-lib (Deno-compatible via esm.sh — same proven pattern as
// _shared/herroeping.ts). Result is uploaded to a private Supabase Storage bucket
// and returned as a 7-day signed URL.
//
// Why one function instead of one-per-template:
//   - Branding loading, partner-resolution, auth-checks, rate-limiting, logging,
//     storage-upload and signed-URL generation are identical for every PDF.
//     Centralising them avoids the drift that bit `send-confirmation` vs
//     `send-contract-link` (compare those two — they each re-implement CORS,
//     error-shapes, and PDF helpers).
//   - Future migration to Cloudflare Browser Rendering (for richer typography on
//     the rapport-template) only needs to touch the `renderTemplate` dispatcher.
//
// Endpoint contract: see ./README.md and docs/api/generate-pdf.md.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

import { DEFAULT_BRANDING, Lang, PartnerBranding, sanitize } from "./templates/_shared.ts";
import { renderWerkplanning, type WerkplanningData } from "./templates/werkplanning.ts";
import { renderRapportBranded, type RapportBrandedData } from "./templates/rapport_branded.ts";
import { renderContractSigned, type ContractSignedData } from "./templates/contract_signed.ts";
import { renderFacturatieOverzicht, type FacturatieOverzichtData } from "./templates/facturatie_overzicht.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Environment
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

const BUCKET = Deno.env.get("GEN_PDF_BUCKET") ?? "gen-pdf";
const SIGNED_URL_TTL_SECONDS = parseInt(
  Deno.env.get("GEN_PDF_SIGNED_URL_TTL_SECONDS") ?? "604800", // 7 days
  10,
);
const RATE_LIMIT_PER_MIN = parseInt(
  Deno.env.get("GEN_PDF_RATE_LIMIT_PER_MIN") ?? "30",
  10,
);
const MAX_PAYLOAD_BYTES = parseInt(
  Deno.env.get("GEN_PDF_MAX_PAYLOAD_BYTES") ?? "262144", // 256 KB
  10,
);
const LOGO_FETCH_TIMEOUT_MS = parseInt(
  Deno.env.get("GEN_PDF_LOGO_FETCH_TIMEOUT_MS") ?? "3000",
  10,
);
const LOGO_MAX_BYTES = parseInt(
  Deno.env.get("GEN_PDF_LOGO_MAX_BYTES") ?? "102400", // 100 KB
  10,
);

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS")
  ?? "https://app.flancco-platform.be,https://calculator.flancco-platform.be,https://flancco-platform.be,https://www.flancco-platform.be,https://extanore.github.io"
).split(",").map((s) => s.trim()).filter(Boolean);

// ─────────────────────────────────────────────────────────────────────────────
// Template registry
// ─────────────────────────────────────────────────────────────────────────────

type TemplateName = "werkplanning" | "rapport_branded" | "contract_signed" | "facturatie_overzicht";

const TEMPLATE_NAMES: readonly TemplateName[] = [
  "werkplanning",
  "rapport_branded",
  "contract_signed",
  "facturatie_overzicht",
] as const;

interface TemplateMeta {
  name: TemplateName;
  /** Whether this template requires a valid JWT in Authorization header. */
  requiresAuth: boolean;
  /** Filename prefix used when uploading the PDF. */
  filenamePrefix: string;
}

const TEMPLATES: Record<TemplateName, TemplateMeta> = {
  werkplanning: { name: "werkplanning", requiresAuth: false, filenamePrefix: "werkplanning" },
  rapport_branded: { name: "rapport_branded", requiresAuth: true, filenamePrefix: "rapport" },
  contract_signed: { name: "contract_signed", requiresAuth: true, filenamePrefix: "contract" },
  facturatie_overzicht: { name: "facturatie_overzicht", requiresAuth: true, filenamePrefix: "facturatie" },
};

function isTemplateName(value: unknown): value is TemplateName {
  return typeof value === "string" && (TEMPLATE_NAMES as readonly string[]).includes(value);
}

function isLang(value: unknown): value is Lang {
  return value === "nl" || value === "fr";
}

// ─────────────────────────────────────────────────────────────────────────────
// CORS — pattern matches send-confirmation
// ─────────────────────────────────────────────────────────────────────────────

function corsFor(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allow = ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes("*")
    ? (origin || "*")
    : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate limiting — in-memory, per-IP, per minute. Cold-start reset is acceptable
// for this volume; a Redis-backed limiter is overkill until we exceed cold-start
// frequency.
// ─────────────────────────────────────────────────────────────────────────────

interface RateBucket { count: number; resetAt: number; }
const rateBuckets = new Map<string, RateBucket>();

function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("cf-connecting-ip")
    ?? req.headers.get("x-real-ip")
    ?? "unknown";
}

function checkRateLimit(ip: string): { allowed: boolean; resetIn: number } {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(ip, { count: 1, resetAt: now + 60_000 });
    return { allowed: true, resetIn: 60 };
  }
  if (bucket.count >= RATE_LIMIT_PER_MIN) {
    return { allowed: false, resetIn: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  bucket.count++;
  return { allowed: true, resetIn: Math.ceil((bucket.resetAt - now) / 1000) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Logging — structured JSON, zero PII
// ─────────────────────────────────────────────────────────────────────────────

interface LogEntry {
  event: string;
  template?: TemplateName;
  partner_slug?: string;
  status?: number;
  duration_ms?: number;
  error?: string;
  ts: string;
  /** Hashed IP fragment for rate-limit debugging without storing the full IP. */
  ip_hash?: string;
}

function logEvent(entry: Omit<LogEntry, "ts">): void {
  const payload: LogEntry = { ...entry, ts: new Date().toISOString() };
  console.log(JSON.stringify(payload));
}

async function hashIp(ip: string): Promise<string> {
  const data = new TextEncoder().encode(ip);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).slice(0, 4)
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth — verify JWT manually (verify_jwt = false in config so werkplanning can be
// called by techniciens without a session)
// ─────────────────────────────────────────────────────────────────────────────

interface AuthContext {
  user_id: string;
  role: "admin" | "partner" | "bediende" | "technieker" | "unknown";
  partner_id: string | null;
}

async function verifyAuth(req: Request, sb: SupabaseClient): Promise<AuthContext | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  if (!SUPABASE_ANON_KEY) return null;

  const token = authHeader.slice(7).trim();
  if (!token) return null;

  const anon = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY);
  const { data: userResp, error: authErr } = await anon.auth.getUser(token);
  if (authErr || !userResp?.user) return null;

  const { data: roleRow } = await sb
    .from("user_roles")
    .select("role, partner_id")
    .eq("user_id", userResp.user.id)
    .maybeSingle();

  return {
    user_id: userResp.user.id,
    role: (roleRow?.role as AuthContext["role"]) ?? "unknown",
    partner_id: (roleRow?.partner_id as string | null) ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Branding loader
// ─────────────────────────────────────────────────────────────────────────────

interface PartnerRow {
  slug: string;
  bedrijfsnaam: string | null;
  naam: string | null;
  kleur_primair: string | null;
  kleur_donker: string | null;
  logo_url: string | null;
  adres: string | null;
  postcode: string | null;
  gemeente: string | null;
  email: string | null;
  telefoon: string | null;
  website: string | null;
  actief: boolean | null;
}

async function loadPartnerBranding(
  slug: string | undefined,
  sb: SupabaseClient,
): Promise<PartnerBranding> {
  if (!slug) return DEFAULT_BRANDING;

  const { data: row, error } = await sb
    .from("partners")
    .select("slug, bedrijfsnaam, naam, kleur_primair, kleur_donker, logo_url, adres, postcode, gemeente, email, telefoon, website, actief")
    .eq("slug", slug)
    .maybeSingle<PartnerRow>();

  if (error || !row) return { ...DEFAULT_BRANDING, slug };

  const branding: PartnerBranding = {
    slug: row.slug,
    name: row.bedrijfsnaam || row.naam || DEFAULT_BRANDING.name,
    primaryColor: row.kleur_primair || DEFAULT_BRANDING.primaryColor,
    // partners.kleur_donker holds the dark/accent variant — we surface it as
    // secondaryColor so templates can use it for sub-bands and chips.
    secondaryColor: row.kleur_donker || DEFAULT_BRANDING.secondaryColor,
    logoUrl: row.logo_url || "",
    logoBytes: null,
    logoMime: null,
    address: row.adres || "",
    postcode: row.postcode || "",
    gemeente: row.gemeente || "",
    email: row.email || "",
    telefoon: row.telefoon || "",
    website: row.website || "",
  };

  if (branding.logoUrl) {
    const logo = await fetchLogo(branding.logoUrl);
    if (logo) {
      branding.logoBytes = logo.bytes;
      branding.logoMime = logo.mime;
    }
  }
  return branding;
}

async function fetchLogo(url: string): Promise<{ bytes: Uint8Array; mime: "image/png" | "image/jpeg" } | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), LOGO_FETCH_TIMEOUT_MS);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > LOGO_MAX_BYTES) return null;
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("png")) return { bytes: buf, mime: "image/png" };
    if (ct.includes("jpeg") || ct.includes("jpg")) return { bytes: buf, mime: "image/jpeg" };
    // Magic-byte sniff as a last resort.
    if (buf[0] === 0x89 && buf[1] === 0x50) return { bytes: buf, mime: "image/png" };
    if (buf[0] === 0xff && buf[1] === 0xd8) return { bytes: buf, mime: "image/jpeg" };
    return null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Template dispatcher
// ─────────────────────────────────────────────────────────────────────────────

async function renderTemplate(
  template: TemplateName,
  data: Record<string, unknown>,
  branding: PartnerBranding,
  lang: Lang,
): Promise<Uint8Array> {
  switch (template) {
    case "werkplanning":
      return await renderWerkplanning(coerceWerkplanning(data), branding, lang);
    case "rapport_branded":
      return await renderRapportBranded(data as RapportBrandedData, branding, lang);
    case "contract_signed":
      return await renderContractSigned(data as ContractSignedData, branding, lang);
    case "facturatie_overzicht":
      return await renderFacturatieOverzicht(coerceFacturatieOverzicht(data), branding, lang);
  }
}

// Slot D — strikte coercion van facturatie-payload. We accepteren een lege
// `beurten`-array (toon "geen data"-state) maar wijzen niet-arrays af om
// crashes in de renderer te voorkomen.
function coerceFacturatieOverzicht(data: Record<string, unknown>): FacturatieOverzichtData {
  const beurtenRaw = Array.isArray(data.beurten) ? data.beurten : [];
  const beurten = beurtenRaw.map((b, idx) => {
    if (!b || typeof b !== "object") throw new BadRequest(`data.beurten[${idx}] must be an object`);
    const obj = b as Record<string, unknown>;
    return {
      datum: typeof obj.datum === "string" ? obj.datum : null,
      klant_naam: typeof obj.klant_naam === "string" ? obj.klant_naam : null,
      sector: typeof obj.sector === "string" ? obj.sector : null,
      aantal_panelen: typeof obj.aantal_panelen === "number" ? obj.aantal_panelen : null,
      bedrag_excl_btw: typeof obj.bedrag_excl_btw === "number" ? obj.bedrag_excl_btw : null,
      bedrag_incl_btw: typeof obj.bedrag_incl_btw === "number" ? obj.bedrag_incl_btw : null,
      planning_fee: typeof obj.planning_fee === "number" ? obj.planning_fee : null,
      partner_marge: typeof obj.partner_marge === "number" ? obj.partner_marge : null,
    };
  });

  const totalenRaw = (data.totalen && typeof data.totalen === "object" && !Array.isArray(data.totalen))
    ? (data.totalen as Record<string, unknown>)
    : null;
  const totalen = totalenRaw ? {
    aantal_beurten: typeof totalenRaw.aantal_beurten === "number" ? totalenRaw.aantal_beurten : beurten.length,
    totaal_excl_btw: typeof totalenRaw.totaal_excl_btw === "number" ? totalenRaw.totaal_excl_btw : 0,
    totaal_incl_btw: typeof totalenRaw.totaal_incl_btw === "number" ? totalenRaw.totaal_incl_btw : 0,
    totaal_planning_fee: typeof totalenRaw.totaal_planning_fee === "number" ? totalenRaw.totaal_planning_fee : 0,
    totaal_marge: typeof totalenRaw.totaal_marge === "number" ? totalenRaw.totaal_marge : 0,
  } : undefined;

  const periodeType = typeof data.periode_type === "string" && ["week", "maand", "jaar"].includes(data.periode_type)
    ? (data.periode_type as "week" | "maand" | "jaar")
    : "maand";

  return {
    periode_van: typeof data.periode_van === "string" ? data.periode_van : undefined,
    periode_tot: typeof data.periode_tot === "string" ? data.periode_tot : undefined,
    periode_label: typeof data.periode_label === "string" ? data.periode_label : undefined,
    periode_type: periodeType,
    alleen_gefactureerd: data.alleen_gefactureerd === true,
    beurten,
    totalen,
  };
}

function coerceWerkplanning(data: Record<string, unknown>): WerkplanningData {
  const datum = typeof data.datum === "string" ? data.datum : "";
  const technieker_naam = typeof data.technieker_naam === "string" ? data.technieker_naam : "";
  if (!datum) throw new BadRequest("data.datum is required (YYYY-MM-DD)");
  if (!technieker_naam) throw new BadRequest("data.technieker_naam is required");

  const beurtenRaw = Array.isArray(data.beurten) ? data.beurten : [];
  const beurten = beurtenRaw.map((b, idx) => {
    if (!b || typeof b !== "object") throw new BadRequest(`data.beurten[${idx}] must be an object`);
    const obj = b as Record<string, unknown>;
    if (typeof obj.klant_naam !== "string" || obj.klant_naam.trim() === "") {
      throw new BadRequest(`data.beurten[${idx}].klant_naam is required`);
    }
    return {
      id: typeof obj.id === "string" ? obj.id : undefined,
      klant_naam: obj.klant_naam,
      klant_telefoon: typeof obj.klant_telefoon === "string" ? obj.klant_telefoon : undefined,
      klant_adres: typeof obj.klant_adres === "string" ? obj.klant_adres : undefined,
      klant_postcode: typeof obj.klant_postcode === "string" ? obj.klant_postcode : undefined,
      klant_gemeente: typeof obj.klant_gemeente === "string" ? obj.klant_gemeente : undefined,
      tijd_slot: typeof obj.tijd_slot === "string" ? obj.tijd_slot : undefined,
      start_tijd: typeof obj.start_tijd === "string" ? obj.start_tijd : undefined,
      eind_tijd: typeof obj.eind_tijd === "string" ? obj.eind_tijd : undefined,
      scope_samenvatting: typeof obj.scope_samenvatting === "string" ? obj.scope_samenvatting : undefined,
      special_instructions: typeof obj.special_instructions === "string" ? obj.special_instructions : undefined,
      aantal_panelen: typeof obj.aantal_panelen === "number" ? obj.aantal_panelen : undefined,
      sector: typeof obj.sector === "string" ? obj.sector : undefined,
      geschatte_duur_min: typeof obj.geschatte_duur_min === "number" ? obj.geschatte_duur_min : undefined,
    };
  });

  return {
    datum,
    technieker_naam,
    technieker_telefoon: typeof data.technieker_telefoon === "string" ? data.technieker_telefoon : undefined,
    algemene_opmerking: typeof data.algemene_opmerking === "string" ? data.algemene_opmerking : undefined,
    beurten,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage upload + signed URL
// ─────────────────────────────────────────────────────────────────────────────

interface UploadResult {
  path: string;
  signedUrl: string;
  expiresAt: string;
}

async function uploadAndSign(
  sb: SupabaseClient,
  bytes: Uint8Array,
  template: TemplateName,
  partnerSlug: string,
): Promise<UploadResult> {
  const meta = TEMPLATES[template];
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD partition
  const rand = crypto.randomUUID();
  const path = `${partnerSlug}/${today}/${meta.filenamePrefix}-${rand}.pdf`;

  const { error: upErr } = await sb.storage
    .from(BUCKET)
    .upload(path, bytes, {
      contentType: "application/pdf",
      upsert: false,
    });

  if (upErr) {
    throw new Error(`Storage upload failed: ${sanitize(upErr.message)}`);
  }

  const { data: signed, error: signErr } = await sb.storage
    .from(BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);

  if (signErr || !signed?.signedUrl) {
    throw new Error(`Signed URL creation failed: ${sanitize(signErr?.message ?? "unknown")}`);
  }

  const expiresAt = new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString();
  return { path, signedUrl: signed.signedUrl, expiresAt };
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom error so 4xx vs 5xx routing stays explicit
// ─────────────────────────────────────────────────────────────────────────────

class BadRequest extends Error {
  constructor(message: string) { super(message); this.name = "BadRequest"; }
}

class Unauthorized extends Error {
  constructor(message: string) { super(message); this.name = "Unauthorized"; }
}

class TooLarge extends Error {
  constructor(message: string) { super(message); this.name = "TooLarge"; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const started = Date.now();
  const cors = corsFor(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "method_not_allowed" }, cors);
  }

  // Rate-limit before doing any work.
  const ip = clientIp(req);
  const rate = checkRateLimit(ip);
  if (!rate.allowed) {
    logEvent({ event: "rate_limited", status: 429, ip_hash: await hashIp(ip) });
    return jsonResponse(429, { error: "rate_limited", retry_after_seconds: rate.resetIn }, {
      ...cors,
      "Retry-After": String(rate.resetIn),
    });
  }

  let template: TemplateName | undefined;
  let partnerSlug: string | undefined;

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Server misconfiguration: SUPABASE env vars missing");
    }

    // ── Body parsing & size check ───────────────────────────────────────────
    const contentLengthHeader = req.headers.get("content-length");
    if (contentLengthHeader) {
      const len = parseInt(contentLengthHeader, 10);
      if (Number.isFinite(len) && len > MAX_PAYLOAD_BYTES) {
        throw new TooLarge(`payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
      }
    }

    const rawText = await req.text();
    if (rawText.length > MAX_PAYLOAD_BYTES) {
      throw new TooLarge(`payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
    }

    let body: unknown;
    try {
      body = rawText.length > 0 ? JSON.parse(rawText) : {};
    } catch {
      throw new BadRequest("Body must be valid JSON");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new BadRequest("Body must be a JSON object");
    }

    const bodyObj = body as Record<string, unknown>;

    // ── Validate template ──────────────────────────────────────────────────
    if (!isTemplateName(bodyObj.template)) {
      throw new BadRequest(
        `template is required and must be one of: ${TEMPLATE_NAMES.join(", ")}`,
      );
    }
    template = bodyObj.template;
    const meta = TEMPLATES[template];

    // ── Validate data ──────────────────────────────────────────────────────
    if (!bodyObj.data || typeof bodyObj.data !== "object" || Array.isArray(bodyObj.data)) {
      throw new BadRequest("data is required and must be an object");
    }
    const data = bodyObj.data as Record<string, unknown>;

    // ── Lang ───────────────────────────────────────────────────────────────
    const lang: Lang = isLang(bodyObj.lang) ? bodyObj.lang : "nl";

    // ── Partner slug ───────────────────────────────────────────────────────
    if (bodyObj.partner_slug !== undefined && typeof bodyObj.partner_slug !== "string") {
      throw new BadRequest("partner_slug must be a string");
    }
    partnerSlug = typeof bodyObj.partner_slug === "string" ? bodyObj.partner_slug : undefined;
    if (partnerSlug && !/^[a-z0-9-]{1,64}$/.test(partnerSlug)) {
      throw new BadRequest("partner_slug must match [a-z0-9-]{1,64}");
    }

    // ── Service-role client for everything below ───────────────────────────
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // ── Auth check (skip for public templates) ─────────────────────────────
    if (meta.requiresAuth) {
      const auth = await verifyAuth(req, sb);
      if (!auth) throw new Unauthorized("Valid Authorization header required");
      if (auth.role !== "admin" && auth.role !== "partner" && auth.role !== "bediende") {
        throw new Unauthorized("Insufficient role for this template");
      }
      // Partners may only generate documents for their own slug.
      if (auth.role === "partner" && partnerSlug && auth.partner_id) {
        const { data: own } = await sb
          .from("partners")
          .select("slug")
          .eq("id", auth.partner_id)
          .maybeSingle();
        if (own?.slug && own.slug !== partnerSlug) {
          throw new Unauthorized("Partner cannot generate documents for another partner");
        }
      }
    }

    // ── Branding ───────────────────────────────────────────────────────────
    const branding = await loadPartnerBranding(partnerSlug, sb);

    // ── Render ─────────────────────────────────────────────────────────────
    const bytes = await renderTemplate(template, data, branding, lang);

    // ── Upload + sign ──────────────────────────────────────────────────────
    const upload = await uploadAndSign(sb, bytes, template, branding.slug);

    const duration = Date.now() - started;
    logEvent({
      event: "pdf_generated",
      template,
      partner_slug: branding.slug,
      status: 200,
      duration_ms: duration,
      ip_hash: await hashIp(ip),
    });

    return jsonResponse(200, {
      success: true,
      template,
      partner_slug: branding.slug,
      lang,
      url: upload.signedUrl,
      path: upload.path,
      expires_at: upload.expiresAt,
      bytes: bytes.byteLength,
    }, cors);
  } catch (err) {
    const duration = Date.now() - started;
    const status = err instanceof BadRequest ? 400
      : err instanceof Unauthorized ? 401
      : err instanceof TooLarge ? 413
      : 500;
    const message = err instanceof Error ? err.message : "internal_error";

    logEvent({
      event: status === 500 ? "pdf_error" : "pdf_rejected",
      template,
      partner_slug: partnerSlug,
      status,
      duration_ms: duration,
      error: sanitize(message).slice(0, 200),
      ip_hash: await hashIp(ip),
    });

    // Friendly client message — never raw stack traces.
    const clientMessage = status === 500 ? "internal_error" : sanitize(message).slice(0, 200);
    return jsonResponse(status, { success: false, error: clientMessage }, cors);
  }
});

function jsonResponse(status: number, body: unknown, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
