// upload-partner-contract — Slot Wave 2
// -----------------------------------------------------------------------------
// Doel: anon-callable edge function die een PDF-blob (base64-encoded) uploadt
// naar de privé-bucket `partner-contracts`, een signed URL genereert (TTL 7d) en
// `partner_applications.contract_pdf_url` updatet.
//
// Defenses:
//   - PDF magic-bytes check (%PDF- header)
//   - Hard size cap 5 MB (matcht bucket-limiet)
//   - Idempotency: als application al `contract_pdf_url` heeft, return die URL
//   - upsert:false → dubbele path triggert storage-error (extra vangnet)
//   - Service-role key: nooit naar client gelekt; alleen via Deno.env
//   - CORS allow-list via ALLOWED_ORIGINS env (default = drie productie-origins)
//
// Niet-fataal:
//   - Falen van DB-update na succesvolle storage-upload → log + return success
//     (de storage-rij is wat telt; admin kan PDF later via path retrieven)
// -----------------------------------------------------------------------------

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "https://flancco-platform.be,https://app.flancco-platform.be,https://calculator.flancco-platform.be")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 dagen
const MAX_PDF_BYTES = 5 * 1024 * 1024;            // 5 MB (matcht bucket-cap)

// Rate-limit (in-memory Deno isolate). Mitigeert upload-spam naar partner-contracts bucket.
const RATE_LIMIT_PER_MIN = parseInt(Deno.env.get("UPLOAD_RATE_LIMIT") || "10", 10);
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
function clientIp(req: Request): string {
  return (
    req.headers.get("CF-Connecting-IP") ||
    (req.headers.get("X-Forwarded-For") || "").split(",")[0].trim() ||
    "unknown"
  );
}

interface UploadPayload {
  application_id: string;
  pdf_base64: string; // 'data:application/pdf;base64,...' OR raw base64
}

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get("Origin") || "";
  const corsHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0] || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
    "Access-Control-Max-Age": "3600",
    "Vary": "Origin",
  };

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonError(405, "method_not_allowed", corsHeaders);
  }

  // Rate-limit op IP — mitigeert upload-spam.
  if (!rateLimit(clientIp(req))) {
    return jsonError(429, "rate_limited", corsHeaders);
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("[upload-partner-contract] missing env: SUPABASE_URL/SERVICE_ROLE_KEY");
    return jsonError(500, "server_misconfigured", corsHeaders);
  }

  let payload: UploadPayload;
  try {
    payload = await req.json();
  } catch {
    return jsonError(400, "invalid_json", corsHeaders);
  }

  const { application_id, pdf_base64 } = payload || ({} as UploadPayload);
  if (!application_id || typeof application_id !== "string" || !pdf_base64 || typeof pdf_base64 !== "string") {
    return jsonError(400, "missing_required_fields", corsHeaders);
  }

  // UUID-vorm check (defensief — voorkomt path-injection via application_id)
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRe.test(application_id)) {
    return jsonError(400, "invalid_application_id", corsHeaders);
  }

  // Strip data-URI prefix (zowel application/pdf als generieke octet-stream variant)
  const base64Clean = pdf_base64
    .replace(/^data:application\/pdf;base64,/i, "")
    .replace(/^data:application\/octet-stream;base64,/i, "")
    .replace(/\s+/g, ""); // newlines/spaces uit base64 strippen

  // Decode base64 → Uint8Array
  let pdfBytes: Uint8Array;
  try {
    const binary = atob(base64Clean);
    pdfBytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      pdfBytes[i] = binary.charCodeAt(i);
    }
  } catch {
    return jsonError(400, "invalid_base64", corsHeaders);
  }

  // Size check (matcht bucket-cap)
  if (pdfBytes.length > MAX_PDF_BYTES) {
    return jsonError(413, "file_too_large", corsHeaders, { max_bytes: MAX_PDF_BYTES, actual_bytes: pdfBytes.length });
  }

  // PDF magic-bytes check: '%PDF-' (0x25 0x50 0x44 0x46 0x2D)
  if (
    pdfBytes.length < 5 ||
    pdfBytes[0] !== 0x25 ||
    pdfBytes[1] !== 0x50 ||
    pdfBytes[2] !== 0x44 ||
    pdfBytes[3] !== 0x46 ||
    pdfBytes[4] !== 0x2D
  ) {
    return jsonError(400, "invalid_pdf_format", corsHeaders);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Validate application bestaat + idempotency-check
  const { data: app, error: appErr } = await admin
    .from("partner_applications")
    .select("id, status, contract_pdf_url")
    .eq("id", application_id)
    .maybeSingle();

  if (appErr) {
    console.error("[upload-partner-contract] app lookup failed:", appErr.message);
    return jsonError(500, "app_lookup_failed", corsHeaders);
  }
  if (!app) {
    return jsonError(404, "application_not_found", corsHeaders);
  }

  // Idempotency: dubbele upload-call → return bestaande URL (geen storage-write)
  if (app.contract_pdf_url) {
    console.log("[upload-partner-contract] already_uploaded", { application_id });
    return jsonResponse(200, {
      ok: true,
      pdf_url: app.contract_pdf_url,
      already_uploaded: true,
    }, corsHeaders);
  }

  // Path: <YYYY-MM-DD>/<application_id>.pdf
  const today = new Date().toISOString().slice(0, 10);
  const path = `${today}/${application_id}.pdf`;

  // Storage upload
  const { error: upErr } = await admin.storage
    .from("partner-contracts")
    .upload(path, pdfBytes, {
      contentType: "application/pdf",
      cacheControl: "private, max-age=31536000",
      upsert: false,
    });

  if (upErr) {
    console.error("[upload-partner-contract] storage upload failed:", upErr.message);
    return jsonError(500, "upload_failed", corsHeaders, { detail: upErr.message });
  }

  // Signed URL (TTL 7d)
  const { data: signed, error: signErr } = await admin.storage
    .from("partner-contracts")
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);

  if (signErr || !signed?.signedUrl) {
    console.error("[upload-partner-contract] signed-url failed:", signErr?.message);
    return jsonError(500, "signed_url_failed", corsHeaders, { detail: signErr?.message });
  }

  // DB update — niet-fataal: storage is leading
  const { error: updErr } = await admin
    .from("partner_applications")
    .update({ contract_pdf_url: signed.signedUrl })
    .eq("id", application_id);

  if (updErr) {
    console.warn("[upload-partner-contract] application update failed (non-fatal):", updErr.message);
  }

  console.log("[upload-partner-contract] success", { application_id, path, size_bytes: pdfBytes.length });

  return jsonResponse(200, {
    ok: true,
    pdf_url: signed.signedUrl,
    path,
    expires_at: new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString(),
  }, corsHeaders);
});

function jsonError(
  status: number,
  error: string,
  corsHeaders: Record<string, string>,
  extra: Record<string, unknown> = {},
): Response {
  return new Response(JSON.stringify({ ok: false, error, ...extra }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function jsonResponse(
  status: number,
  body: Record<string, unknown>,
  corsHeaders: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
