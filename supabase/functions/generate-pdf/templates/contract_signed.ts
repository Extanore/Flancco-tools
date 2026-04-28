// Slot P — STUB for getekend contract-PDF (will be fully implemented in Slot O2).
//
// Today the contract-PDF lives inline in the calculator (client-side jsPDF) and
// is uploaded to bucket `contracten-pdf`. Slot O2 will move generation server-side
// so the canonical signed copy is rendered and stored consistently.
//
// Slot T CC1 — Bedrijf-only rendering support
// --------------------------------------------------------------------------
// Wanneer `client_contact_id` IS NULL (= "bedrijf-only contract"):
//   - Title is enkel `company_name` (bedrijfsnaam-snapshot via klant_naam)
//   - Geen "Contactpersoon: …" regel
//   - Ondertekening-blok toont "Naam: <bedrijfsnaam>" i.p.v. persoonsnaam
//   - Klein juridisch disclaimer: "Ondertekend door gemachtigde namens <bedrijfsnaam>"
// Wanneer er WEL een `client_contact_id`/`contact_first_name+contact_last_name`
// is meegegeven, behoudt het template het standaard persoon-gedrag.
//
// TODO[O2]: Volledig contract-template (header, scope-tabel, prijsopbouw,
// algemene voorwaarden, handtekening-image). De Slot T-vertakkingen hieronder
// blijven dan behouden.

import { PDFDocument } from "https://esm.sh/pdf-lib@1.17.1";
import {
  A4_PORTRAIT,
  drawFooter,
  drawHeader,
  drawText,
  embedStandardFonts,
  Lang,
  MARGIN,
  PALETTE,
  PartnerBranding,
} from "./_shared.ts";

export interface ContractSignedData {
  contract_id?: string;
  contract_nummer?: string;

  // Klant-snapshot (legacy)
  klant_naam?: string;

  // Slot T — bedrijf-only detectie + display-fields
  /** UUID van specifieke contactpersoon binnen het bedrijf. NULL = bedrijf-only contract. */
  client_contact_id?: string | null;
  /** Bedrijfsnaam (clients.company_name). Vereist voor bedrijf-only rendering. */
  company_name?: string | null;
  /** Voornaam contactpersoon (alleen relevant als client_contact_id !== null). */
  contact_first_name?: string | null;
  /** Achternaam contactpersoon. */
  contact_last_name?: string | null;
  /** Functie / rol contactpersoon (optioneel). */
  contact_role?: string | null;

  [key: string]: unknown;
}

interface ResolvedSubject {
  /** Wat als titel-subtitle bovenaan komt (zonder contact-naam). */
  partyDisplayName: string;
  /** Naam in het ondertekening-blok ("Naam: ..."). */
  signatureName: string;
  /** Optioneel sub-label onder signatureName (functie of vertegenwoordigings-disclaimer). */
  signatureSubtitle: string | null;
  /** True wanneer geen specifieke contactpersoon → bedrijfs-rendering. */
  isCompanyOnly: boolean;
}

/**
 * Resolve display + signature names op basis van Slot T bedrijf-only-mode.
 * Defensief: als input incompleet is, val terug op klant_naam.
 */
function resolveSubject(data: ContractSignedData, lang: Lang): ResolvedSubject {
  const company = (data.company_name || "").trim();
  const klantSnapshot = (data.klant_naam || "").trim();
  const firstName = (data.contact_first_name || "").trim();
  const lastName = (data.contact_last_name || "").trim();
  const role = (data.contact_role || "").trim();

  // Bedrijf-only: client_contact_id IS NULL én we hebben een company_name.
  // (klant_subtype op `contracten` kan ook 'bedrijf' zijn, maar de meest
  //  betrouwbare signal is dat er geen contactpersoon-FK gekoppeld is.)
  const noContactFk = data.client_contact_id === null || data.client_contact_id === undefined;
  const isCompanyOnly = noContactFk && company.length > 0;

  if (isCompanyOnly) {
    const disclaimer = lang === "fr"
      ? `Signé par mandataire au nom de ${company}`
      : `Ondertekend door gemachtigde namens ${company}`;
    return {
      partyDisplayName: company,
      signatureName: company,
      signatureSubtitle: disclaimer,
      isCompanyOnly: true,
    };
  }

  // Persoon-mode: bouw "Voornaam Achternaam" indien beschikbaar, anders snapshot.
  const personName = [firstName, lastName].filter(Boolean).join(" ").trim();
  const display = personName || klantSnapshot || (lang === "fr" ? "Client" : "Klant");

  // Bij hybride (persoon binnen bedrijf): toon "Persoon · Bedrijf" en functie als subtitle.
  let partyDisplay = display;
  if (company && personName) {
    partyDisplay = `${personName} · ${company}`;
  }

  return {
    partyDisplayName: partyDisplay,
    signatureName: display,
    signatureSubtitle: role || null,
    isCompanyOnly: false,
  };
}

export async function renderContractSigned(
  data: ContractSignedData,
  branding: PartnerBranding,
  lang: Lang,
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const subject = resolveSubject(data, lang);

  // Slot T: titel altijd "Contract — <bedrijfsnaam>" voor bedrijf-only,
  // anders "Contract — <branding.name>" (legacy).
  const docTitle = subject.isCompanyOnly
    ? `${lang === "fr" ? "Contrat" : "Contract"} — ${subject.partyDisplayName}`
    : `Contract — ${branding.name}`;

  pdfDoc.setTitle(docTitle);
  pdfDoc.setAuthor(branding.name);
  pdfDoc.setSubject(subject.isCompanyOnly
    ? "Getekend contract (bedrijf-only — Slot T)"
    : "Getekend contract (stub — Slot O2)");
  pdfDoc.setCreator("Flancco Platform — generate-pdf");
  pdfDoc.setCreationDate(new Date());

  const fonts = await embedStandardFonts(pdfDoc);
  const page = pdfDoc.addPage(A4_PORTRAIT);

  const ctx = { pdfDoc, page, branding, lang, fonts, pageNum: 1, totalPages: 1 };

  const headerSubtitle: string[] = [];
  if (data.contract_nummer) headerSubtitle.push(`#${data.contract_nummer}`);
  // Slot T: in header tonen we party-naam (bedrijf-only of persoon-mode).
  if (subject.partyDisplayName) headerSubtitle.push(subject.partyDisplayName);

  const y = await drawHeader(ctx, {
    title: lang === "fr" ? "Contrat" : "Contract",
    subtitle: headerSubtitle.length ? headerSubtitle.join(" — ") : undefined,
  });

  drawText(page, lang === "fr"
    ? "Ce modèle de contrat sera implémenté dans le slot O2."
    : "Dit contract-template wordt in slot O2 ingevuld.", {
    x: MARGIN.left,
    y: y - 20,
    size: 11,
    font: fonts.italic,
    color: PALETTE.muted,
  });

  drawText(page, "Contract-id: " + (data.contract_id ?? "n/a"), {
    x: MARGIN.left,
    y: y - 40,
    size: 10,
    font: fonts.regular,
    color: PALETTE.ink,
  });

  // ─── Ondertekening-blok (Slot T) ───────────────────────────────────────────
  // Persoon-mode: Contactpersoon-regel + Naam: <persoon>
  // Bedrijf-only: GEEN Contactpersoon-regel, Naam: <bedrijfsnaam> + disclaimer
  const sigBlockY = y - 80;
  const sigLabel = lang === "fr" ? "Signé par :" : "Ondertekend door:";

  drawText(page, sigLabel, {
    x: MARGIN.left,
    y: sigBlockY,
    size: 10,
    font: fonts.bold,
    color: PALETTE.ink,
  });

  drawText(page, (lang === "fr" ? "Nom : " : "Naam: ") + subject.signatureName, {
    x: MARGIN.left,
    y: sigBlockY - 16,
    size: 11,
    font: fonts.regular,
    color: PALETTE.ink,
  });

  if (!subject.isCompanyOnly && subject.signatureSubtitle) {
    // Persoon-mode met functie/rol → tonen onder de naam.
    drawText(page, (lang === "fr" ? "Fonction : " : "Functie: ") + subject.signatureSubtitle, {
      x: MARGIN.left,
      y: sigBlockY - 30,
      size: 9,
      font: fonts.italic,
      color: PALETTE.muted,
    });
  }

  if (subject.isCompanyOnly && subject.signatureSubtitle) {
    // Bedrijf-only → klein juridisch disclaimer onder de naam.
    drawText(page, subject.signatureSubtitle, {
      x: MARGIN.left,
      y: sigBlockY - 30,
      size: 9,
      font: fonts.italic,
      color: PALETTE.muted,
    });
  }

  drawFooter(ctx);
  return await pdfDoc.save();
}
