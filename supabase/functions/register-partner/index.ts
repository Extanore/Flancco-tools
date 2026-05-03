// register-partner — Slot X partner-onboarding-wizard finalizer.
// -----------------------------------------------------------------
// Doel: na stap 4 (contract-signing) van de publieke /onboard/-wizard
// roept de frontend dit endpoint aan met `application_id` + `email`.
// Deze function voert de finale, atomic-as-possible flow uit:
//
//   A. Fetch + valideer partner_applications-rij
//   B. Genereer unieke slug uit bedrijfsnaam
//   C. INSERT partners-rij (branding-defaults; partner kan later self-tunen)
//   D. INSERT sector_config-rijen (1 per gekozen sector, gewhitelist)
//   E. Maak/zoek auth-user; verstuur Flancco-branded magic-link mail via Resend
//   F. INSERT user_roles met partner-permissies (manage_users=true voor eerste seat)
//   G. Update partner_applications.status → 'account_created' + partner_id
//
// Auth-model:
//   - verify_jwt = false (publieke wizard, geen ingelogde gebruiker beschikbaar
//     vóór account-creatie). Anti-misbruik via:
//       1) application_id moet bestaan + status='contract_signed' + partner_id IS NULL
//       2) email moet exact matchen met contactpersoon_email op de application
//       3) ALLOWED_ORIGINS CORS-whitelist
//       4) Idempotency via partner_id-set-check (409 op herhaalde call)
//
// Endpoint:
//   POST /functions/v1/register-partner
//   Body: { application_id: uuid, email: string, lang?: 'nl' | 'fr' }
//
// Failure-modes:
//   - Partner-INSERT mislukt → 500, geen verdere stappen
//   - sector_config-INSERT mislukt → log warning, partner-rij blijft (admin-fix-pad)
//   - user_roles-INSERT mislukt → log warning, magic-link is al verstuurd
//   - Resend-mail mislukt → niet-fataal, partner blijft live, admin kan handmatig retry
//   - application-status-update mislukt → log warning (niet-fataal — partner is live)
//
// Magic-link i.p.v. password-set: gebruiker kiest zelf wachtwoord op eerste login,
// betere UX en geen plain-text password in mail. Mail is volledig Flancco-branded
// (geen Supabase-default mail) — sender, copy en visuele stijl matchen
// `send-partner-application-confirmation`.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

// ─── Config ──────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const APP_BASE_URL = (Deno.env.get("APP_BASE_URL") ?? "https://app.flancco-platform.be").replace(/\/+$/, "");

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const PARTNER_INVITE_FROM = Deno.env.get("PARTNER_INVITE_FROM_ADDRESS")
  ?? "Flancco Partners <noreply@flancco-platform.be>";
const PARTNER_INVITE_REPLY_TO = Deno.env.get("PARTNER_INVITE_REPLY_TO")
  ?? "gillian.geernaert@flancco.be";

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS")
  ?? "https://flancco-platform.be,https://app.flancco-platform.be,https://calculator.flancco-platform.be,https://www.flancco-platform.be"
).split(",").map((s) => s.trim()).filter(Boolean);

// Whitelist sectoren — 'verwarming' is Flancco-only (gas/stookolie expertise).
// Partners kunnen enkel kiezen uit warmtepomp, zonnepanelen, ventilatie.
const ALLOWED_SECTORS = ["warmtepomp", "zonnepanelen", "ventilatie"] as const;
type AllowedSector = typeof ALLOWED_SECTORS[number];

// ─── Types ──────────────────────────────────────────────────────────────────

interface RegisterPayload {
  application_id?: string;
  email?: string;
  lang?: "nl" | "fr";
}

interface PartnerApplication {
  id: string;
  status: string;
  partner_id: string | null;
  bedrijfsnaam: string;
  contactpersoon_voornaam?: string | null;
  contactpersoon_email: string;
  contactpersoon_telefoon?: string | null;
  website?: string | null;
  marge_pct?: number | null;
  sectoren?: unknown;
  // Optioneel: aanvullende velden uit wizard (adres, btw, etc.) — defensief uitgelezen
  btw_nummer?: string | null;
  adres?: string | null;
  postcode?: string | null;
  gemeente?: string | null;
  contactpersoon?: string | null;
}

// ─── Validation ─────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,24}$/;

// ─── CORS / response helpers ────────────────────────────────────────────────

function corsFor(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
    "Access-Control-Max-Age": "3600",
    "Vary": "Origin",
  };
}

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

function jsonOk(
  body: Record<string, unknown>,
  corsHeaders: Record<string, string>,
): Response {
  return new Response(JSON.stringify({ ok: true, ...body }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Slug generation ────────────────────────────────────────────────────────

function generateSlug(naam: string): string {
  return (naam || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "partner";
}

async function findUniqueSlug(admin: SupabaseClient, base: string): Promise<string> {
  let candidate = base;
  for (let i = 2; i <= 50; i++) {
    const { data, error } = await admin
      .from("partners")
      .select("id")
      .eq("slug", candidate)
      .maybeSingle();
    if (error) throw new Error(`slug-uniqueness check failed: ${error.message}`);
    if (!data) return candidate;
    candidate = `${base}-${i}`;
  }
  // Pathologisch geval — voeg uuid-suffix toe.
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

// ─── Existing user lookup (paged) ───────────────────────────────────────────
//
// auth.admin.listUsers() is paged (default 50). We zoeken expliciet op email
// via meerdere pages tot match of laatste page. Voor < 10k users is dit prima.
async function findUserByEmail(admin: SupabaseClient, email: string): Promise<{ id: string } | null> {
  const targetEmail = email.trim().toLowerCase();
  const PER_PAGE = 200;
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const users = data?.users || [];
    const found = users.find((u) => (u.email || "").toLowerCase() === targetEmail);
    if (found) return { id: found.id };
    if (users.length < PER_PAGE) return null;
  }
  return null;
}

// ─── Handler ────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const corsHeaders = corsFor(req);

  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonError(405, "method_not_allowed", corsHeaders);

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("[register-partner] missing SUPABASE_URL or SERVICE_ROLE_KEY");
    return jsonError(500, "server_misconfigured", corsHeaders);
  }
  if (!RESEND_API_KEY) {
    console.error("[register-partner] missing RESEND_API_KEY");
    return jsonError(500, "server_misconfigured", corsHeaders, { detail: "missing_resend_api_key" });
  }

  // Body parsing.
  let payload: RegisterPayload;
  try {
    payload = await req.json();
  } catch {
    return jsonError(400, "invalid_json", corsHeaders);
  }

  const application_id = String(payload.application_id || "").trim();
  const email = String(payload.email || "").trim().toLowerCase();
  const lang: "nl" | "fr" = payload.lang === "fr" ? "fr" : "nl";

  if (!application_id || !UUID_RE.test(application_id)) {
    return jsonError(400, "invalid_application_id", corsHeaders);
  }
  if (!email || !EMAIL_RE.test(email)) {
    return jsonError(400, "invalid_email", corsHeaders);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    // === STAP A: Fetch + valideer application ===
    const { data: app, error: appErr } = await admin
      .from("partner_applications")
      .select("*")
      .eq("id", application_id)
      .maybeSingle<PartnerApplication>();

    if (appErr) {
      console.error("[register-partner] application lookup error", appErr.message);
      // Defensief: als de tabel nog niet bestaat krijgen we hier een schema-fout.
      return jsonError(500, "application_lookup_failed", corsHeaders, { detail: appErr.message });
    }
    if (!app) {
      return jsonError(404, "application_not_found", corsHeaders);
    }
    if (app.status !== "contract_signed") {
      return jsonError(400, "application_status_invalid", corsHeaders, { actual_status: app.status });
    }
    if ((app.contactpersoon_email || "").trim().toLowerCase() !== email) {
      return jsonError(400, "email_mismatch", corsHeaders);
    }
    if (app.partner_id) {
      // Idempotency: tweede call op zelfde application.
      return jsonError(409, "partner_already_registered", corsHeaders, { partner_id: app.partner_id });
    }
    if (!app.bedrijfsnaam || app.bedrijfsnaam.trim().length === 0) {
      return jsonError(400, "missing_bedrijfsnaam", corsHeaders);
    }

    // Validate + filter sectoren tegen whitelist.
    const sectorenRaw: unknown[] = Array.isArray(app.sectoren) ? app.sectoren as unknown[] : [];
    const validSectors = sectorenRaw
      .filter((s): s is AllowedSector => typeof s === "string" && (ALLOWED_SECTORS as readonly string[]).includes(s));
    if (validSectors.length === 0) {
      return jsonError(400, "no_valid_sectors", corsHeaders);
    }

    // === STAP B: Genereer unieke slug ===
    const baseSlug = generateSlug(app.bedrijfsnaam);
    const finalSlug = await findUniqueSlug(admin, baseSlug);

    // === STAP C: INSERT partner-rij ===
    // marge_pct: NUMERIC kolom, default 10.00. Application-veld kan null zijn.
    const margePct = (typeof app.marge_pct === "number" && isFinite(app.marge_pct))
      ? app.marge_pct
      : 10;

    const partnerInsert = {
      naam: app.bedrijfsnaam,
      bedrijfsnaam: app.bedrijfsnaam,
      slug: finalSlug,
      marge_pct: margePct,
      planning_fee: 0, // partner kan in self-setup-wizard tunen
      kleur_primair: "#1A1A2E", // Flancco-default tot partner branding kiest
      kleur_donker: "#0F0F1E",
      email: app.contactpersoon_email,
      telefoon: app.contactpersoon_telefoon ?? null,
      website: app.website ?? "",
      contactpersoon: app.contactpersoon ?? null,
      btw_nummer: app.btw_nummer ?? null,
      adres: app.adres ?? null,
      postcode: app.postcode ?? null,
      gemeente: app.gemeente ?? null,
      contract_getekend: true,
      contract_datum: new Date().toISOString().slice(0, 10),
      actief: true,
    };

    const { data: partner, error: partnerErr } = await admin
      .from("partners")
      .insert(partnerInsert)
      .select("id, slug")
      .single();

    if (partnerErr || !partner) {
      console.error("[register-partner] partner insert failed", partnerErr?.message);
      return jsonError(500, "partner_create_failed", corsHeaders, { detail: partnerErr?.message });
    }

    const partnerId = partner.id as string;

    // === STAP D: INSERT sector_config-rijen (1 per sector) ===
    const sectorRows = validSectors.map((sector) => ({
      partner_id: partnerId,
      sector,
      config: {
        usps: [],
        vragen: [],
        frequentie_opties: ["jaarlijks", "halfjaarlijks", "kwartaal"],
        contractduur_opties: [1, 2, 3, 5],
      },
    }));

    const { error: scErr } = await admin.from("sector_config").insert(sectorRows);
    if (scErr) {
      // Niet-fataal: partner-rij blijft, admin kan later sector_config aanvullen.
      console.error("[register-partner] sector_config insert failed (non-fatal)", scErr.message);
    }

    // === STAP E: Magic-link genereren + Flancco-branded mail versturen ===
    //
    // We gebruiken auth.admin.generateLink (NIET inviteUserByEmail) zodat
    // Supabase géén default mail verstuurt. We ontvangen de action_link in
    // de response en versturen zelf een Flancco-branded mail via Resend.
    let userId: string | null = null;
    let inviteSent = false;
    let inviteError: string | null = null;
    let magicLink: string | null = null;

    try {
      // Redirect naar /admin/ ipv /. Reden: app.flancco-platform.be/ wordt door
      // _worker.js 302'd naar /onboard/ (publieke wizard) — daar zit géén
      // Supabase auth-handler, dus de access_token in de URL-hash blijft onverwerkt.
      // /admin/ is een directe asset-fetch (geen worker-redirect) waar admin/index.html
      // de session via sb.auth.getSession() automatisch uit de hash leest.
      const partnerRedirect = `${APP_BASE_URL}/admin/?welcome=1`;

      const existing = await findUserByEmail(admin, email);
      if (existing) {
        userId = existing.id;
        const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
          type: "magiclink",
          email,
          options: { redirectTo: partnerRedirect },
        });
        if (linkErr) {
          inviteError = `magiclink_generate_failed: ${linkErr.message}`;
        } else {
          magicLink = linkData?.properties?.action_link ?? null;
          if (!magicLink) {
            inviteError = "magiclink_missing_action_link";
          }
        }
      } else {
        // Nieuwe user: type=invite creëert de user + genereert link in één call,
        // zonder Supabase-default mail.
        const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
          type: "invite",
          email,
          options: {
            redirectTo: partnerRedirect,
            data: { partner_id: partnerId, lang, invited_via: "onboarding_wizard" },
          },
        });
        if (linkErr) {
          inviteError = `invite_generate_failed: ${linkErr.message}`;
        } else {
          userId = linkData?.user?.id ?? null;
          magicLink = linkData?.properties?.action_link ?? null;
          if (!userId) {
            inviteError = "invite_missing_user_id";
          } else if (!magicLink) {
            inviteError = "invite_missing_action_link";
          }
        }
      }

      // Verstuur Flancco-branded mail (alleen als link beschikbaar is)
      if (magicLink && !inviteError) {
        const voornaam = (app.contactpersoon_voornaam ?? "").trim();
        const mailResult = await sendPartnerInviteMail({
          to: email,
          voornaam,
          bedrijfsnaam: app.bedrijfsnaam,
          magicLink,
          lang,
        });
        if (mailResult.ok) {
          inviteSent = true;
        } else {
          // Niet-fataal: link is gegenereerd maar mail-delivery faalde.
          // Admin kan handmatig retry doen. Partner-rij blijft bestaan.
          inviteError = mailResult.error ?? "invite_mail_failed";
        }
      }
    } catch (e) {
      inviteError = `invite_exception: ${(e as Error).message}`;
    }

    if (!userId) {
      // Auth-flow mislukt volledig — partner blijft bestaan, maar geen login mogelijk.
      // Admin moet manueel user provisionen. Niet-fataal voor wizard-flow.
      console.error("[register-partner] user invite failed completely", inviteError);
    }

    // === STAP F: INSERT user_role ===
    let roleInserted = false;
    if (userId) {
      // Permissions: eerste partner-seat krijgt manage_users=true zodat hij
      // teamleden kan toevoegen via invite-partner-member endpoint.
      const { error: roleErr } = await admin.from("user_roles").upsert({
        user_id: userId,
        role: "partner",
        partner_id: partnerId,
        permissions: {
          manage_users: true,
          contracten_aanmaken: true,
          facturatie_inzage: true,
          rapporten_inzage: true,
          planning_inzage: true,
        },
      }, { onConflict: "user_id" });

      if (roleErr) {
        console.error("[register-partner] user_role upsert failed (non-fatal)", roleErr.message);
      } else {
        roleInserted = true;
      }
    }

    // === STAP G: Update application status ===
    const { error: appUpdateErr } = await admin
      .from("partner_applications")
      .update({
        status: "account_created",
        partner_id: partnerId,
      })
      .eq("id", application_id);

    if (appUpdateErr) {
      console.error("[register-partner] application status update failed (non-fatal)", appUpdateErr.message);
    }

    // === Logging — geen PII (alleen tenant + outcome) ===
    console.log(JSON.stringify({
      fn: "register-partner",
      application_id,
      partner_id: partnerId,
      slug: finalSlug,
      sectors: validSectors,
      sector_config_ok: !scErr,
      user_id_set: !!userId,
      role_inserted: roleInserted,
      invite_sent: inviteSent,
      invite_error: inviteError,
    }));

    return jsonOk({
      partner_id: partnerId,
      slug: finalSlug,
      user_id: userId,
      invite_sent: inviteSent,
      invite_error: inviteError,
      sectoren: validSectors,
      redirect_url: `${APP_BASE_URL}/admin/?welcome=1`,
    }, corsHeaders);
  } catch (err) {
    console.error("[register-partner] unhandled exception", err);
    return jsonError(500, "internal_error", corsHeaders, { detail: (err as Error).message });
  }
});

// ─── Resend mail wrapper + templates ────────────────────────────────────────

interface InviteMailParams {
  to: string;
  voornaam: string;
  bedrijfsnaam: string;
  magicLink: string;
  lang: "nl" | "fr";
}

async function sendPartnerInviteMail(
  params: InviteMailParams,
): Promise<{ ok: boolean; error?: string }> {
  const subject = params.lang === "fr"
    ? "Bienvenue chez Flancco — activez votre compte partenaire"
    : "Welkom bij Flancco — activeer je partner-account";

  const html = params.lang === "fr"
    ? buildFrInviteHtml(params)
    : buildNlInviteHtml(params);

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: PARTNER_INVITE_FROM,
        to: params.to,
        subject,
        html,
        reply_to: PARTNER_INVITE_REPLY_TO,
      }),
    });
    if (!resp.ok) {
      // Lees response-body niet om PII (recipient-email in Resend-error) te vermijden.
      return { ok: false, error: `invite_mail_failed_status_${resp.status}` };
    }
    return { ok: true };
  } catch (e) {
    console.error("[sendPartnerInviteMail] fetch failed:", (e as Error).message);
    return { ok: false, error: "invite_mail_failed_network" };
  }
}

interface InviteCtx {
  voornaam: string;
  bedrijfsnaam: string;
  magicLink: string;
}

function buildNlInviteHtml(c: InviteCtx): string {
  const aanhef = c.voornaam ? `Beste ${escHtml(c.voornaam)}` : "Beste partner";
  const bedrijfBlok = c.bedrijfsnaam
    ? ` voor <strong>${escHtml(c.bedrijfsnaam)}</strong>`
    : "";

  return `<!DOCTYPE html>
<html lang="nl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Activeer je Flancco partner-account</title></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#F3F4F6;color:#1A1A2E">
<div style="max-width:600px;margin:0 auto;padding:20px">
  <div style="background:#1A1A2E;color:#FFF;padding:28px 32px;border-radius:12px 12px 0 0;text-align:center;border-bottom:3px solid #E74C3C">
    <h1 style="margin:0;font-size:22px;letter-spacing:1.5px">FLANCCO</h1>
    <p style="margin:6px 0 0;opacity:0.9;font-size:14px">Partner-platform voor onderhoud en service</p>
  </div>
  <div style="background:#FFF;padding:32px;border-radius:0 0 12px 12px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb">
    <h2 style="color:#E74C3C;font-size:20px;margin:0 0 20px">Welkom als Flancco-partner</h2>
    <p style="font-size:15px;line-height:1.7;margin:0 0 16px">${aanhef},</p>
    <p style="font-size:14px;line-height:1.7;margin:0 0 16px">Het partnercontract is succesvol getekend en je partner-account${bedrijfBlok} is klaar om geactiveerd te worden.</p>

    <p style="margin:28px 0;text-align:center">
      <a href="${escUrl(c.magicLink)}" style="display:inline-block;background:#E74C3C;color:#FFF;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px">Activeer mijn account</a>
    </p>

    <p style="font-size:13px;line-height:1.7;margin:0 0 24px;color:#6b7280">Werkt de knop niet? Kopieer dan deze link in je browser:<br><a href="${escUrl(c.magicLink)}" style="color:#1A1A2E;word-break:break-all">${escHtml(c.magicLink)}</a></p>

    <div style="background:#F8F9FA;border-left:3px solid #E74C3C;border-radius:8px;padding:20px;margin:24px 0">
      <h3 style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:1.2px">Wat vind je in je dashboard?</h3>
      <ul style="margin:0;padding-left:20px;font-size:14px;line-height:1.8;color:#374151">
        <li>Beheer van klanten en contracten onder jouw merk</li>
        <li>Live planning van onderhoudsbeurten door Flancco</li>
        <li>Branded rapporten met jouw logo en kleuren</li>
        <li>Marketing-kit met QR-code voor je calculator</li>
        <li>Facturatie-overzicht met je marge per beurt</li>
      </ul>
    </div>

    <div style="margin-top:32px;padding-top:24px;border-top:1px solid #e5e7eb">
      <p style="font-size:14px;color:#6b7280;margin:0 0 8px">Vragen?</p>
      <p style="font-size:14px;margin:0;line-height:1.7">
        Antwoord op deze mail of bel rechtstreeks <strong style="color:#1f2937">0484 59 47 62</strong>.
      </p>
    </div>

    <p style="margin-top:24px;font-size:14px;line-height:1.7">Met vriendelijke groet,<br><strong>Het Flancco team</strong></p>
  </div>
  <p style="text-align:center;margin:16px 0 0;color:#999;font-size:11px">Flancco BV &mdash; Partner-platform voor onderhoud en service</p>
</div>
</body>
</html>`;
}

function buildFrInviteHtml(c: InviteCtx): string {
  const aanhef = c.voornaam ? `Bonjour ${escHtml(c.voornaam)}` : "Bonjour cher partenaire";
  const bedrijfBlok = c.bedrijfsnaam
    ? ` pour <strong>${escHtml(c.bedrijfsnaam)}</strong>`
    : "";

  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Activez votre compte partenaire Flancco</title></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#F3F4F6;color:#1A1A2E">
<div style="max-width:600px;margin:0 auto;padding:20px">
  <div style="background:#1A1A2E;color:#FFF;padding:28px 32px;border-radius:12px 12px 0 0;text-align:center;border-bottom:3px solid #E74C3C">
    <h1 style="margin:0;font-size:22px;letter-spacing:1.5px">FLANCCO</h1>
    <p style="margin:6px 0 0;opacity:0.9;font-size:14px">Plateforme partenaire pour entretien et service</p>
  </div>
  <div style="background:#FFF;padding:32px;border-radius:0 0 12px 12px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb">
    <h2 style="color:#E74C3C;font-size:20px;margin:0 0 20px">Bienvenue en tant que partenaire Flancco</h2>
    <p style="font-size:15px;line-height:1.7;margin:0 0 16px">${aanhef},</p>
    <p style="font-size:14px;line-height:1.7;margin:0 0 16px">Le contrat de partenariat a été signé avec succès et votre compte partenaire${bedrijfBlok} est prêt à être activé.</p>

    <p style="margin:28px 0;text-align:center">
      <a href="${escUrl(c.magicLink)}" style="display:inline-block;background:#E74C3C;color:#FFF;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px">Activer mon compte</a>
    </p>

    <p style="font-size:13px;line-height:1.7;margin:0 0 24px;color:#6b7280">Le bouton ne fonctionne pas ? Copiez ce lien dans votre navigateur :<br><a href="${escUrl(c.magicLink)}" style="color:#1A1A2E;word-break:break-all">${escHtml(c.magicLink)}</a></p>

    <div style="background:#F8F9FA;border-left:3px solid #E74C3C;border-radius:8px;padding:20px;margin:24px 0">
      <h3 style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:1.2px">Que trouverez-vous dans votre tableau de bord ?</h3>
      <ul style="margin:0;padding-left:20px;font-size:14px;line-height:1.8;color:#374151">
        <li>Gestion des clients et contrats sous votre marque</li>
        <li>Planification en direct des entretiens par Flancco</li>
        <li>Rapports brandés avec votre logo et vos couleurs</li>
        <li>Kit marketing avec QR-code pour votre calculateur</li>
        <li>Aperçu de facturation avec votre marge par intervention</li>
      </ul>
    </div>

    <div style="margin-top:32px;padding-top:24px;border-top:1px solid #e5e7eb">
      <p style="font-size:14px;color:#6b7280;margin:0 0 8px">Une question ?</p>
      <p style="font-size:14px;margin:0;line-height:1.7">
        Répondez à cet e-mail ou appelez directement <strong style="color:#1f2937">0484 59 47 62</strong>.
      </p>
    </div>

    <p style="margin-top:24px;font-size:14px;line-height:1.7">Cordialement,<br><strong>L'équipe Flancco</strong></p>
  </div>
  <p style="text-align:center;margin:16px 0 0;color:#999;font-size:11px">Flancco BV &mdash; Plateforme partenaire pour entretien et service</p>
</div>
</body>
</html>`;
}

// ─── HTML escape helpers ────────────────────────────────────────────────────

function escHtml(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Veilige URL-escape: laat enkel http(s) door — voorkomt javascript: injectie. */
function escUrl(s: string | null | undefined): string {
  const v = String(s ?? "").trim();
  if (!v) return "";
  if (/^https?:/i.test(v)) {
    return v.replace(/"/g, "%22").replace(/</g, "%3C").replace(/>/g, "%3E");
  }
  return "";
}
