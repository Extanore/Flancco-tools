// send-partner-application-confirmation — twee-pad prospect-mail.
//
// Aangeroepen vanuit twee plekken:
//   1. /onboard/ callback-flow (LEAD-status): "we hebben je aanvraag ontvangen,
//      we nemen contact op". Toont sectoren + range eindklanten (uit notitie),
//      GEEN marge (die is op LEAD-niveau placeholder 10%).
//   2. /onboard/sign/ post-signing (CONTRACT_SIGNED-status): "welkom, je contract
//      is getekend". Toont marge + ondertekend op + PDF-attachment.
//
// Branch via `app.status`. Backward-compat: ook contract_signed_at gevuld → signed.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";

const EMAIL_FROM_ADDRESS = Deno.env.get("EMAIL_FROM_ADDRESS") ?? "Flancco <noreply@flancco-platform.be>";
const EMAIL_REPLY_TO = Deno.env.get("EMAIL_REPLY_TO") ?? "gillian.geernaert@flancco.be";
const ADMIN_NOTIFICATION_EMAIL = Deno.env.get("ADMIN_NOTIFICATION_EMAIL") ?? "gillian.geernaert@flancco.be";

const ACCOUNT_MANAGER_NAME = Deno.env.get("ACCOUNT_MANAGER_NAME") ?? "Gillian Geernaert";
const ACCOUNT_MANAGER_EMAIL = Deno.env.get("ACCOUNT_MANAGER_EMAIL") ?? "gillian.geernaert@flancco.be";
const ACCOUNT_MANAGER_PHONE = Deno.env.get("ACCOUNT_MANAGER_PHONE") ?? "+32 484 59 47 62";

const FIRST_LEAD_TARGET_DAYS = 10;

const APP_BASE_URL = (Deno.env.get("APP_BASE_URL") ?? "https://app.flancco-platform.be").replace(/\/$/, "");

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS")
  ?? "https://flancco-platform.be,https://app.flancco-platform.be,https://www.flancco-platform.be"
).split(",").map((s) => s.trim()).filter(Boolean);

interface ConfirmPayload { application_id: string; }

interface PartnerApplicationRow {
  id: string;
  status: string | null;
  bedrijfsnaam: string | null;
  btw_nummer: string | null;
  contactpersoon_voornaam: string | null;
  contactpersoon_naam: string | null;
  contactpersoon_email: string | null;
  contactpersoon_telefoon: string | null;
  sectoren: unknown;
  marge_pct: number | null;
  contract_signed_at: string | null;
  contract_pdf_url: string | null;
  lang: string | null;
  notitie: string | null;
}

function corsFor(req: Request) {
  const origin = req.headers.get("Origin") || "";
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0] ?? "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "3600",
    "Vary": "Origin",
  } as Record<string, string>;
}

// Parse "Range eindklanten: 50-200" uit notitie-veld dat door onboard/index.html
// als eerste lijn gevuld wordt. Returns null als niet gevonden.
function parseRangeKlanten(notitie: string | null): string | null {
  if (!notitie) return null;
  const m = notitie.match(/Range eindklanten:\s*([^\n]+)/i);
  return m ? m[1].trim() : null;
}

Deno.serve(async (req: Request) => {
  const corsHeaders = corsFor(req);

  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResp({ error: "method_not_allowed" }, 405, corsHeaders);

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !RESEND_API_KEY) {
    console.error("[send-partner-application-confirmation] missing env vars");
    return jsonResp({ error: "server_misconfigured" }, 500, corsHeaders);
  }

  let payload: ConfirmPayload;
  try { payload = await req.json(); } catch { return jsonResp({ error: "invalid_json" }, 400, corsHeaders); }

  if (!payload?.application_id || typeof payload.application_id !== "string") {
    return jsonResp({ error: "missing_application_id" }, 400, corsHeaders);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: app, error: appErr } = await admin
    .from("partner_applications")
    .select(`
      id, status, bedrijfsnaam, btw_nummer,
      contactpersoon_voornaam, contactpersoon_naam, contactpersoon_email, contactpersoon_telefoon,
      sectoren, marge_pct, contract_signed_at, contract_pdf_url, lang, notitie
    `)
    .eq("id", payload.application_id)
    .maybeSingle<PartnerApplicationRow>();

  if (appErr || !app) {
    console.warn("[send-partner-application-confirmation] application_not_found", {
      application_id: payload.application_id,
      error: appErr?.message,
    });
    return jsonResp({ error: "application_not_found" }, 404, corsHeaders);
  }

  if (!app.contactpersoon_email) {
    return jsonResp({ error: "missing_contactpersoon_email" }, 400, corsHeaders);
  }

  const lang: "nl" | "fr" = app.lang === "fr" ? "fr" : "nl";
  const isFr = lang === "fr";

  // Status-branch: contract_signed (signed_at gevuld OR status='contract_signed' of later)
  // vs lead/demo_bekeken (pre-signing).
  const isSigned = !!app.contract_signed_at
    || app.status === "contract_signed"
    || app.status === "account_created"
    || app.status === "live";

  const sectorenLabels: Record<string, string> = isFr
    ? { warmtepomp: "Pompe à chaleur", zonnepanelen: "Panneaux solaires", ventilatie: "Ventilation" }
    : { warmtepomp: "Warmtepomp", zonnepanelen: "Zonnepanelen", ventilatie: "Ventilatie" };

  const sectorenArr: string[] = Array.isArray(app.sectoren)
    ? (app.sectoren as unknown[]).map((s) => String(s)).filter(Boolean)
    : [];
  const sectorenList = sectorenArr.map((s) => sectorenLabels[s] ?? s).join(", ");

  const aanhefName = (app.contactpersoon_voornaam ?? "").trim();
  const aanhef = aanhefName
    ? (isFr ? `Bonjour ${aanhefName}` : `Beste ${aanhefName}`)
    : (isFr ? "Bonjour" : "Beste");

  const margePct = app.marge_pct ?? 0;
  const bedrijfsnaam = (app.bedrijfsnaam ?? "").trim() || (isFr ? "votre entreprise" : "uw bedrijf");
  const rangeKlanten = parseRangeKlanten(app.notitie);

  const prospectSubject = isSigned
    ? (isFr ? `Bienvenue chez Flancco — votre contrat est signé` : `Welkom bij Flancco — je contract is getekend`)
    : (isFr ? `Confirmation de votre demande de partenariat — Flancco` : `Bevestiging partner-aanvraag — Flancco`);

  const signedCtx: SignedCtx = {
    aanhef, bedrijfsnaam, btw: app.btw_nummer, sectorenList,
    margePct, pdfUrl: app.contract_pdf_url, contractSignedAt: app.contract_signed_at,
  };
  const leadCtx: LeadCtx = {
    aanhef, bedrijfsnaam, btw: app.btw_nummer, sectorenList, rangeKlanten,
  };

  const prospectHtml = isSigned
    ? (isFr ? buildFrSignedHtml(signedCtx) : buildNlSignedHtml(signedCtx))
    : (isFr ? buildFrLeadHtml(leadCtx) : buildNlLeadHtml(leadCtx));

  const filenameSafeBedrijf = bedrijfsnaam
    .toLowerCase().normalize("NFKD")
    .replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "partner";
  const attachments = (isSigned && app.contract_pdf_url)
    ? [{ filename: `contract-flancco-${filenameSafeBedrijf}.pdf`, path: app.contract_pdf_url }]
    : undefined;

  const adminSubject = isSigned
    ? `[Flancco] Nieuw partnercontract getekend — ${bedrijfsnaam}`
    : `[Flancco] Nieuwe partner-lead — ${bedrijfsnaam}`;
  const adminHtml = buildAdminNotificationHtml({
    appId: app.id, bedrijfsnaam, btw: app.btw_nummer,
    voornaam: app.contactpersoon_voornaam, naam: app.contactpersoon_naam,
    email: app.contactpersoon_email, telefoon: app.contactpersoon_telefoon,
    sectorenList, margePct, contractSignedAt: app.contract_signed_at,
    pdfUrl: app.contract_pdf_url, isSigned, rangeKlanten, notitie: app.notitie,
  });

  const [prospectResult, adminResult] = await Promise.allSettled([
    sendResendEmail({
      to: app.contactpersoon_email, subject: prospectSubject, html: prospectHtml,
      replyTo: EMAIL_REPLY_TO, attachments,
    }),
    sendResendEmail({
      to: ADMIN_NOTIFICATION_EMAIL, subject: adminSubject, html: adminHtml,
      replyTo: app.contactpersoon_email,
    }),
  ]);

  const prospectOk = prospectResult.status === "fulfilled" && prospectResult.value.ok;
  const adminOk = adminResult.status === "fulfilled" && adminResult.value.ok;
  const prospectError = prospectResult.status === "fulfilled"
    ? (prospectResult.value.ok ? null : `status_${prospectResult.value.status}`)
    : "rejected";
  const adminError = adminResult.status === "fulfilled"
    ? (adminResult.value.ok ? null : `status_${adminResult.value.status}`)
    : "rejected";

  console.log("[send-partner-application-confirmation]", {
    application_id: payload.application_id,
    lang, isSigned, prospectOk, adminOk,
    ...(prospectError ? { prospectError } : {}),
    ...(adminError ? { adminError } : {}),
  });

  return jsonResp({
    ok: prospectOk && adminOk,
    prospect_email_sent: prospectOk,
    admin_email_sent: adminOk,
    is_signed: isSigned,
  }, 200, corsHeaders);
});

interface ResendAttachment { filename: string; path: string; }

async function sendResendEmail(params: {
  to: string; subject: string; html: string; replyTo: string;
  attachments?: ResendAttachment[];
}): Promise<{ ok: boolean; status: number }> {
  try {
    const body: Record<string, unknown> = {
      from: EMAIL_FROM_ADDRESS, to: params.to,
      subject: params.subject, html: params.html, reply_to: params.replyTo,
    };
    if (params.attachments && params.attachments.length > 0) body.attachments = params.attachments;
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { ok: resp.ok, status: resp.status };
  } catch (e) {
    console.error("[sendResendEmail] fetch failed:", (e as Error).message);
    return { ok: false, status: 0 };
  }
}

interface LeadCtx {
  aanhef: string;
  bedrijfsnaam: string;
  btw: string | null;
  sectorenList: string;
  rangeKlanten: string | null;
}

interface SignedCtx {
  aanhef: string;
  bedrijfsnaam: string;
  btw: string | null;
  sectorenList: string;
  margePct: number;
  pdfUrl: string | null;
  contractSignedAt: string | null;
}

function formatSignedAt(iso: string | null, locale: "nl-BE" | "fr-BE"): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(locale, {
      day: "2-digit", month: "long", year: "numeric",
      hour: "2-digit", minute: "2-digit", timeZone: "Europe/Brussels",
    });
  } catch { return "—"; }
}

function buildNlLeadHtml(c: LeadCtx): string {
  const btwRow = c.btw
    ? `<tr><td style="padding:6px 0;color:#6b7280">BTW-nummer</td><td style="padding:6px 0;color:#1f2937">${escHtml(c.btw)}</td></tr>`
    : "";
  const rangeRow = c.rangeKlanten
    ? `<tr><td style="padding:6px 0;color:#6b7280">Klantenbestand</td><td style="padding:6px 0;color:#1f2937"><strong>${escHtml(c.rangeKlanten)}</strong> eindklanten</td></tr>`
    : "";

  return `<!DOCTYPE html>
<html lang="nl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bevestiging partner-aanvraag</title></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#F3F4F6;color:#1A1A2E">
<div style="max-width:620px;margin:0 auto;padding:20px">
  <div style="background:#1A1A2E;color:#FFF;padding:32px 32px;border-radius:12px 12px 0 0;text-align:center">
    <h1 style="margin:0;font-size:24px;letter-spacing:2px;font-weight:700">FLANCCO</h1>
    <p style="margin:8px 0 0;opacity:0.85;font-size:14px;letter-spacing:0.3px">Bevestiging partner-aanvraag</p>
  </div>
  <div style="background:#FFF;padding:36px 32px;border-radius:0 0 12px 12px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb">
    <h2 style="color:#E74C3C;font-size:22px;margin:0 0 20px;font-weight:700;letter-spacing:-0.01em">Welkom bij Flancco</h2>
    <p style="font-size:15px;line-height:1.7;margin:0 0 14px;color:#1f2937">${escHtml(c.aanhef)},</p>
    <p style="font-size:14px;line-height:1.75;margin:0 0 20px;color:#374151">Bedankt voor je interesse om partner te worden van Flancco. We hebben je aanvraag voor <strong>${escHtml(c.bedrijfsnaam)}</strong> goed ontvangen en kijken ernaar uit om een gesprek met je in te plannen.</p>

    <div style="background:#F8F9FA;border-left:3px solid #E74C3C;border-radius:8px;padding:22px;margin:24px 0">
      <h3 style="margin:0 0 14px;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:1.2px;font-weight:700">Samenvatting van je aanvraag</h3>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr><td style="padding:6px 0;color:#6b7280;width:42%">Bedrijf</td><td style="padding:6px 0;color:#1f2937;font-weight:600">${escHtml(c.bedrijfsnaam)}</td></tr>
        ${btwRow}
        <tr><td style="padding:6px 0;color:#6b7280">Sectoren</td><td style="padding:6px 0;color:#1f2937">${escHtml(c.sectorenList || "—")}</td></tr>
        ${rangeRow}
      </table>
    </div>

    <h3 style="font-size:16px;margin:32px 0 14px;color:#1f2937;font-weight:700;letter-spacing:-0.01em">Wat gebeurt nu?</h3>
    <ol style="margin:0 0 28px;padding-left:22px;font-size:14px;line-height:1.85;color:#374151">
      <li style="margin-bottom:6px">Ons partnership-team neemt <strong>binnen 3 werkdagen</strong> persoonlijk contact op</li>
      <li style="margin-bottom:6px">In dat gesprek bespreken we de demo van het platform + commerciële voorwaarden (marge, planning fee)</li>
      <li style="margin-bottom:6px">Bij wederzijdse interesse ontvang je een signing-link voor het partnercontract</li>
      <li style="margin-bottom:6px">Na ondertekening volgt activatie van je partner-account, je kan dan onmiddellijk klanten beheren onder je eigen merk</li>
    </ol>

    <div style="background:#FFF;border:1.5px solid #E5E7EB;border-radius:10px;padding:22px;margin:0 0 24px">
      <h4 style="margin:0 0 12px;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:1.2px;font-weight:700">Direct contact</h4>
      <p style="font-size:14px;margin:0 0 6px;line-height:1.6;color:#1f2937"><strong>${escHtml(ACCOUNT_MANAGER_NAME)}</strong> &mdash; je aanspreekpunt</p>
      <p style="font-size:14px;margin:0 0 4px;line-height:1.6"><a href="mailto:${escAttr(ACCOUNT_MANAGER_EMAIL)}" style="color:#1A1A2E;text-decoration:none">${escHtml(ACCOUNT_MANAGER_EMAIL)}</a></p>
      <p style="font-size:14px;margin:0 0 10px;line-height:1.6"><a href="tel:${escAttr(ACCOUNT_MANAGER_PHONE.replace(/\s/g, ""))}" style="color:#1A1A2E;text-decoration:none">${escHtml(ACCOUNT_MANAGER_PHONE)}</a></p>
      <p style="font-size:12.5px;margin:0;color:#6b7280;font-style:italic">Heb je specifieke vragen vooraf? Je mag altijd reageren op deze mail of bellen.</p>
    </div>

    <p style="margin:28px 0 0;font-size:14px;line-height:1.7;color:#374151">Met vriendelijke groet,<br><strong style="color:#1f2937">${escHtml(ACCOUNT_MANAGER_NAME)}</strong><br><span style="color:#6b7280">Flancco BV</span></p>
  </div>
  <p style="text-align:center;margin:18px 0 0;color:#9ca3af;font-size:11px;line-height:1.7">
    Flancco BV &mdash; 9080 Beervelde<br>
    <a href="https://flancco-platform.be/privacy" style="color:#9ca3af">Privacy</a>
    &nbsp;&middot;&nbsp;
    <a href="https://flancco-platform.be/voorwaarden" style="color:#9ca3af">Voorwaarden</a>
  </p>
</div>
</body>
</html>`;
}

function buildFrLeadHtml(c: LeadCtx): string {
  const btwRow = c.btw
    ? `<tr><td style="padding:6px 0;color:#6b7280">N° TVA</td><td style="padding:6px 0;color:#1f2937">${escHtml(c.btw)}</td></tr>`
    : "";
  const rangeRow = c.rangeKlanten
    ? `<tr><td style="padding:6px 0;color:#6b7280">Portefeuille</td><td style="padding:6px 0;color:#1f2937"><strong>${escHtml(c.rangeKlanten)}</strong> clients</td></tr>`
    : "";

  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Confirmation demande de partenariat</title></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#F3F4F6;color:#1A1A2E">
<div style="max-width:620px;margin:0 auto;padding:20px">
  <div style="background:#1A1A2E;color:#FFF;padding:32px 32px;border-radius:12px 12px 0 0;text-align:center">
    <h1 style="margin:0;font-size:24px;letter-spacing:2px;font-weight:700">FLANCCO</h1>
    <p style="margin:8px 0 0;opacity:0.85;font-size:14px;letter-spacing:0.3px">Confirmation demande de partenariat</p>
  </div>
  <div style="background:#FFF;padding:36px 32px;border-radius:0 0 12px 12px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb">
    <h2 style="color:#E74C3C;font-size:22px;margin:0 0 20px;font-weight:700;letter-spacing:-0.01em">Bienvenue chez Flancco</h2>
    <p style="font-size:15px;line-height:1.7;margin:0 0 14px;color:#1f2937">${escHtml(c.aanhef)},</p>
    <p style="font-size:14px;line-height:1.75;margin:0 0 20px;color:#374151">Merci de votre intérêt pour devenir partenaire de Flancco. Nous avons bien reçu votre demande pour <strong>${escHtml(c.bedrijfsnaam)}</strong> et nous nous réjouissons de planifier un entretien.</p>

    <div style="background:#F8F9FA;border-left:3px solid #E74C3C;border-radius:8px;padding:22px;margin:24px 0">
      <h3 style="margin:0 0 14px;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:1.2px;font-weight:700">Résumé de votre demande</h3>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr><td style="padding:6px 0;color:#6b7280;width:42%">Société</td><td style="padding:6px 0;color:#1f2937;font-weight:600">${escHtml(c.bedrijfsnaam)}</td></tr>
        ${btwRow}
        <tr><td style="padding:6px 0;color:#6b7280">Secteurs</td><td style="padding:6px 0;color:#1f2937">${escHtml(c.sectorenList || "—")}</td></tr>
        ${rangeRow}
      </table>
    </div>

    <h3 style="font-size:16px;margin:32px 0 14px;color:#1f2937;font-weight:700;letter-spacing:-0.01em">Et maintenant ?</h3>
    <ol style="margin:0 0 28px;padding-left:22px;font-size:14px;line-height:1.85;color:#374151">
      <li style="margin-bottom:6px">Notre équipe partenariats vous contactera <strong>dans les 3 jours ouvrables</strong></li>
      <li style="margin-bottom:6px">Nous discuterons de la démo de la plateforme + conditions commerciales (marge, frais de planification)</li>
      <li style="margin-bottom:6px">Si intérêt mutuel, vous recevrez un lien de signature pour le contrat de partenariat</li>
      <li style="margin-bottom:6px">Après signature, activation de votre compte partenaire — vous pourrez gérer vos clients sous votre propre marque</li>
    </ol>

    <div style="background:#FFF;border:1.5px solid #E5E7EB;border-radius:10px;padding:22px;margin:0 0 24px">
      <h4 style="margin:0 0 12px;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:1.2px;font-weight:700">Contact direct</h4>
      <p style="font-size:14px;margin:0 0 6px;line-height:1.6;color:#1f2937"><strong>${escHtml(ACCOUNT_MANAGER_NAME)}</strong> &mdash; votre interlocuteur</p>
      <p style="font-size:14px;margin:0 0 4px;line-height:1.6"><a href="mailto:${escAttr(ACCOUNT_MANAGER_EMAIL)}" style="color:#1A1A2E;text-decoration:none">${escHtml(ACCOUNT_MANAGER_EMAIL)}</a></p>
      <p style="font-size:14px;margin:0 0 10px;line-height:1.6"><a href="tel:${escAttr(ACCOUNT_MANAGER_PHONE.replace(/\s/g, ""))}" style="color:#1A1A2E;text-decoration:none">${escHtml(ACCOUNT_MANAGER_PHONE)}</a></p>
    </div>

    <p style="margin:28px 0 0;font-size:14px;line-height:1.7;color:#374151">Cordialement,<br><strong style="color:#1f2937">${escHtml(ACCOUNT_MANAGER_NAME)}</strong><br><span style="color:#6b7280">Flancco BV</span></p>
  </div>
  <p style="text-align:center;margin:18px 0 0;color:#9ca3af;font-size:11px;line-height:1.7">
    Flancco BV &mdash; 9080 Beervelde<br>
    <a href="https://flancco-platform.be/privacy" style="color:#9ca3af">Confidentialité</a>
    &nbsp;&middot;&nbsp;
    <a href="https://flancco-platform.be/voorwaarden" style="color:#9ca3af">Conditions</a>
  </p>
</div>
</body>
</html>`;
}

function buildNlSignedHtml(c: SignedCtx): string {
  const signedAt = formatSignedAt(c.contractSignedAt, "nl-BE");
  const pdfCta = c.pdfUrl
    ? `<p style="margin:8px 0 24px;text-align:center"><a href="${escUrl(c.pdfUrl)}" style="display:inline-block;background:#1A1A2E;color:#FFF;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;letter-spacing:0.3px">Bekijk getekend contract</a></p><p style="margin:0 0 24px;text-align:center;font-size:12px;color:#6b7280">Ook bijgevoegd als PDF &mdash; bewaar deze voor je boekhouding.</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="nl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Welkom bij Flancco</title></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#F3F4F6;color:#1A1A2E">
<div style="max-width:620px;margin:0 auto;padding:20px">
  <div style="background:#1A1A2E;color:#FFF;padding:32px 32px;border-radius:12px 12px 0 0;text-align:center">
    <h1 style="margin:0;font-size:24px;letter-spacing:2px;font-weight:700">FLANCCO</h1>
    <p style="margin:8px 0 0;opacity:0.85;font-size:14px;letter-spacing:0.3px">Je contract is getekend</p>
  </div>
  <div style="background:#FFF;padding:36px 32px;border-radius:0 0 12px 12px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb">
    <h2 style="color:#E74C3C;font-size:22px;margin:0 0 20px;font-weight:700;letter-spacing:-0.01em">Welkom bij Flancco</h2>
    <p style="font-size:15px;line-height:1.7;margin:0 0 14px;color:#1f2937">${escHtml(c.aanhef)},</p>
    <p style="font-size:14px;line-height:1.75;margin:0 0 20px;color:#374151">Je hebt zonet het partnercontract digitaal ondertekend. Welkom bij Flancco &mdash; we kijken ernaar uit onze samenwerking met <strong>${escHtml(c.bedrijfsnaam)}</strong> concreet te maken.</p>

    <div style="background:#F8F9FA;border-left:3px solid #E74C3C;border-radius:8px;padding:22px;margin:24px 0">
      <h3 style="margin:0 0 14px;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:1.2px;font-weight:700">Samenvatting getekend contract</h3>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr><td style="padding:6px 0;color:#6b7280;width:42%">Bedrijf</td><td style="padding:6px 0;color:#1f2937;font-weight:600">${escHtml(c.bedrijfsnaam)}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">BTW-nummer</td><td style="padding:6px 0;color:#1f2937">${escHtml(c.btw || "—")}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Sectoren</td><td style="padding:6px 0;color:#1f2937">${escHtml(c.sectorenList || "—")}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Marge</td><td style="padding:6px 0;color:#1f2937"><strong>${escHtml(String(c.margePct))}%</strong> bovenop Flancco-prijzen</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Ondertekend op</td><td style="padding:6px 0;color:#1f2937">${escHtml(signedAt)}</td></tr>
      </table>
    </div>

    ${pdfCta}

    <h3 style="font-size:16px;margin:32px 0 14px;color:#1f2937;font-weight:700;letter-spacing:-0.01em">Wat gebeurt nu &mdash; jouw activatie-traject</h3>
    <ol style="margin:0 0 28px;padding-left:22px;font-size:14px;line-height:1.85;color:#374151">
      <li style="margin-bottom:6px"><strong>Binnen 1 werkdag</strong> ontvang je een aparte e-mail met een veilige activatie-link voor je partner-portaal</li>
      <li style="margin-bottom:6px"><strong>Bij eerste login</strong> doorloop je een korte onboarding-tour: branding (logo + kleuren), calculator-instellingen en eerste teamleden</li>
      <li style="margin-bottom:6px"><strong>Marketing-kit</strong> wordt automatisch klaargezet in je portaal: QR-codes, share-templates en banner-snippets voor je calculator</li>
      <li style="margin-bottom:6px"><strong>Persoonlijke begeleiding</strong> door je account-manager voor de eerste live-leads</li>
    </ol>

    <div style="background:#FEF3C7;border-left:3px solid #F59E0B;border-radius:8px;padding:18px 20px;margin:0 0 28px">
      <h4 style="margin:0 0 6px;font-size:12px;color:#92400E;text-transform:uppercase;letter-spacing:1px;font-weight:700">Verwachtingen voor de eerste weken</h4>
      <p style="margin:0;font-size:14px;line-height:1.7;color:#78350F">Reken op je eerste live-lead binnen <strong>~${FIRST_LEAD_TARGET_DAYS} werkdagen</strong> na activatie. We zorgen ervoor dat marketing-kit en calculator in de eerste week vlot bij je klanten landen, zodat je commercieel meteen kan starten.</p>
    </div>

    <div style="background:#FFF;border:1.5px solid #E5E7EB;border-radius:10px;padding:22px;margin:0 0 24px">
      <h4 style="margin:0 0 12px;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:1.2px;font-weight:700">Direct contact</h4>
      <p style="font-size:14px;margin:0 0 6px;line-height:1.6;color:#1f2937"><strong>${escHtml(ACCOUNT_MANAGER_NAME)}</strong> &mdash; je account-manager</p>
      <p style="font-size:14px;margin:0 0 4px;line-height:1.6"><a href="mailto:${escAttr(ACCOUNT_MANAGER_EMAIL)}" style="color:#1A1A2E;text-decoration:none">${escHtml(ACCOUNT_MANAGER_EMAIL)}</a></p>
      <p style="font-size:14px;margin:0 0 10px;line-height:1.6"><a href="tel:${escAttr(ACCOUNT_MANAGER_PHONE.replace(/\s/g, ""))}" style="color:#1A1A2E;text-decoration:none">${escHtml(ACCOUNT_MANAGER_PHONE)}</a></p>
      <p style="font-size:12.5px;margin:0;color:#6b7280;font-style:italic">Bewaar dit nummer &mdash; je mag altijd bellen bij vragen tijdens de activatie.</p>
    </div>

    <p style="margin:28px 0 0;font-size:14px;line-height:1.7;color:#374151">Met vriendelijke groet,<br><strong style="color:#1f2937">${escHtml(ACCOUNT_MANAGER_NAME)}</strong><br><span style="color:#6b7280">Flancco BV</span></p>
  </div>
  <p style="text-align:center;margin:18px 0 0;color:#9ca3af;font-size:11px;line-height:1.7">
    Flancco BV &mdash; 9080 Beervelde<br>
    <a href="https://flancco-platform.be/privacy" style="color:#9ca3af">Privacy</a>
    &nbsp;&middot;&nbsp;
    <a href="https://flancco-platform.be/voorwaarden" style="color:#9ca3af">Voorwaarden</a>
  </p>
</div>
</body>
</html>`;
}

function buildFrSignedHtml(c: SignedCtx): string {
  const signedAt = formatSignedAt(c.contractSignedAt, "fr-BE");
  const pdfCta = c.pdfUrl
    ? `<p style="margin:8px 0 24px;text-align:center"><a href="${escUrl(c.pdfUrl)}" style="display:inline-block;background:#1A1A2E;color:#FFF;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;letter-spacing:0.3px">Voir le contrat signé</a></p><p style="margin:0 0 24px;text-align:center;font-size:12px;color:#6b7280">Également joint en PDF &mdash; conservez-le pour votre comptabilité.</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bienvenue chez Flancco</title></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#F3F4F6;color:#1A1A2E">
<div style="max-width:620px;margin:0 auto;padding:20px">
  <div style="background:#1A1A2E;color:#FFF;padding:32px 32px;border-radius:12px 12px 0 0;text-align:center">
    <h1 style="margin:0;font-size:24px;letter-spacing:2px;font-weight:700">FLANCCO</h1>
    <p style="margin:8px 0 0;opacity:0.85;font-size:14px;letter-spacing:0.3px">Votre contrat est signé</p>
  </div>
  <div style="background:#FFF;padding:36px 32px;border-radius:0 0 12px 12px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb">
    <h2 style="color:#E74C3C;font-size:22px;margin:0 0 20px;font-weight:700;letter-spacing:-0.01em">Bienvenue chez Flancco</h2>
    <p style="font-size:15px;line-height:1.7;margin:0 0 14px;color:#1f2937">${escHtml(c.aanhef)},</p>
    <p style="font-size:14px;line-height:1.75;margin:0 0 20px;color:#374151">Vous venez de signer le contrat de partenariat. Bienvenue chez Flancco &mdash; nous nous réjouissons de concrétiser notre collaboration avec <strong>${escHtml(c.bedrijfsnaam)}</strong>.</p>

    <div style="background:#F8F9FA;border-left:3px solid #E74C3C;border-radius:8px;padding:22px;margin:24px 0">
      <h3 style="margin:0 0 14px;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:1.2px;font-weight:700">Résumé du contrat signé</h3>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr><td style="padding:6px 0;color:#6b7280;width:42%">Société</td><td style="padding:6px 0;color:#1f2937;font-weight:600">${escHtml(c.bedrijfsnaam)}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">N° TVA</td><td style="padding:6px 0;color:#1f2937">${escHtml(c.btw || "—")}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Secteurs</td><td style="padding:6px 0;color:#1f2937">${escHtml(c.sectorenList || "—")}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Marge</td><td style="padding:6px 0;color:#1f2937"><strong>${escHtml(String(c.margePct))}%</strong> au-dessus des prix Flancco</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Signé le</td><td style="padding:6px 0;color:#1f2937">${escHtml(signedAt)}</td></tr>
      </table>
    </div>

    ${pdfCta}

    <h3 style="font-size:16px;margin:32px 0 14px;color:#1f2937;font-weight:700;letter-spacing:-0.01em">Vos prochaines étapes &mdash; activation</h3>
    <ol style="margin:0 0 28px;padding-left:22px;font-size:14px;line-height:1.85;color:#374151">
      <li style="margin-bottom:6px"><strong>Dans 1 jour ouvrable</strong> vous recevrez un e-mail séparé avec un lien d'activation sécurisé pour votre portail partenaire</li>
      <li style="margin-bottom:6px"><strong>À la première connexion</strong> vous suivrez une courte visite d'onboarding</li>
      <li style="margin-bottom:6px"><strong>Kit marketing</strong> sera automatiquement préparé dans votre portail</li>
      <li style="margin-bottom:6px"><strong>Accompagnement personnel</strong> par votre account-manager pour les premiers leads en direct</li>
    </ol>

    <div style="background:#FEF3C7;border-left:3px solid #F59E0B;border-radius:8px;padding:18px 20px;margin:0 0 28px">
      <h4 style="margin:0 0 6px;font-size:12px;color:#92400E;text-transform:uppercase;letter-spacing:1px;font-weight:700">Attentes pour les premières semaines</h4>
      <p style="margin:0;font-size:14px;line-height:1.7;color:#78350F">Comptez sur votre premier lead en direct dans <strong>~${FIRST_LEAD_TARGET_DAYS} jours ouvrables</strong> après l'activation.</p>
    </div>

    <div style="background:#FFF;border:1.5px solid #E5E7EB;border-radius:10px;padding:22px;margin:0 0 24px">
      <h4 style="margin:0 0 12px;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:1.2px;font-weight:700">Contact direct</h4>
      <p style="font-size:14px;margin:0 0 6px;line-height:1.6;color:#1f2937"><strong>${escHtml(ACCOUNT_MANAGER_NAME)}</strong> &mdash; votre account-manager</p>
      <p style="font-size:14px;margin:0 0 4px;line-height:1.6"><a href="mailto:${escAttr(ACCOUNT_MANAGER_EMAIL)}" style="color:#1A1A2E;text-decoration:none">${escHtml(ACCOUNT_MANAGER_EMAIL)}</a></p>
      <p style="font-size:14px;margin:0 0 10px;line-height:1.6"><a href="tel:${escAttr(ACCOUNT_MANAGER_PHONE.replace(/\s/g, ""))}" style="color:#1A1A2E;text-decoration:none">${escHtml(ACCOUNT_MANAGER_PHONE)}</a></p>
    </div>

    <p style="margin:28px 0 0;font-size:14px;line-height:1.7;color:#374151">Cordialement,<br><strong style="color:#1f2937">${escHtml(ACCOUNT_MANAGER_NAME)}</strong><br><span style="color:#6b7280">Flancco BV</span></p>
  </div>
  <p style="text-align:center;margin:18px 0 0;color:#9ca3af;font-size:11px;line-height:1.7">
    Flancco BV &mdash; 9080 Beervelde<br>
    <a href="https://flancco-platform.be/privacy" style="color:#9ca3af">Confidentialité</a>
    &nbsp;&middot;&nbsp;
    <a href="https://flancco-platform.be/voorwaarden" style="color:#9ca3af">Conditions</a>
  </p>
</div>
</body>
</html>`;
}

interface AdminCtx {
  appId: string;
  bedrijfsnaam: string;
  btw: string | null;
  voornaam: string | null;
  naam: string | null;
  email: string | null;
  telefoon: string | null;
  sectorenList: string;
  margePct: number;
  contractSignedAt: string | null;
  pdfUrl: string | null;
  isSigned: boolean;
  rangeKlanten: string | null;
  notitie: string | null;
}

function buildAdminNotificationHtml(c: AdminCtx): string {
  const fullName = [(c.voornaam ?? "").trim(), (c.naam ?? "").trim()].filter(Boolean).join(" ") || "—";
  const signedAt = c.contractSignedAt
    ? new Date(c.contractSignedAt).toLocaleString("nl-BE", {
        day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
      })
    : "—";
  const pipelineUrl = `${APP_BASE_URL}/admin/?page=partner-pipeline&app=${encodeURIComponent(c.appId)}`;
  const pdfRow = c.pdfUrl
    ? `<tr><td style="padding:8px;border-bottom:1px solid #E5E5E5;color:#666">Contract-PDF</td><td style="padding:8px;border-bottom:1px solid #E5E5E5"><a href="${escUrl(c.pdfUrl)}" style="color:#E74C3C">Download getekend contract</a></td></tr>`
    : "";
  const signedRow = c.isSigned
    ? `<tr><td style="padding:8px;border-bottom:1px solid #E5E5E5;color:#666">Getekend op</td><td style="padding:8px;border-bottom:1px solid #E5E5E5">${escHtml(signedAt)}</td></tr>`
    : "";
  const margeOrRangeRow = c.isSigned
    ? `<tr><td style="padding:8px;border-bottom:1px solid #E5E5E5;color:#666">Marge</td><td style="padding:8px;border-bottom:1px solid #E5E5E5"><strong>${escHtml(String(c.margePct))}%</strong></td></tr>`
    : (c.rangeKlanten
        ? `<tr><td style="padding:8px;border-bottom:1px solid #E5E5E5;color:#666">Klantenbestand</td><td style="padding:8px;border-bottom:1px solid #E5E5E5"><strong>${escHtml(c.rangeKlanten)}</strong> eindklanten</td></tr>`
        : "");
  const notitieBlok = (!c.isSigned && c.notitie)
    ? `<p style="margin:18px 0 0;background:#FFF8E7;border:1px solid #F0DCA0;border-radius:8px;padding:14px 18px;font-size:13px;line-height:1.6;color:#7a6520;white-space:pre-wrap">${escHtml(c.notitie)}</p>`
    : "";
  const headerText = c.isSigned
    ? "Een prospect heeft het partner-contract digitaal getekend en wacht op validatie."
    : "Een nieuwe partner-lead heeft de callback-aanvraag ingediend en wacht op contact.";

  return `<!DOCTYPE html>
<html lang="nl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nieuwe partner-aanvraag</title></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#F3F4F6;color:#1A1A2E">
<div style="max-width:600px;margin:0 auto;padding:32px 20px">
  <h1 style="color:#1A1A2E;font-size:22px;margin:0 0 8px">${c.isSigned ? "Nieuw partnercontract getekend" : "Nieuwe partner-lead"}</h1>
  <p style="color:#666;font-size:14px;margin:0 0 24px">${escHtml(headerText)}</p>

  <table style="width:100%;border-collapse:collapse;background:#FFF;border:1px solid #E5E5E5;border-radius:8px;overflow:hidden;font-size:14px">
    <tr><td style="padding:8px;border-bottom:1px solid #E5E5E5;width:160px;color:#666">Bedrijfsnaam</td><td style="padding:8px;border-bottom:1px solid #E5E5E5"><strong>${escHtml(c.bedrijfsnaam)}</strong></td></tr>
    <tr><td style="padding:8px;border-bottom:1px solid #E5E5E5;color:#666">BTW</td><td style="padding:8px;border-bottom:1px solid #E5E5E5">${escHtml(c.btw || "—")}</td></tr>
    <tr><td style="padding:8px;border-bottom:1px solid #E5E5E5;color:#666">Contactpersoon</td><td style="padding:8px;border-bottom:1px solid #E5E5E5">${escHtml(fullName)}</td></tr>
    <tr><td style="padding:8px;border-bottom:1px solid #E5E5E5;color:#666">Email</td><td style="padding:8px;border-bottom:1px solid #E5E5E5">${c.email ? `<a href="mailto:${escAttr(c.email)}" style="color:#1A1A2E">${escHtml(c.email)}</a>` : "—"}</td></tr>
    <tr><td style="padding:8px;border-bottom:1px solid #E5E5E5;color:#666">Telefoon</td><td style="padding:8px;border-bottom:1px solid #E5E5E5">${escHtml(c.telefoon || "—")}</td></tr>
    <tr><td style="padding:8px;border-bottom:1px solid #E5E5E5;color:#666">Sectoren</td><td style="padding:8px;border-bottom:1px solid #E5E5E5">${escHtml(c.sectorenList || "—")}</td></tr>
    ${margeOrRangeRow}
    ${signedRow}
    ${pdfRow}
  </table>

  ${notitieBlok}

  <p style="margin:28px 0 0">
    <a href="${escUrl(pipelineUrl)}" style="background:#E74C3C;color:#FFF;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;font-weight:600;font-size:14px">Bekijk in partner-pipeline</a>
  </p>

  <p style="margin-top:24px;color:#999;font-size:12px;font-family:'SF Mono','Menlo',monospace">Application ID: ${escHtml(c.appId)}</p>
</div>
</body>
</html>`;
}

function jsonResp(body: unknown, status: number, corsHeaders: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function escHtml(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function escAttr(s: string | null | undefined): string { return escHtml(s).replace(/`/g, "&#96;"); }
function escUrl(s: string | null | undefined): string {
  const v = String(s ?? "").trim();
  if (!v) return "";
  if (/^(https?:|mailto:)/i.test(v)) return v.replace(/"/g, "%22").replace(/</g, "%3C").replace(/>/g, "%3E");
  return "";
}
