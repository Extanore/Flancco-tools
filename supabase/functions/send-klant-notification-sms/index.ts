// send-klant-notification-sms — Slot F klant-facing SMS reminders (Twilio)
// ============================================================
// SCOPE: zelfde event-types als email (reminder_24h, reminder_day, rapport_klaar,
// test) maar via Twilio Programmable SMS. Recipient = klant_telefoon (E.164).
//
// AUTH (verify_jwt=false in Supabase, custom in handler):
//   Caller MOET een van twee presenteren:
//     a) Service-role bearer (dispatcher / pg_cron)  → exact-match check
//     b) Geldige user-JWT met role='admin' OF (role='partner' + manage_users)
//
// FEATURE-FLAG:
//   Als TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER ontbreken → 503 met
//   `error:'twilio_not_configured'`. Beurt-timestamp wordt NIET geüpdatet
//   zodat een volgende run automatisch een herkans krijgt zodra de admin
//   de secrets heeft toegevoegd.
//
// COST-CAP:
//   TWILIO_DAILY_CAP (default 100). Voor elke send tellen we
//   klant_notification_log rows met kanaal='sms' status='sent' van vandaag.
//   Bij overschrijding → 429 + skip-log.
//
// PHONE NORMALIZATION:
//   - Accepteer E.164 (+32...) direct
//   - 04xxxxxxxx of 0032xxxxxxxxx → +32xxxxxxxxx
//   - Anders → 400 invalid_phone

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

// ─── Config ──────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
const TWILIO_FROM_NUMBER = Deno.env.get("TWILIO_FROM_NUMBER") ?? "";
const TWILIO_DAILY_CAP = parseInt(Deno.env.get("TWILIO_DAILY_CAP") || "100", 10);

const APP_BASE_URL = Deno.env.get("APP_BASE_URL") || "https://flancco-platform.be/";

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS")
  || "https://app.flancco-platform.be,https://flancco-platform.be,https://www.flancco-platform.be"
).split(",").map((s) => s.trim()).filter(Boolean);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const E164_RE = /^\+[1-9]\d{6,14}$/;
const FN_NAME = "send-klant-notification-sms";

// ─── Types ───────────────────────────────────────────────────────────────────

type Lang = "nl" | "fr";
type EventType = "reminder_24h" | "reminder_day" | "rapport_klaar" | "test";

interface Payload {
  beurt_id?: string;
  contract_id?: string;
  event_type: EventType;
  force?: boolean;
  override_phone?: string;
}

interface BeurtRow {
  id: string;
  contract_id: string | null;
  plan_datum: string | null;
  start_tijd: string | null;
  hele_dag: boolean | null;
  status: string | null;
  technieker_id: string | null;
  reminder_24h_sms_ts: string | null;
  reminder_day_sms_ts: string | null;
}

interface ContractRow {
  id: string;
  partner_id: string | null;
  klant_naam: string | null;
  klant_email: string | null;
  klant_telefoon: string | null;
  lang: string | null;
}

interface PartnerRow {
  id: string;
  slug: string;
  naam: string | null;
  bedrijfsnaam: string | null;
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

function logJson(meta: Record<string, unknown>): void {
  try { console.log(JSON.stringify({ fn: FN_NAME, ts: new Date().toISOString(), ...meta })); }
  catch { console.log(`${FN_NAME} log-failed`); }
}

/**
 * Normalize Belgian/E.164 phone numbers. Returns +32... or null if invalid.
 */
function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let cleaned = String(raw).replace(/[\s.\-()/]/g, "").trim();
  if (!cleaned) return null;

  if (cleaned.startsWith("00")) cleaned = "+" + cleaned.slice(2);
  if (cleaned.startsWith("0") && !cleaned.startsWith("00") && !cleaned.startsWith("+")) {
    // Belgian shortform 04XX → +324XX
    cleaned = "+32" + cleaned.slice(1);
  }
  if (!cleaned.startsWith("+")) {
    // Last resort — assume BE
    if (/^\d{8,14}$/.test(cleaned)) cleaned = "+32" + cleaned;
  }
  return E164_RE.test(cleaned) ? cleaned : null;
}

function maskPhone(phone: string): string {
  if (phone.length < 6) return "***";
  return phone.slice(0, 4) + "****" + phone.slice(-2);
}

// ─── Auth ────────────────────────────────────────────────────────────────────

interface AuthResult { ok: true; mode: "service_role" | "user" }
interface AuthFail { ok: false; status: number; error: string }

async function authenticate(req: Request, admin: SupabaseClient): Promise<AuthResult | AuthFail> {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return { ok: false, status: 401, error: "missing_authorization" };

  if (SUPABASE_SERVICE_ROLE_KEY && token.length === SUPABASE_SERVICE_ROLE_KEY.length) {
    let diff = 0;
    for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ SUPABASE_SERVICE_ROLE_KEY.charCodeAt(i);
    if (diff === 0) return { ok: true, mode: "service_role" };
  }

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

  if (!isAdmin && !isPartnerOwner) return { ok: false, status: 403, error: "insufficient_role" };
  return { ok: true, mode: "user" };
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

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // 1) AUTH FIRST
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
  if (event_type === "rapport_klaar") {
    return json(400, { error: "rapport_klaar_not_via_sms" }, corsHeaders);
  }
  const force = body.force === true;
  const beurt_id = body.beurt_id ? String(body.beurt_id).trim() : "";
  const contract_id = body.contract_id ? String(body.contract_id).trim() : "";
  const override_phone = body.override_phone ? String(body.override_phone).trim() : "";

  if (beurt_id && !UUID_RE.test(beurt_id)) return json(400, { error: "invalid_beurt_id" }, corsHeaders);
  if (contract_id && !UUID_RE.test(contract_id)) return json(400, { error: "invalid_contract_id" }, corsHeaders);
  if (!beurt_id && !contract_id && event_type !== "test") {
    return json(400, { error: "beurt_id_or_contract_id_required" }, corsHeaders);
  }

  // 3) Twilio feature-flag check
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
    await insertLog(admin, {
      beurt_id: beurt_id || null,
      contract_id: contract_id || null,
      partner_id: null,
      kanaal: "sms", event_type, recipient: override_phone || "(unknown)",
      status: "failed",
      error_detail: "twilio_not_configured",
    });
    logJson({ event: "twilio_not_configured" });
    return json(503, {
      error: "twilio_not_configured",
      detail: "Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER in Supabase Edge Function secrets",
    }, corsHeaders);
  }

  try {
    // 4) Resolve beurt + contract + partner
    let beurt: BeurtRow | null = null;
    let contract: ContractRow | null = null;

    if (beurt_id) {
      const { data: br } = await admin
        .from("onderhoudsbeurten")
        .select(`id, contract_id, plan_datum, start_tijd, hele_dag, status, technieker_id,
                 reminder_24h_sms_ts, reminder_day_sms_ts`)
        .eq("id", beurt_id)
        .maybeSingle<BeurtRow>();
      if (!br) return json(404, { error: "beurt_not_found" }, corsHeaders);
      beurt = br;

      if (br.contract_id) {
        const { data: cr } = await admin
          .from("contracten")
          .select(`id, partner_id, klant_naam, klant_email, klant_telefoon, lang`)
          .eq("id", br.contract_id)
          .maybeSingle<ContractRow>();
        contract = cr;
      }
    } else if (contract_id) {
      const { data: cr } = await admin
        .from("contracten")
        .select(`id, partner_id, klant_naam, klant_email, klant_telefoon, lang`)
        .eq("id", contract_id)
        .maybeSingle<ContractRow>();
      contract = cr;
    }

    if (event_type !== "test" && !contract) return json(404, { error: "contract_not_found" }, corsHeaders);

    let partner: PartnerRow | null = null;
    if (contract?.partner_id) {
      const { data: pr } = await admin
        .from("partners")
        .select(`id, slug, naam, bedrijfsnaam`)
        .eq("id", contract.partner_id)
        .maybeSingle<PartnerRow>();
      partner = pr;
    }

    let technieker: TechniekerRow | null = null;
    if (beurt?.technieker_id && event_type === "reminder_day") {
      const { data: tr } = await admin
        .from("techniekers")
        .select("id, naam, voornaam")
        .eq("id", beurt.technieker_id)
        .maybeSingle<TechniekerRow>();
      technieker = tr;
    }

    // 5) Recipient + normalization
    const rawPhone = override_phone || contract?.klant_telefoon || "";
    const phoneE164 = normalizePhone(rawPhone);

    if (!phoneE164) {
      await insertLog(admin, {
        beurt_id: beurt?.id ?? null, contract_id: contract?.id ?? null, partner_id: contract?.partner_id ?? null,
        kanaal: "sms", event_type, recipient: rawPhone || "(geen)",
        status: "skipped_missing_contact",
        error_detail: rawPhone ? "phone_invalid_format" : "phone_missing",
      });
      return json(200, { ok: true, skipped: rawPhone ? "phone_invalid" : "missing_contact" }, corsHeaders);
    }

    // 6) Idempotency
    if (event_type !== "test" && beurt && !force) {
      const tsField = `${event_type}_sms_ts` as keyof BeurtRow;
      if (beurt[tsField]) {
        await insertLog(admin, {
          beurt_id: beurt.id, contract_id: contract?.id ?? null, partner_id: contract?.partner_id ?? null,
          kanaal: "sms", event_type, recipient: phoneE164,
          status: "skipped_already_sent",
        });
        return json(200, { ok: true, skipped: "already_sent" }, corsHeaders);
      }
    }

    // 7) Consent-check (kanaal='sms' vereist expliciete opt-in via ePrivacy)
    if (event_type !== "test") {
      const klantEmail = contract?.klant_email?.toLowerCase() || "";
      if (klantEmail) {
        const { data: cons } = await admin
          .from("v_klant_consent_actief")
          .select("bereikbaar")
          .eq("klant_email", klantEmail)
          .eq("kanaal", "sms")
          .maybeSingle();
        if (!cons || cons.bereikbaar !== true) {
          await insertLog(admin, {
            beurt_id: beurt?.id ?? null, contract_id: contract?.id ?? null, partner_id: contract?.partner_id ?? null,
            kanaal: "sms", event_type, recipient: phoneE164,
            status: "skipped_no_consent",
          });
          return json(200, { ok: true, skipped: "no_consent" }, corsHeaders);
        }
      } else {
        // No email → can't link to consent row. Default-deny.
        await insertLog(admin, {
          beurt_id: beurt?.id ?? null, contract_id: contract?.id ?? null, partner_id: contract?.partner_id ?? null,
          kanaal: "sms", event_type, recipient: phoneE164,
          status: "skipped_no_consent",
          error_detail: "no_email_to_lookup_consent",
        });
        return json(200, { ok: true, skipped: "no_consent" }, corsHeaders);
      }
    }

    // 8) Daily-cap (cost-control)
    if (event_type !== "test") {
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);
      const { count } = await admin
        .from("klant_notification_log")
        .select("id", { count: "exact", head: true })
        .eq("kanaal", "sms")
        .eq("status", "sent")
        .gte("created_at", todayStart.toISOString());
      if ((count || 0) >= TWILIO_DAILY_CAP) {
        await insertLog(admin, {
          beurt_id: beurt?.id ?? null, contract_id: contract?.id ?? null, partner_id: contract?.partner_id ?? null,
          kanaal: "sms", event_type, recipient: phoneE164,
          status: "skipped_daily_cap",
          error_detail: `cap=${TWILIO_DAILY_CAP} reached`,
        });
        logJson({ event: "daily_cap_reached", cap: TWILIO_DAILY_CAP });
        return json(429, { error: "daily_cap_reached", cap: TWILIO_DAILY_CAP }, corsHeaders);
      }
    }

    // 9) Build SMS body
    const lang: Lang = contract?.lang === "fr" ? "fr" : "nl";
    const partnerName = partner?.bedrijfsnaam || partner?.naam || "Flancco";
    const optOutToken = (event_type !== "test" && contract?.id && contract?.klant_email)
      ? await fetchOptOutToken(admin, contract.id, contract.klant_email, "sms")
      : null;
    const message = buildSmsMessage({
      event: event_type,
      lang,
      partnerName,
      planDatum: beurt?.plan_datum ?? null,
      startTijd: beurt?.start_tijd ?? null,
      heleDag: beurt?.hele_dag === true,
      technieker: technieker ? `${technieker.voornaam ?? ""} ${technieker.naam ?? ""}`.trim() : "",
      optOutToken,
    });

    // 10) Send via Twilio
    const formBody = new URLSearchParams({
      From: TWILIO_FROM_NUMBER,
      To: phoneE164,
      Body: message,
    });

    const credentials = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
    const twResp = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Messages.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Authorization": `Basic ${credentials}`,
        },
        body: formBody.toString(),
      },
    );

    const twResult = await twResp.json().catch(() => ({} as Record<string, unknown>));
    if (!twResp.ok) {
      const errMsg = (twResult as { message?: string })?.message
        || (twResult as { code?: number })?.code?.toString()
        || `twilio_status_${twResp.status}`;
      logJson({ event: "send_failed", provider: "twilio", status: twResp.status });
      await insertLog(admin, {
        beurt_id: beurt?.id ?? null, contract_id: contract?.id ?? null, partner_id: contract?.partner_id ?? null,
        kanaal: "sms", event_type, recipient: phoneE164,
        status: "failed",
        error_detail: errMsg.slice(0, 500),
      });
      return json(500, { error: "send_failed", detail: errMsg }, corsHeaders);
    }

    const messageSid = (twResult as { sid?: string })?.sid || null;

    // 11) Write back timestamp
    if (event_type !== "test" && beurt) {
      const tsField = `${event_type}_sms_ts`;
      await admin.from("onderhoudsbeurten").update({ [tsField]: new Date().toISOString() }).eq("id", beurt.id);
    }

    await insertLog(admin, {
      beurt_id: beurt?.id ?? null, contract_id: contract?.id ?? null, partner_id: contract?.partner_id ?? null,
      kanaal: "sms", event_type, recipient: phoneE164,
      status: "sent",
      provider_message_id: messageSid,
    });

    logJson({ event: "sent", event_type, kanaal: "sms", recipient_masked: maskPhone(phoneE164) });
    return json(200, { ok: true, provider_message_id: messageSid, recipient_masked: maskPhone(phoneE164) }, corsHeaders);

  } catch (err) {
    logJson({ event: "exception", err: err instanceof Error ? err.message : "unknown" });
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
  try { await admin.from("klant_notification_log").insert(entry); }
  catch (e) { logJson({ event: "log_insert_failed", err: e instanceof Error ? e.message : "unknown" }); }
}

async function fetchOptOutToken(
  admin: SupabaseClient,
  contractId: string,
  klantEmail: string,
  kanaal: "email_service" | "sms" | "whatsapp",
): Promise<string | null> {
  try {
    const { data } = await admin
      .from("klant_consents")
      .select("opt_out_token, opt_out_ts")
      .eq("contract_id", contractId)
      .eq("klant_email", klantEmail.toLowerCase())
      .eq("kanaal", kanaal)
      .order("aangemaakt_op", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data?.opt_out_token || data.opt_out_ts) return null;
    return data.opt_out_token as string;
  } catch { return null; }
}

interface SmsCtx {
  event: EventType;
  lang: Lang;
  partnerName: string;
  planDatum: string | null;
  startTijd: string | null;
  heleDag: boolean;
  technieker: string;
  optOutToken: string | null;
}

function buildSmsMessage(c: SmsCtx): string {
  const isFr = c.lang === "fr";
  const optOutSuffix = c.optOutToken
    ? (isFr
        ? ` Stop SMS: ${APP_BASE_URL}opt-out/?t=${encodeURIComponent(c.optOutToken)}&k=sms`
        : ` Stop SMS: ${APP_BASE_URL}opt-out/?t=${encodeURIComponent(c.optOutToken)}&k=sms`)
    : "";

  const datum = c.planDatum ? formatShortDate(c.planDatum, c.lang) : "";
  const tijd = c.heleDag
    ? (isFr ? "toute la journée" : "ganse dag")
    : (c.startTijd ? c.startTijd.slice(0, 5) : "");

  if (c.event === "reminder_24h") {
    return isFr
      ? `${c.partnerName}: rappel - entretien panneaux solaires demain ${datum}${tijd ? " a " + tijd : ""}.${optOutSuffix}`
      : `${c.partnerName}: herinnering - onderhoud zonnepanelen morgen ${datum}${tijd ? " om " + tijd : ""}.${optOutSuffix}`;
  }

  if (c.event === "reminder_day") {
    const techPart = c.technieker
      ? (isFr ? ` Technicien: ${c.technieker}.` : ` Technieker: ${c.technieker}.`)
      : "";
    return isFr
      ? `${c.partnerName}: nous arrivons aujourd'hui${tijd ? " a " + tijd : ""}.${techPart}${optOutSuffix}`
      : `${c.partnerName}: we komen vandaag langs${tijd ? " om " + tijd : ""}.${techPart}${optOutSuffix}`;
  }

  // test
  return isFr
    ? `${c.partnerName}: SMS de test (Slot F).${optOutSuffix}`
    : `${c.partnerName}: test SMS (Slot F).${optOutSuffix}`;
}

function formatShortDate(iso: string, lang: Lang): string {
  try {
    const d = new Date(`${iso}T00:00:00`);
    return d.toLocaleDateString(lang === "fr" ? "fr-BE" : "nl-BE", { day: "numeric", month: "short" });
  } catch { return iso; }
}
