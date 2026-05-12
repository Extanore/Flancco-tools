// send-klant-indexering-aankondiging
// ===================================
// Stuurt een NL aankondigings-mail naar de eindklant 14 dagen vóór zijn
// contract-verjaardag, met preview van de nieuwe prijzen op basis van de
// laatst gekende Belgische gezondheidsindex (cap min/max uit contract).
// Partner-branding (kleur, logo, naam) wordt overgenomen.
//
// AUTH: verify_jwt = false. Public endpoint, maar enforced via Authorization
// header = SUPABASE_SERVICE_ROLE_KEY (constant-time exact match). Aangeroepen
// door pg_cron (dispatch_klant_indexering_aankondigingen) of admin-UI.
//
// BODY:
//   { contract_id: uuid, gepland_voor_datum?: 'YYYY-MM-DD' }
//
// LOGICA:
//   - Lookup contract + partner + huidige gezondheidsindex
//   - Bereken capped_pct + preview nieuwe prijzen (forfait + totaal_incl_btw)
//   - Verstuur via Resend (Flancco-from, partner-styled HTML)
//   - UPDATE contract_indexering_announcements rij (sent|failed)
//
// IDEMPOTENTIE: de cron-helper schrijft pré-INSERT een 'pending' rij; deze
// edge fn UPDATE't die rij naar 'sent' of 'failed'. Bij direct-admin-call
// (zonder cron-pre-claim) wordt de rij hier opgezet via UPSERT.
//
// LOGGING: geen PII; alleen contract_id + status. Recipient masked.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const FN_NAME = "send-klant-indexering-aankondiging";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";

const EMAIL_FROM_ADDRESS = Deno.env.get("EMAIL_FROM_ADDRESS")
  ?? "Flancco <noreply@flancco-platform.be>";
const EMAIL_REPLY_TO = Deno.env.get("EMAIL_REPLY_TO")
  ?? "gillian.geernaert@flancco.be";

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

// CORS — Allow-Origin gewhitelist op productie-domeinen (admin/portal + calculator).
// Override via ALLOWED_ORIGINS env var (comma-separated) voor staging-domeinen.
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS")
  ?? "https://flancco-platform.be,https://app.flancco-platform.be,https://www.flancco-platform.be,https://calculator.flancco-platform.be"
).split(",").map((s) => s.trim()).filter(Boolean);

function corsFor(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0] ?? "null";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "3600",
    "Vary": "Origin",
  };
}

interface ContractRow {
  id: string;
  partner_id: string | null;
  klant_naam: string | null;
  klant_email: string | null;
  klant_subtype: string | null;
  bedrijfsnaam: string | null;
  contract_nummer: string | null;
  contract_start: string | null;
  forfait_bedrag: number | null;
  totaal_incl_btw: number | null;
  supplement_vervuiling: number | null;
  supplement_transport: number | null;
  supplement_hoogte: number | null;
  indexering_min_pct: number | null;
  indexering_max_pct: number | null;
  indexering_start_index: number | null;
  btw_type: string | null;
  sector: string | null;
  frequentie: string | null;
}

interface PartnerRow {
  id: string;
  bedrijfsnaam: string | null;
  naam: string | null;
  slug: string | null;
  email: string | null;
  telefoon: string | null;
  kleur_primair: string | null;
  kleur_donker: string | null;
  logo_url: string | null;
}

interface IndexRow {
  waarde: number;
  jaar: number;
  maand: number;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const corsHeaders = corsFor(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResp(405, { error: "method_not_allowed" }, corsHeaders);
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !RESEND_API_KEY) {
    console.error(`[${FN_NAME}] server_misconfigured`);
    return jsonResp(500, { error: "server_misconfigured" }, corsHeaders);
  }

  const ip = getClientIp(req);
  const rl = rateLimit(ip);
  if (!rl.ok) {
    return new Response(
      JSON.stringify({ error: "rate_limit_exceeded", reset_in_ms: rl.resetIn }),
      {
        status: 429,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "Retry-After": String(Math.ceil(rl.resetIn / 1000)),
        },
      },
    );
  }

  if (!isServiceRoleAuthorized(req)) {
    console.log(`[${FN_NAME}] auth_rejected`);
    return jsonResp(401, { error: "unauthorized" }, corsHeaders);
  }

  let body: { contract_id?: string; gepland_voor_datum?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResp(400, { error: "invalid_json" }, corsHeaders);
  }

  const contractId = body?.contract_id;
  if (!contractId || typeof contractId !== "string") {
    return jsonResp(400, { error: "missing_contract_id" }, corsHeaders);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: contract, error: contractErr } = await admin
    .from("contracten")
    .select(`
      id, partner_id, klant_naam, klant_email, klant_subtype, bedrijfsnaam,
      contract_nummer, contract_start, forfait_bedrag, totaal_incl_btw,
      supplement_vervuiling, supplement_transport, supplement_hoogte,
      indexering_min_pct, indexering_max_pct, indexering_start_index,
      btw_type, sector, frequentie
    `)
    .eq("id", contractId)
    .maybeSingle<ContractRow>();

  if (contractErr || !contract) {
    console.warn(`[${FN_NAME}] contract_not_found`, { contractId, err: contractErr?.message });
    return jsonResp(200, { error: "contract_not_found", skipped: true }, corsHeaders);
  }

  if (!contract.klant_email) {
    return await finalize(admin, contractId, body?.gepland_voor_datum ?? null, "skipped",
      "missing_klant_email", null, corsHeaders);
  }

  if (!contract.indexering_start_index || contract.indexering_start_index <= 0) {
    return await finalize(admin, contractId, body?.gepland_voor_datum ?? null, "skipped",
      "missing_start_index", null, corsHeaders);
  }

  let partner: PartnerRow | null = null;
  if (contract.partner_id) {
    const { data: p } = await admin
      .from("partners")
      .select("id, bedrijfsnaam, naam, slug, email, telefoon, kleur_primair, kleur_donker, logo_url")
      .eq("id", contract.partner_id)
      .maybeSingle<PartnerRow>();
    partner = p ?? null;
  }

  const { data: idx, error: idxErr } = await admin
    .from("gezondheidsindex_metingen")
    .select("waarde, jaar, maand")
    .order("jaar", { ascending: false })
    .order("maand", { ascending: false })
    .limit(1)
    .maybeSingle<IndexRow>();

  if (idxErr || !idx) {
    console.warn(`[${FN_NAME}] no_index_meting`);
    return await finalize(admin, contractId, body?.gepland_voor_datum ?? null, "skipped",
      "no_index_meting", null, corsHeaders);
  }

  const startIndex = Number(contract.indexering_start_index);
  const minPct = Number(contract.indexering_min_pct ?? 1.5);
  const maxPct = Number(contract.indexering_max_pct ?? 4.0);

  const rawPct = (Number(idx.waarde) / startIndex - 1) * 100;
  const pctUsed = Math.min(Math.max(rawPct, minPct), maxPct);
  const factor = 1 + pctUsed / 100;

  const oudForfait = nullableNum(contract.forfait_bedrag);
  const oudTotaal = nullableNum(contract.totaal_incl_btw);
  const nieuwForfait = oudForfait == null ? null : round2(oudForfait * factor);
  const nieuwTotaal = oudTotaal == null ? null : round2(oudTotaal * factor);

  const verjaardag = computeNextAnniversary(contract.contract_start);

  const klantLabel = contract.klant_subtype === "bedrijf"
    ? (contract.bedrijfsnaam || contract.klant_naam || "klant")
    : (contract.klant_naam || "klant");

  const partnerLabel = partner?.bedrijfsnaam || partner?.naam || "Flancco";
  const subject = `Tariefaanpassing voor je onderhoudscontract — vanaf ${formatDate(verjaardag)}`;
  const html = buildKlantHtml({
    klantLabel,
    partnerLabel,
    contractNummer: contract.contract_nummer,
    sector: contract.sector,
    frequentie: contract.frequentie,
    verjaardagLabel: formatDate(verjaardag),
    pctLabel: formatPct(pctUsed),
    pctMinLabel: formatPct(minPct),
    pctMaxLabel: formatPct(maxPct),
    oudForfaitLabel: formatEur(oudForfait),
    nieuwForfaitLabel: formatEur(nieuwForfait),
    oudTotaalLabel: formatEur(oudTotaal),
    nieuwTotaalLabel: formatEur(nieuwTotaal),
    kleurPrimair: sanitizeColor(partner?.kleur_primair, "#1A1A2E"),
    kleurDonker:  sanitizeColor(partner?.kleur_donker,  "#0F0F1F"),
    logoUrl:      partner?.logo_url ?? null,
    partnerEmail: partner?.email ?? null,
    partnerTelefoon: partner?.telefoon ?? null,
  });

  const recipient = contract.klant_email;
  let resendOk = false;
  let providerStatus: number | undefined;
  let reason: string | undefined;

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
    resendOk = resp.ok;
    providerStatus = resp.status;
    if (!resp.ok) reason = `resend_status_${resp.status}`;
  } catch (e) {
    reason = `fetch_failed: ${(e as Error).message}`;
  }

  const newStatus: "sent" | "failed" = resendOk ? "sent" : "failed";
  return await finalize(
    admin,
    contractId,
    body?.gepland_voor_datum ?? verjaardag,
    newStatus,
    reason ?? null,
    maskEmail(recipient),
    corsHeaders,
    providerStatus,
  );
});

async function finalize(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  contractId: string,
  geplandVoorDatum: string | null,
  status: "sent" | "failed" | "skipped",
  reason: string | null,
  maskedRecipient: string | null,
  corsHeaders: Record<string, string>,
  providerStatus?: number,
): Promise<Response> {
  if (geplandVoorDatum) {
    try {
      const { data: existing } = await admin
        .from("contract_indexering_announcements")
        .select("id")
        .eq("contract_id", contractId)
        .eq("gepland_voor_datum", geplandVoorDatum)
        .maybeSingle();

      if (existing?.id) {
        await admin
          .from("contract_indexering_announcements")
          .update({
            status,
            verzonden_op: status === "sent" ? new Date().toISOString() : null,
            recipient: maskedRecipient,
            error_detail: reason,
          })
          .eq("id", existing.id);
      } else {
        await admin
          .from("contract_indexering_announcements")
          .insert({
            contract_id: contractId,
            gepland_voor_datum: geplandVoorDatum,
            status,
            verzonden_op: status === "sent" ? new Date().toISOString() : null,
            recipient: maskedRecipient,
            error_detail: reason,
          });
      }
    } catch (e) {
      console.error(`[${FN_NAME}] announcement_write_failed`, { contractId, err: (e as Error).message });
    }
  }

  console.log(`[${FN_NAME}] dispatched`, {
    contractId,
    status,
    reason: reason ?? undefined,
    providerStatus,
  });

  return jsonResp(200, {
    ok: status === "sent",
    status,
    reason: reason ?? undefined,
  }, corsHeaders);
}

function jsonResp(status: number, body: unknown, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function nullableNum(v: number | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
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

function formatEur(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("nl-BE", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(n));
}

function computeNextAnniversary(contractStart: string | null): string | null {
  if (!contractStart) return null;
  try {
    const d = new Date(contractStart + "T00:00:00Z");
    const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
    const candidate = new Date(Date.UTC(today.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    if (candidate.getTime() < today.getTime()) {
      candidate.setUTCFullYear(candidate.getUTCFullYear() + 1);
    }
    return candidate.toISOString().slice(0, 10);
  } catch {
    return contractStart;
  }
}

function maskEmail(e: string | null | undefined): string | null {
  if (!e) return null;
  const [local, domain] = e.split("@");
  if (!domain) return e;
  const head = local.length <= 2 ? local[0] ?? "" : local.slice(0, 2);
  return `${head}***@${domain}`;
}

/** Laat enkel hex-kleuren door (#RGB / #RRGGBB). Default-fallback bij ongeldige input. */
function sanitizeColor(v: string | null | undefined, fallback: string): string {
  const s = String(v ?? "").trim();
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s) ? s : fallback;
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

function escUrl(s: string | null | undefined): string {
  const v = String(s ?? "").trim();
  if (!v) return "";
  if (/^(https?:|mailto:)/i.test(v)) {
    return v.replace(/"/g, "%22").replace(/</g, "%3C").replace(/>/g, "%3E");
  }
  return "";
}

interface KlantHtmlCtx {
  klantLabel: string;
  partnerLabel: string;
  contractNummer: string | null;
  sector: string | null;
  frequentie: string | null;
  verjaardagLabel: string;
  pctLabel: string;
  pctMinLabel: string;
  pctMaxLabel: string;
  oudForfaitLabel: string;
  nieuwForfaitLabel: string;
  oudTotaalLabel: string;
  nieuwTotaalLabel: string;
  kleurPrimair: string;
  kleurDonker: string;
  logoUrl: string | null;
  partnerEmail: string | null;
  partnerTelefoon: string | null;
}

function buildKlantHtml(c: KlantHtmlCtx): string {
  const logoBlock = c.logoUrl
    ? `<img src="${escUrl(c.logoUrl)}" alt="${escAttr(c.partnerLabel)}" style="max-height:48px;max-width:200px;display:block;margin:0 auto 8px"/>`
    : `<h1 style="margin:0;font-size:22px;letter-spacing:1px;color:#FFF">${escHtml(c.partnerLabel.toUpperCase())}</h1>`;

  const contractRef = c.contractNummer
    ? `<tr><td style="padding:6px 0;color:#6b7280;width:40%">Contractnummer</td><td style="padding:6px 0;color:#1f2937">${escHtml(c.contractNummer)}</td></tr>`
    : "";
  const sectorRow = c.sector
    ? `<tr><td style="padding:6px 0;color:#6b7280">Sector</td><td style="padding:6px 0;color:#1f2937">${escHtml(formatSectorLabel(c.sector))}</td></tr>`
    : "";
  const frequentieRow = c.frequentie
    ? `<tr><td style="padding:6px 0;color:#6b7280">Frequentie</td><td style="padding:6px 0;color:#1f2937">${escHtml(c.frequentie)}</td></tr>`
    : "";

  const partnerFooterContact = c.partnerEmail || c.partnerTelefoon
    ? `<p style="font-size:14px;margin:0;line-height:1.7">
         <strong style="color:#1f2937">${escHtml(c.partnerLabel)}</strong><br>
         ${c.partnerEmail ? `<a href="mailto:${escAttr(c.partnerEmail)}" style="color:${escAttr(c.kleurDonker)};text-decoration:none">${escHtml(c.partnerEmail)}</a><br>` : ""}
         ${c.partnerTelefoon ? `<span style="color:#374151">${escHtml(c.partnerTelefoon)}</span>` : ""}
       </p>`
    : `<p style="font-size:14px;margin:0;line-height:1.7"><strong style="color:#1f2937">${escHtml(c.partnerLabel)}</strong></p>`;

  return `<!DOCTYPE html>
<html lang="nl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tariefaanpassing onderhoudscontract</title></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#F3F4F6;color:#1A1A2E">
<div style="max-width:620px;margin:0 auto;padding:20px">
  <div style="background:${escAttr(c.kleurPrimair)};color:#FFF;padding:28px 32px;border-radius:12px 12px 0 0;text-align:center">
    ${logoBlock}
    <p style="margin:6px 0 0;opacity:0.95;font-size:14px;color:#FFF">Aankondiging tariefaanpassing</p>
  </div>
  <div style="background:#FFF;padding:32px;border-radius:0 0 12px 12px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb">
    <h2 style="color:${escAttr(c.kleurDonker)};font-size:20px;margin:0 0 20px">Beste ${escHtml(c.klantLabel)}</h2>

    <p style="font-size:14px;line-height:1.7;margin:0 0 16px">
      Conform de indexering-clausule (artikel 3) van uw onderhoudscontract,
      worden de tarieven aangepast op uw eerstvolgende contract-verjaardag.
      We informeren u graag tijdig over de nieuwe prijzen.
    </p>

    <div style="background:#F8F9FA;border-left:3px solid ${escAttr(c.kleurPrimair)};border-radius:8px;padding:20px;margin:24px 0">
      <h3 style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:1.2px">Uw contract</h3>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        ${contractRef}
        ${sectorRow}
        ${frequentieRow}
        <tr><td style="padding:6px 0;color:#6b7280;width:40%">Indexering vanaf</td><td style="padding:6px 0;color:#1f2937;font-weight:600">${escHtml(c.verjaardagLabel)}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Aanpassing</td><td style="padding:6px 0;color:#1f2937;font-weight:600">${escHtml(c.pctLabel)}</td></tr>
      </table>
    </div>

    <h3 style="font-size:15px;margin:28px 0 12px;color:#1f2937">Nieuwe prijzen</h3>
    <table style="width:100%;border-collapse:collapse;font-size:14px;background:#FFF;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
      <thead>
        <tr style="background:#F9FAFB">
          <th style="padding:10px 12px;text-align:left;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:1px">Onderdeel</th>
          <th style="padding:10px 12px;text-align:right;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:1px">Huidig</th>
          <th style="padding:10px 12px;text-align:right;font-size:12px;color:${escAttr(c.kleurDonker)};text-transform:uppercase;letter-spacing:1px">Vanaf ${escHtml(c.verjaardagLabel)}</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td style="padding:10px 12px;color:#1f2937;border-top:1px solid #e5e7eb">Forfait per beurt</td>
          <td style="padding:10px 12px;color:#374151;border-top:1px solid #e5e7eb;text-align:right">${escHtml(c.oudForfaitLabel)}</td>
          <td style="padding:10px 12px;color:${escAttr(c.kleurDonker)};font-weight:600;border-top:1px solid #e5e7eb;text-align:right">${escHtml(c.nieuwForfaitLabel)}</td>
        </tr>
        <tr>
          <td style="padding:10px 12px;color:#1f2937;border-top:1px solid #e5e7eb">Totaal contract (incl. btw)</td>
          <td style="padding:10px 12px;color:#374151;border-top:1px solid #e5e7eb;text-align:right">${escHtml(c.oudTotaalLabel)}</td>
          <td style="padding:10px 12px;color:${escAttr(c.kleurDonker)};font-weight:600;border-top:1px solid #e5e7eb;text-align:right">${escHtml(c.nieuwTotaalLabel)}</td>
        </tr>
      </tbody>
    </table>

    <div style="background:#F8FAFC;border-left:3px solid #94A3B8;border-radius:8px;padding:18px 20px;margin:24px 0;font-size:13px;line-height:1.7;color:#475569">
      De aanpassing is gebaseerd op de Belgische gezondheidsindex, met een
      contractueel afgesproken cap tussen ${escHtml(c.pctMinLabel)} en ${escHtml(c.pctMaxLabel)} per jaar.
      De definitieve berekening gebeurt op uw verjaardag-datum zelf; bovenstaande
      bedragen zijn de huidige preview (kan licht afwijken indien er een nieuwere
      indexmeting wordt gepubliceerd).
    </div>

    <h3 style="font-size:15px;margin:28px 0 12px;color:#1f2937">Wat moet u doen?</h3>
    <p style="font-size:14px;line-height:1.7;margin:0 0 16px;color:#374151">
      Niets. De nieuwe tarieven worden automatisch toegepast vanaf ${escHtml(c.verjaardagLabel)}.
      Uw eerstvolgende factuur reflecteert de nieuwe prijzen. Hebt u vragen of
      opmerkingen, neem dan contact op met ${escHtml(c.partnerLabel)}.
    </p>

    <div style="margin-top:32px;padding-top:24px;border-top:1px solid #e5e7eb">
      ${partnerFooterContact}
    </div>

    <p style="margin-top:24px;font-size:14px;line-height:1.7">Met vriendelijke groet,<br><strong>${escHtml(c.partnerLabel)}</strong></p>
  </div>
  <p style="text-align:center;margin:16px 0 0;color:#999;font-size:11px">${escHtml(c.partnerLabel)} &mdash; via het Flancco onderhoudsplatform</p>
</div>
</body>
</html>`;
}

function formatSectorLabel(s: string): string {
  const labels: Record<string, string> = {
    warmtepomp: "Warmtepomp",
    zonnepanelen: "Zonnepanelen",
    ventilatie: "Ventilatie",
    verwarming: "Verwarming",
  };
  return labels[s] ?? s;
}
