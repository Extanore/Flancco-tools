// handle-opt-out — public GDPR opt-out endpoint (Slot Q).
// ─────────────────────────────────────────────────────────────────────
// Wettelijke functie: art. 7.3 AVG (recht om consent in te trekken). De link
// in elke service/marketing-mail bevat ?token=<opt_out_token>; deze functie
// muteert de consent-rij naar opt_out_ts=now() en opt_out_bron='email_link'.
//
// Idempotent: dezelfde token tweemaal aanroepen = no-op (success, geen error).
// De public confirmation-page (/opt-out/index.html op calculator-subdomain)
// roept deze functie aan en toont NL/FR confirmation via Slot S i18n.
//
// Security:
//   - verify_jwt = false (public endpoint, link in mail is universeel toegankelijk)
//   - Token-validatie: lengte 30-50 chars, alleen [A-Za-z0-9\-_~] (URL-safe base64)
//   - Geen enumeration: bij ongeldige/onbekende token retourneren we generieke
//     "ongeldige link" zonder lekken of het token ooit bestaan heeft
//   - Geen PII in response — alleen kanaal-naam + masked email (b***@***.be)
//   - Rate-limit per IP (10 requests/min) tegen brute-force token-guessing
//   - SERVICE_ROLE_KEY enkel server-side in Deno.env

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS")
  || "https://app.flancco-platform.be,https://calculator.flancco-platform.be,https://flancco-platform.be,https://www.flancco-platform.be,https://extanore.github.io"
).split(",").map((s) => s.trim()).filter(Boolean);

const RATE_LIMIT_PER_MIN = parseInt(Deno.env.get("OPT_OUT_RATE_LIMIT") || "10", 10);
const TOKEN_RE = /^[A-Za-z0-9\-_~]{30,50}$/;

// In-memory rate-limit (Deno isolate, voldoende voor lage volumes; bij schaal
// → migreren naar Supabase-based rate-limit-tabel of Cloudflare KV).
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
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Vary": "Origin",
  };
}

function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const [local, domain] = email.split("@");
  if (!local || !domain) return null;
  const localMask = local.length <= 2 ? local[0] + "*" : local[0] + "***" + local[local.length - 1];
  const domainParts = domain.split(".");
  const tld = domainParts.pop() || "";
  const domainMask = "***." + tld;
  return `${localMask}@${domainMask}`;
}

function clientIp(req: Request): string {
  // Cloudflare Workers/Pages → CF-Connecting-IP, fallback X-Forwarded-For first hop
  return (
    req.headers.get("CF-Connecting-IP") ||
    (req.headers.get("X-Forwarded-For") || "").split(",")[0].trim() ||
    "unknown"
  );
}

Deno.serve(async (req: Request) => {
  const corsHeaders = corsFor(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const ip = clientIp(req);
  if (!rateLimit(ip)) {
    return new Response(
      JSON.stringify({ success: false, error: "rate_limited" }),
      { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Token kan via GET ?token=xxx of POST { token } komen — beide ondersteund
  // zodat email-clients die GET-prefetch doen niet meteen muteren (we eisen POST
  // voor de mutatie; GET retourneert metadata zodat de UI een "bevestig"-knop
  // kan tonen voor extra friction).
  let token: string | null = null;
  let confirm = false;
  // Slot T CC2 — optionele vrije tekst over wie de opt-out triggered.
  // Bij bedrijf-klanten typisch "Naam X namens [bedrijfsnaam]". Optioneel veld;
  // niet meegegeven → blijft NULL in de DB-rij.
  let optOutDoor: string | null = null;

  if (req.method === "GET") {
    const url = new URL(req.url);
    token = url.searchParams.get("token");
    confirm = false;
  } else if (req.method === "POST") {
    try {
      const body = await req.json();
      token = typeof body?.token === "string" ? body.token : null;
      confirm = body?.confirm === true;
      // Slot T CC2 — accepteer opt_out_door (sanitize + clip op 200 chars)
      if (typeof body?.opt_out_door === "string") {
        const trimmed = body.opt_out_door.trim();
        if (trimmed.length > 0) {
          optOutDoor = trimmed.slice(0, 200);
        }
      }
    } catch {
      return new Response(
        JSON.stringify({ success: false, error: "invalid_body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
  } else {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  if (!token || !TOKEN_RE.test(token)) {
    return new Response(
      JSON.stringify({ success: false, error: "invalid_token" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Lookup consent-row via token (UNIQUE)
    const { data: consent, error: lookupErr } = await sb
      .from("klant_consents")
      .select("id, klant_email, kanaal, opt_in, opt_out_ts")
      .eq("opt_out_token", token)
      .maybeSingle();

    if (lookupErr) {
      console.error("[handle-opt-out] lookup error:", lookupErr.message);
      return new Response(
        JSON.stringify({ success: false, error: "lookup_failed" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!consent) {
      // Geen enumeration-leak: zelfde response als invalid_token
      return new Response(
        JSON.stringify({ success: false, error: "invalid_token" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Idempotency: al opt-out → return success met informational flag
    if (consent.opt_out_ts) {
      return new Response(
        JSON.stringify({
          success: true,
          already_opted_out: true,
          kanaal: consent.kanaal,
          email_masked: maskEmail(consent.klant_email),
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // GET zonder confirm = preview-mode (toon info, geen mutatie)
    if (req.method === "GET" || !confirm) {
      return new Response(
        JSON.stringify({
          success: true,
          preview: true,
          kanaal: consent.kanaal,
          email_masked: maskEmail(consent.klant_email),
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // POST + confirm=true → muteren
    // Slot T CC2: opt_out_door wordt enkel meegestuurd als hij echt aanwezig is,
    // anders weglaten zodat een eventueel bestaande waarde niet per ongeluk
    // op NULL gezet wordt door een herhaling. (idempotent gedrag blijft behouden)
    const updatePayload: Record<string, unknown> = {
      opt_out_ts: new Date().toISOString(),
      opt_out_bron: "email_link",
      opt_out_ip: ip !== "unknown" ? ip : null,
    };
    if (optOutDoor !== null) {
      updatePayload.opt_out_door = optOutDoor;
    }

    const { error: updateErr } = await sb
      .from("klant_consents")
      .update(updatePayload)
      .eq("id", consent.id);

    if (updateErr) {
      console.error("[handle-opt-out] update error:", updateErr.message);
      return new Response(
        JSON.stringify({ success: false, error: "update_failed" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    console.log(JSON.stringify({
      event: "opt_out_processed",
      consent_id: consent.id,
      kanaal: consent.kanaal,
      ts: new Date().toISOString(),
    }));

    return new Response(
      JSON.stringify({
        success: true,
        kanaal: consent.kanaal,
        email_masked: maskEmail(consent.klant_email),
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[handle-opt-out] unexpected:", err instanceof Error ? err.message : String(err));
    return new Response(
      JSON.stringify({ success: false, error: "internal_error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
