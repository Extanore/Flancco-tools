// send-klant-notification-email — Slot F klant-facing email reminders
// ============================================================
// SCOPE (separate from existing `send-notification-email` v5):
//   Dit endpoint stuurt EMAILS NAAR DE EINDKLANT (reminder_24h, reminder_day,
//   rapport_klaar). De bestaande `send-notification-email` is volledig
//   intern (admin/partner alerts) — twee compleet aparte systemen, geen
//   gedeelde code, geen overlap.
//
// AUTH (verify_jwt=false in Supabase, custom in handler):
//   Caller MOET een van twee presenteren:
//     a) Service-role bearer (dispatcher / pg_cron)  → exact-match check
//     b) Geldige user-JWT met role='admin' OF (role='partner' + manage_users)
//   Anders 401.
//
// IDEMPOTENTIE:
//   Per (beurt_id, event_type) bestaat één timestamp-veld op onderhoudsbeurten.
//   Eens ingevuld → return 200 {skipped:'already_sent'} tenzij `force=true`.
//   Race-safe: als twee tegelijkertijd binnenkomen, wint de DB-update; tweede
//   merkt dit bij volgende dispatcher-run.
//
// CONSENT (Slot Q):
//   Lookup `v_klant_consent_actief` voor (klant_email, kanaal='email_service').
//   Als bereikbaar !== true → log 'skipped_no_consent' en return 200 zonder send.
//
// GDPR-FOOTER:
//   Elke mail heeft een opt-out link via klant_consents.opt_out_token.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

// ─── Config ──────────────────────────────────────────────────────────────────

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const FROM_ADDRESS = Deno.env.get("EMAIL_FROM_ADDRESS")
  || "Flancco Platform <noreply@flancco-platform.be>";
const REPLY_TO_DEFAULT = Deno.env.get("EMAIL_REPLY_TO")
  || "gillian.geernaert@flancco.be";

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS")
  || "https://app.flancco-platform.be,https://flancco-platform.be,https://www.flancco-platform.be"
).split(",").map((s) => s.trim()).filter(Boolean);

const OPT_OUT_BASE_URL = Deno.env.get("OPT_OUT_BASE_URL")
  || "https://flancco-platform.be/opt-out/";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FN_NAME = "send-klant-notification-email";

// ─── Types ───────────────────────────────────────────────────────────────────

type Lang = "nl" | "fr";
type EventType = "reminder_24h" | "reminder_day" | "rapport_klaar" | "test";

interface Payload {
  beurt_id?: string;
  contract_id?: string;
  event_type: EventType;
  force?: boolean;
  override_email?: string;
  rapport_url?: string;
}

interface PartnerBranding {
  id: string | null;
  slug: string;
  name: string;
  primaryColor: string;
  secondaryColor: string;
  logoUrl: string;
  email: string;
  telefoon: string;
  website: string;
  isFlancco: boolean;
}

interface BeurtRow {
  id: string;
  contract_id: string | null;
  plan_datum: string | null;
  start_tijd: string | null;
  hele_dag: boolean | null;
  status: string | null;
  technieker_id: string | null;
  reminder_24h_email_ts: string | null;
  reminder_day_email_ts: string | null;
  rapport_klaar_email_ts: string | null;
}

interface ContractRow {
  id: string;
  partner_id: string | null;
  klant_naam: string | null;
  klant_email: string | null;
  klant_postcode: string | null;
  klant_gemeente: string | null;
  klant_adres: string | null;
  lang: string | null;
  // Slot T — bedrijf-only-detectie + lookup-keys
  client_id: string | null;
  client_contact_id: string | null;
}

// Slot T — recipient + greeting resolution voor klant-notificaties
interface RecipientResolution {
  email: string;
  greetingName: string;
  isCompanyOnly: boolean;
}

interface PartnerRow {
  id: string;
  slug: string;
  naam: string | null;
  bedrijfsnaam: string | null;
  kleur_primair: string | null;
  kleur_donker: string | null;
  logo_url: string | null;
  email: string | null;
  telefoon: string | null;
  website: string | null;
}

interface TechniekerRow {
  id: string;
  naam: string | null;
  voornaam: string | null;
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function corsFor(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
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

function escUrl(s: string | null | undefined): string {
  const v = String(s ?? "").trim();
  if (!v) return "";
  if (/^(https?:|mailto:)/i.test(v)) {
    return v.replace(/"/g, "%22").replace(/</g, "%3C").replace(/>/g, "%3E");
  }
  return "";
}

function sanitizeHex(value: string | null | undefined, fallback: string): string {
  const v = String(value ?? "").trim();
  if (/^#?[0-9a-fA-F]{6}$/.test(v) || /^#?[0-9a-fA-F]{3}$/.test(v)) {
    return v.startsWith("#") ? v : `#${v}`;
  }
  return fallback;
}

function logJson(meta: Record<string, unknown>): void {
  try { console.log(JSON.stringify({ fn: FN_NAME, ts: new Date().toISOString(), ...meta })); }
  catch { console.log(`${FN_NAME} log-failed`); }
}

// ─── Auth ────────────────────────────────────────────────────────────────────

interface AuthResult { ok: true; mode: "service_role" | "user"; user_id?: string }
interface AuthFail { ok: false; status: number; error: string }

async function authenticate(req: Request, admin: SupabaseClient): Promise<AuthResult | AuthFail> {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return { ok: false, status: 401, error: "missing_authorization" };

  // Service-role exact match (constant-time comparison via length-first)
  if (SUPABASE_SERVICE_ROLE_KEY && token.length === SUPABASE_SERVICE_ROLE_KEY.length) {
    let diff = 0;
    for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ SUPABASE_SERVICE_ROLE_KEY.charCodeAt(i);
    if (diff === 0) return { ok: true, mode: "service_role" };
  }

  // User-JWT path
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) return { ok: false, status: 401, error: "invalid_token" };

  const { data: roleRow } = await admin
    .from("user_roles")
    .select("role, partner_id, permissions")
    .eq("user_id", userData.user.id)
    .maybeSingle();

  if (!roleRow) return { ok: false, status: 403, error: "no_role" };

  const isAdmin = roleRow.role === "admin";
  const isPartnerOwner = roleRow.role === "partner"
    && roleRow.permissions
    && (roleRow.permissions as Record<string, unknown>).manage_users === true;

  if (!isAdmin && !isPartnerOwner) {
    return { ok: false, status: 403, error: "insufficient_role" };
  }
  return { ok: true, mode: "user", user_id: userData.user.id };
}

// ─── Handler ────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const corsHeaders = corsFor(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" }, corsHeaders);

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    logJson({ event: "config_missing", reason: "supabase_env" });
    return json(500, { error: "server_misconfigured" }, corsHeaders);
  }
  if (!RESEND_API_KEY) {
    logJson({ event: "config_missing", reason: "resend_api_key" });
    return json(503, { error: "resend_not_configured" }, corsHeaders);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // 1) AUTH FIRST (before body parsing) — info-disclosure prevention
  const auth = await authenticate(req, admin);
  if (!auth.ok) {
    logJson({ event: "auth_failed", status: auth.status, reason: auth.error });
    return json(auth.status, { error: auth.error }, corsHeaders);
  }

  // 2) Parse body
  let body: Payload;
  try { body = await req.json() as Payload; }
  catch { return json(400, { error: "invalid_json" }, corsHeaders); }

  const event_type = body.event_type;
  if (!["reminder_24h", "reminder_day", "rapport_klaar", "test"].includes(event_type)) {
    return json(400, { error: "invalid_event_type" }, corsHeaders);
  }
  const force = body.force === true;
  const beurt_id = body.beurt_id ? String(body.beurt_id).trim() : "";
  const contract_id = body.contract_id ? String(body.contract_id).trim() : "";
  const override_email = body.override_email ? String(body.override_email).trim().toLowerCase() : "";
  const rapport_url = body.rapport_url ? String(body.rapport_url).trim() : "";

  if (beurt_id && !UUID_RE.test(beurt_id)) return json(400, { error: "invalid_beurt_id" }, corsHeaders);
  if (contract_id && !UUID_RE.test(contract_id)) return json(400, { error: "invalid_contract_id" }, corsHeaders);
  if (!beurt_id && !contract_id && event_type !== "test") {
    return json(400, { error: "beurt_id_or_contract_id_required" }, corsHeaders);
  }
  if (override_email && !EMAIL_RE.test(override_email)) {
    return json(400, { error: "invalid_override_email" }, corsHeaders);
  }
  if (override_email && auth.mode !== "service_role" && auth.mode !== "user") {
    return json(403, { error: "override_email_admin_only" }, corsHeaders);
  }

  try {
    // 3) Resolve beurt + contract + partner + technieker
    let beurt: BeurtRow | null = null;
    let contract: ContractRow | null = null;

    if (beurt_id) {
      const { data: br, error: be } = await admin
        .from("onderhoudsbeurten")
        .select(`id, contract_id, plan_datum, start_tijd, hele_dag, status, technieker_id,
                 reminder_24h_email_ts, reminder_day_email_ts, rapport_klaar_email_ts`)
        .eq("id", beurt_id)
        .maybeSingle<BeurtRow>();
      if (be) { logJson({ event: "beurt_lookup_error", err: be.message }); return json(500, { error: "beurt_lookup_failed" }, corsHeaders); }
      if (!br) return json(404, { error: "beurt_not_found" }, corsHeaders);
      beurt = br;

      if (br.contract_id) {
        const { data: cr } = await admin
          .from("contracten")
          .select(`id, partner_id, klant_naam, klant_email, klant_postcode, klant_gemeente, klant_adres, lang, client_id, client_contact_id`)
          .eq("id", br.contract_id)
          .maybeSingle<ContractRow>();
        contract = cr;
      }
    } else if (contract_id) {
      const { data: cr } = await admin
        .from("contracten")
        .select(`id, partner_id, klant_naam, klant_email, klant_postcode, klant_gemeente, klant_adres, lang, client_id, client_contact_id`)
        .eq("id", contract_id)
        .maybeSingle<ContractRow>();
      contract = cr;
    }

    if (event_type !== "test" && !contract) {
      return json(404, { error: "contract_not_found" }, corsHeaders);
    }

    // Partner branding
    let partner: PartnerRow | null = null;
    if (contract?.partner_id) {
      const { data: pr } = await admin
        .from("partners")
        .select(`id, slug, naam, bedrijfsnaam, kleur_primair, kleur_donker, logo_url, email, telefoon, website`)
        .eq("id", contract.partner_id)
        .maybeSingle<PartnerRow>();
      partner = pr;
    }

    // Technieker (optional, only relevant for reminder_day)
    let technieker: TechniekerRow | null = null;
    if (beurt?.technieker_id) {
      const { data: tr } = await admin
        .from("techniekers")
        .select("id, naam, voornaam")
        .eq("id", beurt.technieker_id)
        .maybeSingle<TechniekerRow>();
      technieker = tr;
    }

    // 4) Resolve recipient (Slot T: bedrijf-only support via client_contact_id)
    const resolved = override_email
      ? {
          email: override_email,
          greetingName: contract?.klant_naam || (lang_default(contract) === "fr" ? "Cher client" : "Beste klant"),
          isCompanyOnly: false,
        } as RecipientResolution
      : await resolveRecipient(admin, contract);

    const recipient = resolved.email;
    if (!recipient || !EMAIL_RE.test(recipient)) {
      await insertLog(admin, {
        beurt_id: beurt?.id ?? null,
        contract_id: contract?.id ?? null,
        partner_id: contract?.partner_id ?? null,
        kanaal: "email", event_type, recipient: recipient || "(geen)",
        status: "skipped_missing_contact",
        error_detail: "klant_email niet beschikbaar",
      });
      return json(200, { ok: true, skipped: "missing_contact" }, corsHeaders);
    }

    // 5) Idempotency-check (test = altijd door)
    if (event_type !== "test" && beurt && !force) {
      const tsField = `${event_type}_email_ts` as keyof BeurtRow;
      if (beurt[tsField]) {
        await insertLog(admin, {
          beurt_id: beurt.id, contract_id: contract?.id ?? null, partner_id: contract?.partner_id ?? null,
          kanaal: "email", event_type, recipient,
          status: "skipped_already_sent",
        });
        return json(200, { ok: true, skipped: "already_sent" }, corsHeaders);
      }
    }

    // 6) Consent-check (test = altijd door, geen registratie nodig)
    if (event_type !== "test") {
      const { data: cons } = await admin
        .from("v_klant_consent_actief")
        .select("bereikbaar")
        .eq("klant_email", recipient.toLowerCase())
        .eq("kanaal", "email_service")
        .maybeSingle();
      // Default-on voor service-mails (art. 6.1.b WER): als geen rij of opt_in=false maar bereikbaar=true → ok
      // Maar als bereikbaar expliciet false (opt_out_ts gezet) → skip.
      if (cons && cons.bereikbaar === false) {
        await insertLog(admin, {
          beurt_id: beurt?.id ?? null, contract_id: contract?.id ?? null, partner_id: contract?.partner_id ?? null,
          kanaal: "email", event_type, recipient,
          status: "skipped_no_consent",
        });
        return json(200, { ok: true, skipped: "no_consent" }, corsHeaders);
      }
    }

    // 7) Build email
    const branding = resolveBranding(partner);
    const lang: Lang = (contract?.lang === "fr") ? "fr" : "nl";

    const optOutToken = (event_type !== "test" && contract?.id)
      ? await fetchOptOutToken(admin, contract.id, recipient)
      : null;
    const optOutUrl = optOutToken
      ? `${OPT_OUT_BASE_URL}?token=${encodeURIComponent(optOutToken)}&lang=${lang}`
      : null;

    // Voor rapport_klaar: regenereer PDF on-demand uit DB-data wanneer caller
    // geen explicit rapport_url meegaf. Voorkomt dat leeg-opgeslagen PDFs uit
    // pre-PR#107 nog naar de klant gestuurd worden (zie PR #111 voor admin UI).
    let effectiveRapportUrl = rapport_url;
    if (event_type === "rapport_klaar" && !effectiveRapportUrl && beurt?.id) {
      const regen = await regenerateRapportPdfUrl(admin, beurt.id, branding.slug, lang);
      if (regen) {
        effectiveRapportUrl = regen.url;
        logJson({ event: "rapport_pdf_regenerated", beurt_id: beurt.id, rapport_id: regen.rapportId });
      } else {
        // Fallback: rapport.pdf_url uit DB (kan stale zijn maar beter dan niets).
        // Generate-pdf-failure-modi: missing secrets, expired session, network.
        const { data: rRow } = await admin
          .from("rapporten")
          .select("pdf_url")
          .eq("onderhoudsbeurt_id", beurt.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle<{ pdf_url: string | null }>();
        if (rRow?.pdf_url) {
          effectiveRapportUrl = rRow.pdf_url;
          logJson({ event: "rapport_pdf_regen_fallback_stale", beurt_id: beurt.id });
        }
      }
    }

    const ctx: TemplateCtx = {
      branding, lang,
      klantNaam: resolved.greetingName,
      isCompanyOnly: resolved.isCompanyOnly,
      planDatum: beurt?.plan_datum ?? null,
      startTijd: beurt?.start_tijd ?? null,
      heleDag: beurt?.hele_dag === true,
      technieker: technieker ? `${technieker.voornaam ?? ""} ${technieker.naam ?? ""}`.trim() : "",
      rapportUrl: effectiveRapportUrl || "",
    };

    const tpl = buildTemplate(event_type, ctx);
    const optOutFooter = optOutUrl ? renderOptOutFooter(lang, optOutUrl) : "";
    const html = renderShell({ branding, lang, headerTitle: tpl.subject, bodyHtml: tpl.bodyHtml, optOutFooterHtml: optOutFooter });

    const replyTo = (!branding.isFlancco && branding.email) ? branding.email : REPLY_TO_DEFAULT;

    // 8) Send via Resend
    const sendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        reply_to: [replyTo],
        to: [recipient],
        subject: tpl.subject,
        html,
      }),
    });

    const sendResult = await sendRes.json().catch(() => ({} as Record<string, unknown>));
    if (!sendRes.ok) {
      const errMsg = (sendResult as { message?: string })?.message || `resend_status_${sendRes.status}`;
      logJson({ event: "send_failed", provider: "resend", status: sendRes.status });
      await insertLog(admin, {
        beurt_id: beurt?.id ?? null, contract_id: contract?.id ?? null, partner_id: contract?.partner_id ?? null,
        kanaal: "email", event_type, recipient,
        status: "failed",
        error_detail: errMsg.slice(0, 500),
      });
      return json(500, { error: "send_failed", detail: errMsg }, corsHeaders);
    }

    const providerMessageId = (sendResult as { id?: string })?.id || null;

    // 9) Write back timestamp (skip for test)
    if (event_type !== "test" && beurt) {
      const tsField = `${event_type}_email_ts`;
      const { error: upErr } = await admin
        .from("onderhoudsbeurten")
        .update({ [tsField]: new Date().toISOString() })
        .eq("id", beurt.id);
      if (upErr) logJson({ event: "ts_update_failed", err: upErr.message });
    }

    await insertLog(admin, {
      beurt_id: beurt?.id ?? null, contract_id: contract?.id ?? null, partner_id: contract?.partner_id ?? null,
      kanaal: "email", event_type, recipient,
      status: "sent",
      provider_message_id: providerMessageId,
    });

    logJson({ event: "sent", event_type, kanaal: "email", partner_slug: branding.slug });
    return json(200, { ok: true, provider_message_id: providerMessageId, lang, partner_slug: branding.slug }, corsHeaders);

  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    logJson({ event: "exception", err: msg });
    return json(500, { error: "internal_error" }, corsHeaders);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

interface LogEntry {
  beurt_id: string | null;
  contract_id: string | null;
  partner_id: string | null;
  kanaal: "email" | "sms" | "whatsapp";
  event_type: EventType;
  recipient: string;
  status: "sent" | "failed" | "skipped_no_consent" | "skipped_already_sent" | "skipped_missing_contact" | "skipped_daily_cap";
  provider_message_id?: string | null;
  error_detail?: string | null;
}

async function insertLog(admin: SupabaseClient, entry: LogEntry): Promise<void> {
  try {
    await admin.from("klant_notification_log").insert(entry);
  } catch (e) {
    logJson({ event: "log_insert_failed", err: e instanceof Error ? e.message : "unknown" });
  }
}

async function fetchOptOutToken(admin: SupabaseClient, contractId: string, klantEmail: string): Promise<string | null> {
  try {
    const { data } = await admin
      .from("klant_consents")
      .select("opt_out_token, opt_out_ts")
      .eq("contract_id", contractId)
      .eq("klant_email", klantEmail.toLowerCase())
      .eq("kanaal", "email_service")
      .order("aangemaakt_op", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data?.opt_out_token || data.opt_out_ts) return null;
    return data.opt_out_token as string;
  } catch (e) {
    logJson({ event: "opt_out_token_lookup_failed", err: e instanceof Error ? e.message : "unknown" });
    return null;
  }
}

// ─── Rapport PDF regeneration ────────────────────────────────────────────────
// Bij `event_type='rapport_klaar'` zonder explicit `rapport_url`: regenereer via
// generate-pdf edge function uit DB-data en update `rapporten.pdf_url`. Voorkomt
// dat leeg-opgeslagen PDFs naar de klant gestuurd worden (zie PR #107, #111).

interface RapportRow {
  id: string;
  contract_id: string | null;
  onderhoudsbeurt_id: string | null;
  referentie: string | null;
  sector: string | null;
  datum_onderhoud: string | null;
  checklist_data: Record<string, unknown> | null;
  materiaal_data: unknown[] | null;
  foto_urls: unknown;
  opmerkingen: string | null;
  pdf_url: string | null;
}

interface ContractFullRow {
  id: string;
  partner_id: string | null;
  contract_nummer: string | null;
  klant_naam: string | null;
  klant_adres: string | null;
  klant_postcode: string | null;
  klant_gemeente: string | null;
  klant_email: string | null;
  klant_telefoon: string | null;
  aantal_panelen: number | null;
  frequentie: string | null;
  contractduur: number | null;
  sector: string | null;
  lang: string | null;
}

function _isFotoUrlsObject(v: unknown): v is Record<string, unknown[]> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function _flattenFotoUrls(v: unknown): string[] {
  if (Array.isArray(v)) return (v as unknown[]).filter((u) => typeof u === "string") as string[];
  if (_isFotoUrlsObject(v)) {
    const out: string[] = [];
    for (const k of Object.keys(v)) {
      const arr = (v as Record<string, unknown>)[k];
      if (Array.isArray(arr)) {
        for (const u of arr) if (typeof u === "string" && u) out.push(u);
      }
    }
    return out;
  }
  return [];
}

function buildRapportPayload(
  rapport: RapportRow,
  beurt: BeurtRow | null,
  contract: ContractFullRow | null,
): Record<string, unknown> {
  const checkData = (rapport.checklist_data || {}) as Record<string, { status?: string; label?: string; note?: string }>;
  const sector = rapport.sector || null;

  const bevindingenLines: string[] = [];
  for (const key of Object.keys(checkData)) {
    if (key === "_meta") continue;
    const v = checkData[key];
    if (!v || v.status !== "nok") continue;
    const label = v.label || key;
    let line = "• " + label;
    if (v.note) line += ": " + v.note;
    bevindingenLines.push(line);
  }
  const meta = (checkData as Record<string, unknown>)._meta as Record<string, unknown> | undefined;
  const icZones = meta && Array.isArray(meta.ic_zones) ? meta.ic_zones as Array<{ zone_naam?: string; opmerkingen?: string }> : null;
  if (icZones && icZones.length) {
    bevindingenLines.push("Behandelde zones: " + icZones.length);
    icZones.forEach((z, i) => {
      const lbl = (z.zone_naam || ("Zone " + (i + 1))) + (z.opmerkingen ? " — " + z.opmerkingen : "");
      bevindingenLines.push("  · " + lbl);
    });
  }
  const klussen = meta && typeof meta.klussen === "object" ? meta.klussen as { omschrijving?: string; meerwerk?: string } : null;
  if (klussen) {
    if (klussen.omschrijving) bevindingenLines.push(klussen.omschrijving);
    if (klussen.meerwerk) bevindingenLines.push("Meerwerk: " + klussen.meerwerk);
  }
  if (rapport.opmerkingen) bevindingenLines.push(rapport.opmerkingen);

  const materiaalLines: string[] = [];
  const mat = Array.isArray(rapport.materiaal_data) ? rapport.materiaal_data : [];
  for (const m of mat) {
    if (!m || typeof m !== "object") continue;
    const row = m as { naam?: string; aantal?: number };
    if (!row.naam) continue;
    materiaalLines.push("• " + row.naam + (row.aantal && row.aantal !== 1 ? " (" + row.aantal + "x)" : ""));
  }

  const fotoUrls = _flattenFotoUrls(rapport.foto_urls).slice(0, 6);

  const sig = (meta && typeof meta.handtekening === "object") ? meta.handtekening as { image?: string; naam?: string } : null;
  const sigImage = sig?.image || null;
  const sigNaam = sig?.naam || null;
  const sigDatum = sigImage ? (rapport.datum_onderhoud || beurt?.plan_datum || null) : null;

  return {
    beurt_id: beurt?.id || rapport.onderhoudsbeurt_id || null,
    contract_id: contract?.id || rapport.contract_id || null,
    contract_nummer: contract?.contract_nummer || rapport.referentie || null,
    klant_naam: contract?.klant_naam || null,
    klant_adres: contract?.klant_adres || null,
    klant_postcode: contract?.klant_postcode || null,
    klant_gemeente: contract?.klant_gemeente || null,
    klant_email: contract?.klant_email || null,
    klant_telefoon: contract?.klant_telefoon || null,
    datum: rapport.datum_onderhoud || beurt?.plan_datum || new Date().toISOString().split("T")[0],
    aantal_panelen: contract?.aantal_panelen || null,
    frequentie: contract?.frequentie || null,
    contractduur: contract?.contractduur || null,
    sector,
    bevindingen: bevindingenLines.length ? bevindingenLines.join("\n") : null,
    aanbevelingen: null,
    materiaal: materiaalLines.length ? materiaalLines.join("\n") : null,
    fotos: fotoUrls,
    handtekening_url: sigImage,
    handtekening_naam: sigNaam,
    handtekening_datum: sigDatum,
  };
}

/**
 * Roept generate-pdf edge function aan met service-role bearer en regenereert
 * de PDF uit DB-data. Updatet `rapporten.pdf_url` bij succes. Returnt de verse
 * signed URL, of null bij elke faal-modus. Time-out 25s.
 */
async function regenerateRapportPdfUrl(
  admin: SupabaseClient,
  beurtId: string,
  partnerSlug: string,
  lang: Lang,
): Promise<{ url: string; rapportId: string } | null> {
  try {
    // 1) Rapport ophalen (latest by created_at als er meerdere zijn)
    const { data: rRows, error: rErr } = await admin
      .from("rapporten")
      .select(`id, contract_id, onderhoudsbeurt_id, referentie, sector, datum_onderhoud,
               checklist_data, materiaal_data, foto_urls, opmerkingen, pdf_url`)
      .eq("onderhoudsbeurt_id", beurtId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (rErr || !rRows || rRows.length === 0) {
      logJson({ event: "rapport_regen_no_record", beurt_id: beurtId, err: rErr?.message });
      return null;
    }
    const rapport = rRows[0] as RapportRow;

    // 2) Beurt + contract context
    const { data: beurtData } = await admin
      .from("onderhoudsbeurten")
      .select(`id, contract_id, plan_datum, start_tijd, hele_dag, status, technieker_id,
               reminder_24h_email_ts, reminder_day_email_ts, rapport_klaar_email_ts`)
      .eq("id", beurtId)
      .maybeSingle<BeurtRow>();
    const beurt = beurtData;

    let contract: ContractFullRow | null = null;
    if (rapport.contract_id || beurt?.contract_id) {
      const { data: cr } = await admin
        .from("contracten")
        .select(`id, partner_id, contract_nummer, klant_naam, klant_adres, klant_postcode,
                 klant_gemeente, klant_email, klant_telefoon, aantal_panelen,
                 frequentie, contractduur, sector, lang`)
        .eq("id", rapport.contract_id || beurt?.contract_id)
        .maybeSingle<ContractFullRow>();
      contract = cr;
    }

    const payload = buildRapportPayload(rapport, beurt, contract);

    // 3) generate-pdf edge function aanroepen (service-role bearer)
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, 25_000);
    let resp: Response;
    try {
      resp = await fetch(`${SUPABASE_URL}/functions/v1/generate-pdf`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({
          template: "rapport_branded",
          partner_slug: partnerSlug,
          lang,
          data: payload,
        }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      logJson({ event: "rapport_regen_http_fail", status: resp.status, detail: errText.slice(0, 300) });
      return null;
    }
    const j = await resp.json().catch(() => null) as { url?: string; signedUrl?: string } | null;
    const url = j?.url || j?.signedUrl;
    if (!url) {
      logJson({ event: "rapport_regen_no_url", body: JSON.stringify(j).slice(0, 200) });
      return null;
    }

    // 4) Best-effort patch op rapporten.pdf_url
    try {
      await admin.from("rapporten").update({ pdf_url: url }).eq("id", rapport.id);
    } catch (e) {
      logJson({ event: "rapport_pdf_url_patch_failed", err: e instanceof Error ? e.message : "unknown" });
    }

    return { url, rapportId: rapport.id };
  } catch (err) {
    logJson({ event: "rapport_regen_exception", err: err instanceof Error ? err.message : "unknown" });
    return null;
  }
}

const FLANCCO_BRANDING: PartnerBranding = {
  id: null, slug: "flancco", name: "Flancco BV",
  primaryColor: "#1A1A2E", secondaryColor: "#E74C3C", logoUrl: "",
  email: "info@flancco.be", telefoon: "", website: "https://flancco-platform.be",
  isFlancco: true,
};

function resolveBranding(p: PartnerRow | null): PartnerBranding {
  if (!p) return FLANCCO_BRANDING;
  const isFlancco = (p.slug || "").toLowerCase() === "flancco" || /flancco/i.test(p.bedrijfsnaam || p.naam || "");
  if (isFlancco) {
    return {
      ...FLANCCO_BRANDING,
      id: p.id,
      slug: p.slug || "flancco",
      name: p.bedrijfsnaam || p.naam || "Flancco BV",
      logoUrl: p.logo_url || "",
      email: p.email || FLANCCO_BRANDING.email,
      telefoon: p.telefoon || "",
      website: p.website || FLANCCO_BRANDING.website,
    };
  }
  return {
    id: p.id,
    slug: p.slug,
    name: p.bedrijfsnaam || p.naam || "Partner",
    primaryColor: sanitizeHex(p.kleur_primair, FLANCCO_BRANDING.primaryColor),
    secondaryColor: sanitizeHex(p.kleur_donker, FLANCCO_BRANDING.secondaryColor),
    logoUrl: p.logo_url || "",
    email: p.email || "",
    telefoon: p.telefoon || "",
    website: p.website || "",
    isFlancco: false,
  };
}

// ─── Templates ───────────────────────────────────────────────────────────────

interface TemplateCtx {
  branding: PartnerBranding;
  lang: Lang;
  klantNaam: string;
  /** Slot T: true → bedrijf-only contract, gebruikt bedrijfs-aanhef. */
  isCompanyOnly: boolean;
  planDatum: string | null;   // "YYYY-MM-DD"
  startTijd: string | null;   // "HH:MM:SS"
  heleDag: boolean;
  technieker: string;
  rapportUrl: string;
}

interface BuiltTemplate { subject: string; bodyHtml: string }

/**
 * Slot T — adapt aanhef voor bedrijf-only-contracten.
 * Persoon: "Beste {naam}," / "Bonjour {naam},"
 * Bedrijf: "Beste collega's van {bedrijf}," / "Chers collègues de {bedrijf},"
 */
function buildAanhef(c: TemplateCtx): string {
  const isFr = c.lang === "fr";
  if (c.isCompanyOnly) {
    return isFr
      ? `Chers collègues de ${c.klantNaam},`
      : `Beste collega's van ${c.klantNaam},`;
  }
  return isFr ? `Bonjour ${c.klantNaam},` : `Beste ${c.klantNaam},`;
}

function lang_default(contract: ContractRow | null): Lang {
  return contract?.lang === "fr" ? "fr" : "nl";
}

/**
 * Slot T — resolve recipient + greeting name voor klant-notificatie email.
 * Wanneer client_contact_id koppelt naar een specifieke persoon: gebruik
 * client_contacts.email + first_name.
 * Wanneer NULL en client_id bestaat: bedrijf-only mode → clients.email +
 * company_name.
 * Fallback: contracten.klant_email + klant_naam (legacy).
 */
async function resolveRecipient(
  admin: SupabaseClient,
  contract: ContractRow | null,
): Promise<RecipientResolution> {
  const lang = lang_default(contract);
  const fallbackName = lang === "fr" ? "Cher client" : "Beste klant";

  if (!contract) {
    return { email: "", greetingName: fallbackName, isCompanyOnly: false };
  }

  // Path 1 — specifieke contactpersoon
  if (contract.client_contact_id) {
    const { data: cc } = await admin
      .from("client_contacts")
      .select("first_name, email")
      .eq("id", contract.client_contact_id)
      .maybeSingle();
    return {
      email: String(cc?.email || contract.klant_email || "").trim(),
      greetingName: String(cc?.first_name || contract.klant_naam || fallbackName).trim(),
      isCompanyOnly: false,
    };
  }

  // Path 2 — bedrijf-only
  if (contract.client_id) {
    const { data: client } = await admin
      .from("clients")
      .select("company_name, email")
      .eq("id", contract.client_id)
      .maybeSingle();
    const company = String(client?.company_name || "").trim();
    if (company) {
      return {
        email: String(client?.email || contract.klant_email || "").trim(),
        greetingName: company,
        isCompanyOnly: true,
      };
    }
  }

  // Path 3 — legacy
  return {
    email: String(contract.klant_email || "").trim(),
    greetingName: String(contract.klant_naam || fallbackName).trim(),
    isCompanyOnly: false,
  };
}

function fmtDate(iso: string | null, lang: Lang): string {
  if (!iso) return "";
  try {
    return new Date(`${iso}T00:00:00`).toLocaleDateString(
      lang === "fr" ? "fr-BE" : "nl-BE",
      { weekday: "long", day: "numeric", month: "long", year: "numeric" },
    );
  } catch { return iso; }
}

function fmtTime(t: string | null): string {
  if (!t) return "";
  return t.slice(0, 5); // "HH:MM"
}

function buildTemplate(event: EventType, c: TemplateCtx): BuiltTemplate {
  const isFr = c.lang === "fr";
  const datum = fmtDate(c.planDatum, c.lang);
  const tijd = c.heleDag ? (isFr ? "toute la journée" : "de hele dag") : (fmtTime(c.startTijd) || (isFr ? "à confirmer" : "nog te bevestigen"));
  const techLabel = c.technieker
    ? (isFr ? `Notre technicien : ${c.technieker}` : `Onze technieker: ${c.technieker}`)
    : "";

  const accent = sanitizeHex(c.branding.secondaryColor, "#E74C3C");
  const primary = sanitizeHex(c.branding.primaryColor, "#1A1A2E");

  if (event === "reminder_24h") {
    return {
      subject: isFr
        ? `${c.branding.name} — Rappel : entretien demain (${datum})`
        : `${c.branding.name} — Herinnering: onderhoud morgen (${datum})`,
      bodyHtml: `
        <p style="font-size:16px;margin:0 0 20px">${escHtml(buildAanhef(c))}</p>
        <p style="font-size:14px;line-height:1.7;margin:0 0 16px">${escHtml(isFr
          ? `Petit rappel : nous passons demain pour l'entretien de vos panneaux solaires.`
          : `Een korte herinnering: we komen morgen langs voor het onderhoud van uw zonnepanelen.`)}</p>
        <div style="background:#f8f9fa;border-left:3px solid ${accent};border-radius:8px;padding:20px;margin:24px 0">
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <tr><td style="padding:6px 0;color:#6b7280">${escHtml(isFr ? "Date" : "Datum")}</td>
                <td style="padding:6px 0;text-align:right;font-weight:600;color:#1f2937">${escHtml(datum)}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7280">${escHtml(isFr ? "Heure" : "Tijdstip")}</td>
                <td style="padding:6px 0;text-align:right;color:#1f2937">${escHtml(tijd)}</td></tr>
          </table>
        </div>
        <p style="font-size:14px;line-height:1.7;margin:0 0 16px">${escHtml(isFr
          ? `Merci de vous assurer que l'accès à l'installation est libre. En cas de souci, contactez-nous le plus rapidement possible.`
          : `Gelieve te zorgen dat de installatie vlot bereikbaar is. Bij vragen of een onverwachte verhindering, contacteer ons zo snel mogelijk.`)}</p>`,
    };
  }

  if (event === "reminder_day") {
    return {
      subject: isFr
        ? `${c.branding.name} — Nous arrivons aujourd'hui (${tijd})`
        : `${c.branding.name} — We komen vandaag langs (${tijd})`,
      bodyHtml: `
        <p style="font-size:16px;margin:0 0 20px">${escHtml(buildAanhef(c))}</p>
        <p style="font-size:14px;line-height:1.7;margin:0 0 16px">${escHtml(isFr
          ? `Notre équipe passe aujourd'hui pour l'entretien de vos panneaux solaires.`
          : `Onze ploeg komt vandaag langs voor het onderhoud van uw zonnepanelen.`)}</p>
        <div style="background:#f8f9fa;border-left:3px solid ${accent};border-radius:8px;padding:20px;margin:24px 0">
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <tr><td style="padding:6px 0;color:#6b7280">${escHtml(isFr ? "Heure prévue" : "Voorzien tijdstip")}</td>
                <td style="padding:6px 0;text-align:right;font-weight:600;color:${primary}">${escHtml(tijd)}</td></tr>
            ${techLabel ? `<tr><td colspan="2" style="padding:10px 0 0;font-size:13px;color:#374151">${escHtml(techLabel)}</td></tr>` : ""}
          </table>
        </div>
        <p style="font-size:14px;line-height:1.7;margin:0 0 16px">${escHtml(isFr
          ? `Notre technicien suivra la procédure complète : nettoyage, inspection visuelle, contrôle des fixations et rapport digital après l'intervention.`
          : `Onze technieker doorloopt de volledige procedure: reiniging, visuele inspectie, controle van bevestigingen en digitaal rapport na uitvoering.`)}</p>`,
    };
  }

  if (event === "rapport_klaar") {
    const cta = c.rapportUrl
      ? `<p style="text-align:center;margin:28px 0">
           <a href="${escUrl(c.rapportUrl)}" style="display:inline-block;background:${primary};color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;font-size:14px">${escHtml(isFr ? "Consulter le rapport" : "Rapport bekijken")}</a>
         </p>` : "";
    return {
      subject: isFr
        ? `${c.branding.name} — Votre rapport d'entretien est prêt`
        : `${c.branding.name} — Uw onderhoudsrapport is klaar`,
      bodyHtml: `
        <p style="font-size:16px;margin:0 0 20px">${escHtml(buildAanhef(c))}</p>
        <p style="font-size:14px;line-height:1.7;margin:0 0 16px">${escHtml(isFr
          ? `L'entretien de vos panneaux solaires est terminé. Le rapport digital, avec photos avant/après et observations techniques, est disponible.`
          : `Het onderhoud van uw zonnepanelen is uitgevoerd. Het digitale rapport, met foto's voor/na en technische bevindingen, is beschikbaar.`)}</p>
        ${cta}
        <p style="font-size:13px;line-height:1.7;margin:0 0 16px;color:#6b7280">${escHtml(isFr
          ? `Si vous avez des questions sur le rapport ou souhaitez planifier la prochaine intervention, n'hésitez pas à nous contacter.`
          : `Bij vragen over het rapport of voor het plannen van een volgend onderhoud, contacteer ons gerust.`)}</p>`,
    };
  }

  // test
  return {
    subject: isFr
      ? `${c.branding.name} — Email de test (Slot F)`
      : `${c.branding.name} — Test email (Slot F)`,
    bodyHtml: `
      <p style="font-size:16px;margin:0 0 20px">${escHtml(isFr ? "Bonjour," : "Beste,")}</p>
      <p style="font-size:14px;line-height:1.7;margin:0 0 16px">${escHtml(isFr
        ? `Ceci est un email de test envoyé via l'infrastructure Slot F (notifications client). Si vous lisez ce message, la configuration fonctionne correctement.`
        : `Dit is een testmail vanuit de Slot F infrastructuur (klant-notificaties). Als u deze boodschap leest, werkt de configuratie correct.`)}</p>
      <p style="font-size:13px;color:#6b7280">${new Date().toISOString()}</p>`,
  };
}

interface ShellOpts {
  branding: PartnerBranding;
  lang: Lang;
  headerTitle: string;
  bodyHtml: string;
  optOutFooterHtml: string;
}

function renderShell(o: ShellOpts): string {
  const primary = sanitizeHex(o.branding.primaryColor, "#1A1A2E");
  const headerLogoOrName = o.branding.logoUrl
    ? `<img src="${escUrl(o.branding.logoUrl)}" alt="${escHtml(o.branding.name)}" style="max-height:48px;max-width:200px;display:block;margin:0 auto" />`
    : `<h1 style="margin:0;font-size:22px;letter-spacing:1.5px;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">${escHtml(o.branding.name)}</h1>`;

  const flanccoCredit = o.branding.isFlancco
    ? ""
    : `<p style="margin:8px 0 0;font-size:11px;color:#999">${o.lang === "fr" ? "Plateforme propulsée par" : "Platform aangedreven door"} <strong>Flancco BV</strong></p>`;

  const footerContact = renderFooterContact(o.branding, o.lang);

  return `<!DOCTYPE html>
<html lang="${o.lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escHtml(o.headerTitle)}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937">
<div style="max-width:600px;margin:0 auto;padding:20px">
  <div style="background:${primary};color:#fff;padding:28px 32px;border-radius:12px 12px 0 0;text-align:center">
    ${headerLogoOrName}
  </div>
  <div style="background:#fff;padding:32px;border-radius:0 0 12px 12px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb">
    ${o.bodyHtml}
    <div style="margin-top:32px;padding-top:24px;border-top:1px solid #e5e7eb">
      ${footerContact}
    </div>
  </div>
  <div style="text-align:center;margin-top:16px">
    ${flanccoCredit}
    ${o.optOutFooterHtml}
  </div>
</div>
</body>
</html>`;
}

function renderFooterContact(b: PartnerBranding, lang: Lang): string {
  const labels = lang === "fr"
    ? { vragen: "Une question ?", website: "Site web" }
    : { vragen: "Vragen?", website: "Website" };

  const lines: string[] = [];
  if (b.telefoon) lines.push(`<span style="color:#4b5563">${escHtml(b.telefoon)}</span>`);
  if (b.email) lines.push(`<a href="mailto:${escHtml(b.email)}" style="color:${sanitizeHex(b.primaryColor, "#1A1A2E")};text-decoration:none">${escHtml(b.email)}</a>`);
  if (b.website) lines.push(`<a href="${escUrl(b.website)}" style="color:${sanitizeHex(b.primaryColor, "#1A1A2E")};text-decoration:none">${labels.website}</a>`);
  if (lines.length === 0) return "";

  return `<p style="font-size:14px;color:#6b7280;margin:0 0 8px">${labels.vragen}</p>
    <p style="font-size:14px;margin:0;line-height:1.7">
      <strong style="color:#1f2937">${escHtml(b.name)}</strong><br>
      ${lines.join(" &middot; ")}
    </p>`;
}

function renderOptOutFooter(lang: Lang, optOutUrl: string): string {
  const text = lang === "fr"
    ? "Vous pouvez vous désinscrire des e-mails de service à tout moment via"
    : "U kunt zich altijd uitschrijven van service-e-mails via";
  const link = lang === "fr" ? "ce lien de désinscription" : "deze uitschrijflink";
  return `<p style="margin:12px 0 0;font-size:11px;color:#9ca3af;line-height:1.5">
    ${escHtml(text)} <a href="${escUrl(optOutUrl)}" style="color:#9ca3af;text-decoration:underline">${escHtml(link)}</a>.
  </p>`;
}
