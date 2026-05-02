// send-confirmation — bevestigingsmail / mail de confirmation na contractondertekening.
//
// Wettelijke functie: deze mail ontvangt de klant na signing en bevat als verplichte bijlagen:
//   1. Het ondertekende contract als PDF (uit bucket `contracten-pdf`, via `contracten.pdf_url`).
//   2. Het wettelijke modelformulier voor herroeping (dynamisch gegenereerd, EU 2011/83/EU).
//
// Zonder deze bijlagen start de 14-daagse herroepingstermijn juridisch niet (art. VI.53 WER).
// Bij ontbreken van de contract-PDF sturen we de mail alsnog, maar markeren dit als warning
// zodat de admin kan bijsturen.
//
// Slot C4: branded HTML-template per partner (logo, kleuren, contact-block) en NL/FR per
// `contracten.lang` (Slot S DB-persistentie). Flancco-default fallback bij `partner_slug='flancco'`
// of wanneer geen partner geresolveerd kan worden.
//
// Note: verify_jwt = false op deze functie (public call vanuit calculator post-signing).
// Validatie gebeurt via:
//   - contract_id moet bestaan én status === 'getekend'
//   - contract mag niet ouder zijn dan SEND_CONFIRM_MAX_AGE_MIN (default 30 min)
//   - Geen herzenden: `verzonden_bevestiging_op` moet NULL zijn (anders skip)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
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

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// v4: sender gemigreerd naar @flancco-platform.be. Reply-to behoudt actief Flancco-postvak,
// tenzij de partner een eigen contact_email/email heeft (zie buildReplyTo()).
const FROM_ADDRESS = Deno.env.get("CONFIRM_FROM_ADDRESS") || "noreply@flancco-platform.be";
const REPLY_TO_DEFAULT = Deno.env.get("CONFIRM_REPLY_TO") || "gillian.geernaert@flancco.be";

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS")
  || "https://app.flancco-platform.be,https://calculator.flancco-platform.be,https://flancco-platform.be,https://www.flancco-platform.be,https://extanore.github.io"
).split(",").map((s) => s.trim()).filter(Boolean);

const MAX_AGE_MINUTES = parseInt(Deno.env.get("SEND_CONFIRM_MAX_AGE_MIN") || "30", 10);

const OPT_OUT_BASE_URL = Deno.env.get("OPT_OUT_BASE_URL") || "https://flancco-platform.be/opt-out/";

// Juridische Flancco-entiteit voor het herroepingsformulier — blijft Flancco-only.
const FLANCCO_LEGAL_NAME = Deno.env.get("FLANCCO_LEGAL_NAME") ?? "Flancco BV";
const FLANCCO_LEGAL_ADDRESS = Deno.env.get("FLANCCO_LEGAL_ADDRESS") ?? "Industrieweg 25, 9080 Lochristi, België";
const FLANCCO_LEGAL_EMAIL = Deno.env.get("FLANCCO_LEGAL_EMAIL") ?? "info@flancco.be";
const FLANCCO_LEGAL_VAT = Deno.env.get("FLANCCO_LEGAL_VAT") ?? "";

// ─────────────────────────────────────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type Lang = "nl" | "fr";

interface PartnerBranding {
  slug: string;
  name: string;          // bedrijfsnaam || naam
  primaryColor: string;  // hex (#1A1A2E fallback)
  secondaryColor: string; // hex — sourced from kleur_donker; falls back to #E74C3C
  logoUrl: string;
  email: string;
  telefoon: string;
  website: string;
  isFlancco: boolean;
}

interface ContractRow {
  id: string;
  klant_naam: string;
  klant_email: string | null;
  klant_telefoon: string | null;
  klant_adres: string | null;
  klant_postcode: string | null;
  klant_gemeente: string | null;
  totaal_incl_btw: number | string | null;
  btw_type: string | null;
  frequentie: string | null;
  contractduur: string | null;
  contract_nummer: string | null;
  datum_ondertekening: string | null;
  pdf_url: string | null;
  status: string | null;
  created_at: string | null;
  verzonden_bevestiging_op: string | null;
  lang: string | null;
  // Slot T — bedrijf-only-detectie + lookup-keys
  client_id: string | null;
  client_contact_id: string | null;
  partners: {
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
  } | null;
}

// Slot T — recipient + aanhef-resolution
interface RecipientResolution {
  /** Email-adres waar de bevestiging naartoe gaat. */
  email: string;
  /** Aanhef-naam ("Beste {first_name}" of "Beste collega's van {company_name}"). */
  greetingName: string;
  /** True wanneer geen specifieke contactpersoon → bedrijf-only. */
  isCompanyOnly: boolean;
  /** Bedrijfsnaam (clients.company_name) — voor metadata. */
  companyName: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Branding resolver
// ─────────────────────────────────────────────────────────────────────────────

const FLANCCO_DEFAULT_BRANDING: PartnerBranding = {
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

function resolveBranding(
  partner: ContractRow["partners"],
  partnerSlugFromPayload: string | undefined,
): PartnerBranding {
  // Explicit override path: caller provided a slug different from the contract's partner.
  // We treat this as untrusted — only use it when no DB-partner is present.
  if (!partner) {
    if (partnerSlugFromPayload && partnerSlugFromPayload !== "flancco") {
      // No partner-record but slug given → unknown partner, fall back to Flancco
      return FLANCCO_DEFAULT_BRANDING;
    }
    return FLANCCO_DEFAULT_BRANDING;
  }

  const isFlancco = (partner.slug || "").toLowerCase() === "flancco" || /flancco/i.test(partner.bedrijfsnaam || partner.naam || "");

  if (isFlancco) {
    return {
      ...FLANCCO_DEFAULT_BRANDING,
      slug: partner.slug || "flancco",
      name: partner.bedrijfsnaam || partner.naam || "Flancco BV",
      logoUrl: partner.logo_url || "",
      email: partner.email || FLANCCO_DEFAULT_BRANDING.email,
      telefoon: partner.telefoon || "",
      website: partner.website || FLANCCO_DEFAULT_BRANDING.website,
    };
  }

  return {
    slug: partner.slug,
    name: partner.bedrijfsnaam || partner.naam || "Partner",
    primaryColor: partner.kleur_primair || FLANCCO_DEFAULT_BRANDING.primaryColor,
    secondaryColor: partner.kleur_donker || FLANCCO_DEFAULT_BRANDING.secondaryColor,
    logoUrl: partner.logo_url || "",
    email: partner.email || "",
    telefoon: partner.telefoon || "",
    website: partner.website || "",
    isFlancco: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP handler
// ─────────────────────────────────────────────────────────────────────────────

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

    // Optional payload-level overrides (back-compat: both undefined is the original behaviour).
    const partnerSlugFromPayload = typeof body?.partner_slug === "string" ? body.partner_slug : undefined;
    const langFromPayload = body?.lang === "fr" || body?.lang === "nl" ? (body.lang as Lang) : undefined;

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: contract, error: cErr } = await sb
      .from("contracten")
      .select(`
        id, klant_naam, klant_email, klant_telefoon, klant_adres, klant_postcode, klant_gemeente,
        totaal_incl_btw, btw_type, frequentie, contractduur, contract_nummer, datum_ondertekening,
        pdf_url, status, created_at, verzonden_bevestiging_op, lang,
        client_id, client_contact_id,
        partners ( id, slug, naam, bedrijfsnaam, kleur_primair, kleur_donker, logo_url, email, telefoon, website, actief )
      `)
      .eq("id", contract_id)
      .maybeSingle<ContractRow>();

    if (cErr || !contract) throw new Error("Contract niet gevonden");
    if (contract.status && contract.status !== "getekend" && contract.status !== "actief") {
      throw new Error("Contract is niet getekend");
    }
    if (!contract.partners || contract.partners.actief === false) {
      throw new Error("Partner niet actief");
    }

    // Slot T — resolve recipient: contact-FK → client → contracten-snapshot
    const recipient = await resolveRecipient(sb, contract);
    if (!recipient.email) throw new Error("Geen klant email");

    const createdAt = contract.created_at ? new Date(contract.created_at).getTime() : 0;
    const ageMin = (Date.now() - createdAt) / 60000;
    if (!createdAt || ageMin > MAX_AGE_MINUTES) {
      throw new Error("Contract te oud voor automatische bevestiging");
    }
    if (contract.verzonden_bevestiging_op) {
      return new Response(
        JSON.stringify({ success: true, skipped: true, reason: "already_sent" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Resolve branding + language
    // ─────────────────────────────────────────────────────────────────────────
    const branding = resolveBranding(contract.partners, partnerSlugFromPayload);
    const lang: Lang = (langFromPayload
      ?? (contract.lang === "fr" || contract.lang === "nl" ? (contract.lang as Lang) : "nl"));

    const opt_out_token = await fetchOptOutToken(sb, contract_id, recipient.email);

    // ─────────────────────────────────────────────────────────────────────────
    // Build email content
    // ─────────────────────────────────────────────────────────────────────────
    const totalNumber = parseFloat(String(contract.totaal_incl_btw ?? 0));
    const totaal = isFinite(totalNumber) ? totalNumber.toFixed(2).replace(".", ",") : "0,00";
    const btwType = contract.btw_type || "21%";
    const freq = contract.frequentie || (lang === "fr" ? "annuel" : "jaarlijks");
    const duur = contract.contractduur || (lang === "fr" ? "ponctuel" : "eenmalig");
    const contractNr = contract.contract_nummer || contract.id.slice(0, 8).toUpperCase();
    const datum = new Date(contract.datum_ondertekening || Date.now()).toLocaleDateString(
      lang === "fr" ? "fr-BE" : "nl-BE",
      { day: "numeric", month: "long", year: "numeric" },
    );

    const eerstePeriode = computeFirstWindow(lang);

    const content = lang === "fr"
      ? frContent({ branding, klantNaam: recipient.greetingName, isCompanyOnly: recipient.isCompanyOnly, contractNr, datum, freq, duur, totaal, btwType, eerstePeriode })
      : nlContent({ branding, klantNaam: recipient.greetingName, isCompanyOnly: recipient.isCompanyOnly, contractNr, datum, freq, duur, totaal, btwType, eerstePeriode });

    const optOutFooter = opt_out_token
      ? renderOptOutFooter(branding, lang, OPT_OUT_BASE_URL + "?token=" + encodeURIComponent(opt_out_token))
      : "";

    const emailHtml = renderEmailShell({
      branding,
      lang,
      headerTitle: content.headerTitle,
      headerSubtitle: content.headerSubtitle,
      bodyHtml: content.bodyHtml,
      optOutFooterHtml: optOutFooter,
    });

    const subject = lang === "fr"
      ? `${branding.name} \u2014 Confirmation de l'entretien panneaux solaires (${contractNr})`
      : `${branding.name} \u2014 Bevestiging onderhoud zonnepanelen (${contractNr})`;

    // ─────────────────────────────────────────────────────────────────────────
    // BIJLAGEN: contract-PDF + herroepingsformulier
    // ─────────────────────────────────────────────────────────────────────────
    const attachments: Array<{ filename: string; content: string }> = [];
    const attachmentWarnings: string[] = [];

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

    // Herroepingsformulier — altijd, juridisch verplicht. Blijft Flancco-juridisch
    // omdat Flancco BV de aannemer-entiteit is op het contract; partners zijn
    // commerciële intermediairs.
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

    // ─────────────────────────────────────────────────────────────────────────
    // From + Reply-to
    // ─────────────────────────────────────────────────────────────────────────
    const afzenderNaam = branding.isFlancco ? "Flancco BV" : `${branding.name} via Flancco`;
    const replyTo = !branding.isFlancco && branding.email ? branding.email : REPLY_TO_DEFAULT;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${RESEND_API_KEY}`,
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

    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result?.message || "Email verzending mislukt");

    await sb.from("contracten")
      .update({ verzonden_bevestiging_op: new Date().toISOString() })
      .eq("id", contract_id);

    return new Response(
      JSON.stringify({
        success: true,
        id: result.id,
        partner_slug: branding.slug,
        lang,
        attachments_count: attachments.length,
        company_only: recipient.isCompanyOnly,
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
// EMAIL TEMPLATE — branded shell + per-language body
// ═══════════════════════════════════════════════════════════════════════════════

interface ShellOptions {
  branding: PartnerBranding;
  lang: Lang;
  headerTitle: string;
  headerSubtitle: string;
  bodyHtml: string;
  optOutFooterHtml: string;
}

function renderEmailShell(opts: ShellOptions): string {
  const { branding, lang, headerTitle, headerSubtitle, bodyHtml, optOutFooterHtml } = opts;
  const primary = sanitizeHex(branding.primaryColor, "#1A1A2E");
  const headerLogoOrName = branding.logoUrl
    ? `<img src="${escUrl(branding.logoUrl)}" alt="${escAttr(branding.name)}" style="max-height:48px;max-width:200px;display:block;margin:0 auto 12px" />`
    : `<h1 style="margin:0 0 6px;font-size:22px;letter-spacing:1.5px;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">${escHtml(branding.name)}</h1>`;

  const footerContact = renderFooterContact(branding, lang);
  const flanccoCredit = branding.isFlancco
    ? ""
    : `<p style="margin:8px 0 0;font-size:11px;color:#999">${lang === "fr" ? "Plateforme propuls\u00E9e par" : "Platform aangedreven door"} <strong>Flancco BV</strong></p>`;

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escHtml(headerTitle)}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937">
<div style="max-width:600px;margin:0 auto;padding:20px">
  <div style="background:${primary};color:#fff;padding:28px 32px;border-radius:12px 12px 0 0;text-align:center">
    ${headerLogoOrName}
    <p style="margin:6px 0 0;opacity:0.9;font-size:14px;color:#fff">${escHtml(headerSubtitle)}</p>
  </div>
  <div style="background:#fff;padding:32px;border-radius:0 0 12px 12px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb">
    ${bodyHtml}
    <div style="margin-top:32px;padding-top:24px;border-top:1px solid #e5e7eb">
      ${footerContact}
    </div>
  </div>
  <div style="text-align:center;margin-top:16px">
    ${flanccoCredit}
    ${optOutFooterHtml}
  </div>
</div>
<style>
@media (max-width:480px) {
  div[style*="padding:32px"] { padding:20px !important; }
  table[style*="font-size:14px"] td { font-size:13px !important; }
}
</style>
</body>
</html>`;
}

function renderFooterContact(branding: PartnerBranding, lang: Lang): string {
  const labels = lang === "fr"
    ? { vragen: "Une question ?", website: "Site web" }
    : { vragen: "Vragen?", website: "Website" };

  const contactLines: string[] = [];
  if (branding.telefoon) contactLines.push(`<span style="color:#4b5563">${escHtml(branding.telefoon)}</span>`);
  if (branding.email) {
    contactLines.push(
      `<a href="mailto:${escAttr(branding.email)}" style="color:${sanitizeHex(branding.primaryColor, "#1A1A2E")};text-decoration:none">${escHtml(branding.email)}</a>`,
    );
  }
  if (branding.website) {
    contactLines.push(
      `<a href="${escUrl(branding.website)}" style="color:${sanitizeHex(branding.primaryColor, "#1A1A2E")};text-decoration:none">${labels.website}</a>`,
    );
  }
  if (contactLines.length === 0) return "";

  return `<p style="font-size:14px;color:#6b7280;margin:0 0 8px">${labels.vragen}</p>
    <p style="font-size:14px;margin:0;line-height:1.7">
      <strong style="color:#1f2937">${escHtml(branding.name)}</strong><br>
      ${contactLines.join(" &middot; ")}
    </p>`;
}

function renderOptOutFooter(branding: PartnerBranding, lang: Lang, optOutUrl: string): string {
  const text = lang === "fr"
    ? "Vous pouvez vous d\u00E9sinscrire des e-mails de service \u00E0 tout moment via"
    : "U kunt zich altijd uitschrijven van service-e-mails via";
  const link = lang === "fr" ? "ce lien de d\u00E9sinscription" : "deze uitschrijflink";
  return `<p style="margin:12px 0 0;font-size:11px;color:#9ca3af;line-height:1.5">
    ${escHtml(text)} <a href="${escUrl(optOutUrl)}" style="color:#9ca3af;text-decoration:underline">${escHtml(link)}</a>.
  </p>`;
}

interface BodyContext {
  branding: PartnerBranding;
  klantNaam: string;
  /** Slot T: true → bedrijf-only contract, gebruikt bedrijfs-aanhef. */
  isCompanyOnly: boolean;
  contractNr: string;
  datum: string;
  freq: string;
  duur: string;
  totaal: string;
  btwType: string;
  eerstePeriode: string;
}

interface BodyPayload {
  headerTitle: string;
  headerSubtitle: string;
  bodyHtml: string;
}

function nlContent(c: BodyContext): BodyPayload {
  const accent = sanitizeHex(c.branding.secondaryColor, "#E74C3C");
  const primary = sanitizeHex(c.branding.primaryColor, "#1A1A2E");
  // Slot T — bedrijfs-aanhef bij bedrijf-only contracten (geen specifieke contactpersoon).
  const aanhef = c.isCompanyOnly
    ? `Beste collega's van ${escHtml(c.klantNaam)}`
    : `Beste ${escHtml(c.klantNaam)}`;
  return {
    headerTitle: "Bevestiging overeenkomst",
    headerSubtitle: "Bevestiging overeenkomst",
    bodyHtml: `
      <p style="font-size:16px;margin:0 0 20px">${aanhef},</p>
      <p style="font-size:14px;line-height:1.7;margin:0 0 16px">Hartelijk dank voor uw vertrouwen in <strong>${escHtml(c.branding.name)}</strong>. Uw overeenkomst voor professioneel onderhoud van uw zonnepanelen is succesvol ondertekend.</p>
      <p style="font-size:14px;line-height:1.7;margin:0 0 16px">In bijlage vindt u:</p>
      <ul style="font-size:14px;line-height:1.8;color:#374151;margin:0 0 16px;padding-left:20px">
        <li><strong>Uw ondertekende contract</strong> (PDF) &mdash; bewaar dit voor uw dossier</li>
        <li><strong>Modelformulier voor herroeping</strong> (PDF) &mdash; conform EU-richtlijn 2011/83/EU</li>
      </ul>
      <div style="background:#f8f9fa;border-left:3px solid ${accent};border-radius:8px;padding:20px;margin:24px 0">
        <h3 style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:1.2px">Samenvatting</h3>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr><td style="padding:6px 0;color:#6b7280">Contractnummer</td><td style="padding:6px 0;text-align:right;font-weight:600;color:#1f2937">${escHtml(c.contractNr)}</td></tr>
          <tr><td style="padding:6px 0;color:#6b7280">Datum ondertekening</td><td style="padding:6px 0;text-align:right;color:#1f2937">${escHtml(c.datum)}</td></tr>
          <tr><td style="padding:6px 0;color:#6b7280">Frequentie</td><td style="padding:6px 0;text-align:right;color:#1f2937">${escHtml(c.freq)}</td></tr>
          <tr><td style="padding:6px 0;color:#6b7280">Contractduur</td><td style="padding:6px 0;text-align:right;color:#1f2937">${escHtml(c.duur)}</td></tr>
          <tr style="border-top:2px solid #e5e7eb"><td style="padding:10px 0 0;font-weight:700;color:#1f2937">Totaal per beurt</td><td style="padding:10px 0 0;text-align:right;font-weight:700;font-size:18px;color:${primary}">&euro; ${escHtml(c.totaal)}</td></tr>
          <tr><td colspan="2" style="padding:2px 0 0;font-size:12px;color:#9ca3af;text-align:right">incl. ${escHtml(c.btwType)} btw</td></tr>
        </table>
      </div>
      <h3 style="font-size:15px;margin:24px 0 12px;color:#1f2937">Wat gebeurt er nu?</h3>
      <ol style="margin:0;padding-left:20px;font-size:14px;line-height:1.8;color:#374151">
        <li>Wij plannen uw eerste onderhoudsbeurt in <strong>${escHtml(c.eerstePeriode)}</strong></li>
        <li>U wordt telefonisch gecontacteerd voor een concrete datum</li>
        <li>Na uitvoering ontvangt u een digitaal rapport met foto's</li>
      </ol>
      <div style="background:#fff8e7;border:1px solid #f0dca0;border-radius:8px;padding:16px 20px;margin:24px 0;font-size:13px;color:#7a6520;line-height:1.6">
        <strong>Herroepingsrecht</strong><br>
        U heeft het recht om binnen 14 kalenderdagen na ondertekening deze overeenkomst zonder opgave van redenen te herroepen, conform de Europese richtlijn 2011/83/EU. Gebruik hiervoor het bijgevoegde modelformulier of een eigen schriftelijke mededeling.
      </div>`,
  };
}

function frContent(c: BodyContext): BodyPayload {
  const accent = sanitizeHex(c.branding.secondaryColor, "#E74C3C");
  const primary = sanitizeHex(c.branding.primaryColor, "#1A1A2E");
  // Slot T — adresse à l'entreprise pour les contrats sans personne de contact.
  const aanhef = c.isCompanyOnly
    ? `Chers collègues de ${escHtml(c.klantNaam)}`
    : `Bonjour ${escHtml(c.klantNaam)}`;
  return {
    headerTitle: "Confirmation de l'accord",
    headerSubtitle: "Confirmation de l'accord",
    bodyHtml: `
      <p style="font-size:16px;margin:0 0 20px">${aanhef},</p>
      <p style="font-size:14px;line-height:1.7;margin:0 0 16px">Merci de votre confiance en <strong>${escHtml(c.branding.name)}</strong>. Votre accord pour l'entretien professionnel de vos panneaux solaires a \u00E9t\u00E9 sign\u00E9 avec succ\u00E8s.</p>
      <p style="font-size:14px;line-height:1.7;margin:0 0 16px">Vous trouverez en pi\u00E8ce jointe :</p>
      <ul style="font-size:14px;line-height:1.8;color:#374151;margin:0 0 16px;padding-left:20px">
        <li><strong>Votre contrat sign\u00E9</strong> (PDF) &mdash; \u00E0 conserver pour votre dossier</li>
        <li><strong>Formulaire de r\u00E9tractation</strong> (PDF) &mdash; conforme \u00E0 la directive UE 2011/83/UE</li>
      </ul>
      <div style="background:#f8f9fa;border-left:3px solid ${accent};border-radius:8px;padding:20px;margin:24px 0">
        <h3 style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:1.2px">R\u00E9sum\u00E9</h3>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr><td style="padding:6px 0;color:#6b7280">N\u00B0 de contrat</td><td style="padding:6px 0;text-align:right;font-weight:600;color:#1f2937">${escHtml(c.contractNr)}</td></tr>
          <tr><td style="padding:6px 0;color:#6b7280">Date de signature</td><td style="padding:6px 0;text-align:right;color:#1f2937">${escHtml(c.datum)}</td></tr>
          <tr><td style="padding:6px 0;color:#6b7280">Fr\u00E9quence</td><td style="padding:6px 0;text-align:right;color:#1f2937">${escHtml(c.freq)}</td></tr>
          <tr><td style="padding:6px 0;color:#6b7280">Dur\u00E9e du contrat</td><td style="padding:6px 0;text-align:right;color:#1f2937">${escHtml(c.duur)}</td></tr>
          <tr style="border-top:2px solid #e5e7eb"><td style="padding:10px 0 0;font-weight:700;color:#1f2937">Total par intervention</td><td style="padding:10px 0 0;text-align:right;font-weight:700;font-size:18px;color:${primary}">&euro; ${escHtml(c.totaal)}</td></tr>
          <tr><td colspan="2" style="padding:2px 0 0;font-size:12px;color:#9ca3af;text-align:right">TVA ${escHtml(c.btwType)} comprise</td></tr>
        </table>
      </div>
      <h3 style="font-size:15px;margin:24px 0 12px;color:#1f2937">Et maintenant ?</h3>
      <ol style="margin:0;padding-left:20px;font-size:14px;line-height:1.8;color:#374151">
        <li>Nous planifions votre premi\u00E8re intervention <strong>${escHtml(c.eerstePeriode)}</strong></li>
        <li>Vous serez contact\u00E9 par t\u00E9l\u00E9phone pour fixer une date</li>
        <li>Apr\u00E8s l'intervention, vous recevrez un rapport digital avec photos</li>
      </ol>
      <div style="background:#fff8e7;border:1px solid #f0dca0;border-radius:8px;padding:16px 20px;margin:24px 0;font-size:13px;color:#7a6520;line-height:1.6">
        <strong>Droit de r\u00E9tractation</strong><br>
        Vous disposez de 14 jours calendrier apr\u00E8s la signature pour r\u00E9tracter cet accord sans justification, conform\u00E9ment \u00E0 la directive UE 2011/83/UE. Utilisez le formulaire ci-joint ou un \u00E9crit personnel.
      </div>`,
  };
}

function computeFirstWindow(lang: Lang): string {
  const nu = new Date();
  const maand = nu.getMonth() + 1;
  if (maand >= 3 && maand <= 10) {
    return lang === "fr" ? "dans les prochaines semaines" : "de komende weken";
  }
  const jaar = maand > 10 ? nu.getFullYear() + 1 : nu.getFullYear();
  return lang === "fr" ? `en mars\u2013avril ${jaar}` : `in maart\u2013april ${jaar}`;
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
 * Slot T — resolve recipient email + greeting based on whether the contract
 * is bedrijf-only (no specific contact person) or has a linked contact.
 *
 * Resolution order:
 *   1. client_contact_id IS NOT NULL → look up client_contacts → use first_name + email
 *   2. client_contact_id IS NULL + client_id → look up clients → use company_name + email
 *   3. fallback → contracten.klant_email + contracten.klant_naam (legacy)
 *
 * Bedrijf-only is true only when path (2) is hit AND there is a non-empty company_name.
 */
async function resolveRecipient(
  // deno-lint-ignore no-explicit-any
  sb: any,
  contract: ContractRow,
): Promise<RecipientResolution> {
  // Path 1 — specifieke contactpersoon
  if (contract.client_contact_id) {
    const { data: cc } = await sb
      .from("client_contacts")
      .select("first_name, last_name, email")
      .eq("id", contract.client_contact_id)
      .maybeSingle();
    const email = (cc?.email || contract.klant_email || "").trim();
    const greeting = (cc?.first_name || contract.klant_naam || "").trim() || "klant";

    // Optional: ook company_name ophalen voor metadata (niet strict noodzakelijk)
    let companyName: string | null = null;
    if (contract.client_id) {
      const { data: client } = await sb
        .from("clients")
        .select("company_name")
        .eq("id", contract.client_id)
        .maybeSingle();
      companyName = client?.company_name ?? null;
    }
    return { email, greetingName: greeting, isCompanyOnly: false, companyName };
  }

  // Path 2 — bedrijf-only (geen contact-FK, wel client_id)
  if (contract.client_id) {
    const { data: client } = await sb
      .from("clients")
      .select("company_name, email")
      .eq("id", contract.client_id)
      .maybeSingle();
    const company = (client?.company_name || "").trim();
    if (company) {
      const email = (client?.email || contract.klant_email || "").trim();
      return {
        email,
        greetingName: company,
        isCompanyOnly: true,
        companyName: company,
      };
    }
  }

  // Path 3 — legacy fallback (geen client_id koppeling)
  return {
    email: (contract.klant_email || "").trim(),
    greetingName: contract.klant_naam || "klant",
    isCompanyOnly: false,
    companyName: null,
  };
}

/**
 * Pick the email_service consent token for the contract — used to render the
 * opt-out footer link. We only fetch the token; if the consent row is missing
 * or already opted out, we skip the footer.
 */
async function fetchOptOutToken(
  // deno-lint-ignore no-explicit-any
  sb: any,
  contractId: string,
  klantEmail: string,
): Promise<string | null> {
  try {
    const { data } = await sb
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
    console.warn("fetchOptOutToken failed (non-fatal):", e);
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

function escAttr(s: string | null | undefined): string {
  return escHtml(s);
}

function escUrl(s: string | null | undefined): string {
  // Allow only http(s) + mailto. Reject otherwise so we never inject javascript:.
  const v = String(s ?? "").trim();
  if (!v) return "";
  if (/^(https?:|mailto:)/i.test(v)) {
    return v.replace(/"/g, "%22").replace(/</g, "%3C").replace(/>/g, "%3E");
  }
  return "";
}

function sanitizeHex(value: string | null | undefined, fallback: string): string {
  const v = String(value ?? "").trim();
  if (/^#?[0-9a-fA-F]{6}$/.test(v)) return v.startsWith("#") ? v : `#${v}`;
  if (/^#?[0-9a-fA-F]{3}$/.test(v)) return v.startsWith("#") ? v : `#${v}`;
  return fallback;
}
