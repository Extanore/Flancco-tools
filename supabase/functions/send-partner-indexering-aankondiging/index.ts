// send-partner-indexering-aankondiging
// =====================================
// Stuurt een NL aankondigings-mail naar elke actieve partner over een door
// admin geplande Flancco-basis tariefaanpassing (`pricing_indexering_planned`).
// Doel: partner krijgt minstens 30 dagen vóór effective_date een schriftelijke
// kennisgeving zoals contractueel afgesproken (opzegrecht-clausule).
//
// AUTH: verify_jwt = false. Public endpoint, maar enforced via Authorization
// header = SUPABASE_SERVICE_ROLE_KEY (constant-time exact match). Geen
// gebruikers-context — alleen het admin-platform of pg_cron mag dit triggeren.
//
// BODY:
//   { planned_indexering_id: uuid }
//     → fan-out: stuur naar alle actieve partners (uitgezonderd Flancco-zelf).
//   { planned_indexering_id: uuid, partner_id: uuid }
//     → single-partner mode (re-send, of test).
//
// ALLEEN STUUR als `aangekondigd_op IS NOT NULL` op de planned-rij. Een
// draft-planning (zonder admin-aankondiging-bevestiging) wordt geweigerd
// met `not_announced_yet`.
//
// MAIL: Flancco-branded NL (zoals send-partner-application-confirmation),
// vermeldt expliciet de 30-dagen opzeg-clausule.
//
// LOGGING: structured zonder PII. Tellingen sent / failed in response.
//
// AUDIT: er wordt geen DB-write gedaan voor partner-aankondiging-status; de
// effectieve aankondiging-datum is `aangekondigd_op` op de planned-rij zelf
// (door admin gezet via wizard). Deze functie verstuurt enkel de mail.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const FN_NAME = "send-partner-indexering-aankondiging";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";

const EMAIL_FROM_ADDRESS = Deno.env.get("EMAIL_FROM_ADDRESS")
  ?? "Flancco <noreply@flancco-platform.be>";
const EMAIL_REPLY_TO = Deno.env.get("EMAIL_REPLY_TO")
  ?? "gillian.geernaert@flancco.be";

const APP_BASE_URL = (Deno.env.get("APP_BASE_URL") ?? "https://app.flancco-platform.be")
  .replace(/\/$/, "");

const RATE_BUCKET = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;

function rateLimit(ip: string): { ok: boolean; remaining: number; resetIn: number } {
  if (!ip) return { ok: true, remaining: RATE_LIMIT, resetIn: 0 };
  const now = Date.now();
  const entry = RATE_BUCKET.get(ip);
  if (!entry || entry.resetAt < now) {
    RATE_BUCKET.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { ok: true, remaining: RATE_LIMIT - 1, resetIn: RATE_WINDOW_MS };
  }
  if (entry.count >= RATE_LIMIT) {
    return { ok: false, remaining: 0, resetIn: entry.resetAt - now };
  }
  entry.count++;
  return { ok: true, remaining: RATE_LIMIT - entry.count, resetIn: entry.resetAt - now };
}

function getClientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip")
    || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim()
    || req.headers.get("x-real-ip")
    || "";
}

function isServiceRoleAuthorized(req: Request): boolean {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token || !SUPABASE_SERVICE_ROLE_KEY) return false;
  if (token.length !== SUPABASE_SERVICE_ROLE_KEY.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) {
    diff |= token.charCodeAt(i) ^ SUPABASE_SERVICE_ROLE_KEY.charCodeAt(i);
  }
  return diff === 0;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "3600",
};

interface PlannedRow {
  id: string;
  effective_date: string;
  pct_increase: number;
  scope_sectoren: string[] | null;
  reden: string | null;
  aangekondigd_op: string | null;
  applied_at: string | null;
  cancelled_at: string | null;
}

interface PartnerRow {
  id: string;
  bedrijfsnaam: string | null;
  naam: string | null;
  slug: string | null;
  email: string | null;
  communicatie_email: string | null;
  actief: boolean | null;
}

interface SendDetail {
  partner_id: string;
  recipient_domain: string | null;
  ok: boolean;
  status?: number;
  reason?: string;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResp(405, { error: "method_not_allowed" });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !RESEND_API_KEY) {
    console.error(`[${FN_NAME}] server_misconfigured`);
    return jsonResp(500, { error: "server_misconfigured" });
  }

  const ip = getClientIp(req);
  const rl = rateLimit(ip);
  if (!rl.ok) {
    return new Response(
      JSON.stringify({ error: "rate_limit_exceeded", reset_in_ms: rl.resetIn }),
      {
        status: 429,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json",
          "Retry-After": String(Math.ceil(rl.resetIn / 1000)),
        },
      },
    );
  }

  if (!isServiceRoleAuthorized(req)) {
    console.log(`[${FN_NAME}] auth_rejected`);
    return jsonResp(401, { error: "unauthorized" });
  }

  let body: { planned_indexering_id?: string; partner_id?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResp(400, { error: "invalid_json" });
  }

  const plannedId = body?.planned_indexering_id;
  const singlePartnerId = body?.partner_id ?? null;

  if (!plannedId || typeof plannedId !== "string") {
    return jsonResp(400, { error: "missing_planned_indexering_id" });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: planned, error: plannedErr } = await admin
    .from("pricing_indexering_planned")
    .select("id, effective_date, pct_increase, scope_sectoren, reden, aangekondigd_op, applied_at, cancelled_at")
    .eq("id", plannedId)
    .maybeSingle<PlannedRow>();

  if (plannedErr || !planned) {
    console.warn(`[${FN_NAME}] planned_not_found`, { plannedId, err: plannedErr?.message });
    return jsonResp(200, { error: "planned_not_found", skipped: true });
  }
  if (planned.cancelled_at) {
    return jsonResp(200, { error: "planned_cancelled", skipped: true });
  }
  if (!planned.aangekondigd_op) {
    return jsonResp(200, { error: "not_announced_yet", skipped: true });
  }

  const partnersQuery = admin
    .from("partners")
    .select("id, bedrijfsnaam, naam, slug, email, communicatie_email, actief")
    .eq("actief", true)
    .neq("slug", "flancco");

  if (singlePartnerId) {
    partnersQuery.eq("id", singlePartnerId);
  }

  const { data: partners, error: partnersErr } = await partnersQuery;
  if (partnersErr) {
    console.error(`[${FN_NAME}] partners_select_failed`, { err: partnersErr.message });
    return jsonResp(200, { error: "partners_select_failed", skipped: true });
  }

  const rows = (partners ?? []) as PartnerRow[];
  if (rows.length === 0) {
    return jsonResp(200, { sent: 0, failed: 0, details: [] });
  }

  const sectorenLabel = formatSectoren(planned.scope_sectoren);
  const effectiveLabel = formatDate(planned.effective_date);
  const pctLabel = formatPct(planned.pct_increase);

  const results = await Promise.allSettled(
    rows.map(async (p): Promise<SendDetail> => {
      const recipient = (p.communicatie_email || p.email || "").trim();
      if (!recipient) {
        return { partner_id: p.id, recipient_domain: null, ok: false, reason: "missing_email" };
      }
      const domain = recipient.split("@")[1] ?? null;

      const partnerLabel = (p.bedrijfsnaam || p.naam || "uw onderneming").trim();
      const subject = `Aankondiging: tariefaanpassing per ${effectiveLabel}`;
      const html = buildPartnerHtml({
        partnerLabel,
        effectiveLabel,
        pctLabel,
        sectorenLabel,
        reden: planned.reden,
      });

      try {
        const resp = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${RESEND_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: EMAIL_FROM_ADDRESS,
            to: recipient,
            subject,
            html,
            reply_to: EMAIL_REPLY_TO,
          }),
        });
        return {
          partner_id: p.id,
          recipient_domain: domain,
          ok: resp.ok,
          status: resp.status,
          ...(resp.ok ? {} : { reason: `resend_status_${resp.status}` }),
        };
      } catch (e) {
        return {
          partner_id: p.id,
          recipient_domain: domain,
          ok: false,
          reason: `fetch_failed: ${(e as Error).message}`,
        };
      }
    }),
  );

  const details: SendDetail[] = [];
  let sent = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === "fulfilled") {
      details.push(r.value);
      r.value.ok ? sent++ : failed++;
    } else {
      failed++;
      details.push({ partner_id: "?", recipient_domain: null, ok: false, reason: "rejected" });
    }
  }

  console.log(`[${FN_NAME}] dispatched`, {
    plannedId,
    singlePartnerId,
    sent,
    failed,
    total: rows.length,
  });

  return jsonResp(200, { sent, failed, total: rows.length, details });
});

function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso + (iso.length === 10 ? "T00:00:00Z" : "")).toLocaleDateString("nl-BE", {
      day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Brussels",
    });
  } catch {
    return String(iso);
  }
}

function formatPct(p: number | null | undefined): string {
  if (p == null || Number.isNaN(p)) return "—";
  return `${(Math.round(Number(p) * 100) / 100).toString().replace(".", ",")}%`;
}

function formatSectoren(arr: string[] | null | undefined): string {
  if (!arr || arr.length === 0) return "alle sectoren";
  const labels: Record<string, string> = {
    warmtepomp: "Warmtepomp",
    zonnepanelen: "Zonnepanelen",
    ventilatie: "Ventilatie",
    verwarming: "Verwarming",
  };
  return arr.map((s) => labels[s] ?? s).join(", ");
}

interface PartnerHtmlCtx {
  partnerLabel: string;
  effectiveLabel: string;
  pctLabel: string;
  sectorenLabel: string;
  reden: string | null;
}

function buildPartnerHtml(c: PartnerHtmlCtx): string {
  const partnerSettingsUrl = `${APP_BASE_URL}/admin/?page=instellingen#partner-contract`;
  const redenBlock = (c.reden && c.reden.trim().length > 0)
    ? `<tr><td style="padding:6px 0;color:#6b7280">Reden</td><td style="padding:6px 0;color:#1f2937">${escHtml(c.reden)}</td></tr>`
    : "";

  return `<!DOCTYPE html>
<html lang="nl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aankondiging tariefaanpassing</title></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#F3F4F6;color:#1A1A2E">
<div style="max-width:620px;margin:0 auto;padding:20px">
  <div style="background:#1A1A2E;color:#FFF;padding:28px 32px;border-radius:12px 12px 0 0;text-align:center">
    <h1 style="margin:0;font-size:22px;letter-spacing:1.5px">FLANCCO</h1>
    <p style="margin:6px 0 0;opacity:0.9;font-size:14px">Aankondiging tariefaanpassing basisprijslijst</p>
  </div>
  <div style="background:#FFF;padding:32px;border-radius:0 0 12px 12px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb">
    <h2 style="color:#E74C3C;font-size:20px;margin:0 0 20px">Beste partner van ${escHtml(c.partnerLabel)}</h2>

    <p style="font-size:14px;line-height:1.7;margin:0 0 16px">
      We informeren u over een aanpassing van de Flancco-basisprijslijst.
      Deze aanpassing wordt automatisch toegepast op alle nieuwe contracten
      die vanaf de hieronder vermelde datum worden opgemaakt via uw calculator.
    </p>

    <div style="background:#F8F9FA;border-left:3px solid #E74C3C;border-radius:8px;padding:20px;margin:24px 0">
      <h3 style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:1.2px">Samenvatting</h3>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr><td style="padding:6px 0;color:#6b7280;width:40%">Effectief vanaf</td><td style="padding:6px 0;color:#1f2937;font-weight:600">${escHtml(c.effectiveLabel)}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Verhoging</td><td style="padding:6px 0;color:#1f2937;font-weight:600">${escHtml(c.pctLabel)}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Scope</td><td style="padding:6px 0;color:#1f2937">${escHtml(c.sectorenLabel)}</td></tr>
        ${redenBlock}
      </table>
    </div>

    <h3 style="font-size:15px;margin:28px 0 12px;color:#1f2937">Wat verandert er voor u?</h3>
    <ul style="margin:0 0 16px;padding-left:20px;font-size:14px;line-height:1.8;color:#374151">
      <li>De Flancco-basisforfaits in uw calculator worden automatisch aangepast op ${escHtml(c.effectiveLabel)}.</li>
      <li>Uw eigen marge en planning-fee blijven ongewijzigd — die beheert u zelf.</li>
      <li><strong>Lopende contracten met eindklanten worden niet geraakt.</strong> Bestaande klantcontracten volgen hun eigen indexering-clausule (gezondheidsindex met cap).</li>
    </ul>

    <div style="background:#FFF7ED;border-left:3px solid #F59E0B;border-radius:8px;padding:18px 20px;margin:24px 0;font-size:14px;line-height:1.7;color:#92400e">
      <strong style="color:#78350f">Uw opzeg-recht</strong><br>
      Conform de partner-overeenkomst hebt u het recht om de samenwerking
      schriftelijk op te zeggen binnen <strong>30 dagen</strong> na deze
      aankondiging, mocht u zich niet kunnen vinden in deze tariefaanpassing.
      De volledige clausule en de geldende contractversie vindt u in uw
      partner-instellingen.
    </div>

    <p style="margin:24px 0">
      <a href="${escUrl(partnerSettingsUrl)}" style="display:inline-block;background:#1A1A2E;color:#FFF;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px">Bekijk uw partner-contract</a>
    </p>

    <div style="margin-top:32px;padding-top:24px;border-top:1px solid #e5e7eb">
      <p style="font-size:14px;color:#6b7280;margin:0 0 8px">Vragen of opmerkingen?</p>
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
