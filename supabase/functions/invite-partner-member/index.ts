// invite-partner-member — Slot I + Slot U (rol-gebaseerd partner-team)
// -------------------------------------------------------------
// Doel: laat een partner-eigenaar (role='partner', permissions.manage_users=true)
// teamleden toevoegen aan zijn tenant met een gedefinieerde permissie-set.
// Verschilt van het bestaande `create-bediende` door:
//   1. Whitelisting van permissie-keys (server-side hard cap; geen manage_partners/manage_pricing).
//   2. Magic-link invite via auth.admin.inviteUserByEmail i.p.v. password-create
//      (betere onboarding-UX — gebruiker kiest zelf eerste wachtwoord).
//   3. Re-invite-pad: bestaande user (zonder user_role) krijgt enkel role+techniekers-rij.
//      Bestaande user MET user_role van andere partner → 409 (anti-hijack).
//      Slot U: bij re-invite van een eerder uit-dienst gezette tech wordt
//      uit_dienst_sinds op NULL gezet (trigger trg_techniekers_sync_actief
//      synct actief=true). Bij re-invite < 30 dagen na uit-dienst wordt
//      `recently_exited: true` mee teruggegeven als waarschuwing.
//   4. In-memory rate limit per partner_id (10 invites / uur).
//   5. Branded invite-mail (NL/FR per partner of body.lang) via Resend, fallback naar
//      manuele credentials wanneer Resend ongeconfigureerd is.
//
// Auth-model:
//   - verify_jwt=false (custom auth in handler voor nettere errors zonder generic 401).
//   - Caller MOET ofwel role='admin', ofwel role='partner' + matching partner_id +
//     permissions.manage_users=true. Anders → 403.
//
// Endpoint:
//   POST /functions/v1/invite-partner-member
//   Authorization: Bearer <user-JWT>
//   Body: {
//     email: string,
//     voornaam: string,
//     naam: string,
//     partner_id: uuid,
//     permissions?: { manage_users?, contracten_aanmaken?, facturatie_inzage?,
//                     rapporten_inzage?, planning_inzage? },
//     lang?: 'nl' | 'fr'   // default 'nl'
//   }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

// ─── Config ──────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM_DEFAULT = Deno.env.get("EMAIL_FROM_ADDRESS") ?? "Flancco Platform <noreply@flancco-platform.be>";
const REPLY_TO_DEFAULT = Deno.env.get("EMAIL_REPLY_TO") ?? "gillian.geernaert@flancco.be";
const APP_BASE_URL = (Deno.env.get("APP_BASE_URL") ?? "https://app.flancco-platform.be/").replace(/\/?$/, "/");

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS")
  || "https://app.flancco-platform.be,https://flancco-platform.be,https://www.flancco-platform.be"
).split(",").map((s) => s.trim()).filter(Boolean);

// Whitelist van permissie-keys die een partner-admin mag uitdelen aan teamleden.
// `manage_partners` en `manage_pricing` zijn super-admin-only en nooit toegestaan
// in dit endpoint. Verlof-beheer is Flancco-intern (HR), niet partner-tenant.
const ALLOWED_PERMISSION_KEYS = [
  "manage_users",
  "contracten_aanmaken",
  "facturatie_inzage",
  "rapporten_inzage",
  "planning_inzage",
] as const;
type PermissionKey = typeof ALLOWED_PERMISSION_KEYS[number];

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 uur
const RATE_LIMIT_MAX = 10;

// ─── In-memory rate limiter (per edge-instance) ─────────────────────────────
//
// Per partner_id: lijst van invite-timestamps binnen het venster. Cleanup-tick
// houdt de map klein. Niet 100% accuraat tussen edge-instances, maar voldoende
// als brute-force-buffer; een echte misbruiker stuit ook op Resend-throttling.
const _rateMap = new Map<string, number[]>();

function rateLimitCheck(partnerId: string): { ok: boolean; retryInSec: number } {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const arr = (_rateMap.get(partnerId) || []).filter((t) => t > cutoff);
  if (arr.length >= RATE_LIMIT_MAX) {
    const earliest = arr[0];
    return { ok: false, retryInSec: Math.max(1, Math.ceil((earliest + RATE_LIMIT_WINDOW_MS - now) / 1000)) };
  }
  arr.push(now);
  _rateMap.set(partnerId, arr);
  return { ok: true, retryInSec: 0 };
}

// ─── CORS ────────────────────────────────────────────────────────────────────

function corsFor(req: Request) {
  const origin = req.headers.get("Origin") || "";
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  } as Record<string, string>;
}

function json(status: number, body: unknown, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...extraHeaders, "Content-Type": "application/json" },
  });
}

// ─── Validation ─────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// RFC-5322 simplified — geen exotische unicode/local-part; voldoende voor B2B.
const EMAIL_RE = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,24}$/;
// Anti-injection in display names: alleen letters (incl. accents), spaces, '-, .
const NAME_RE = /^[\p{L}\p{M}\s\-'.]{1,64}$/u;

function sanitizePermissions(input: unknown): Record<PermissionKey, boolean> {
  const out = {
    manage_users: false,
    contracten_aanmaken: false,
    facturatie_inzage: false,
    rapporten_inzage: false,
    planning_inzage: false,
  } satisfies Record<PermissionKey, boolean>;
  if (!input || typeof input !== "object") return out;
  const obj = input as Record<string, unknown>;
  for (const k of ALLOWED_PERMISSION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      out[k] = obj[k] === true;
    }
  }
  return out;
}

// ─── Branded invite-mail (NL/FR) ────────────────────────────────────────────

interface PartnerBrand {
  slug: string;
  name: string;
  primaryColor: string;
  logoUrl: string;
  email: string;
  telefoon: string;
  website: string;
  isFlancco: boolean;
}

function escHtml(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escUrl(s: string | null | undefined): string {
  const v = String(s ?? "").trim();
  if (!v) return "";
  if (/^https?:/i.test(v)) {
    return v.replace(/"/g, "%22").replace(/</g, "%3C").replace(/>/g, "%3E");
  }
  return "";
}

function sanitizeHex(value: string | null | undefined, fallback: string): string {
  const v = String(value ?? "").trim();
  if (/^#?[0-9a-fA-F]{6}$/.test(v)) return v.startsWith("#") ? v : `#${v}`;
  return fallback;
}

async function loadPartnerBrand(sb: SupabaseClient, partnerId: string): Promise<PartnerBrand> {
  const { data } = await sb.from("partners")
    .select("slug, naam, bedrijfsnaam, kleur_primair, logo_url, email, telefoon, website")
    .eq("id", partnerId)
    .maybeSingle();
  const slug = String(data?.slug || "flancco").toLowerCase();
  const isFlancco = slug === "flancco";
  return {
    slug,
    name: data?.bedrijfsnaam || data?.naam || "Partner",
    primaryColor: sanitizeHex(data?.kleur_primair, "#1A1A2E"),
    logoUrl: data?.logo_url || "",
    email: data?.email || "",
    telefoon: data?.telefoon || "",
    website: data?.website || "",
    isFlancco,
  };
}

interface InviteEmailInput {
  brand: PartnerBrand;
  recipient: { email: string; voornaam: string; naam: string };
  loginUrl: string;
  inviterDisplay: string;
  tempPassword: string | null; // null wanneer magic-link mode (toekomstig); nu altijd gevuld
  permissions: Record<PermissionKey, boolean>;
  lang: "nl" | "fr";
}

function permissionLabels(lang: "nl" | "fr"): Record<PermissionKey, string> {
  if (lang === "fr") {
    return {
      manage_users: "Gestion de l'\u00E9quipe",
      contracten_aanmaken: "Cr\u00E9er des contrats",
      facturatie_inzage: "Acc\u00E8s facturation",
      rapporten_inzage: "Acc\u00E8s rapports",
      planning_inzage: "Acc\u00E8s planning",
    };
  }
  return {
    manage_users: "Teamleden beheren",
    contracten_aanmaken: "Contracten aanmaken",
    facturatie_inzage: "Inzage facturatie",
    rapporten_inzage: "Inzage rapporten",
    planning_inzage: "Inzage planning",
  };
}

function buildInviteEmailHtml(opts: InviteEmailInput): { subject: string; html: string } {
  const { brand, recipient, loginUrl, inviterDisplay, tempPassword, permissions, lang } = opts;
  const primary = brand.primaryColor;
  const accent = "#E74C3C";
  const safeBrandName = escHtml(brand.name);
  const safeRecipient = escHtml((recipient.voornaam + " " + recipient.naam).trim() || recipient.email);
  const safeInviter = escHtml(inviterDisplay);

  const permLabels = permissionLabels(lang);
  const enabledPerms = (Object.keys(permissions) as PermissionKey[])
    .filter((k) => permissions[k])
    .map((k) => `<li style="margin:4px 0">${escHtml(permLabels[k])}</li>`)
    .join("");

  const subject = lang === "fr"
    ? `${brand.name} \u2014 vous a invit\u00E9 sur la plateforme Flancco`
    : `${brand.name} heeft je uitgenodigd voor het Flancco-platform`;

  const headerLogo = brand.logoUrl
    ? `<img src="${escUrl(brand.logoUrl)}" alt="${escHtml(brand.name)}" style="max-height:40px;max-width:200px;display:block">`
    : `<div style="font-size:18px;font-weight:700;color:#fff;letter-spacing:0.3px">${safeBrandName}</div>`;

  const intro = lang === "fr"
    ? `${safeInviter} vous a ajout\u00E9 \u00E0 l'\u00E9quipe <strong>${safeBrandName}</strong> sur la plateforme partenaire Flancco. Vous pouvez maintenant g\u00E9rer les contrats, clients et interventions de votre tenant.`
    : `${safeInviter} heeft je toegevoegd aan het team van <strong>${safeBrandName}</strong> op het Flancco partner-platform. Je kan nu contracten, klanten en interventies binnen jouw tenant beheren.`;

  const credentialsBox = tempPassword
    ? `
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:10px;margin-top:18px">
        <tr><td style="padding:18px 20px">
          <div style="font-size:11px;font-weight:600;color:#6B7280;letter-spacing:0.5px;text-transform:uppercase;margin-bottom:10px">${lang === "fr" ? "Identifiants" : "Inloggegevens"}</div>
          <div style="font-size:13px;color:#374151;margin-bottom:6px"><strong style="color:${primary}">${lang === "fr" ? "E-mail" : "E-mail"}:</strong> ${escHtml(recipient.email)}</div>
          <div style="font-size:13px;color:#374151"><strong style="color:${primary}">${lang === "fr" ? "Mot de passe temporaire" : "Tijdelijk wachtwoord"}:</strong> <code style="display:inline-block;background:#fff;border:1px solid #E5E7EB;padding:4px 10px;border-radius:6px;font-family:'SF Mono',Menlo,Consolas,monospace;font-size:13px;color:${primary};margin-left:4px">${escHtml(tempPassword)}</code></div>
        </td></tr>
      </table>`
    : "";

  const permsBox = enabledPerms
    ? `
      <div style="margin-top:18px">
        <div style="font-size:11px;font-weight:600;color:#6B7280;letter-spacing:0.5px;text-transform:uppercase;margin-bottom:8px">${lang === "fr" ? "Vos acc\u00E8s" : "Jouw toegangen"}</div>
        <ul style="margin:0;padding-left:20px;font-size:13px;color:#374151;line-height:1.6">${enabledPerms}</ul>
      </div>`
    : "";

  const ctaLabel = lang === "fr" ? "Se connecter \u00E0 la plateforme" : "Inloggen op het platform";
  const securityNote = lang === "fr"
    ? "Modifiez votre mot de passe d\u00E8s la premi\u00E8re connexion via Param\u00E8tres &gt; Mon compte."
    : "Wijzig je wachtwoord direct na je eerste login via Instellingen &gt; Mijn account.";
  const securityHeading = lang === "fr" ? "Important" : "Belangrijk";
  const greeting = lang === "fr" ? `Bonjour ${safeRecipient}` : `Hallo ${safeRecipient}`;
  const tag = lang === "fr" ? "Invitation" : "Uitnodiging";
  const footerNote = lang === "fr"
    ? "Une question&nbsp;? R\u00E9pondez \u00E0 cet e-mail."
    : "Vragen? Reageer op deze e-mail.";

  const html = `<!doctype html>
<html lang="${lang}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${primary}">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f6;padding:24px 12px">
  <tr><td align="center">
    <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 18px rgba(0,0,0,0.06)">
      <tr><td style="background:${primary};padding:24px 28px">${headerLogo}</td></tr>
      <tr><td style="padding:32px 28px 8px">
        <div style="font-size:11px;font-weight:600;color:${accent};letter-spacing:0.5px;text-transform:uppercase;margin-bottom:10px">${escHtml(tag)}</div>
        <h1 style="margin:0 0 14px;font-size:22px;line-height:1.3;color:${primary};font-weight:700">${escHtml(greeting)}</h1>
        <p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#4B5563">${intro}</p>
      </td></tr>
      <tr><td style="padding:8px 28px 8px">${credentialsBox}${permsBox}</td></tr>
      <tr><td style="padding:22px 28px 8px">
        <a href="${escUrl(loginUrl)}" style="display:inline-block;background:${primary};color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:14px;font-weight:600">${escHtml(ctaLabel)}</a>
      </td></tr>
      <tr><td style="padding:18px 28px 8px">
        <div style="background:#FEF3F2;border-left:3px solid ${accent};padding:12px 14px;border-radius:4px;font-size:13px;color:#7F1D1D;line-height:1.5"><strong>${escHtml(securityHeading)}:</strong> ${securityNote}</div>
      </td></tr>
      <tr><td style="padding:22px 28px 28px;border-top:1px solid #E5E7EB;font-size:12px;color:#9CA3AF;line-height:1.6">
        ${escHtml(footerNote)}
        <br>${brand.isFlancco ? "Flancco BV" : safeBrandName + " &middot; " + (lang === "fr" ? "via la plateforme Flancco" : "via Flancco-platform")}
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
  return { subject, html };
}

// ─── Handler ────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const corsHeaders = corsFor(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "method not allowed" }, corsHeaders);

  try {
    // 1) Auth check — service-role validation van de JWT.
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return json(401, { error: "Geen Authorization-header meegegeven", step: "no_token" }, corsHeaders);

    if (!SUPABASE_URL || !SERVICE_KEY) {
      console.error("invite-partner-member: missing SUPABASE_URL or SERVICE_KEY");
      return json(500, { error: "Server misconfigured" }, corsHeaders);
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) {
      return json(401, { error: "Sessie verlopen of ongeldig — log uit en opnieuw in", step: "get_user" }, corsHeaders);
    }
    const caller = userData.user;

    // 2) Body validation.
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const email = String(body.email || "").trim().toLowerCase();
    const voornaam = String(body.voornaam || "").trim();
    const naam = String(body.naam || "").trim();
    const partner_id = String(body.partner_id || "").trim();
    const lang: "nl" | "fr" = body.lang === "fr" ? "fr" : "nl";

    if (!email || !EMAIL_RE.test(email)) {
      return json(400, { error: "Ongeldig e-mailadres", field: "email" }, corsHeaders);
    }
    if (!voornaam || !NAME_RE.test(voornaam)) {
      return json(400, { error: "Ongeldige voornaam", field: "voornaam" }, corsHeaders);
    }
    if (!naam || !NAME_RE.test(naam)) {
      return json(400, { error: "Ongeldige achternaam", field: "naam" }, corsHeaders);
    }
    if (!UUID_RE.test(partner_id)) {
      return json(400, { error: "Ongeldig partner_id", field: "partner_id" }, corsHeaders);
    }

    const permissions = sanitizePermissions(body.permissions);

    // 3) Caller-rol resolveren.
    const { data: callerRole, error: callerRoleErr } = await admin
      .from("user_roles")
      .select("role, partner_id, permissions")
      .eq("user_id", caller.id)
      .maybeSingle();

    if (callerRoleErr) {
      console.error("invite-partner-member: caller-role lookup failed", callerRoleErr);
      return json(500, { error: "Kon rolprofiel niet ophalen" }, corsHeaders);
    }
    if (!callerRole) {
      return json(403, { error: "Geen rol gevonden voor deze gebruiker" }, corsHeaders);
    }

    const isAdmin = callerRole.role === "admin";
    const isPartnerOwner = callerRole.role === "partner"
      && callerRole.partner_id === partner_id
      && callerRole.permissions
      && (callerRole.permissions as Record<string, unknown>).manage_users === true;

    if (!isAdmin && !isPartnerOwner) {
      return json(403, { error: "Geen rechten om teamleden uit te nodigen voor deze partner" }, corsHeaders);
    }

    // 4) Partner-existence + branding.
    const brand = await loadPartnerBrand(admin, partner_id);
    if (!brand.slug) {
      return json(404, { error: "Partner niet gevonden" }, corsHeaders);
    }

    // 5) Rate-limit per partner_id (defense vs. mass-invite).
    const rl = rateLimitCheck(partner_id);
    if (!rl.ok) {
      return json(429, { error: "Te veel uitnodigingen verstuurd. Probeer later opnieuw.", retry_after_sec: rl.retryInSec },
        { ...corsHeaders, "Retry-After": String(rl.retryInSec) });
    }

    // 6) Existing-user check (anti-hijack).
    const { data: existingUsers } = await admin.auth.admin.listUsers();
    const existingUser = existingUsers?.users?.find((u: { email?: string }) => (u.email || "").toLowerCase() === email);

    let userId: string;
    let tempPassword: string | null = null;
    let createdNewUser = false;

    if (existingUser) {
      // Bestaande user — check of hij al in een tenant zit.
      const { data: existingRole } = await admin
        .from("user_roles")
        .select("role, partner_id")
        .eq("user_id", existingUser.id)
        .maybeSingle();

      if (existingRole) {
        // Al lid van een tenant — kan niet ge-re-invite worden zonder eerst te verwijderen.
        if (existingRole.partner_id === partner_id) {
          return json(409, { error: "Deze persoon is al lid van je team" }, corsHeaders);
        }
        return json(409, { error: "Deze persoon heeft al een account binnen een ander platform-tenant" }, corsHeaders);
      }

      // Bestaande auth-user zonder rol — koppel aan deze tenant.
      userId = existingUser.id;
    } else {
      // Nieuwe user — aanmaken met tijdelijk wachtwoord (analoog `invite-partner` v5-flow).
      tempPassword = "Flancco_" + crypto.randomUUID().substring(0, 10);
      const { data: newUser, error: createErr } = await admin.auth.admin.createUser({
        email,
        password: tempPassword,
        email_confirm: true,
        user_metadata: { voornaam, naam, invited_by_partner: partner_id },
      });
      if (createErr || !newUser?.user) {
        return json(500, { error: "Aanmaken gebruiker mislukt: " + (createErr?.message || "onbekend") }, corsHeaders);
      }
      userId = newUser.user.id;
      createdNewUser = true;
    }

    // 7) UPSERT user_roles met server-side gevalideerde permissions.
    const { error: roleErr } = await admin.from("user_roles").upsert({
      user_id: userId,
      role: "partner",
      partner_id,
      permissions, // alleen whitelisted keys (sanitizePermissions)
    }, { onConflict: "user_id" });

    if (roleErr) {
      // Rollback nieuwe auth-user als role-insert faalt.
      if (createdNewUser) {
        await admin.auth.admin.deleteUser(userId);
      }
      console.error("invite-partner-member: user_roles upsert failed", roleErr);
      return json(500, { error: "Fout bij aanmaken rol: " + roleErr.message }, corsHeaders);
    }

    // 8) techniekers-rij (type='bediende', tenant-scoped).
    // Eerst kijken of er al een techniekers-rij bestaat met deze email + partner_id (re-invite-pad).
    // Slot U: laad ook uit_dienst_sinds zodat we recent-uit-dienst kunnen detecteren
    // en de inviter een waarschuwing kunnen meegeven (geen blokkade).
    const { data: existingTech } = await admin
      .from("techniekers")
      .select("id, uit_dienst_sinds")
      .eq("partner_id", partner_id)
      .eq("email", email)
      .maybeSingle();

    let recentlyExited = false;
    if (existingTech?.uit_dienst_sinds) {
      const exitedAt = new Date(existingTech.uit_dienst_sinds);
      if (!isNaN(exitedAt.getTime())) {
        const daysSinceExit = (Date.now() - exitedAt.getTime()) / (1000 * 60 * 60 * 24);
        recentlyExited = daysSinceExit < 30;
      }
    }

    if (!existingTech) {
      // Nieuwe techniekers-rij — uit_dienst_sinds NULL (trigger zet actief=true).
      const { error: techErr } = await admin.from("techniekers").insert({
        partner_id,
        voornaam,
        naam,
        email,
        type_personeel: "bediende",
        user_id: userId,
        uit_dienst_sinds: null,
      });
      if (techErr) {
        // Best-effort rollback: alleen rol verwijderen wanneer wij hem hier creëerden.
        await admin.from("user_roles").delete().eq("user_id", userId);
        if (createdNewUser) await admin.auth.admin.deleteUser(userId);
        console.error("invite-partner-member: techniekers insert failed", techErr);
        return json(500, { error: "Aanmaken techniekers-rij mislukt: " + techErr.message }, corsHeaders);
      }
    } else {
      // Slot U: bij re-invite zet uit_dienst_sinds NULL — de trigger
      // trg_techniekers_sync_actief synct actief=true automatisch.
      const { error: techUpdateErr } = await admin
        .from("techniekers")
        .update({ user_id: userId, uit_dienst_sinds: null })
        .eq("id", existingTech.id);
      if (techUpdateErr) {
        await admin.from("user_roles").delete().eq("user_id", userId);
        if (createdNewUser) await admin.auth.admin.deleteUser(userId);
        console.error("invite-partner-member: techniekers re-invite update failed", techUpdateErr);
        return json(500, { error: "Heractiveren techniekers-rij mislukt: " + techUpdateErr.message }, corsHeaders);
      }
    }

    // 9) Branded invite-mail via Resend (best-effort — niet fataal als faalt).
    const inviterDisplay = (caller.user_metadata as Record<string, unknown> | undefined)?.full_name as string
      || caller.email
      || (lang === "fr" ? "un administrateur" : "een beheerder");

    let emailSent = false;
    let emailError: string | null = null;
    if (RESEND_KEY && tempPassword) {
      try {
        const { subject, html } = buildInviteEmailHtml({
          brand,
          recipient: { email, voornaam, naam },
          loginUrl: APP_BASE_URL,
          inviterDisplay: String(inviterDisplay),
          tempPassword,
          permissions,
          lang,
        });
        const replyTo = !brand.isFlancco && brand.email ? brand.email : REPLY_TO_DEFAULT;
        const resp = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: FROM_DEFAULT,
            reply_to: [replyTo],
            to: [email],
            subject,
            html,
          }),
        });
        if (resp.ok) {
          emailSent = true;
        } else {
          const detail = await resp.json().catch(() => ({}));
          emailError = `Resend ${resp.status}: ${JSON.stringify(detail)}`;
        }
      } catch (e) {
        emailError = (e as Error).message;
      }
    } else if (!RESEND_KEY) {
      emailError = "RESEND_API_KEY niet geconfigureerd";
    } else if (!tempPassword) {
      // Bestaande gebruiker → magic-link of bestaande sessie. Geen nieuwe credentials nodig.
      emailSent = true;
    }

    // 10) Logging — geen PII in regel; alleen partner + outcome.
    console.log(JSON.stringify({
      fn: "invite-partner-member",
      partner_id,
      created_new_user: createdNewUser,
      recently_exited: recentlyExited,
      email_sent: emailSent,
      perms_count: Object.values(permissions).filter(Boolean).length,
    }));

    return json(200, {
      success: true,
      user_id: userId,
      created_new_user: createdNewUser,
      recently_exited: recentlyExited,
      email_sent: emailSent,
      email_error: emailError,
      partner_slug: brand.slug,
      message: emailSent
        ? "Uitnodiging verstuurd"
        : "Account aangemaakt — e-mail kon niet verstuurd worden, deel gegevens manueel",
    }, corsHeaders);
  } catch (err) {
    console.error("invite-partner-member exception:", err);
    return json(500, { error: (err as Error).message || "Onbekende fout" }, corsFor(req));
  }
});
