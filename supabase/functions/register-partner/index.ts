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
//   E. Maak/zoek auth-user; stuur magic-link invite (geen wachtwoord-set)
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
//   - application-status-update mislukt → log warning (niet-fataal — partner is live)
//
// Magic-link i.p.v. password-set: gebruiker kiest zelf wachtwoord op eerste login,
// betere UX en geen plain-text password in mail.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

// ─── Config ──────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const APP_BASE_URL = (Deno.env.get("APP_BASE_URL") ?? "https://app.flancco-platform.be").replace(/\/+$/, "");

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

    // === STAP E: Magic-link invite (of bestaande user koppelen) ===
    let userId: string | null = null;
    let inviteSent = false;
    let inviteError: string | null = null;

    try {
      const existing = await findUserByEmail(admin, email);
      if (existing) {
        userId = existing.id;
        // Bestaande user → genereer magic-link expliciet via inviteUserByEmail
        // gebruiken werkt niet voor reeds bestaande users. We sturen een
        // standaard recovery-link via generateLink.
        const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
          type: "magiclink",
          email,
          options: { redirectTo: `${APP_BASE_URL}/?welcome=1` },
        });
        if (linkErr) {
          inviteError = `magiclink_generate_failed: ${linkErr.message}`;
        } else if (linkData) {
          // Supabase verstuurt automatisch via SMTP wanneer geconfigureerd.
          // De email bevat de magic-link. Geen aparte mail-call nodig.
          inviteSent = true;
        }
      } else {
        const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, {
          redirectTo: `${APP_BASE_URL}/?welcome=1`,
          data: { partner_id: partnerId, lang, invited_via: "onboarding_wizard" },
        });
        if (inviteErr || !invited?.user) {
          inviteError = `invite_failed: ${inviteErr?.message || "unknown"}`;
        } else {
          userId = invited.user.id;
          inviteSent = true;
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
      redirect_url: `${APP_BASE_URL}/?welcome=1`,
    }, corsHeaders);
  } catch (err) {
    console.error("[register-partner] unhandled exception", err);
    return jsonError(500, "internal_error", corsHeaders, { detail: (err as Error).message });
  }
});
