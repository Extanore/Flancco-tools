// seed-feestdagen-jaar — auto-extend BE feestdagen voor een gegeven jaar (Slot K).
// ─────────────────────────────────────────────────────────────────────
// Doel: jaarlijks (cron 1 december) automatisch volgend jaar's wettelijke
// feestdagen seeden in tabel `public.feestdagen`. Idempotent via UNIQUE(datum, label).
//
// Aanroep:
//   POST /functions/v1/seed-feestdagen-jaar?year=2028
//   Authorization: Bearer <admin-jwt>
//
// Default year = current_year + 1.
//
// Variabele feestdagen (Pasen + dependencies) berekend via Computus
// (Anonymous Gregorian algorithm, geldig 1583-4099).
//
// Security:
//   - verify_jwt = false in deployment (eigen Auth-implementatie in handler — zelfde
//     pattern als handle-opt-out, omdat we BOTH user-JWT (admin) EN service_role-JWT
//     (cron) moeten ondersteunen — Supabase's built-in JWT-verify weigert service_role)
//   - Auth-check: admin-role in user_roles OF service_role-JWT (cron)
//   - SERVICE_ROLE_KEY enkel server-side voor user_roles lookup + insert
//   - Rate-limit: 5 calls/uur per IP (laag — beheers-functie)
//   - Geen PII in response of logs
//
// Cron-setup (manueel via Supabase Dashboard):
//   1. Database → Cron Jobs → New
//   2. Name: 'feestdagen_jaarlijks_extend'
//   3. Schedule: '0 6 1 12 *'  (1 december, 06:00 UTC)
//   4. SQL:
//        SELECT net.http_post(
//          url := 'https://<PROJECT_REF>.supabase.co/functions/v1/seed-feestdagen-jaar',
//          headers := jsonb_build_object(
//            'Content-Type','application/json',
//            'Authorization','Bearer <SERVICE_ROLE_KEY>'
//          ),
//          body := '{}'::jsonb
//        );
//   Service-role-JWT bypasst onze admin-role-check (we accepteren service_role expliciet).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS")
  || "https://app.flancco-platform.be,https://flancco-platform.be,https://www.flancco-platform.be,https://extanore.github.io"
).split(",").map((s) => s.trim()).filter(Boolean);

const RATE_LIMIT_PER_HOUR = parseInt(Deno.env.get("FEESTDAGEN_RATE_LIMIT") || "5", 10);

// In-memory rate-limit (Deno isolate) — voldoende voor lage volumes.
const ipBuckets = new Map<string, { count: number; resetAt: number }>();

function rateLimit(ip: string): boolean {
  const now = Date.now();
  const bucket = ipBuckets.get(ip);
  if (!bucket || bucket.resetAt < now) {
    ipBuckets.set(ip, { count: 1, resetAt: now + 60 * 60 * 1000 });
    return true;
  }
  if (bucket.count >= RATE_LIMIT_PER_HOUR) return false;
  bucket.count++;
  return true;
}

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

function clientIp(req: Request): string {
  return (
    req.headers.get("CF-Connecting-IP") ||
    (req.headers.get("X-Forwarded-For") || "").split(",")[0].trim() ||
    "unknown"
  );
}

// ─────────────────────────────────────────────────────────────────────
// COMPUTUS — Anonymous Gregorian algorithm voor Pasen
// Geldig voor jaren 1583-4099. Returnt {year, month (1-12), day}.
// ─────────────────────────────────────────────────────────────────────
function easterDate(year: number): { y: number; m: number; d: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { y: year, m: month, d: day };
}

function dateToIso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function addDays(y: number, m: number, d: number, n: number): { y: number; m: number; d: number } {
  // JS Date in UTC om DST/timezone-edge cases te vermijden
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

// 10 wettelijke BE feestdagen voor een gegeven jaar
function buildFeestdagenFor(year: number): Array<{ datum: string; label: string }> {
  const easter = easterDate(year);
  const paasmaandag = addDays(easter.y, easter.m, easter.d, 1);
  const hemelvaart = addDays(easter.y, easter.m, easter.d, 39);
  const pinkstermaandag = addDays(easter.y, easter.m, easter.d, 50);

  return [
    { datum: dateToIso(year, 1, 1),                                  label: "Nieuwjaar" },
    { datum: dateToIso(paasmaandag.y, paasmaandag.m, paasmaandag.d), label: "Paasmaandag" },
    { datum: dateToIso(year, 5, 1),                                  label: "Dag van de Arbeid" },
    { datum: dateToIso(hemelvaart.y, hemelvaart.m, hemelvaart.d),    label: "O.L.H. Hemelvaart" },
    { datum: dateToIso(pinkstermaandag.y, pinkstermaandag.m, pinkstermaandag.d), label: "Pinkstermaandag" },
    { datum: dateToIso(year, 7, 21),                                 label: "Nationale Feestdag" },
    { datum: dateToIso(year, 8, 15),                                 label: "O.L.V. Hemelvaart" },
    { datum: dateToIso(year, 11, 1),                                 label: "Allerheiligen" },
    { datum: dateToIso(year, 11, 11),                                label: "Wapenstilstand" },
    { datum: dateToIso(year, 12, 25),                                label: "Kerstmis" },
  ];
}

// ─────────────────────────────────────────────────────────────────────
// Auth check: admin-role OF service_role-JWT
// ─────────────────────────────────────────────────────────────────────
async function isAuthorized(req: Request): Promise<{ ok: boolean; reason?: string }> {
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return { ok: false, reason: "missing_token" };
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) return { ok: false, reason: "missing_token" };

  // Pad 1: service_role-JWT (cron-call) — bypass, vol vertrouwen
  if (token === SUPABASE_SERVICE_ROLE_KEY) return { ok: true };

  // Pad 2: user-JWT — valideer + check user_roles.role='admin'
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userRes, error: userErr } = await sb.auth.getUser();
  if (userErr || !userRes?.user) return { ok: false, reason: "invalid_jwt" };

  // Lookup role via service-role client (omzeilt RLS op user_roles)
  const adminSb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: roleRow, error: roleErr } = await adminSb
    .from("user_roles")
    .select("role")
    .eq("user_id", userRes.user.id)
    .maybeSingle();
  if (roleErr) return { ok: false, reason: "role_lookup_failed" };
  if (!roleRow || roleRow.role !== "admin") return { ok: false, reason: "not_admin" };

  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  const corsHeaders = corsFor(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  const ip = clientIp(req);
  if (!rateLimit(ip)) {
    return new Response(
      JSON.stringify({ success: false, error: "rate_limited" }),
      { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Auth
  const auth = await isAuthorized(req);
  if (!auth.ok) {
    return new Response(
      JSON.stringify({ success: false, error: "unauthorized", reason: auth.reason }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Year-param (?year=2028) of body { year }, default = current_year + 1
  let year = new Date().getFullYear() + 1;
  try {
    const url = new URL(req.url);
    const qYear = url.searchParams.get("year");
    if (qYear) {
      const parsed = parseInt(qYear, 10);
      if (Number.isFinite(parsed)) year = parsed;
    } else if (req.headers.get("Content-Type")?.includes("application/json")) {
      const body = await req.json().catch(() => ({}));
      if (body?.year && Number.isFinite(body.year)) year = body.year;
    }
  } catch (_) { /* fallback to default */ }

  // Sanity-check: jaar in redelijk bereik (Computus is geldig 1583-4099)
  if (year < 2024 || year > 2100) {
    return new Response(
      JSON.stringify({ success: false, error: "year_out_of_range", year }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  try {
    const rows = buildFeestdagenFor(year).map((r) => ({
      datum: r.datum,
      label: r.label,
      type: "feestdag" as const,
      recurring: "jaarlijks" as const,
    }));

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Upsert via on_conflict — idempotent. ignoreDuplicates → INSERT...ON CONFLICT DO NOTHING.
    const { data, error } = await sb
      .from("feestdagen")
      .upsert(rows, { onConflict: "datum,label", ignoreDuplicates: true })
      .select("id");

    if (error) {
      console.error("[seed-feestdagen-jaar] upsert error:", error.message);
      return new Response(
        JSON.stringify({ success: false, error: "insert_failed" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const insertedCount = (data || []).length;
    console.log(JSON.stringify({
      fn: "seed-feestdagen-jaar",
      year,
      inserted_count: insertedCount,
      total_target: rows.length,
      ts: new Date().toISOString(),
    }));

    return new Response(
      JSON.stringify({
        success: true,
        year,
        inserted_count: insertedCount,
        total_target: rows.length,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[seed-feestdagen-jaar] exception:", (e as Error).message);
    return new Response(
      JSON.stringify({ success: false, error: "internal_error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
