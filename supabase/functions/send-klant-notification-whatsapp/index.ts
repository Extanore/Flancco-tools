// send-klant-notification-whatsapp — Slot F klant-facing WhatsApp reminders
// ============================================================
// SCOPE: WhatsApp Business Cloud API. WhatsApp Business vereist
// PRE-APPROVED MESSAGE TEMPLATES voor outbound notificaties buiten het
// 24-uur user-initiated venster. Template-naam-patroon:
//   `klant_${event_type}_${lang}` — bv. `klant_reminder_24h_nl`
//
// AUTH: identiek aan email/sms (service-role of admin/partner-owner).
//
// FEATURE-FLAG: WHATSAPP_PHONE_ID + WHATSAPP_ACCESS_TOKEN ontbreken → 503.
//
// COST-CAP: WHATSAPP_DAILY_CAP (default 100).
//
// FALLBACK: als templates nog niet goedgekeurd zijn door Meta, kan een admin
// `force=true` + `freeform=true` gebruiken om een plain-text body te sturen
// (dit faalt buiten het 24h venster — Meta-policy).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

// ─── Config ──────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const WHATSAPP_PHONE_ID = Deno.env.get("WHATSAPP_PHONE_ID") ?? "";
const WHATSAPP_ACCESS_TOKEN = Deno.env.get("WHATSAPP_ACCESS_TOKEN") ?? "";
const WHATSAPP_API_VERSION = Deno.env.get("WHATSAPP_API_VERSION") || "v18.0";
const WHATSAPP_DAILY_CAP = parseInt(Deno.env.get("WHATSAPP_DAILY_CAP") || "100", 10);

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS")
  || "https://app.flancco-platform.be,https://flancco-platform.be,https://www.flancco-platform.be"
).split(",").map((s) => s.trim()).filter(Boolean);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const E164_RE = /^\+[1-9]\d{6,14}$/;
const FN_NAME = "send-klant-notification-whatsapp";

// ─── Types ───────────────────────────────────────────────────────────────────

type Lang = "nl" | "fr";
type EventType = "reminder_24h" | "reminder_day" | "rapport_klaar" | "test";

interface Payload {
  beurt_id?: string;
  contract_id?: string;
  event_type: EventType;
  force?: boolean;
  override_phone?: string;
  rapport_url?: string;
  freeform?: boolean; // admin-test only
}

interface BeurtRow {
  id: string;
  contract_id: string | null;
  plan_datum: string | null;
  start_tijd: string | null;
  hele_dag: boolean | null;
  status: string | null;
  technieker_id: string | null;
  reminder_24h_whatsapp_ts: string | null;
  reminder_day_whatsapp_ts: string | null;
}

interface ContractRow {
  id: string;
  partner_id: string | null;
  klant_naam: string | null;
  klant_email: string | null;
  klant_telefoon: string | null;
  lang: string | null;
  // Slot T — bedrijf-only-detectie + lookup-keys
  client_id: string | null;
  client_contact_id: string | null;
}

// Slot T — phone-resolution result
interface PhoneResolution {
  rawPhone: string;
  klantEmail: string;
  isCompanyOnly: boolean;
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

function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let cleaned = String(raw).replace(/[\s.\-()/]/g, "").trim();
  if (!cleaned) return null;
  if (cleaned.startsWith("00")) cleaned = "+" + cleaned.slice(2);
  if (cleaned.startsWith("0") && !cleaned.startsWith("00") && !cleaned.startsWith("+")) {
    cleaned = "+32" + cleaned.slice(1);
  }
  if (!cleaned.startsWith("+")) {
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
  const force = body.force === true;
  const freeform = body.freeform === true && auth.mode === "user"; // admin override only via user-JWT
  const beurt_id = body.beurt_id ? String(body.beurt_id).trim() : "";
  const contract_id = body.contract_id ? String(body.contract_id).trim() : "";
  const override_phone = body.override_phone ? String(body.override_phone).trim() : "";
  const rapport_url = body.rapport_url ? String(body.rapport_url).trim() : "";

  if (beurt_id && !UUID_RE.test(beurt_id)) return json(400, { error: "invalid_beurt_id" }, corsHeaders);
  if (contract_id && !UUID_RE.test(contract_id)) return json(400, { error: "invalid_contract_id" }, corsHeaders);
  if (!beurt_id && !contract_id && event_type !== "test") {
    return json(400, { error: "beurt_id_or_contract_id_required" }, corsHeaders);
  }

  // 3) WhatsApp feature-flag
  if (!WHATSAPP_PHONE_ID || !WHATSAPP_ACCESS_TOKEN) {
    await insertLog(admin, {
      beurt_id: beurt_id || null,
      contract_id: contract_id || null,
      partner_id: null,
      kanaal: "whatsapp", event_type, recipient: override_phone || "(unknown)",
      status: "failed",
      error_detail: "whatsapp_not_configured",
    });
    return json(503, {
      error: "whatsapp_not_configured",
      detail: "Set WHATSAPP_PHONE_ID and WHATSAPP_ACCESS_TOKEN in Supabase Edge Function secrets",
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
                 reminder_24h_whatsapp_ts, reminder_day_whatsapp_ts`)
        .eq("id", beurt_id)
        .maybeSingle<BeurtRow>();
      if (!br) return json(404, { error: "beurt_not_found" }, corsHeaders);
      beurt = br;

      if (br.contract_id) {
        const { data: cr } = await admin
          .from("contracten")
          .select(`id, partner_id, klant_naam, klant_email, klant_telefoon, lang, client_id, client_contact_id`)
          .eq("id", br.contract_id)
          .maybeSingle<ContractRow>();
        contract = cr;
      }
    } else if (contract_id) {
      const { data: cr } = await admin
        .from("contracten")
        .select(`id, partner_id, klant_naam, klant_email, klant_telefoon, lang, client_id, client_contact_id`)
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

    // 5) Phone normalization (Slot T: bedrijf-only support)
    const phoneRes: PhoneResolution = override_phone
      ? { rawPhone: override_phone, klantEmail: contract?.klant_email?.toLowerCase() || "", isCompanyOnly: false }
      : await resolvePhone(admin, contract);
    const rawPhone = phoneRes.rawPhone;
    const phoneE164 = normalizePhone(rawPhone);
    if (!phoneE164) {
      await insertLog(admin, {
        beurt_id: beurt?.id ?? null, contract_id: contract?.id ?? null, partner_id: contract?.partner_id ?? null,
        kanaal: "whatsapp", event_type, recipient: rawPhone || "(geen)",
        status: "skipped_missing_contact",
        error_detail: rawPhone ? "phone_invalid_format" : "phone_missing",
      });
      return json(200, { ok: true, skipped: rawPhone ? "phone_invalid" : "missing_contact" }, corsHeaders);
    }
    // WhatsApp Cloud API requires phone WITHOUT leading +
    const waPhone = phoneE164.replace(/^\+/, "");

    // 6) Idempotency (whatsapp doesn't support rapport_klaar via templates by default)
    if (event_type !== "test" && beurt && !force) {
      const tsField = `${event_type}_whatsapp_ts` as keyof BeurtRow;
      if (tsField in beurt && beurt[tsField]) {
        await insertLog(admin, {
          beurt_id: beurt.id, contract_id: contract?.id ?? null, partner_id: contract?.partner_id ?? null,
          kanaal: "whatsapp", event_type, recipient: phoneE164,
          status: "skipped_already_sent",
        });
        return json(200, { ok: true, skipped: "already_sent" }, corsHeaders);
      }
    }

    // 7) Consent-check (kanaal='whatsapp' vereist expliciete opt-in)
    // Slot T: gebruik resolved klantEmail (kan client_contact.email of clients.email zijn).
    if (event_type !== "test") {
      const klantEmail = phoneRes.klantEmail;
      if (klantEmail) {
        const { data: cons } = await admin
          .from("v_klant_consent_actief")
          .select("bereikbaar")
          .eq("klant_email", klantEmail)
          .eq("kanaal", "whatsapp")
          .maybeSingle();
        if (!cons || cons.bereikbaar !== true) {
          await insertLog(admin, {
            beurt_id: beurt?.id ?? null, contract_id: contract?.id ?? null, partner_id: contract?.partner_id ?? null,
            kanaal: "whatsapp", event_type, recipient: phoneE164,
            status: "skipped_no_consent",
          });
          return json(200, { ok: true, skipped: "no_consent" }, corsHeaders);
        }
      } else {
        await insertLog(admin, {
          beurt_id: beurt?.id ?? null, contract_id: contract?.id ?? null, partner_id: contract?.partner_id ?? null,
          kanaal: "whatsapp", event_type, recipient: phoneE164,
          status: "skipped_no_consent",
          error_detail: "no_email_to_lookup_consent",
        });
        return json(200, { ok: true, skipped: "no_consent" }, corsHeaders);
      }
    }

    // 8) Daily-cap
    if (event_type !== "test") {
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);
      const { count } = await admin
        .from("klant_notification_log")
        .select("id", { count: "exact", head: true })
        .eq("kanaal", "whatsapp")
        .eq("status", "sent")
        .gte("created_at", todayStart.toISOString());
      if ((count || 0) >= WHATSAPP_DAILY_CAP) {
        await insertLog(admin, {
          beurt_id: beurt?.id ?? null, contract_id: contract?.id ?? null, partner_id: contract?.partner_id ?? null,
          kanaal: "whatsapp", event_type, recipient: phoneE164,
          status: "skipped_daily_cap",
          error_detail: `cap=${WHATSAPP_DAILY_CAP} reached`,
        });
        return json(429, { error: "daily_cap_reached", cap: WHATSAPP_DAILY_CAP }, corsHeaders);
      }
    }

    // 9) Build WhatsApp payload (template-first, freeform fallback)
    const lang: Lang = contract?.lang === "fr" ? "fr" : "nl";
    const partnerName = partner?.bedrijfsnaam || partner?.naam || "Flancco";
    const datum = beurt?.plan_datum ? formatShortDate(beurt.plan_datum, lang) : "";
    const tijd = beurt?.hele_dag ? (lang === "fr" ? "toute la journée" : "ganse dag") : (beurt?.start_tijd ? beurt.start_tijd.slice(0, 5) : "");
    const techName = technieker ? `${technieker.voornaam ?? ""} ${technieker.naam ?? ""}`.trim() : "";

    // Voor rapport_klaar: regenereer PDF on-demand uit DB-data wanneer caller
    // geen explicit rapport_url meegaf. Voorkomt stale/leeg-opgeslagen PDFs.
    let effectiveRapportUrl = rapport_url;
    if (event_type === "rapport_klaar" && !effectiveRapportUrl && beurt?.id) {
      const partnerSlug = partner?.slug || "flancco";
      const regen = await regenerateRapportPdfUrl(admin, beurt.id, partnerSlug, lang);
      if (regen) {
        effectiveRapportUrl = regen.url;
        logJson({ event: "rapport_pdf_regenerated", beurt_id: beurt.id, rapport_id: regen.rapportId });
      } else {
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

    let waBody: Record<string, unknown>;
    if (freeform) {
      // Plain-text message — only works in 24h user-initiated window
      const text = buildFreeformText({
        event: event_type, lang, partnerName, datum, tijd, technieker: techName, rapportUrl: effectiveRapportUrl,
      });
      waBody = {
        messaging_product: "whatsapp",
        to: waPhone,
        type: "text",
        text: { body: text, preview_url: false },
      };
    } else {
      // Template payload
      waBody = buildTemplatePayload({
        event: event_type, lang, partnerName, datum, tijd, technieker: techName, rapportUrl: effectiveRapportUrl, waPhone,
      });
    }

    // 10) POST to Graph API
    const waResp = await fetch(
      `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${encodeURIComponent(WHATSAPP_PHONE_ID)}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        },
        body: JSON.stringify(waBody),
      },
    );

    const waResult = await waResp.json().catch(() => ({} as Record<string, unknown>));
    if (!waResp.ok) {
      const errMsg = (waResult as { error?: { message?: string } })?.error?.message
        || `whatsapp_status_${waResp.status}`;
      logJson({ event: "send_failed", provider: "whatsapp", status: waResp.status });
      await insertLog(admin, {
        beurt_id: beurt?.id ?? null, contract_id: contract?.id ?? null, partner_id: contract?.partner_id ?? null,
        kanaal: "whatsapp", event_type, recipient: phoneE164,
        status: "failed",
        error_detail: errMsg.slice(0, 500),
      });
      return json(500, { error: "send_failed", detail: errMsg }, corsHeaders);
    }

    const waMessages = (waResult as { messages?: Array<{ id?: string }> })?.messages;
    const messageId = (waMessages && waMessages[0]?.id) || null;

    // 11) Write back timestamp (only for events with a timestamp column)
    if (event_type !== "test" && beurt && (event_type === "reminder_24h" || event_type === "reminder_day")) {
      const tsField = `${event_type}_whatsapp_ts`;
      await admin.from("onderhoudsbeurten").update({ [tsField]: new Date().toISOString() }).eq("id", beurt.id);
    }

    await insertLog(admin, {
      beurt_id: beurt?.id ?? null, contract_id: contract?.id ?? null, partner_id: contract?.partner_id ?? null,
      kanaal: "whatsapp", event_type, recipient: phoneE164,
      status: "sent",
      provider_message_id: messageId,
    });

    logJson({ event: "sent", event_type, kanaal: "whatsapp", recipient_masked: maskPhone(phoneE164), template: !freeform });
    return json(200, { ok: true, provider_message_id: messageId, recipient_masked: maskPhone(phoneE164) }, corsHeaders);

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
  catch { /* swallow — log-failures shouldn't block */ }
}

// ─── Rapport PDF regeneration ────────────────────────────────────────────────
// Bij `event_type='rapport_klaar'` zonder explicit `rapport_url`: regenereer via
// generate-pdf edge function uit DB-data en update `rapporten.pdf_url`. Voorkomt
// dat leeg-opgeslagen PDFs naar de klant gestuurd worden. Zie ook PR #111 voor
// dezelfde fix in admin UI + send-klant-notification-email.

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

function _flattenFotoUrls(v: unknown): string[] {
  if (Array.isArray(v)) return (v as unknown[]).filter((u) => typeof u === "string") as string[];
  if (v != null && typeof v === "object") {
    const out: string[] = [];
    for (const k of Object.keys(v as Record<string, unknown>)) {
      const arr = (v as Record<string, unknown>)[k];
      if (Array.isArray(arr)) for (const u of arr) if (typeof u === "string" && u) out.push(u);
    }
    return out;
  }
  return [];
}

function buildRapportPayload(
  rapport: RapportRow,
  beurt: BeurtRow | null,
  contract: { id?: string; partner_id?: string | null; contract_nummer?: string | null; klant_naam?: string | null; klant_adres?: string | null; klant_postcode?: string | null; klant_gemeente?: string | null; klant_email?: string | null; klant_telefoon?: string | null; aantal_panelen?: number | null; frequentie?: string | null; contractduur?: number | null; sector?: string | null; } | null,
): Record<string, unknown> {
  const checkData = (rapport.checklist_data || {}) as Record<string, { status?: string; label?: string; note?: string }>;
  const sector = rapport.sector || null;
  const bevindingenLines: string[] = [];
  for (const key of Object.keys(checkData)) {
    if (key === "_meta") continue;
    const v = checkData[key];
    if (!v || v.status !== "nok") continue;
    let line = "• " + (v.label || key);
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

async function regenerateRapportPdfUrl(
  admin: SupabaseClient,
  beurtId: string,
  partnerSlug: string,
  lang: Lang,
): Promise<{ url: string; rapportId: string } | null> {
  try {
    const { data: rRows } = await admin
      .from("rapporten")
      .select(`id, contract_id, onderhoudsbeurt_id, referentie, sector, datum_onderhoud,
               checklist_data, materiaal_data, foto_urls, opmerkingen, pdf_url`)
      .eq("onderhoudsbeurt_id", beurtId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (!rRows || rRows.length === 0) {
      logJson({ event: "rapport_regen_no_record", beurt_id: beurtId });
      return null;
    }
    const rapport = rRows[0] as RapportRow;

    const { data: beurtData } = await admin
      .from("onderhoudsbeurten")
      .select(`id, contract_id, plan_datum, start_tijd, hele_dag, status, technieker_id,
               reminder_24h_whatsapp_ts, reminder_day_whatsapp_ts`)
      .eq("id", beurtId)
      .maybeSingle<BeurtRow>();

    let contract: { id?: string; partner_id?: string | null; contract_nummer?: string | null; klant_naam?: string | null; klant_adres?: string | null; klant_postcode?: string | null; klant_gemeente?: string | null; klant_email?: string | null; klant_telefoon?: string | null; aantal_panelen?: number | null; frequentie?: string | null; contractduur?: number | null; sector?: string | null; } | null = null;
    const cid = rapport.contract_id || beurtData?.contract_id;
    if (cid) {
      const { data: cr } = await admin
        .from("contracten")
        .select(`id, partner_id, contract_nummer, klant_naam, klant_adres, klant_postcode,
                 klant_gemeente, klant_email, klant_telefoon, aantal_panelen,
                 frequentie, contractduur, sector`)
        .eq("id", cid)
        .maybeSingle();
      contract = cr;
    }

    const payload = buildRapportPayload(rapport, beurtData, contract);

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
        body: JSON.stringify({ template: "rapport_branded", partner_slug: partnerSlug, lang, data: payload }),
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
    if (!url) return null;
    try { await admin.from("rapporten").update({ pdf_url: url }).eq("id", rapport.id); }
    catch (_) { /* best-effort */ }
    return { url, rapportId: rapport.id };
  } catch (err) {
    logJson({ event: "rapport_regen_exception", err: err instanceof Error ? err.message : "unknown" });
    return null;
  }
}

/**
 * Slot T — resolve phone-number + consent-email voor klant-notificatie WhatsApp.
 * Wanneer client_contact_id koppelt: gebruik client_contacts.phone + email.
 * Wanneer NULL en client_id bestaat: bedrijf-only → clients.phone + email.
 * Fallback: contracten.klant_telefoon + klant_email (legacy).
 */
async function resolvePhone(
  admin: SupabaseClient,
  contract: ContractRow | null,
): Promise<PhoneResolution> {
  if (!contract) {
    return { rawPhone: "", klantEmail: "", isCompanyOnly: false };
  }

  if (contract.client_contact_id) {
    const { data: cc } = await admin
      .from("client_contacts")
      .select("phone, email")
      .eq("id", contract.client_contact_id)
      .maybeSingle();
    return {
      rawPhone: String(cc?.phone || contract.klant_telefoon || "").trim(),
      klantEmail: String(cc?.email || contract.klant_email || "").trim().toLowerCase(),
      isCompanyOnly: false,
    };
  }

  if (contract.client_id) {
    const { data: client } = await admin
      .from("clients")
      .select("company_name, phone, email")
      .eq("id", contract.client_id)
      .maybeSingle();
    const company = String(client?.company_name || "").trim();
    if (company) {
      return {
        rawPhone: String(client?.phone || contract.klant_telefoon || "").trim(),
        klantEmail: String(client?.email || contract.klant_email || "").trim().toLowerCase(),
        isCompanyOnly: true,
      };
    }
  }

  return {
    rawPhone: String(contract.klant_telefoon || "").trim(),
    klantEmail: String(contract.klant_email || "").trim().toLowerCase(),
    isCompanyOnly: false,
  };
}

interface PayloadCtx {
  event: EventType;
  lang: Lang;
  partnerName: string;
  datum: string;
  tijd: string;
  technieker: string;
  rapportUrl: string;
  waPhone?: string;
}

function buildTemplatePayload(c: PayloadCtx): Record<string, unknown> {
  const templateName = c.event === "test"
    ? `klant_test_${c.lang}`
    : `klant_${c.event}_${c.lang}`;

  // Components per template (must match Meta-approved layout)
  const headerVars: Array<{ type: "text"; text: string }> = [];
  const bodyVars: Array<{ type: "text"; text: string }> = [];
  const buttons: Array<Record<string, unknown>> = [];

  if (c.event === "reminder_24h") {
    headerVars.push({ type: "text", text: c.datum || "—" });
    bodyVars.push({ type: "text", text: c.tijd || "—" });
  } else if (c.event === "reminder_day") {
    bodyVars.push({ type: "text", text: c.tijd || "—" });
    bodyVars.push({ type: "text", text: c.technieker || "—" });
  } else if (c.event === "rapport_klaar" && c.rapportUrl) {
    buttons.push({
      type: "button",
      sub_type: "url",
      index: "0",
      parameters: [{ type: "text", text: c.rapportUrl }],
    });
  }

  const components: Array<Record<string, unknown>> = [];
  if (headerVars.length) components.push({ type: "header", parameters: headerVars });
  if (bodyVars.length)   components.push({ type: "body",   parameters: bodyVars });
  if (buttons.length)    components.push(...buttons);

  return {
    messaging_product: "whatsapp",
    to: c.waPhone,
    type: "template",
    template: {
      name: templateName,
      language: { code: c.lang === "fr" ? "fr" : "nl" },
      ...(components.length ? { components } : {}),
    },
  };
}

function buildFreeformText(c: Omit<PayloadCtx, "waPhone">): string {
  const isFr = c.lang === "fr";
  if (c.event === "reminder_24h") {
    return isFr
      ? `${c.partnerName}: rappel — entretien panneaux solaires demain ${c.datum}${c.tijd ? " à " + c.tijd : ""}.`
      : `${c.partnerName}: herinnering — onderhoud zonnepanelen morgen ${c.datum}${c.tijd ? " om " + c.tijd : ""}.`;
  }
  if (c.event === "reminder_day") {
    const tech = c.technieker ? (isFr ? ` Technicien: ${c.technieker}.` : ` Technieker: ${c.technieker}.`) : "";
    return isFr
      ? `${c.partnerName}: nous arrivons aujourd'hui${c.tijd ? " à " + c.tijd : ""}.${tech}`
      : `${c.partnerName}: we komen vandaag langs${c.tijd ? " om " + c.tijd : ""}.${tech}`;
  }
  if (c.event === "rapport_klaar") {
    return isFr
      ? `${c.partnerName}: votre rapport d'entretien est prêt.${c.rapportUrl ? " " + c.rapportUrl : ""}`
      : `${c.partnerName}: uw onderhoudsrapport is klaar.${c.rapportUrl ? " " + c.rapportUrl : ""}`;
  }
  return isFr
    ? `${c.partnerName}: message de test (Slot F).`
    : `${c.partnerName}: testbericht (Slot F).`;
}

function formatShortDate(iso: string, lang: Lang): string {
  try {
    const d = new Date(`${iso}T00:00:00`);
    return d.toLocaleDateString(lang === "fr" ? "fr-BE" : "nl-BE", { day: "numeric", month: "short" });
  } catch { return iso; }
}
