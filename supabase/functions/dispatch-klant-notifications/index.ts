// dispatch-klant-notifications — Slot F orchestrator
// ============================================================
// SCOPE: één keer per dag (07:15 UTC via pg_cron) bouwt deze function de
// dispatch-lijst van klant-notificaties:
//   - reminder_24h: alle beurten met plan_datum = morgen, status in
//     ('ingepland','toekomstig'), geen *_email_ts/_sms_ts/_whatsapp_ts
//   - reminder_day: alle beurten met plan_datum = vandaag, status='ingepland',
//     geen *_email_ts/_sms_ts/_whatsapp_ts
//
// Per beurt × kanaal vuren we PARALLEL fetch-calls naar de send-klant-* edge
// functions met service-role bearer. Failures van individuele beurten
// stoppen de batch niet (Promise.allSettled).
//
// AUTH: caller MOET service-role bearer presenteren (constant-time exact match).
// Geen public exposure.
//
// LOGGING: structured no-PII; aggregaten in response body.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

// ─── Config ──────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const FN_NAME = "dispatch-klant-notifications";

// Channel-toggles via env so we can disable SMS/WA in early phase
const ENABLE_EMAIL = (Deno.env.get("DISPATCH_ENABLE_EMAIL") || "true").toLowerCase() !== "false";
const ENABLE_SMS = (Deno.env.get("DISPATCH_ENABLE_SMS") || "true").toLowerCase() !== "false";
const ENABLE_WHATSAPP = (Deno.env.get("DISPATCH_ENABLE_WHATSAPP") || "true").toLowerCase() !== "false";

// Max beurten per run — defense against runaway DB query.
const DISPATCH_MAX_BATCH = parseInt(Deno.env.get("DISPATCH_MAX_BATCH") || "500", 10);

// ─── Types ───────────────────────────────────────────────────────────────────

interface BeurtForDispatch {
  id: string;
  contract_id: string | null;
  plan_datum: string | null;
  status: string | null;
  reminder_24h_email_ts: string | null;
  reminder_day_email_ts: string | null;
  reminder_24h_sms_ts: string | null;
  reminder_day_sms_ts: string | null;
  reminder_24h_whatsapp_ts: string | null;
  reminder_day_whatsapp_ts: string | null;
}

interface DispatchTotals {
  processed: number;
  sent_email: number;
  sent_sms: number;
  sent_whatsapp: number;
  skipped: number;
  failed: number;
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function logJson(meta: Record<string, unknown>): void {
  try { console.log(JSON.stringify({ fn: FN_NAME, ts: new Date().toISOString(), ...meta })); }
  catch { console.log(`${FN_NAME} log-failed`); }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function todayUtcDateStr(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  // YYYY-MM-DD
  return d.toISOString().slice(0, 10);
}

// Constant-time service-role compare
function isServiceRoleAuthorized(req: Request): boolean {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token || !SUPABASE_SERVICE_ROLE_KEY) return false;
  if (token.length !== SUPABASE_SERVICE_ROLE_KEY.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ SUPABASE_SERVICE_ROLE_KEY.charCodeAt(i);
  return diff === 0;
}

// ─── Handler ────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS" },
    });
  }
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    logJson({ event: "config_missing" });
    return json(500, { error: "server_misconfigured" });
  }

  // 1) Auth — service-role exact match only
  if (!isServiceRoleAuthorized(req)) {
    logJson({ event: "auth_rejected" });
    return json(401, { error: "unauthorized" });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const totals: DispatchTotals = {
    processed: 0, sent_email: 0, sent_sms: 0, sent_whatsapp: 0, skipped: 0, failed: 0,
  };

  const date_24h = todayUtcDateStr(1);  // tomorrow
  const date_day = todayUtcDateStr(0);  // today

  logJson({ event: "slot_f_dispatch_run", date_24h, date_day });

  try {
    // ─── reminder_24h batch (plan_datum = tomorrow, geen ts gezet) ─────────
    const beurten24h = await fetchPendingBeurten(admin, date_24h, "24h");
    for (const b of beurten24h) {
      if (totals.processed >= DISPATCH_MAX_BATCH) break;
      totals.processed++;
      await dispatchOneBeurt(b, "reminder_24h", totals);
    }

    // ─── reminder_day batch (plan_datum = today, status='ingepland', geen ts) ──
    const beurtenDay = await fetchPendingBeurten(admin, date_day, "day");
    for (const b of beurtenDay) {
      if (totals.processed >= DISPATCH_MAX_BATCH) break;
      totals.processed++;
      await dispatchOneBeurt(b, "reminder_day", totals);
    }

    logJson({ event: "slot_f_dispatch_done", ...totals });

    return json(200, { ok: true, date_24h, date_day, ...totals });

  } catch (err) {
    logJson({ event: "exception", err: err instanceof Error ? err.message : "unknown" });
    return json(500, { error: "internal_error", partial: totals });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchPendingBeurten(
  admin: SupabaseClient,
  planDatum: string,
  bucket: "24h" | "day",
): Promise<BeurtForDispatch[]> {
  const statusFilter = bucket === "day" ? ["ingepland"] : ["ingepland", "toekomstig"];

  // We fetch ALL channel-fields and filter per-channel inside dispatchOneBeurt.
  // The SQL OR-on-NULL would be complex; we read once and decide in-app.
  const { data, error } = await admin
    .from("onderhoudsbeurten")
    .select(`id, contract_id, plan_datum, status,
             reminder_24h_email_ts, reminder_day_email_ts,
             reminder_24h_sms_ts, reminder_day_sms_ts,
             reminder_24h_whatsapp_ts, reminder_day_whatsapp_ts`)
    .eq("plan_datum", planDatum)
    .in("status", statusFilter)
    .not("contract_id", "is", null)
    .limit(DISPATCH_MAX_BATCH);

  if (error) {
    logJson({ event: "fetch_failed", bucket, err: error.message });
    return [];
  }
  return (data || []) as BeurtForDispatch[];
}

async function dispatchOneBeurt(
  b: BeurtForDispatch,
  event: "reminder_24h" | "reminder_day",
  totals: DispatchTotals,
): Promise<void> {
  const tasks: Array<Promise<{ kanaal: "email" | "sms" | "whatsapp"; ok: boolean; skipped: boolean }>> = [];

  // Email
  if (ENABLE_EMAIL) {
    const tsField = `${event}_email_ts` as keyof BeurtForDispatch;
    if (!b[tsField]) tasks.push(invokeChannel(b.id, event, "email"));
  }
  // SMS
  if (ENABLE_SMS) {
    const tsField = `${event}_sms_ts` as keyof BeurtForDispatch;
    if (!b[tsField]) tasks.push(invokeChannel(b.id, event, "sms"));
  }
  // WhatsApp
  if (ENABLE_WHATSAPP) {
    const tsField = `${event}_whatsapp_ts` as keyof BeurtForDispatch;
    if (!b[tsField]) tasks.push(invokeChannel(b.id, event, "whatsapp"));
  }

  if (tasks.length === 0) return;

  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === "fulfilled") {
      const v = r.value;
      if (v.ok && !v.skipped) {
        if (v.kanaal === "email") totals.sent_email++;
        else if (v.kanaal === "sms") totals.sent_sms++;
        else if (v.kanaal === "whatsapp") totals.sent_whatsapp++;
      } else if (v.skipped) {
        totals.skipped++;
      } else {
        totals.failed++;
      }
    } else {
      totals.failed++;
    }
  }
}

async function invokeChannel(
  beurtId: string,
  event: "reminder_24h" | "reminder_day",
  kanaal: "email" | "sms" | "whatsapp",
): Promise<{ kanaal: "email" | "sms" | "whatsapp"; ok: boolean; skipped: boolean }> {
  const fnName = `send-klant-notification-${kanaal}`;
  const url = `${SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/${fnName}`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ beurt_id: beurtId, event_type: event }),
    });

    const result = await resp.json().catch(() => ({} as Record<string, unknown>));
    if (!resp.ok) {
      logJson({ event: "child_call_failed", child: fnName, status: resp.status });
      return { kanaal, ok: false, skipped: false };
    }
    const skipped = typeof (result as { skipped?: string }).skipped === "string";
    return { kanaal, ok: true, skipped };
  } catch (err) {
    logJson({ event: "child_call_exception", child: fnName, err: err instanceof Error ? err.message : "unknown" });
    return { kanaal, ok: false, skipped: false };
  }
}
