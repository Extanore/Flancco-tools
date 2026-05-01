// send-partner-contract-link — Slot X.2 admin-driven flow
// -------------------------------------------------------------
// Doel: vanuit de admin-wizard "Verstuur signing-link" → genereer een signing-token
// via RPC `admin_generate_signing_token` en verstuur een mail naar de prospect-partner
// met de unieke link naar de signing-pagina.
//
// Context: de prospect heeft al een persoonlijk gesprek met Gillian gehad en kent
// de pricing daaruit. Vóór hij de officiële pricing op zijn eigen device kan inkijken,
// gaat hij akkoord met een korte vertrouwelijkheidsverklaring op de signing-pagina.
// Daarna kan hij het contract direct online tekenen.
//
// Auth-model:
//   - verify_jwt = true (Supabase platform valideert JWT-signature & expiry vooraf)
//   - Server-side rol-check: caller MOET role='admin' in user_roles → anders 403
//   - RPC-aanroep gebeurt met user-JWT zodat de SECURITY DEFINER admin-check
//     in de RPC zelf nog eens passeert (defense in depth)
//
// Endpoint:
//   POST /functions/v1/send-partner-contract-link
//   Authorization: Bearer <user-JWT>
//   Body: { application_id: uuid, ttl_days?: number (1-30, default 7) }
//
// Response:
//   200 { ok: true, expires_at, signing_url, message_id }
//   400 invalid_input
//   401 missing/invalid token
//   403 not_admin
//   404 application_not_found
//   500 rpc_failed | resend_failed | server_misconfigured
//
// Belangrijk:
//   - Token-URL wordt NIET gelogd (PII / security risk). Enkel application_id +
//     email-domein worden naar console geschreven.
//   - Bij Resend-failure wordt het token NIET ingetrokken; de admin kan de URL
//     handmatig uit de DB kopiëren en alsnog versturen.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// ─── Config ──────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";

const EMAIL_FROM_ADDRESS = Deno.env.get("EMAIL_FROM_ADDRESS")
  ?? "Flancco <partners@flancco.be>";
const EMAIL_REPLY_TO = Deno.env.get("EMAIL_REPLY_TO")
  ?? "service@flancco.be";
const APP_BASE_URL = (Deno.env.get("APP_BASE_URL") ?? "https://app.flancco-platform.be")
  .replace(/\/$/, "");

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "3600",
};

// ─── Validation ──────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RequestPayload {
  application_id: string;
  ttl_days?: number;
}

interface ApplicationRow {
  id: string;
  bedrijfsnaam: string | null;
  contactpersoon_voornaam: string | null;
  contactpersoon_naam: string | null;
  contactpersoon_email: string | null;
  lang: string | null;
}

interface RpcTokenRow {
  token: string;
  expires_at: string;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResp({ ok: false, error: "method_not_allowed" }, 405);
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY || !RESEND_API_KEY) {
    console.error("[send-partner-contract-link] missing env vars");
    return jsonResp({ ok: false, error: "server_misconfigured" }, 500);
  }

  // 1) Auth: JWT extraction & user-resolution
  const authHeader = req.headers.get("Authorization") || "";
  const userJwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!userJwt) {
    return jsonResp({ ok: false, error: "missing_authorization" }, 401);
  }

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: userData, error: userErr } = await adminClient.auth.getUser(userJwt);
  if (userErr || !userData?.user) {
    return jsonResp({ ok: false, error: "invalid_token" }, 401);
  }
  const callerId = userData.user.id;

  // 2) Server-side admin rol-check
  const { data: callerRole, error: callerRoleErr } = await adminClient
    .from("user_roles")
    .select("role")
    .eq("user_id", callerId)
    .maybeSingle();

  if (callerRoleErr) {
    console.error("[send-partner-contract-link] caller-role lookup failed", callerRoleErr.message);
    return jsonResp({ ok: false, error: "role_lookup_failed" }, 500);
  }
  if (!callerRole || callerRole.role !== "admin") {
    return jsonResp({ ok: false, error: "not_admin" }, 403);
  }

  // 3) Body parsing & validation
  let payload: RequestPayload;
  try {
    payload = await req.json();
  } catch {
    return jsonResp({ ok: false, error: "invalid_json" }, 400);
  }

  const applicationId = String(payload?.application_id ?? "").trim();
  if (!UUID_RE.test(applicationId)) {
    return jsonResp({ ok: false, error: "invalid_application_id" }, 400);
  }

  const rawTtl = payload?.ttl_days;
  const ttlDays = rawTtl === undefined || rawTtl === null
    ? 7
    : (Number.isInteger(rawTtl) ? Number(rawTtl) : NaN);
  if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 30) {
    return jsonResp({ ok: false, error: "invalid_ttl_days" }, 400);
  }

  // 4) Lookup partner_application row (service-role; we're already admin-authorised)
  const { data: app, error: appErr } = await adminClient
    .from("partner_applications")
    .select(`
      id, bedrijfsnaam,
      contactpersoon_voornaam, contactpersoon_naam, contactpersoon_email, lang
    `)
    .eq("id", applicationId)
    .maybeSingle<ApplicationRow>();

  if (appErr) {
    console.error("[send-partner-contract-link] application lookup failed", appErr.message);
    return jsonResp({ ok: false, error: "application_lookup_failed" }, 500);
  }
  if (!app) {
    return jsonResp({ ok: false, error: "application_not_found" }, 404);
  }
  if (!app.contactpersoon_email) {
    return jsonResp({ ok: false, error: "missing_contactpersoon_email" }, 400);
  }

  // 5) RPC met user-JWT (SECURITY DEFINER admin-check passeert opnieuw)
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${userJwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: rpcRows, error: rpcErr } = await userClient.rpc(
    "admin_generate_signing_token",
    { p_application_id: applicationId, p_ttl_days: ttlDays },
  );

  if (rpcErr) {
    console.error("[send-partner-contract-link] rpc_failed", {
      application_id: applicationId,
      message: rpcErr.message,
      code: rpcErr.code,
    });
    return jsonResp({ ok: false, error: "rpc_failed", detail: rpcErr.message }, 500);
  }

  const tokenRow: RpcTokenRow | null = Array.isArray(rpcRows)
    ? (rpcRows[0] ?? null)
    : (rpcRows as RpcTokenRow | null);

  if (!tokenRow?.token || !tokenRow?.expires_at) {
    console.error("[send-partner-contract-link] rpc_returned_empty", { application_id: applicationId });
    return jsonResp({ ok: false, error: "rpc_returned_empty" }, 500);
  }

  const signingUrl = `${APP_BASE_URL}/onboard/sign/?token=${encodeURIComponent(tokenRow.token)}`;
  const expiresDateLabel = formatBelgianDateTime(tokenRow.expires_at);

  // 6) Build mail
  const voornaam = (app.contactpersoon_voornaam ?? "").trim() || "partner";
  const bedrijfsnaam = (app.bedrijfsnaam ?? "").trim() || "uw bedrijf";

  const subject = "Je Flancco partnercontract — klaar om te tekenen";
  const html = buildMailHtml({
    voornaam,
    bedrijfsnaam,
    signingUrl,
    expiresDate: expiresDateLabel,
  });
  const text = buildMailText({
    voornaam,
    bedrijfsnaam,
    signingUrl,
    expiresDate: expiresDateLabel,
  });

  // 7) Send via Resend
  const resendResult = await sendResendEmail({
    to: app.contactpersoon_email,
    subject,
    html,
    text,
  });

  // Veilig loggen — geen token-URL, geen volledig adres
  const emailDomain = (app.contactpersoon_email.split("@")[1] || "").toLowerCase();
  console.log("[send-partner-contract-link]", {
    application_id: applicationId,
    email_domain: emailDomain,
    ttl_days: ttlDays,
    expires_at: tokenRow.expires_at,
    resend_ok: resendResult.ok,
    ...(resendResult.ok ? {} : { resend_status: resendResult.status }),
  });

  if (!resendResult.ok) {
    return jsonResp({
      ok: false,
      error: "resend_failed",
      detail: `status_${resendResult.status}`,
      // Token blijft geldig — admin kan handmatig URL ophalen uit DB
      expires_at: tokenRow.expires_at,
    }, 500);
  }

  return jsonResp({
    ok: true,
    expires_at: tokenRow.expires_at,
    signing_url: signingUrl,
    message_id: resendResult.messageId,
  }, 200);
});

// ─── Resend wrapper ──────────────────────────────────────────────────────────

interface ResendResult {
  ok: boolean;
  status: number;
  messageId: string | null;
}

async function sendResendEmail(params: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<ResendResult> {
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: EMAIL_FROM_ADDRESS,
        to: params.to,
        subject: params.subject,
        html: params.html,
        text: params.text,
        reply_to: EMAIL_REPLY_TO,
      }),
    });

    if (!resp.ok) {
      return { ok: false, status: resp.status, messageId: null };
    }

    let messageId: string | null = null;
    try {
      const body = await resp.json();
      const idCandidate = body?.id;
      if (typeof idCandidate === "string" && idCandidate.length > 0) {
        messageId = idCandidate;
      }
    } catch {
      // ignore — id is optional in our response contract
    }
    return { ok: true, status: resp.status, messageId };
  } catch (e) {
    console.error("[sendResendEmail] fetch failed:", (e as Error).message);
    return { ok: false, status: 0, messageId: null };
  }
}

// ─── Email templates ─────────────────────────────────────────────────────────

interface MailCtx {
  voornaam: string;
  bedrijfsnaam: string;
  signingUrl: string;
  expiresDate: string;
}

function buildMailHtml(c: MailCtx): string {
  const voornaam = escHtml(c.voornaam);
  const bedrijfsnaam = escHtml(c.bedrijfsnaam);
  const signingUrl = escUrl(c.signingUrl);
  const expiresDate = escHtml(c.expiresDate);

  return `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#FAF7F4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1A1A2E;">
<div style="max-width:560px;margin:0 auto;padding:32px 24px;">
  <div style="text-align:left;margin-bottom:32px;">
    <span style="font-weight:700;font-size:22px;letter-spacing:-0.01em;color:#1A1A2E;">FLANC<span style="color:#E76F51;">C</span>O</span>
  </div>
  <h1 style="font-size:24px;font-weight:600;line-height:1.25;letter-spacing:-0.01em;margin:0 0 16px 0;">
    Beste ${voornaam},
  </h1>
  <p style="font-size:16px;line-height:1.6;margin:0 0 16px 0;color:#3D3D55;">
    Bedankt voor het aangename gesprek. Hierbij vind je de unieke link om onze partnerovereenkomst &mdash; met de pricing zoals samen besproken &mdash; te ondertekenen.
  </p>
  <p style="font-size:16px;line-height:1.6;margin:0 0 24px 0;color:#3D3D55;">
    V&oacute;&oacute;r je de offici&euml;le pricing op je eigen device kan inkijken, ga je akkoord met een korte vertrouwelijkheidsverklaring. Daarna kan je het contract direct online tekenen.
  </p>
  <div style="text-align:center;margin:32px 0;">
    <a href="${signingUrl}" style="display:inline-block;background:#E76F51;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:16px;">
      Open contract en teken
    </a>
  </div>
  <div style="background:#FCE4DA;border-left:3px solid #E76F51;padding:16px 20px;border-radius:4px;margin:24px 0;">
    <p style="margin:0 0 8px 0;font-size:14px;font-weight:600;color:#1A1A2E;">Belangrijk om te weten</p>
    <ul style="margin:0;padding-left:20px;font-size:14px;line-height:1.6;color:#3D3D55;">
      <li>Deze link is geldig tot <strong>${expiresDate}</strong>.</li>
      <li>Je kan de link maximum 3 keer openen.</li>
      <li>Bij vragen, antwoord gerust op deze mail of bel mij rechtstreeks.</li>
    </ul>
  </div>
  <p style="font-size:14px;line-height:1.6;margin:24px 0 0 0;color:#6B6B7E;">
    Met vriendelijke groet,<br>
    <strong style="color:#1A1A2E;">Gillian Geernaert</strong><br>
    Business Development &mdash; Flancco BV
  </p>
  <hr style="border:none;border-top:1px solid #E5E5EA;margin:32px 0;">
  <p style="font-size:12px;line-height:1.5;color:#9B9BA8;margin:0;">
    Werkt de knop niet? Kopieer deze link in je browser:<br>
    <span style="word-break:break-all;color:#6B6B7E;">${signingUrl}</span>
  </p>
  <p style="font-size:11px;line-height:1.5;color:#9B9BA8;margin:16px 0 0 0;">
    Deze e-mail is verstuurd via een beveiligde verbinding. De link is uniek voor ${bedrijfsnaam} en mag niet worden doorgestuurd.
  </p>
</div>
</body>
</html>`;
}

function buildMailText(c: MailCtx): string {
  return `Beste ${c.voornaam},

Bedankt voor het aangename gesprek. Hierbij vind je de unieke link om onze partnerovereenkomst — met de pricing zoals samen besproken — te ondertekenen.

Vóór je de officiële pricing op je eigen device kan inkijken, ga je akkoord met een korte vertrouwelijkheidsverklaring. Daarna kan je het contract direct online tekenen.

Open contract: ${c.signingUrl}

Belangrijk:
- Deze link is geldig tot ${c.expiresDate}
- Je kan de link maximum 3 keer openen
- Bij vragen, antwoord op deze mail of bel mij rechtstreeks

Met vriendelijke groet,
Gillian Geernaert
Business Development — Flancco BV

---
Werkt de link niet? Kopieer deze in je browser:
${c.signingUrl}

Deze e-mail is verstuurd via een beveiligde verbinding. De link is uniek voor ${c.bedrijfsnaam} en mag niet worden doorgestuurd.`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Format an ISO timestamp as `dd/mm/yyyy om HH:MM` in Belgische tijd (Europe/Brussels).
 * Voorbeeld: "08/05/2026 om 14:30".
 */
function formatBelgianDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    const dateParts = new Intl.DateTimeFormat("nl-BE", {
      timeZone: "Europe/Brussels",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).formatToParts(date);
    const timeParts = new Intl.DateTimeFormat("nl-BE", {
      timeZone: "Europe/Brussels",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(date);
    const get = (parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes) =>
      parts.find((p) => p.type === type)?.value ?? "";
    const dd = get(dateParts, "day");
    const mm = get(dateParts, "month");
    const yyyy = get(dateParts, "year");
    const hh = get(timeParts, "hour");
    const mi = get(timeParts, "minute");
    if (!dd || !mm || !yyyy || !hh || !mi) return iso;
    return `${dd}/${mm}/${yyyy} om ${hh}:${mi}`;
  } catch {
    return iso;
  }
}

function jsonResp(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function escHtml(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Veilige URL-escape: laat enkel http(s) door — voorkomt javascript:/data: injectie. */
function escUrl(s: string | null | undefined): string {
  const v = String(s ?? "").trim();
  if (!v) return "";
  if (/^https?:/i.test(v)) {
    return v.replace(/"/g, "%22").replace(/</g, "%3C").replace(/>/g, "%3E");
  }
  return "";
}
