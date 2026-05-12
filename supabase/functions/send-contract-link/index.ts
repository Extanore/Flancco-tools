// send-contract-link — uitnodigingsmail / mail d'invitation om contract te ondertekenen.
//
// Wettelijke functie: deze mail wordt door admin/partner verzonden vóór ondertekening.
// Bevat de unieke teken-link plus het wettelijke modelformulier voor herroeping als bijlage
// (juridische voorbereiding op art. VI.64 WER pre-contractuele informatieplicht).
//
// Slot S i18n: NL/FR per `contracten.lang` (DB-persistentie). Default fallback NL.
// Slot T: bedrijf-only contracten (client_contact_id IS NULL) gebruiken bedrijfs-aanhef.
// Slot C4: branded HTML-shell per partner (logo, kleuren, contact-block) via
// resolveBranding(); Flancco-default fallback bij slug='flancco' of ontbrekende partner.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// Inline-paste van _shared/herroeping.ts (Supabase MCP-deploy ondersteunt geen relative ../_shared imports — Edge Function CLI wel).
import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";

interface HerroepingContext {
  /** Juridische / commerciële naam van de partner (bv. "Flancco BV", "Novectra BV") */
  partnerName: string;
  /** Volledig postadres voor retourzending (bv. "Industriepark X 12, 9000 Gent") */
  partnerAddress?: string;
  /** Contact e-mail voor herroepingen */
  partnerEmail?: string;
  /** Optioneel telefoon- of BTW-nummer */
  partnerPhone?: string;
  partnerVatNumber?: string;
}

/**
 * Genereer het EU-standaard herroepingsformulier als PDF-bytes (A4, 1 pagina).
 * Pure tekst-PDF — geen afbeeldingen, geen fonts buiten standaard Helvetica.
 * Return type: Uint8Array. In Deno geschikt voor base64-encoding via `encodeBase64`.
 */
async function generateHerroepingsformulierPdf(ctx: HerroepingContext): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle("Modelformulier voor herroeping");
  pdfDoc.setAuthor(ctx.partnerName || "Flancco BV");
  pdfDoc.setSubject("EU-richtlijn 2011/83/EU modelformulier voor herroeping");
  pdfDoc.setCreator("Flancco Platform");
  pdfDoc.setCreationDate(new Date());

  const page = pdfDoc.addPage([595.28, 841.89]); // A4 portrait in points
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontItalic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  const marginLeft = 56;
  const marginRight = 56;
  const contentWidth = page.getWidth() - marginLeft - marginRight;
  let y = page.getHeight() - 56;

  const black = rgb(0.1, 0.1, 0.18);
  const muted = rgb(0.4, 0.4, 0.45);

  // Header
  page.drawText("MODELFORMULIER VOOR HERROEPING", {
    x: marginLeft, y, size: 14, font: fontBold, color: black,
  });
  y -= 20;
  page.drawText("Bijlage I, deel B — Europese Richtlijn 2011/83/EU", {
    x: marginLeft, y, size: 9, font: fontItalic, color: muted,
  });
  y -= 28;

  // Intro-tekst
  const intro = "Dit formulier alleen invullen en terugzenden wanneer u de overeenkomst wilt herroepen. U heeft "
    + "hiertoe 14 kalenderdagen vanaf de ondertekening van de overeenkomst, conform richtlijn 2011/83/EU "
    + "en boek VI Wetboek Economisch Recht.";
  y = drawWrappedText(page, intro, marginLeft, y, contentWidth, 10, font, black, 14);
  y -= 14;

  // Aan: blok
  page.drawText("Aan:", { x: marginLeft, y, size: 10, font: fontBold, color: black });
  y -= 14;
  const aanLines: string[] = [ctx.partnerName || "Flancco BV"];
  if (ctx.partnerAddress) aanLines.push(ctx.partnerAddress);
  if (ctx.partnerEmail) aanLines.push("E-mail: " + ctx.partnerEmail);
  if (ctx.partnerPhone) aanLines.push("Telefoon: " + ctx.partnerPhone);
  if (ctx.partnerVatNumber) aanLines.push("BTW: " + ctx.partnerVatNumber);
  for (const line of aanLines) {
    page.drawText(line, { x: marginLeft + 12, y, size: 10, font, color: black });
    y -= 13;
  }
  y -= 10;

  // Verklaring
  const verklaring = "Ik/Wij (*) deel/delen (*) u hierbij mede dat ik/wij (*) onze overeenkomst betreffende "
    + "de verkoop van de volgende goederen / levering van de volgende dienst (*) herroep/herroepen (*):";
  y = drawWrappedText(page, verklaring, marginLeft, y, contentWidth, 10, font, black, 14);
  y -= 8;

  // Invulvelden met onderstrepingslijnen
  const fields: { label: string; lines: number }[] = [
    { label: "Besteld op (*) / Ontvangen op (*):", lines: 1 },
    { label: "Naam consument(en):", lines: 1 },
    { label: "Adres consument(en):", lines: 2 },
    { label: "Handtekening van consument(en) (alleen bij kennisgeving op papier):", lines: 2 },
    { label: "Datum:", lines: 1 },
  ];

  for (const field of fields) {
    page.drawText(field.label, { x: marginLeft, y, size: 10, font: fontBold, color: black });
    y -= 16;
    for (let i = 0; i < field.lines; i++) {
      page.drawLine({
        start: { x: marginLeft, y: y + 2 },
        end:   { x: marginLeft + contentWidth, y: y + 2 },
        thickness: 0.5,
        color: muted,
      });
      y -= 18;
    }
    y -= 4;
  }

  // Voetnoot
  y -= 6;
  page.drawText("(*) Doorhalen wat niet van toepassing is.", {
    x: marginLeft, y, size: 9, font: fontItalic, color: muted,
  });
  y -= 14;

  const note = "U kunt dit formulier ingevuld terugsturen per post of e-mail naar bovenstaand adres. "
    + "Een herroeping per e-mail, fax of andere duurzame drager is eveneens geldig. "
    + "De termijn is in acht genomen als u uw mededeling betreffende uw uitoefening van het "
    + "herroepingsrecht verzendt voordat de herroepingstermijn is verstreken.";
  y = drawWrappedText(page, note, marginLeft, y, contentWidth, 9, font, muted, 12);

  // Footer
  const footerText = "Dit document maakt integraal deel uit van uw contract. Bewaar een kopie voor uw dossier.";
  page.drawText(footerText, {
    x: marginLeft, y: 40, size: 8, font: fontItalic, color: muted,
  });

  return await pdfDoc.save();
}

/**
 * Tekst-wrap helper. Breekt `text` op spaties zodat elke regel binnen `maxWidth` blijft.
 * Tekent elke regel op (x, y) met line-height `lineHeight`. Returnt de nieuwe y-coördinaat.
 */
function drawWrappedText(
  // deno-lint-ignore no-explicit-any
  page: any,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  fontSize: number,
  // deno-lint-ignore no-explicit-any
  font: any,
  // deno-lint-ignore no-explicit-any
  color: any,
  lineHeight: number,
): number {
  const words = text.split(/\s+/);
  let line = "";
  let currentY = y;

  for (const word of words) {
    const test = line ? line + " " + word : word;
    const width = font.widthOfTextAtSize(test, fontSize);
    if (width > maxWidth && line) {
      page.drawText(line, { x, y: currentY, size: fontSize, font, color });
      currentY -= lineHeight;
      line = word;
    } else {
      line = test;
    }
  }
  if (line) {
    page.drawText(line, { x, y: currentY, size: fontSize, font, color });
    currentY -= lineHeight;
  }
  return currentY;
}

/**
 * Helper: Uint8Array → base64 string (voor Resend attachments).
 * Gebruikt native Deno std base64 encoder.
 */
function uint8ToBase64(bytes: Uint8Array): string {
  // Chunked encoding voor grote buffers (voorkomt stack overflow bij String.fromCharCode(...huge))
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, Math.min(i + CHUNK, bytes.length))),
    );
  }
  return btoa(binary);
}

// CORS. Bewust permissief: partner-portal + admin-dashboard draaien op verschillende sub-domeinen.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Sender + reply-to zijn env-var overridable zodat we zonder redeploy kunnen swappen
// wanneer flancco.be DNS-toegang alsnog beschikbaar wordt.
const FROM_ADDRESS = Deno.env.get("CONTRACT_FROM_ADDRESS") ?? "noreply@flancco-platform.be";
const REPLY_TO_DEFAULT = Deno.env.get("CONTRACT_REPLY_TO") ?? "gillian.geernaert@flancco.be";

// Vaste wettelijke verzend-adres van Flancco BV voor het herroepingsformulier.
// Overridable via env voor staging/testomgevingen.
const FLANCCO_LEGAL_NAME    = Deno.env.get("FLANCCO_LEGAL_NAME")    ?? "Flancco BV";
const FLANCCO_LEGAL_ADDRESS = Deno.env.get("FLANCCO_LEGAL_ADDRESS") ?? "Industrieweg 25, 9080 Lochristi, België";
const FLANCCO_LEGAL_EMAIL   = Deno.env.get("FLANCCO_LEGAL_EMAIL")   ?? "info@flancco.be";
const FLANCCO_LEGAL_VAT     = Deno.env.get("FLANCCO_LEGAL_VAT")     ?? "";

// Rate-limit (in-memory Deno isolate). Admin/partner-initiated, 10/min ruim.
const RATE_LIMIT_PER_MIN = parseInt(Deno.env.get("SEND_CONTRACT_LINK_RATE_LIMIT") || "10", 10);
const ipBuckets = new Map<string, { count: number; resetAt: number }>();
function rateLimit(ip: string): boolean {
  const now = Date.now();
  const bucket = ipBuckets.get(ip);
  if (!bucket || bucket.resetAt < now) {
    ipBuckets.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (bucket.count >= RATE_LIMIT_PER_MIN) return false;
  bucket.count++;
  return true;
}
function clientIp(req: Request): string {
  return (
    req.headers.get("CF-Connecting-IP") ||
    (req.headers.get("X-Forwarded-For") || "").split(",")[0].trim() ||
    "unknown"
  );
}

type Lang = "nl" | "fr";

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
  actief: boolean | null;
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

const FLANCCO_BRANDING: PartnerBranding = {
  id: null,
  slug: "flancco",
  name: "Flancco BV",
  primaryColor: "#1A1A2E",
  secondaryColor: "#E74C3C",
  logoUrl: "",
  email: "info@flancco.be",
  telefoon: "",
  website: "https://flancco-platform.be",
  isFlancco: true,
};

/**
 * Slot C4 — branding-resolutie. Voor `flancco`-slug of een ontbrekende partner-row vallen
 * we terug op de Flancco-defaults. Voor commerciële partners (Novectra, CW Solar, ...) gebruiken
 * we de partner-eigen kleuren, logo en contact-info.
 */
function resolveBranding(p: PartnerRow | null): PartnerBranding {
  if (!p) return FLANCCO_BRANDING;
  const isFlancco = (p.slug || "").toLowerCase() === "flancco"
    || /flancco/i.test(p.bedrijfsnaam || p.naam || "");
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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Rate-limit op IP.
  if (!rateLimit(clientIp(req))) {
    return new Response(
      JSON.stringify({ success: false, error: "rate_limited" }),
      { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
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

    // Get contract_id (and optional lang-override) from body
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const contract_id = body?.contract_id;
    const langFromPayload = body?.lang === "fr" || body?.lang === "nl" ? (body.lang as Lang) : undefined;
    if (!contract_id) {
      return new Response(JSON.stringify({ error: "contract_id vereist" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch contract + partner. Expliciet partner-kolommen selecteren (alleen wat we nodig hebben).
    const { data: contract, error: cErr } = await sb
      .from("contracten")
      .select(`
        *,
        partners (
          id, slug, naam, bedrijfsnaam, kleur_primair, kleur_donker,
          logo_url, email, telefoon, website, actief
        )
      `)
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

    // Slot S — taal-resolutie: payload-override > contract.lang (DB) > NL fallback
    const lang: Lang = langFromPayload
      ?? (contract.lang === "fr" || contract.lang === "nl" ? (contract.lang as Lang) : "nl");

    // Slot T — resolve recipient: contact-FK → client → contracten-snapshot.
    // Bedrijf-only contract (client_contact_id IS NULL) gebruikt clients.email
    // als koppel-adres en aanhef "Beste collega's van <bedrijfsnaam>" / "Chers collègues de <bedrijfsnaam>".
    const recipient = await resolveRecipient(sb, contract, lang);
    if (!recipient.email) {
      return new Response(JSON.stringify({ error: "Klant heeft geen emailadres" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Slot C4 — partner-branded shell. Default Flancco bij slug='flancco' of ontbrekende partner.
    const branding = resolveBranding(contract.partners as PartnerRow | null);

    // Env-var zodat we staging/prod/legacy kunnen swappen zonder redeploy-per-URL-wijziging.
    // Default: productiedomein op Cloudflare Pages.
    const calculatorBase = (Deno.env.get("CALCULATOR_BASE_URL") ?? "https://calculator.flancco-platform.be").replace(/\/$/, "");
    const tekenUrl = `${calculatorBase}/?contract=${contract.teken_token}`;

    // Sector-labels per taal
    const sectorLabels: Record<Lang, Record<string, string>> = {
      nl: {
        zon: "Zonnepanelen",
        warmtepomp: "Warmtepomp",
        ventilatie: "Ventilatie",
        verwarming: "Verwarming",
      },
      fr: {
        zon: "Panneaux solaires",
        warmtepomp: "Pompe à chaleur",
        ventilatie: "Ventilation",
        verwarming: "Chauffage",
      },
    };
    const fallbackSectorLabel = lang === "fr" ? "Service d'entretien" : "Onderhoudsdienst";

    // Parse sectoren for summary
    let sectorenHtml = "";
    try {
      const sectoren = typeof contract.sectoren === "string"
        ? JSON.parse(contract.sectoren)
        : contract.sectoren || [];
      sectorenHtml = sectoren
        .map((s: { sector?: string }) => `<li>${escHtml(sectorLabels[lang][s.sector ?? ""] || s.sector || fallbackSectorLabel)}</li>`)
        .join("");
    } catch {
      sectorenHtml = `<li>${escHtml(lang === "fr" ? "Services d'entretien" : "Onderhoudsdiensten")}</li>`;
    }

    const totaal = contract.totaal_incl_btw
      ? `€ ${Number(contract.totaal_incl_btw).toFixed(2).replace(".", ",")}`
      : (lang === "fr" ? "Voir contrat" : "Zie contract");

    // Build email body per taal
    const content = lang === "fr"
      ? frContent({ branding, greeting: recipient.greeting, sectorenHtml, frequentie: contract.frequentie || "annuel", totaal, tekenUrl })
      : nlContent({ branding, greeting: recipient.greeting, sectorenHtml, frequentie: contract.frequentie || "Jaarlijks", totaal, tekenUrl });

    const emailHtml = renderShell({
      branding,
      lang,
      headerTitle: content.headerTitle,
      bodyHtml: content.bodyHtml,
    });

    const subject = lang === "fr"
      ? `${branding.name} — Votre contrat d'entretien prêt à être signé`
      : `${branding.name} — Uw onderhoudscontract ter ondertekening`;

    // ═══════════════════════════════════════════════════════════════════════════════
    // BIJLAGEN: herroepingsformulier (altijd) + eventuele contract-PDF (indien al getekend)
    // ═══════════════════════════════════════════════════════════════════════════════
    // Op het moment dat de partner deze mail verstuurt, is het contract typisch nog NIET
    // getekend — dus pdf_url ontbreekt. We voegen dan enkel het herroepingsformulier toe.
    // Als het contract later herverzonden wordt na ondertekening, sturen we ook de PDF mee.
    const attachments: Array<{ filename: string; content: string }> = [];
    const attachmentWarnings: string[] = [];

    // 1. Herroepingsformulier — altijd genereren, juridisch verplicht bij contracten op afstand.
    // Blijft Flancco-juridisch ongeacht de partner — Flancco BV is de contracts-counterparty.
    try {
      const herroepingBytes = await generateHerroepingsformulierPdf({
        partnerName: FLANCCO_LEGAL_NAME,
        partnerAddress: FLANCCO_LEGAL_ADDRESS,
        partnerEmail: FLANCCO_LEGAL_EMAIL,
        partnerVatNumber: FLANCCO_LEGAL_VAT || undefined,
      });
      attachments.push({
        filename: lang === "fr" ? "Formulaire_de_retractation.pdf" : "Herroepingsformulier.pdf",
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
          lang,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Slot C4 — sender-naam toont partner ("Novectra via Flancco") en reply-to gaat naar
    // partner-eigen mailbox indien beschikbaar; Flancco-default als de partner geen contact-mail heeft.
    const afzenderNaam = branding.isFlancco ? "Flancco BV" : `${branding.name} via Flancco`;
    const replyTo = (!branding.isFlancco && branding.email) ? branding.email : REPLY_TO_DEFAULT;

    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${afzenderNaam} <${FROM_ADDRESS}>`,
        reply_to: [replyTo],
        to: [recipient.email],
        subject,
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
        message: (lang === "fr" ? "E-mail envoyé à " : "Email verzonden naar ") + recipient.email,
        attachments_count: attachments.length,
        company_only: recipient.isCompanyOnly,
        partner_slug: branding.slug,
        lang,
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
// EMAIL TEMPLATES — NL + FR (Slot C4 partner-branded shell)
// ═══════════════════════════════════════════════════════════════════════════════

interface BodyContext {
  branding: PartnerBranding;
  greeting: string;
  sectorenHtml: string;
  frequentie: string;
  totaal: string;
  tekenUrl: string;
}

interface BodyPayload {
  headerTitle: string;
  bodyHtml: string;
}

function nlContent(c: BodyContext): BodyPayload {
  const primary = sanitizeHex(c.branding.primaryColor, "#1A1A2E");
  const accent = sanitizeHex(c.branding.secondaryColor, "#E74C3C");
  return {
    headerTitle: "Onderhoudscontract ter ondertekening",
    bodyHtml: `
      <h2 style="color:#1a1a2e;margin-top:0;font-size:18px">Uw onderhoudscontract ter ondertekening</h2>
      <p style="font-size:15px;margin:0 0 16px">${escHtml(c.greeting)},</p>
      <p style="font-size:14px;line-height:1.7;margin:0 0 16px"><strong>${escHtml(c.branding.name)}</strong> heeft een onderhoudscontract voor u opgesteld. Hieronder vindt u een beknopt overzicht:</p>

      <div style="background:#f8f9fa;border-left:3px solid ${accent};border-radius:8px;padding:20px;margin:24px 0">
        <h3 style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:1.2px">Samenvatting</h3>
        <p style="margin:0 0 8px;font-size:14px;color:#1f2937"><strong>Diensten</strong></p>
        <ul style="margin:0 0 12px;padding-left:20px;font-size:14px;line-height:1.7;color:#374151">${c.sectorenHtml}</ul>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr><td style="padding:6px 0;color:#6b7280">Frequentie</td><td style="padding:6px 0;text-align:right;color:#1f2937">${escHtml(c.frequentie)}</td></tr>
          <tr style="border-top:2px solid #e5e7eb"><td style="padding:10px 0 0;font-weight:700;color:#1f2937">Totaal per beurt</td><td style="padding:10px 0 0;text-align:right;font-weight:700;font-size:18px;color:${primary}">${c.totaal}</td></tr>
          <tr><td colspan="2" style="padding:2px 0 0;font-size:12px;color:#9ca3af;text-align:right">incl. btw</td></tr>
        </table>
      </div>

      <p style="text-align:center;margin:32px 0">
        <a href="${escUrl(c.tekenUrl)}" style="display:inline-block;background:${primary};color:#fff;padding:16px 40px;border-radius:8px;text-decoration:none;font-size:16px;font-weight:600;letter-spacing:0.3px">
          Bekijk &amp; teken uw contract
        </a>
      </p>

      <p style="color:#666;font-size:13px;line-height:1.6;margin:0 0 16px">Deze link is uniek voor u en kan eenmalig worden gebruikt om het contract te ondertekenen.</p>

      <div style="background:#fff8e7;border:1px solid #f0dca0;border-radius:8px;padding:16px 20px;margin:24px 0;font-size:13px;color:#7a6520;line-height:1.6">
        <strong>Herroepingsrecht</strong><br>
        Als consument heeft u het recht om binnen 14 kalenderdagen na ondertekening deze overeenkomst zonder opgave van redenen te herroepen, conform EU-richtlijn 2011/83/EU en boek VI WER. Bij deze e-mail vindt u het wettelijke <strong>modelformulier voor herroeping</strong> als bijlage.
      </div>`,
  };
}

function frContent(c: BodyContext): BodyPayload {
  const primary = sanitizeHex(c.branding.primaryColor, "#1A1A2E");
  const accent = sanitizeHex(c.branding.secondaryColor, "#E74C3C");
  return {
    headerTitle: "Contrat d'entretien prêt à être signé",
    bodyHtml: `
      <h2 style="color:#1a1a2e;margin-top:0;font-size:18px">Votre contrat d'entretien prêt à être signé</h2>
      <p style="font-size:15px;margin:0 0 16px">${escHtml(c.greeting)},</p>
      <p style="font-size:14px;line-height:1.7;margin:0 0 16px"><strong>${escHtml(c.branding.name)}</strong> a préparé un contrat d'entretien pour vous. Voici un bref aperçu :</p>

      <div style="background:#f8f9fa;border-left:3px solid ${accent};border-radius:8px;padding:20px;margin:24px 0">
        <h3 style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:1.2px">Résumé</h3>
        <p style="margin:0 0 8px;font-size:14px;color:#1f2937"><strong>Services</strong></p>
        <ul style="margin:0 0 12px;padding-left:20px;font-size:14px;line-height:1.7;color:#374151">${c.sectorenHtml}</ul>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr><td style="padding:6px 0;color:#6b7280">Fréquence</td><td style="padding:6px 0;text-align:right;color:#1f2937">${escHtml(c.frequentie)}</td></tr>
          <tr style="border-top:2px solid #e5e7eb"><td style="padding:10px 0 0;font-weight:700;color:#1f2937">Total par intervention</td><td style="padding:10px 0 0;text-align:right;font-weight:700;font-size:18px;color:${primary}">${c.totaal}</td></tr>
          <tr><td colspan="2" style="padding:2px 0 0;font-size:12px;color:#9ca3af;text-align:right">TVA comprise</td></tr>
        </table>
      </div>

      <p style="text-align:center;margin:32px 0">
        <a href="${escUrl(c.tekenUrl)}" style="display:inline-block;background:${primary};color:#fff;padding:16px 40px;border-radius:8px;text-decoration:none;font-size:16px;font-weight:600;letter-spacing:0.3px">
          Consulter &amp; signer votre contrat
        </a>
      </p>

      <p style="color:#666;font-size:13px;line-height:1.6;margin:0 0 16px">Ce lien vous est destiné personnellement et ne peut être utilisé qu'une seule fois pour signer le contrat.</p>

      <div style="background:#fff8e7;border:1px solid #f0dca0;border-radius:8px;padding:16px 20px;margin:24px 0;font-size:13px;color:#7a6520;line-height:1.6">
        <strong>Droit de rétractation</strong><br>
        En tant que consommateur, vous disposez de 14 jours calendrier après la signature pour rétracter cet accord sans justification, conformément à la directive UE 2011/83/UE et au livre VI du CDE. Vous trouverez en pièce jointe le <strong>formulaire légal de rétractation</strong>.
      </div>`,
  };
}

interface ShellOpts {
  branding: PartnerBranding;
  lang: Lang;
  headerTitle: string;
  bodyHtml: string;
}

function renderShell(o: ShellOpts): string {
  const primary = sanitizeHex(o.branding.primaryColor, "#1A1A2E");
  const headerLogoOrName = o.branding.logoUrl
    ? `<img src="${escUrl(o.branding.logoUrl)}" alt="${escAttr(o.branding.name)}" style="max-height:48px;max-width:200px;display:block;margin:0 auto" />`
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
  if (b.email) lines.push(`<a href="mailto:${escAttr(b.email)}" style="color:${sanitizeHex(b.primaryColor, "#1A1A2E")};text-decoration:none">${escHtml(b.email)}</a>`);
  if (b.website) lines.push(`<a href="${escUrl(b.website)}" style="color:${sanitizeHex(b.primaryColor, "#1A1A2E")};text-decoration:none">${labels.website}</a>`);
  if (lines.length === 0) return "";
  return `<p style="font-size:14px;color:#6b7280;margin:0 0 8px">${labels.vragen}</p>
    <p style="font-size:14px;margin:0;line-height:1.7">
      <strong style="color:#1f2937">${escHtml(b.name)}</strong><br>
      ${lines.join(" &middot; ")}
    </p>`;
}

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
 * Slot T + Slot S — resolve recipient + greeting voor de contract-link mail.
 *
 * Resolution order:
 *   1. client_contact_id IS NOT NULL → look up client_contacts → use first_name + email
 *   2. client_contact_id IS NULL + client_id → look up clients → bedrijfs-aanhef
 *   3. fallback → contracten.klant_email + contracten.klant_naam (legacy)
 *
 * Aanhef per taal:
 *   - NL persoon:      "Beste {first_name}"
 *   - NL bedrijf-only: "Beste collega's van {company_name}"
 *   - FR persoon:      "Bonjour {first_name}"
 *   - FR bedrijf-only: "Chers collègues de {company_name}"
 */
async function resolveRecipient(
  // deno-lint-ignore no-explicit-any
  sb: any,
  // deno-lint-ignore no-explicit-any
  contract: any,
  lang: Lang,
): Promise<{ email: string; greeting: string; isCompanyOnly: boolean }> {
  const fallbackName = lang === "fr" ? "client" : "klant";

  // Path 1 — specifieke contactpersoon
  if (contract.client_contact_id) {
    const { data: cc } = await sb
      .from("client_contacts")
      .select("first_name, email")
      .eq("id", contract.client_contact_id)
      .maybeSingle();
    const email = String(cc?.email || contract.klant_email || "").trim();
    const firstName = String(cc?.first_name || contract.klant_naam || fallbackName).trim();
    const greeting = lang === "fr"
      ? `Bonjour ${firstName}`
      : `Beste ${firstName}`;
    return { email, greeting, isCompanyOnly: false };
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
      const greeting = lang === "fr"
        ? `Chers collègues de ${company}`
        : `Beste collega's van ${company}`;
      return { email, greeting, isCompanyOnly: true };
    }
  }

  // Path 3 — legacy fallback
  const legacyName = String(contract.klant_naam || fallbackName).trim();
  return {
    email: String(contract.klant_email || "").trim(),
    greeting: lang === "fr" ? `Bonjour ${legacyName}` : `Beste ${legacyName}`,
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

/** Veilige URL-escape: laat enkel http(s) / mailto door. */
function escUrl(s: string | null | undefined): string {
  const v = String(s ?? "").trim();
  if (!v) return "";
  if (/^(https?:|mailto:)/i.test(v)) {
    return v.replace(/"/g, "%22").replace(/</g, "%3C").replace(/>/g, "%3E");
  }
  return "";
}

/** Hex-color sanitizer: returnt fallback bij niet-#RRGGBB / #RGB input. */
function sanitizeHex(value: string | null | undefined, fallback: string): string {
  const v = String(value ?? "").trim();
  if (/^#?[0-9a-fA-F]{6}$/.test(v) || /^#?[0-9a-fA-F]{3}$/.test(v)) {
    return v.startsWith("#") ? v : `#${v}`;
  }
  return fallback;
}
