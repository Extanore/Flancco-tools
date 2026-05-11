// send-partner-application-confirmation — bevestiging + admin-notificatie na Slot X
// partner-onboarding-wizard stap 4 (digitale ondertekening van het partner-contract).
//
// Deze functie wordt publiek aangeroepen vanuit de onboarding-wizard onmiddellijk
// na succesvolle signing van een `partner_applications`-rij. Ze verstuurt twee mails:
//
//   1. Prospect-mail (NL/FR) — bevestiging naar de contactpersoon van het bedrijf
//      dat een partner-aanvraag heeft ingediend, met samenvatting + "wat nu"-flow.
//   2. Admin-notificatie (NL) — interne mail naar gillian.geernaert@flancco.be
//      met alle aanvraag-details en directe deeplink naar de partner-pipeline.
//
// Branding: dit is een **Flancco-branded** mail. De partner bestaat nog niet als
// `partners`-record op het moment van verzending — er is dus geen partner-branding
// beschikbaar. Header gebruikt Flancco navy + accent-rood.
//
// Auth: verify_jwt = false (publieke aanroep vanuit de onboarding-wizard, vergelijkbaar
// met `send-confirmation`). Validatie gebeurt server-side via:
//   - `application_id` moet bestaan in `partner_applications`
//   - We vertrouwen geen client-side payload-velden voor mail-content; alle data komt
//     uit de DB-row (single source of truth, voorkomt spoofing).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";

// Sender + reply-to defaults blijven Flancco — partner heeft nog geen eigen mailbox.
const EMAIL_FROM_ADDRESS = Deno.env.get("EMAIL_FROM_ADDRESS")
  ?? "Flancco <noreply@flancco-platform.be>";
const EMAIL_REPLY_TO = Deno.env.get("EMAIL_REPLY_TO")
  ?? "gillian.geernaert@flancco.be";
// ADMIN_NOTIFICATION_EMAIL blijft Gillian — interne notificatie van nieuwe aanvraag.
const ADMIN_NOTIFICATION_EMAIL = Deno.env.get("ADMIN_NOTIFICATION_EMAIL")
  ?? "gillian.geernaert@flancco.be";

// Account-manager contact — zichtbaar in de welcome-mail. Env-overridable zodat
// we later per partner-segment of taal kunnen alterneren.
const ACCOUNT_MANAGER_NAME = Deno.env.get("ACCOUNT_MANAGER_NAME") ?? "Gillian Geernaert";
const ACCOUNT_MANAGER_EMAIL = Deno.env.get("ACCOUNT_MANAGER_EMAIL") ?? "gillian.geernaert@flancco.be";
const ACCOUNT_MANAGER_PHONE = Deno.env.get("ACCOUNT_MANAGER_PHONE") ?? "+32 484 59 47 62";

// Verwachtingsmanagement — kalender-doel voor eerste live-lead na contract-signing.
// Conservatief gesteld om geen onhoudbare verwachting te creëren.
const FIRST_LEAD_TARGET_DAYS = 10;

const APP_BASE_URL = (Deno.env.get("APP_BASE_URL") ?? "https://app.flancco-platform.be")
  .replace(/\/$/, "");

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS")
  ?? "https://flancco-platform.be,https://app.flancco-platform.be,https://www.flancco-platform.be")
  .split(",").map((s) => s.trim()).filter(Boolean);

interface ConfirmPayload {
  application_id: string;
}

// Minimal shape — we lezen enkel velden die in de mails verschijnen.
interface PartnerApplicationRow {
  id: string;
  bedrijfsnaam: string | null;
  btw_nummer: string | null;
  contactpersoon_voornaam: string | null;
  contactpersoon_naam: string | null;
  contactpersoon_email: string | null;
  contactpersoon_telefoon: string | null;
  sectoren: unknown; // jsonb — array of string
  marge_pct: number | null;
  contract_signed_at: string | null;
  contract_pdf_url: string | null;
  lang: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────────────────────────────────────

function corsFor(req: Request) {
  const origin = req.headers.get("Origin") || "";
  const allow = ALLOWED_ORIGINS.includes(origin)
    ? origin
    : ALLOWED_ORIGINS[0] ?? "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "3600",
    "Vary": "Origin",
  } as Record<string, string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP handler
// ─────────────────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const corsHeaders = corsFor(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResp({ error: "method_not_allowed" }, 405, corsHeaders);
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !RESEND_API_KEY) {
    console.error("[send-partner-application-confirmation] missing env vars");
    return jsonResp({ error: "server_misconfigured" }, 500, corsHeaders);
  }

  let payload: ConfirmPayload;
  try {
    payload = await req.json();
  } catch {
    return jsonResp({ error: "invalid_json" }, 400, corsHeaders);
  }

  if (!payload?.application_id || typeof payload.application_id !== "string") {
    return jsonResp({ error: "missing_application_id" }, 400, corsHeaders);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: app, error: appErr } = await admin
    .from("partner_applications")
    .select(`
      id, bedrijfsnaam, btw_nummer,
      contactpersoon_voornaam, contactpersoon_naam, contactpersoon_email, contactpersoon_telefoon,
      sectoren, marge_pct, contract_signed_at, contract_pdf_url, lang
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

  // ─────────────────────────────────────────────────────────────────────────
  // Build mails
  // ─────────────────────────────────────────────────────────────────────────

  const prospectSubject = isFr
    ? `Bienvenue chez Flancco — votre contrat est signé`
    : `Welkom bij Flancco — je contract is getekend`;

  const ctx: ProspectCtx = {
    aanhef,
    bedrijfsnaam,
    btw: app.btw_nummer,
    sectorenList,
    margePct,
    pdfUrl: app.contract_pdf_url,
    contractSignedAt: app.contract_signed_at,
  };
  const prospectHtml = isFr ? buildFrProspectHtml(ctx) : buildNlProspectHtml(ctx);

  // PDF als bijlage: Resend kan signed URL server-side ophalen via `path`. Filename
  // sanitized: enkel a-z0-9 + dash zodat we geen UTF-8 issues krijgen in headers.
  const filenameSafeBedrijf = bedrijfsnaam
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "partner";
  const attachments = app.contract_pdf_url
    ? [{
        filename: `contract-flancco-${filenameSafeBedrijf}.pdf`,
        path: app.contract_pdf_url,
      }]
    : undefined;

  // Admin-mail blijft NL — interne mail.
  const adminSubject = `[Flancco] Nieuwe partner-aanvraag — ${bedrijfsnaam}`;
  const adminHtml = buildAdminNotificationHtml({
    appId: app.id,
    bedrijfsnaam,
    btw: app.btw_nummer,
    voornaam: app.contactpersoon_voornaam,
    naam: app.contactpersoon_naam,
    email: app.contactpersoon_email,
    telefoon: app.contactpersoon_telefoon,
    sectorenList,
    margePct,
    contractSignedAt: app.contract_signed_at,
    pdfUrl: app.contract_pdf_url,
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Send via Resend (parallel)
  // ─────────────────────────────────────────────────────────────────────────

  const [prospectResult, adminResult] = await Promise.allSettled([
    sendResendEmail({
      to: app.contactpersoon_email,
      subject: prospectSubject,
      html: prospectHtml,
      replyTo: EMAIL_REPLY_TO,
      attachments,
    }),
    sendResendEmail({
      to: ADMIN_NOTIFICATION_EMAIL,
      subject: adminSubject,
      html: adminHtml,
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

  // Geen PII loggen — enkel IDs + status flags.
  console.log("[send-partner-application-confirmation]", {
    application_id: payload.application_id,
    lang,
    prospectOk,
    adminOk,
    ...(prospectError ? { prospectError } : {}),
    ...(adminError ? { adminError } : {}),
  });

  return jsonResp({
    ok: prospectOk && adminOk,
    prospect_email_sent: prospectOk,
    admin_email_sent: adminOk,
  }, 200, corsHeaders);
});

// ─────────────────────────────────────────────────────────────────────────────
// Resend wrapper
// ─────────────────────────────────────────────────────────────────────────────

interface ResendAttachment {
  filename: string;
  path: string;
}

async function sendResendEmail(params: {
  to: string;
  subject: string;
  html: string;
  replyTo: string;
  attachments?: ResendAttachment[];
}): Promise<{ ok: boolean; status: number }> {
  try {
    const body: Record<string, unknown> = {
      from: EMAIL_FROM_ADDRESS,
      to: params.to,
      subject: params.subject,
      html: params.html,
      reply_to: params.replyTo,
    };
    if (params.attachments && params.attachments.length > 0) {
      body.attachments = params.attachments;
    }
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { ok: resp.ok, status: resp.status };
  } catch (e) {
    console.error("[sendResendEmail] fetch failed:", (e as Error).message);
    return { ok: false, status: 0 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Email templates
// ─────────────────────────────────────────────────────────────────────────────

interface ProspectCtx {
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
      hour: "2-digit", minute: "2-digit",
      timeZone: "Europe/Brussels",
    });
  } catch {
    return "—";
  }
}

function buildNlProspectHtml(c: ProspectCtx): string {
  const signedAt = formatSignedAt(c.contractSignedAt, "nl-BE");
  const pdfCta = c.pdfUrl
    ? `<p style="margin:8px 0 24px;text-align:center">
         <a href="${escUrl(c.pdfUrl)}" style="display:inline-block;background:#1A1A2E;color:#FFF;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;letter-spacing:0.3px">Bekijk getekend contract</a>
       </p>
       <p style="margin:0 0 24px;text-align:center;font-size:12px;color:#6b7280">Ook bijgevoegd als PDF — bewaar deze voor je boekhouding.</p>`
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

    <div style="background:#F8F9FA;border-left:3px solid #E74C3C;border-radius:8px;padding:22px 22px;margin:24px 0">
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
      <p style="font-size:14px;margin:0 0 4px;line-height:1.6">
        <a href="mailto:${escAttr(ACCOUNT_MANAGER_EMAIL)}" style="color:#1A1A2E;text-decoration:none">${escHtml(ACCOUNT_MANAGER_EMAIL)}</a>
      </p>
      <p style="font-size:14px;margin:0 0 10px;line-height:1.6">
        <a href="tel:${escAttr(ACCOUNT_MANAGER_PHONE.replace(/\s/g, ""))}" style="color:#1A1A2E;text-decoration:none">${escHtml(ACCOUNT_MANAGER_PHONE)}</a>
      </p>
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

function buildFrProspectHtml(c: ProspectCtx): string {
  const signedAt = formatSignedAt(c.contractSignedAt, "fr-BE");
  const pdfCta = c.pdfUrl
    ? `<p style="margin:8px 0 24px;text-align:center">
         <a href="${escUrl(c.pdfUrl)}" style="display:inline-block;background:#1A1A2E;color:#FFF;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;letter-spacing:0.3px">Voir le contrat signé</a>
       </p>
       <p style="margin:0 0 24px;text-align:center;font-size:12px;color:#6b7280">Également joint en PDF &mdash; conservez-le pour votre comptabilité.</p>`
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

    <div style="background:#F8F9FA;border-left:3px solid #E74C3C;border-radius:8px;padding:22px 22px;margin:24px 0">
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
      <li style="margin-bottom:6px"><strong>À la première connexion</strong> vous suivrez une courte visite d'onboarding : marque (logo + couleurs), paramètres du calculateur et premiers membres d'équipe</li>
      <li style="margin-bottom:6px"><strong>Kit marketing</strong> sera automatiquement préparé dans votre portail : QR-codes, modèles de partage et bannières pour votre calculateur</li>
      <li style="margin-bottom:6px"><strong>Accompagnement personnel</strong> par votre account-manager pour les premiers leads en direct</li>
    </ol>

    <div style="background:#FEF3C7;border-left:3px solid #F59E0B;border-radius:8px;padding:18px 20px;margin:0 0 28px">
      <h4 style="margin:0 0 6px;font-size:12px;color:#92400E;text-transform:uppercase;letter-spacing:1px;font-weight:700">Attentes pour les premières semaines</h4>
      <p style="margin:0;font-size:14px;line-height:1.7;color:#78350F">Comptez sur votre premier lead en direct dans <strong>~${FIRST_LEAD_TARGET_DAYS} jours ouvrables</strong> après l'activation. Nous veillons à ce que le kit marketing et le calculateur soient rapidement à disposition de vos clients dès la première semaine, pour que vous puissiez démarrer commercialement sans délai.</p>
    </div>

    <div style="background:#FFF;border:1.5px solid #E5E7EB;border-radius:10px;padding:22px;margin:0 0 24px">
      <h4 style="margin:0 0 12px;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:1.2px;font-weight:700">Contact direct</h4>
      <p style="font-size:14px;margin:0 0 6px;line-height:1.6;color:#1f2937"><strong>${escHtml(ACCOUNT_MANAGER_NAME)}</strong> &mdash; votre account-manager</p>
      <p style="font-size:14px;margin:0 0 4px;line-height:1.6">
        <a href="mailto:${escAttr(ACCOUNT_MANAGER_EMAIL)}" style="color:#1A1A2E;text-decoration:none">${escHtml(ACCOUNT_MANAGER_EMAIL)}</a>
      </p>
      <p style="font-size:14px;margin:0 0 10px;line-height:1.6">
        <a href="tel:${escAttr(ACCOUNT_MANAGER_PHONE.replace(/\s/g, ""))}" style="color:#1A1A2E;text-decoration:none">${escHtml(ACCOUNT_MANAGER_PHONE)}</a>
      </p>
      <p style="font-size:12.5px;margin:0;color:#6b7280;font-style:italic">Gardez ce numéro &mdash; n'hésitez pas à appeler en cas de question pendant l'activation.</p>
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
}

function buildAdminNotificationHtml(c: AdminCtx): string {
  const fullName = [(c.voornaam ?? "").trim(), (c.naam ?? "").trim()]
    .filter(Boolean).join(" ") || "—";
  const signedAt = c.contractSignedAt
    ? new Date(c.contractSignedAt).toLocaleString("nl-BE", {
        day: "numeric", month: "long", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      })
    : "—";
  const pipelineUrl = `${APP_BASE_URL}/admin/?page=partner-pipeline&app=${encodeURIComponent(c.appId)}`;
  const pdfRow = c.pdfUrl
    ? `<tr><td style="padding:8px;border-bottom:1px solid #E5E5E5;color:#666">Contract-PDF</td><td style="padding:8px;border-bottom:1px solid #E5E5E5"><a href="${escUrl(c.pdfUrl)}" style="color:#E74C3C">Download getekend contract</a></td></tr>`
    : "";

  return `<!DOCTYPE html>
<html lang="nl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nieuwe partner-aanvraag</title></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#F3F4F6;color:#1A1A2E">
<div style="max-width:600px;margin:0 auto;padding:32px 20px">
  <h1 style="color:#1A1A2E;font-size:22px;margin:0 0 8px">Nieuwe partner-aanvraag</h1>
  <p style="color:#666;font-size:14px;margin:0 0 24px">Een prospect heeft het partner-contract digitaal getekend en wacht op validatie.</p>

  <table style="width:100%;border-collapse:collapse;background:#FFF;border:1px solid #E5E5E5;border-radius:8px;overflow:hidden;font-size:14px">
    <tr><td style="padding:8px;border-bottom:1px solid #E5E5E5;width:160px;color:#666">Bedrijfsnaam</td><td style="padding:8px;border-bottom:1px solid #E5E5E5"><strong>${escHtml(c.bedrijfsnaam)}</strong></td></tr>
    <tr><td style="padding:8px;border-bottom:1px solid #E5E5E5;color:#666">BTW</td><td style="padding:8px;border-bottom:1px solid #E5E5E5">${escHtml(c.btw || "—")}</td></tr>
    <tr><td style="padding:8px;border-bottom:1px solid #E5E5E5;color:#666">Contactpersoon</td><td style="padding:8px;border-bottom:1px solid #E5E5E5">${escHtml(fullName)}</td></tr>
    <tr><td style="padding:8px;border-bottom:1px solid #E5E5E5;color:#666">Email</td><td style="padding:8px;border-bottom:1px solid #E5E5E5">${c.email ? `<a href="mailto:${escAttr(c.email)}" style="color:#1A1A2E">${escHtml(c.email)}</a>` : "—"}</td></tr>
    <tr><td style="padding:8px;border-bottom:1px solid #E5E5E5;color:#666">Telefoon</td><td style="padding:8px;border-bottom:1px solid #E5E5E5">${escHtml(c.telefoon || "—")}</td></tr>
    <tr><td style="padding:8px;border-bottom:1px solid #E5E5E5;color:#666">Sectoren</td><td style="padding:8px;border-bottom:1px solid #E5E5E5">${escHtml(c.sectorenList || "—")}</td></tr>
    <tr><td style="padding:8px;border-bottom:1px solid #E5E5E5;color:#666">Marge</td><td style="padding:8px;border-bottom:1px solid #E5E5E5"><strong>${escHtml(String(c.margePct))}%</strong></td></tr>
    <tr><td style="padding:8px;border-bottom:1px solid #E5E5E5;color:#666">Getekend op</td><td style="padding:8px;border-bottom:1px solid #E5E5E5">${escHtml(signedAt)}</td></tr>
    ${pdfRow}
  </table>

  <p style="margin:28px 0 0">
    <a href="${escUrl(pipelineUrl)}" style="background:#E74C3C;color:#FFF;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;font-weight:600;font-size:14px">Bekijk in partner-pipeline</a>
  </p>

  <p style="margin-top:24px;color:#999;font-size:12px;font-family:'SF Mono','Menlo',monospace">Application ID: ${escHtml(c.appId)}</p>
</div>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function jsonResp(body: unknown, status: number, corsHeaders: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
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

function escAttr(s: string | null | undefined): string {
  return escHtml(s).replace(/`/g, "&#96;");
}

/** Veilige URL-escape: laat enkel http(s) / mailto door — voorkomt javascript: injectie. */
function escUrl(s: string | null | undefined): string {
  const v = String(s ?? "").trim();
  if (!v) return "";
  if (/^(https?:|mailto:)/i.test(v)) {
    return v.replace(/"/g, "%22").replace(/</g, "%3C").replace(/>/g, "%3E");
  }
  return "";
}
