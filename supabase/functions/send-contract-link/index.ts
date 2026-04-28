import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { generateHerroepingsformulierPdf, uint8ToBase64 } from "../_shared/herroeping.ts";

// CORS. Bewust permissief: partner-portal + admin-dashboard draaien op verschillende sub-domeinen.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Sender + reply-to zijn env-var overridable zodat we zonder redeploy kunnen swappen
// wanneer flancco.be DNS-toegang alsnog beschikbaar wordt.
const FROM_ADDRESS = Deno.env.get("CONTRACT_FROM_ADDRESS") ?? "contracts@flancco-platform.be";
const REPLY_TO     = Deno.env.get("CONTRACT_REPLY_TO")     ?? "gillian.geernaert@flancco.be";

// Vaste wettelijke verzend-adres van Flancco BV voor het herroepingsformulier.
// Overridable via env voor staging/testomgevingen.
const FLANCCO_LEGAL_NAME    = Deno.env.get("FLANCCO_LEGAL_NAME")    ?? "Flancco BV";
const FLANCCO_LEGAL_ADDRESS = Deno.env.get("FLANCCO_LEGAL_ADDRESS") ?? "Industrieweg 25, 9080 Lochristi, België";
const FLANCCO_LEGAL_EMAIL   = Deno.env.get("FLANCCO_LEGAL_EMAIL")   ?? "gillian.geernaert@flancco.be";
const FLANCCO_LEGAL_VAT     = Deno.env.get("FLANCCO_LEGAL_VAT")     ?? "";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const resendApiKey = Deno.env.get("RESEND_API_KEY");

    // Verify JWT from request
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Niet geautoriseerd" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create service client for DB access
    const sb = createClient(supabaseUrl, supabaseServiceKey);

    // Verify user role (admin or partner)
    const anonClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!);
    const { data: { user }, error: authError } = await anonClient.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Ongeldige sessie" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: role } = await sb
      .from("user_roles")
      .select("role, partner_id")
      .eq("user_id", user.id)
      .single();

    if (!role || (role.role !== "admin" && role.role !== "partner")) {
      return new Response(JSON.stringify({ error: "Geen toegang" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get contract_id from body
    const { contract_id } = await req.json();
    if (!contract_id) {
      return new Response(JSON.stringify({ error: "contract_id vereist" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch contract + partner
    const { data: contract, error: cErr } = await sb
      .from("contracten")
      .select("*, partners(*)")
      .eq("id", contract_id)
      .single();

    if (cErr || !contract) {
      return new Response(JSON.stringify({ error: "Contract niet gevonden" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Partner can only send their own contracts
    if (role.role === "partner" && contract.partner_id !== role.partner_id) {
      return new Response(JSON.stringify({ error: "Geen toegang tot dit contract" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Slot T — resolve recipient: contact-FK → client → contracten-snapshot.
    // Bedrijf-only contract (client_contact_id IS NULL) gebruikt clients.email
    // als koppel-adres en aanhef "Beste collega's van <bedrijfsnaam>".
    const recipient = await resolveRecipient(sb, contract);
    if (!recipient.email) {
      return new Response(JSON.stringify({ error: "Klant heeft geen emailadres" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const partner = contract.partners;
    // Env-var zodat we staging/prod/legacy kunnen swappen zonder redeploy-per-URL-wijziging.
    // Default: productiedomein op Cloudflare Pages.
    const calculatorBase = (Deno.env.get("CALCULATOR_BASE_URL") ?? "https://calculator.flancco-platform.be").replace(/\/$/, "");
    const tekenUrl = `${calculatorBase}/?contract=${contract.teken_token}`;

    // Parse sectoren for summary
    let sectorenHtml = "";
    try {
      const sectoren = typeof contract.sectoren === "string"
        ? JSON.parse(contract.sectoren)
        : contract.sectoren || [];
      const sectorLabels: Record<string, string> = {
        zon: "Zonnepanelen",
        warmtepomp: "Warmtepomp",
        ventilatie: "Ventilatie",
        verwarming: "Verwarming",
      };
      sectorenHtml = sectoren
        .map((s: { sector?: string }) => `<li>${sectorLabels[s.sector ?? ""] || s.sector || "Onderhoudsdienst"}</li>`)
        .join("");
    } catch {
      sectorenHtml = "<li>Onderhoudsdiensten</li>";
    }

    const totaal = contract.totaal_incl_btw
      ? `€ ${Number(contract.totaal_incl_btw).toFixed(2).replace(".", ",")}`
      : "Zie contract";

    const primaryColor = partner?.kleur_primair || "#1A1A2E";
    const partnerNaam = partner?.bedrijfsnaam || partner?.naam || "Flancco";

    // Build email HTML — herroepingsclausule wordt expliciet zichtbaar gemaakt om te voldoen
    // aan de informatieplicht in art. VI.64 WER (pre-contractuele informatie).
    const emailHtml = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;margin-top:32px;margin-bottom:32px;">
    <tr>
      <td style="background:${primaryColor};padding:32px;text-align:center;">
        ${partner?.logo_url ? `<img src="${partner.logo_url}" alt="${escAttr(partnerNaam)}" style="max-height:60px;margin-bottom:12px;">` : ""}
        <h1 style="color:#fff;margin:0;font-size:22px;">${escHtml(partnerNaam)}</h1>
      </td>
    </tr>
    <tr>
      <td style="padding:32px;">
        <h2 style="color:#1a1a2e;margin-top:0;">Uw onderhoudscontract ter ondertekening</h2>
        <p>${escHtml(recipient.greeting)},</p>
        <p>${escHtml(partnerNaam)} heeft een onderhoudscontract voor u opgesteld. Hieronder vindt u een beknopt overzicht:</p>

        <table style="width:100%;background:#f8f9fa;border-radius:8px;padding:16px;margin:20px 0;">
          <tr><td style="padding:8px;">
            <strong>Diensten:</strong>
            <ul style="margin:8px 0;padding-left:20px;">${sectorenHtml}</ul>
          </td></tr>
          <tr><td style="padding:8px;">
            <strong>Frequentie:</strong> ${escHtml(contract.frequentie || "Jaarlijks")}
          </td></tr>
          <tr><td style="padding:8px;">
            <strong>Totaal per beurt incl. BTW:</strong> ${totaal}
          </td></tr>
        </table>

        <p style="text-align:center;margin:32px 0;">
          <a href="${tekenUrl}" style="display:inline-block;background:${primaryColor};color:#fff;padding:16px 40px;border-radius:8px;text-decoration:none;font-size:16px;font-weight:600;">
            Bekijk &amp; teken uw contract
          </a>
        </p>

        <p style="color:#666;font-size:13px;">Deze link is uniek voor u en kan eenmalig worden gebruikt om het contract te ondertekenen.</p>

        <div style="background:#fff8e7;border:1px solid #f0dca0;border-radius:8px;padding:16px 20px;margin:24px 0;font-size:13px;color:#7a6520;">
          <strong>Herroepingsrecht</strong><br>
          Als consument heeft u het recht om binnen 14 kalenderdagen na ondertekening deze overeenkomst
          zonder opgave van redenen te herroepen, conform EU-richtlijn 2011/83/EU en boek VI WER.
          Bij deze e-mail vindt u het wettelijke <strong>modelformulier voor herroeping</strong> als bijlage.
        </div>

        <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
        <p style="color:#888;font-size:13px;">
          ${escHtml(partnerNaam)}<br>
          ${partner?.contact_email ? `${escHtml(partner.contact_email)}<br>` : ""}
          ${partner?.contact_telefoon ? `${escHtml(partner.contact_telefoon)}<br>` : ""}
          ${partner?.website ? escHtml(partner.website) : ""}
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

    // ═══════════════════════════════════════════════════════════════════════════════
    // BIJLAGEN: herroepingsformulier (altijd) + eventuele contract-PDF (indien al getekend)
    // ═══════════════════════════════════════════════════════════════════════════════
    // Op het moment dat de partner deze mail verstuurt, is het contract typisch nog NIET
    // getekend — dus pdf_url ontbreekt. We voegen dan enkel het herroepingsformulier toe.
    // Als het contract later herverzonden wordt na ondertekening, sturen we ook de PDF mee.
    const attachments: Array<{ filename: string; content: string }> = [];
    const attachmentWarnings: string[] = [];

    // 1. Herroepingsformulier — altijd genereren, juridisch verplicht bij contracten op afstand.
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

    // 2. Contract-PDF (optioneel) — alleen als al eerder getekend en pdf_url bestaat
    if (contract.pdf_url) {
      try {
        // pdf_url kan een publieke URL of een bucket-path zijn. Normaliseer naar path voor Storage-API.
        const contractPdfBytes = await downloadContractPdf(sb, contract.pdf_url);
        if (contractPdfBytes) {
          const contractNr = contract.contract_nummer || contract_id.substring(0, 8);
          attachments.push({
            filename: `Contract_${contractNr}.pdf`,
            content: uint8ToBase64(contractPdfBytes),
          });
        } else {
          attachmentWarnings.push("contract-pdf");
        }
      } catch (pdfErr) {
        console.error("Contract-PDF download mislukt:", pdfErr);
        attachmentWarnings.push("contract-pdf");
      }
    }

    // Send email via Resend
    if (!resendApiKey) {
      // If no Resend key, just update verzonden_op and return success with warning
      await sb.from("contracten").update({ verzonden_op: new Date().toISOString() }).eq("id", contract_id);
      return new Response(
        JSON.stringify({
          success: true,
          warning: "RESEND_API_KEY niet geconfigureerd — email niet verzonden, maar contract gemarkeerd als verzonden.",
          teken_url: tekenUrl,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${partnerNaam} <${FROM_ADDRESS}>`,
        reply_to: [REPLY_TO],
        to: [recipient.email],
        subject: `Uw onderhoudscontract van ${partnerNaam} ter ondertekening`,
        html: emailHtml,
        attachments: attachments.length > 0 ? attachments : undefined,
      }),
    });

    if (!emailRes.ok) {
      const errBody = await emailRes.text();
      return new Response(
        JSON.stringify({ error: "Email verzenden mislukt", details: errBody }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Update contract: verzonden_op
    await sb.from("contracten").update({ verzonden_op: new Date().toISOString() }).eq("id", contract_id);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Email verzonden naar " + recipient.email,
        attachments_count: attachments.length,
        company_only: recipient.isCompanyOnly,
        ...(attachmentWarnings.length > 0 ? { attachment_warnings: attachmentWarnings } : {}),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Server fout", details: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
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
    // Normaliseer: extraheer het pad binnen de bucket
    // Mogelijke vormen:
    //   - https://.../storage/v1/object/public/contracten-pdf/path/to/file.pdf
    //   - https://.../storage/v1/object/contracten-pdf/path/to/file.pdf
    //   - path/to/file.pdf  (al een bucket-path)
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

/**
 * Slot T — resolve recipient + greeting voor de contract-link mail.
 *
 * Resolution order:
 *   1. client_contact_id IS NOT NULL → look up client_contacts → use first_name + email
 *   2. client_contact_id IS NULL + client_id → look up clients → bedrijfs-aanhef
 *   3. fallback → contracten.klant_email + contracten.klant_naam (legacy)
 */
async function resolveRecipient(
  // deno-lint-ignore no-explicit-any
  sb: any,
  // deno-lint-ignore no-explicit-any
  contract: any,
): Promise<{ email: string; greeting: string; isCompanyOnly: boolean }> {
  // Path 1 — specifieke contactpersoon
  if (contract.client_contact_id) {
    const { data: cc } = await sb
      .from("client_contacts")
      .select("first_name, email")
      .eq("id", contract.client_contact_id)
      .maybeSingle();
    const email = String(cc?.email || contract.klant_email || "").trim();
    const firstName = String(cc?.first_name || contract.klant_naam || "klant").trim();
    return { email, greeting: `Beste ${firstName}`, isCompanyOnly: false };
  }

  // Path 2 — bedrijf-only (geen contact-FK, wel client_id)
  if (contract.client_id) {
    const { data: client } = await sb
      .from("clients")
      .select("company_name, email")
      .eq("id", contract.client_id)
      .maybeSingle();
    const company = String(client?.company_name || "").trim();
    if (company) {
      const email = String(client?.email || contract.klant_email || "").trim();
      return {
        email,
        greeting: `Beste collega's van ${company}`,
        isCompanyOnly: true,
      };
    }
  }

  // Path 3 — legacy fallback
  return {
    email: String(contract.klant_email || "").trim(),
    greeting: `Beste ${String(contract.klant_naam || "klant").trim()}`,
    isCompanyOnly: false,
  };
}

/** HTML-escape voor user-controlled velden in de email body. */
function escHtml(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escape voor HTML-attribute waarden (strikter dan tekst). */
function escAttr(s: string | null | undefined): string {
  return escHtml(s).replace(/`/g, "&#96;");
}
