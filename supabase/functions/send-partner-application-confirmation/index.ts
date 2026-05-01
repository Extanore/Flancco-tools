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
const ADMIN_NOTIFICATION_EMAIL = Deno.env.get("ADMIN_NOTIFICATION_EMAIL")
  ?? "gillian.geernaert@flancco.be";

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
    ? "Confirmation de votre demande de partenariat — Flancco"
    : "Bevestiging partner-aanvraag — Flancco";

  const prospectHtml = isFr
    ? buildFrProspectHtml({ aanhef, bedrijfsnaam, btw: app.btw_nummer, sectorenList, margePct, pdfUrl: app.contract_pdf_url })
    : buildNlProspectHtml({ aanhef, bedrijfsnaam, btw: app.btw_nummer, sectorenList, margePct, pdfUrl: app.contract_pdf_url });

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

async function sendResendEmail(params: {
  to: string;
  subject: string;
  html: string;
  replyTo: string;
}): Promise<{ ok: boolean; status: number }> {
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: EMAIL_FROM_ADDRESS,
        to: params.to,
        subject: params.subject,
        html: params.html,
        reply_to: params.replyTo,
      }),
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
}

function buildNlProspectHtml(c: ProspectCtx): string {
  const pdfBlock = c.pdfUrl
    ? `<p style="margin:16px 0">
         <a href="${escUrl(c.pdfUrl)}" style="display:inline-block;background:#1A1A2E;color:#FFF;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px">Download ondertekend contract (PDF)</a>
       </p>`
    : "";

  return `<!DOCTYPE html>
<html lang="nl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bevestiging partner-aanvraag</title></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#F3F4F6;color:#1A1A2E">
<div style="max-width:600px;margin:0 auto;padding:20px">
  <div style="background:#1A1A2E;color:#FFF;padding:28px 32px;border-radius:12px 12px 0 0;text-align:center">
    <h1 style="margin:0;font-size:22px;letter-spacing:1.5px">FLANCCO</h1>
    <p style="margin:6px 0 0;opacity:0.9;font-size:14px">Bevestiging partner-aanvraag</p>
  </div>
  <div style="background:#FFF;padding:32px;border-radius:0 0 12px 12px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb">
    <h2 style="color:#E74C3C;font-size:20px;margin:0 0 20px">Welkom bij Flancco</h2>
    <p style="font-size:15px;line-height:1.7;margin:0 0 16px">${escHtml(c.aanhef)},</p>
    <p style="font-size:14px;line-height:1.7;margin:0 0 16px">Bedankt voor je interesse om partner te worden van Flancco. We hebben je ondertekende aanvraag goed ontvangen.</p>

    <div style="background:#F8F9FA;border-left:3px solid #E74C3C;border-radius:8px;padding:20px;margin:24px 0">
      <h3 style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:1.2px">Samenvatting van je aanvraag</h3>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr><td style="padding:6px 0;color:#6b7280;width:40%">Bedrijf</td><td style="padding:6px 0;color:#1f2937;font-weight:600">${escHtml(c.bedrijfsnaam)}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">BTW-nummer</td><td style="padding:6px 0;color:#1f2937">${escHtml(c.btw || "—")}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Sectoren</td><td style="padding:6px 0;color:#1f2937">${escHtml(c.sectorenList || "—")}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Marge</td><td style="padding:6px 0;color:#1f2937"><strong>${escHtml(String(c.margePct))}%</strong> bovenop Flancco-prijzen</td></tr>
      </table>
    </div>

    ${pdfBlock}

    <h3 style="font-size:15px;margin:28px 0 12px;color:#1f2937">Wat gebeurt er nu?</h3>
    <ol style="margin:0;padding-left:20px;font-size:14px;line-height:1.8;color:#374151">
      <li>Onze partnership-team neemt binnen <strong>de 3 werkdagen</strong> contact op</li>
      <li>Na validatie ontvang je een aparte e-mail met magic-link om je account te activeren</li>
      <li>Via je account configureer je branding, calculator-instellingen en eerste team-leden</li>
      <li>Je ontvangt een marketing-kit met QR-code en share-templates voor je calculator</li>
    </ol>

    <div style="margin-top:32px;padding-top:24px;border-top:1px solid #e5e7eb">
      <p style="font-size:14px;color:#6b7280;margin:0 0 8px">Vragen?</p>
      <p style="font-size:14px;margin:0;line-height:1.7">
        <strong style="color:#1f2937">Flancco BV</strong><br>
        <a href="mailto:gillian.geernaert@flancco.be" style="color:#1A1A2E;text-decoration:none">gillian.geernaert@flancco.be</a>
      </p>
    </div>

    <p style="margin-top:24px;font-size:14px;line-height:1.7">Met vriendelijke groet,<br><strong>Het Flancco team</strong></p>
  </div>
  <p style="text-align:center;margin:16px 0 0;color:#999;font-size:11px">Flancco BV &mdash; Partner-platform voor onderhoud en service</p>
</div>
</body>
</html>`;
}

function buildFrProspectHtml(c: ProspectCtx): string {
  const pdfBlock = c.pdfUrl
    ? `<p style="margin:16px 0">
         <a href="${escUrl(c.pdfUrl)}" style="display:inline-block;background:#1A1A2E;color:#FFF;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px">Télécharger le contrat signé (PDF)</a>
       </p>`
    : "";

  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Confirmation demande de partenariat</title></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#F3F4F6;color:#1A1A2E">
<div style="max-width:600px;margin:0 auto;padding:20px">
  <div style="background:#1A1A2E;color:#FFF;padding:28px 32px;border-radius:12px 12px 0 0;text-align:center">
    <h1 style="margin:0;font-size:22px;letter-spacing:1.5px">FLANCCO</h1>
    <p style="margin:6px 0 0;opacity:0.9;font-size:14px">Confirmation demande de partenariat</p>
  </div>
  <div style="background:#FFF;padding:32px;border-radius:0 0 12px 12px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb">
    <h2 style="color:#E74C3C;font-size:20px;margin:0 0 20px">Bienvenue chez Flancco</h2>
    <p style="font-size:15px;line-height:1.7;margin:0 0 16px">${escHtml(c.aanhef)},</p>
    <p style="font-size:14px;line-height:1.7;margin:0 0 16px">Merci de votre intérêt pour devenir partenaire de Flancco. Nous avons bien reçu votre demande signée.</p>

    <div style="background:#F8F9FA;border-left:3px solid #E74C3C;border-radius:8px;padding:20px;margin:24px 0">
      <h3 style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:1.2px">Résumé de votre demande</h3>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr><td style="padding:6px 0;color:#6b7280;width:40%">Société</td><td style="padding:6px 0;color:#1f2937;font-weight:600">${escHtml(c.bedrijfsnaam)}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">N° TVA</td><td style="padding:6px 0;color:#1f2937">${escHtml(c.btw || "—")}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Secteurs</td><td style="padding:6px 0;color:#1f2937">${escHtml(c.sectorenList || "—")}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Marge</td><td style="padding:6px 0;color:#1f2937"><strong>${escHtml(String(c.margePct))}%</strong> au-dessus des prix Flancco</td></tr>
      </table>
    </div>

    ${pdfBlock}

    <h3 style="font-size:15px;margin:28px 0 12px;color:#1f2937">Étapes suivantes</h3>
    <ol style="margin:0;padding-left:20px;font-size:14px;line-height:1.8;color:#374151">
      <li>Notre équipe partenariats vous contactera dans <strong>les 3 jours ouvrables</strong></li>
      <li>Après validation, vous recevrez un e-mail séparé avec un lien magique pour activer votre compte</li>
      <li>Via votre compte, vous configurerez la marque, les paramètres du calculateur et les premiers membres d'équipe</li>
      <li>Vous recevrez un kit marketing avec QR-code et modèles de partage pour votre calculateur</li>
    </ol>

    <div style="margin-top:32px;padding-top:24px;border-top:1px solid #e5e7eb">
      <p style="font-size:14px;color:#6b7280;margin:0 0 8px">Une question ?</p>
      <p style="font-size:14px;margin:0;line-height:1.7">
        <strong style="color:#1f2937">Flancco BV</strong><br>
        <a href="mailto:gillian.geernaert@flancco.be" style="color:#1A1A2E;text-decoration:none">gillian.geernaert@flancco.be</a>
      </p>
    </div>

    <p style="margin-top:24px;font-size:14px;line-height:1.7">Cordialement,<br><strong>L'équipe Flancco</strong></p>
  </div>
  <p style="text-align:center;margin:16px 0 0;color:#999;font-size:11px">Flancco BV &mdash; Plateforme partenaire pour entretien et service</p>
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
