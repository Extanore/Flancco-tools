// send-confirmation — bevestigingsmail ná contractondertekening.
//
// Wettelijke functie: deze mail ontvangt de klant na signing en bevat als verplichte bijlagen:
//   1. Het ondertekende contract als PDF (uit bucket `contracten-pdf`, via `contracten.pdf_url`).
//   2. Het wettelijke modelformulier voor herroeping (dynamisch gegenereerd, EU 2011/83/EU).
//
// Zonder deze bijlagen start de 14-daagse herroepingstermijn juridisch niet (art. VI.53 WER).
// Bij ontbreken van de contract-PDF sturen we de mail alsnog, maar markeren dit als warning
// zodat de admin kan bijsturen.
//
// Note: verify_jwt = false op deze functie (public call vanuit calculator post-signing).
// Validatie gebeurt via:
//   - contract_id moet bestaan én status === 'getekend'
//   - contract mag niet ouder zijn dan SEND_CONFIRM_MAX_AGE_MIN (default 30 min)
//   - Geen herzenden: `verzonden_bevestiging_op` moet NULL zijn (anders skip)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { generateHerroepingsformulierPdf, uint8ToBase64 } from "../_shared/herroeping.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// v4: sender gemigreerd naar @flancco-platform.be. Reply-to behoudt actief Flancco-postvak.
const FROM_ADDRESS = Deno.env.get("CONFIRM_FROM_ADDRESS") || "noreply@flancco-platform.be";
const REPLY_TO     = Deno.env.get("CONFIRM_REPLY_TO")     || "gillian.geernaert@flancco.be";

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS")
  || "https://app.flancco-platform.be,https://calculator.flancco-platform.be,https://flancco-platform.be,https://www.flancco-platform.be,https://extanore.github.io"
).split(",").map((s) => s.trim()).filter(Boolean);

const MAX_AGE_MINUTES = parseInt(Deno.env.get("SEND_CONFIRM_MAX_AGE_MIN") || "30", 10);

// Juridische Flancco-entiteit voor het herroepingsformulier.
const FLANCCO_LEGAL_NAME    = Deno.env.get("FLANCCO_LEGAL_NAME")    ?? "Flancco BV";
const FLANCCO_LEGAL_ADDRESS = Deno.env.get("FLANCCO_LEGAL_ADDRESS") ?? "Industrieweg 25, 9080 Lochristi, België";
const FLANCCO_LEGAL_EMAIL   = Deno.env.get("FLANCCO_LEGAL_EMAIL")   ?? "gillian.geernaert@flancco.be";
const FLANCCO_LEGAL_VAT     = Deno.env.get("FLANCCO_LEGAL_VAT")     ?? "";

function corsFor(req: Request) {
  const origin = req.headers.get("Origin") || "";
  const allow = ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes("*") ? (origin || "*") : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  } as Record<string, string>;
}

Deno.serve(async (req: Request) => {
  const corsHeaders = corsFor(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  try {
    if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY not configured");

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const contract_id = body?.contract_id;
    if (!contract_id || typeof contract_id !== "string") {
      throw new Error("contract_id is required");
    }

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: contract, error: cErr } = await sb
      .from("contracten")
      .select("*, partners(id, bedrijfsnaam, naam, email, telefoon, slug, actief)")
      .eq("id", contract_id)
      .single();

    if (cErr || !contract) throw new Error("Contract niet gevonden");
    if (!contract.klant_email) throw new Error("Geen klant email");
    if (contract.status && contract.status !== "getekend" && contract.status !== "actief") {
      throw new Error("Contract is niet getekend");
    }
    if (!contract.partners || contract.partners.actief === false) {
      throw new Error("Partner niet actief");
    }

    const createdAt = contract.created_at ? new Date(contract.created_at).getTime() : 0;
    const ageMin = (Date.now() - createdAt) / 60000;
    if (!createdAt || ageMin > MAX_AGE_MINUTES) {
      throw new Error("Contract te oud voor automatische bevestiging");
    }
    if ((contract as { verzonden_bevestiging_op?: string }).verzonden_bevestiging_op) {
      return new Response(
        JSON.stringify({ success: true, skipped: true, reason: "already_sent" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const partner = contract.partners;
    const partnerNaam = partner?.bedrijfsnaam || partner?.naam || "Flancco";
    const isFlancco = /flancco/i.test(partnerNaam);
    const afzenderNaam = isFlancco ? "Flancco BV" : `${partnerNaam} via Flancco`;

    const totaal = parseFloat(contract.totaal_incl_btw || 0).toFixed(2).replace(".", ",");
    const btwType = contract.btw_type || "21%";
    const freq = contract.frequentie || "jaarlijks";
    const duur = contract.contractduur || "eenmalig";
    const contractNr = contract.contract_nummer || "\u2014";
    const datum = new Date(contract.datum_ondertekening || Date.now()).toLocaleDateString(
      "nl-BE", { day: "numeric", month: "long", year: "numeric" },
    );

    const nu = new Date();
    const maand = nu.getMonth() + 1;
    const eerstePeriode = maand >= 3 && maand <= 10
      ? "de komende weken"
      : "maart\u2013april " + (maand > 10 ? nu.getFullYear() + 1 : nu.getFullYear());

    const emailHtml = `
<!DOCTYPE html>
<html lang="nl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:20px">
  <div style="background:#1A1A2E;color:#fff;padding:28px 32px;border-radius:12px 12px 0 0;text-align:center">
    <h1 style="margin:0;font-size:22px;letter-spacing:2px">${escHtml(partnerNaam)}</h1>
    <p style="margin:6px 0 0;opacity:0.8;font-size:14px">Bevestiging overeenkomst</p>
  </div>
  <div style="background:#fff;padding:32px;border-radius:0 0 12px 12px">
    <p style="font-size:16px;margin:0 0 20px">Beste ${escHtml(contract.klant_naam)},</p>
    <p>Bedankt voor uw vertrouwen. Uw overeenkomst voor professioneel onderhoud is succesvol ondertekend.</p>
    <p>In bijlage vindt u:</p>
    <ul style="font-size:14px;line-height:1.8;color:#333">
      <li><strong>Uw ondertekende contract</strong> (PDF) &mdash; bewaar dit voor uw dossier</li>
      <li><strong>Modelformulier voor herroeping</strong> (PDF) &mdash; conform EU-richtlijn 2011/83/EU</li>
    </ul>
    <div style="background:#f8f9fa;border-radius:8px;padding:20px;margin:24px 0">
      <h3 style="margin:0 0 12px;font-size:14px;color:#666;text-transform:uppercase;letter-spacing:1px">Samenvatting</h3>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr><td style="padding:6px 0;color:#666">Contractnummer</td><td style="padding:6px 0;text-align:right;font-weight:600">${escHtml(contractNr)}</td></tr>
        <tr><td style="padding:6px 0;color:#666">Datum ondertekening</td><td style="padding:6px 0;text-align:right">${escHtml(datum)}</td></tr>
        <tr><td style="padding:6px 0;color:#666">Frequentie</td><td style="padding:6px 0;text-align:right">${escHtml(freq)}</td></tr>
        <tr><td style="padding:6px 0;color:#666">Contractduur</td><td style="padding:6px 0;text-align:right">${escHtml(duur)}</td></tr>
        <tr style="border-top:2px solid #e5e7eb"><td style="padding:10px 0 0;font-weight:700">Totaal per beurt</td><td style="padding:10px 0 0;text-align:right;font-weight:700;font-size:18px;color:#2D6A4F">&euro; ${totaal}</td></tr>
        <tr><td colspan="2" style="padding:2px 0 0;font-size:12px;color:#999;text-align:right">incl. ${escHtml(btwType)} btw</td></tr>
      </table>
    </div>
    <h3 style="font-size:15px;margin:24px 0 12px">Wat gebeurt er nu?</h3>
    <ol style="margin:0;padding-left:20px;font-size:14px;line-height:1.8;color:#333">
      <li>Wij plannen uw eerste onderhoudsbeurt in <strong>${eerstePeriode}</strong></li>
      <li>U wordt telefonisch gecontacteerd voor een concrete datum</li>
      <li>Na uitvoering ontvangt u een digitaal rapport met foto's</li>
    </ol>
    <div style="background:#fff8e7;border:1px solid #f0dca0;border-radius:8px;padding:16px 20px;margin:24px 0;font-size:13px;color:#7a6520">
      <strong>Herroepingsrecht</strong><br>
      U heeft het recht om binnen 14 kalenderdagen na ondertekening deze overeenkomst zonder opgave van redenen te herroepen,
      conform de Europese richtlijn 2011/83/EU. Gebruik hiervoor het bijgevoegde modelformulier of een eigen schriftelijke mededeling.
    </div>
    <p style="font-size:14px;color:#666;margin:24px 0 0">Vragen? Neem gerust contact op:</p>
    <p style="font-size:14px;margin:4px 0 0">
      <strong>${escHtml(partnerNaam)}</strong>
      ${partner?.telefoon ? "<br>" + escHtml(partner.telefoon) : ""}
      ${partner?.email ? "<br>" + escHtml(partner.email) : ""}
    </p>
  </div>
  <p style="text-align:center;font-size:11px;color:#999;margin-top:16px">
    Automatisch gegenereerd bericht op basis van uw ondertekening via het ${escHtml(partnerNaam)} platform.
  </p>
</div>
</body>
</html>`;

    // ═══════════════════════════════════════════════════════════════════════════════
    // BIJLAGEN: contract-PDF + herroepingsformulier
    // ═══════════════════════════════════════════════════════════════════════════════
    const attachments: Array<{ filename: string; content: string }> = [];
    const attachmentWarnings: string[] = [];

    // 1. Contract-PDF
    if (contract.pdf_url) {
      try {
        const pdfBytes = await downloadContractPdf(sb, contract.pdf_url);
        if (pdfBytes) {
          const safeNr = String(contractNr).replace(/[^a-zA-Z0-9_-]+/g, "_");
          attachments.push({
            filename: `Contract_${safeNr}.pdf`,
            content: uint8ToBase64(pdfBytes),
          });
        } else {
          attachmentWarnings.push("contract-pdf");
        }
      } catch (pdfErr) {
        console.error("Contract-PDF download mislukt:", pdfErr);
        attachmentWarnings.push("contract-pdf");
      }
    } else {
      console.warn("Contract heeft geen pdf_url — PDF-bijlage niet meegestuurd");
      attachmentWarnings.push("contract-pdf-missing");
    }

    // 2. Herroepingsformulier — altijd, juridisch verplicht
    try {
      const herroepingBytes = await generateHerroepingsformulierPdf({
        partnerName: FLANCCO_LEGAL_NAME,
        partnerAddress: FLANCCO_LEGAL_ADDRESS,
        partnerEmail: FLANCCO_LEGAL_EMAIL,
        partnerVatNumber: FLANCCO_LEGAL_VAT || undefined,
      });
      attachments.push({
        filename: "Herroepingsformulier.pdf",
        content: uint8ToBase64(herroepingBytes),
      });
    } catch (hErr) {
      console.error("Herroepingsformulier-generatie mislukt:", hErr);
      attachmentWarnings.push("herroepingsformulier");
    }

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: `${afzenderNaam} <${FROM_ADDRESS}>`,
        reply_to: [REPLY_TO],
        to: [contract.klant_email],
        subject: `Bevestiging overeenkomst ${contractNr} \u2014 ${partnerNaam}`,
        html: emailHtml,
        attachments: attachments.length > 0 ? attachments : undefined,
      }),
    });

    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result?.message || "Email verzending mislukt");

    await sb.from("contracten")
      .update({ verzonden_bevestiging_op: new Date().toISOString() })
      .eq("id", contract_id);

    return new Response(
      JSON.stringify({
        success: true,
        id: result.id,
        attachments_count: attachments.length,
        ...(attachmentWarnings.length > 0 ? { attachment_warnings: attachmentWarnings } : {}),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("send-confirmation error:", err);
    return new Response(
      JSON.stringify({ success: false, error: (err as Error).message }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Download contract-PDF via Storage-API (service-role). Accepteert zowel een volledige publieke URL
 * als een bucket-path. Returns Uint8Array of null bij fout.
 */
async function downloadContractPdf(
  // deno-lint-ignore no-explicit-any
  sb: any,
  pdfUrl: string,
): Promise<Uint8Array | null> {
  try {
    let bucketPath = pdfUrl;
    const marker = "/contracten-pdf/";
    const markerIdx = pdfUrl.indexOf(marker);
    if (markerIdx !== -1) {
      bucketPath = pdfUrl.substring(markerIdx + marker.length);
    }
    const { data, error } = await sb.storage.from("contracten-pdf").download(bucketPath);
    if (error || !data) {
      console.warn("Storage download error:", error);
      return null;
    }
    const arrayBuffer = await data.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  } catch (e) {
    console.error("downloadContractPdf error:", e);
    return null;
  }
}

function escHtml(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
