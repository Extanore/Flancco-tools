// Slot P — STUB for getekend contract-PDF (will be implemented in Slot O2).
//
// Today the contract-PDF lives inline in the calculator (client-side jsPDF) and
// is uploaded to bucket `contracten-pdf`. Slot O2 will move generation server-side
// so the canonical signed copy is rendered and stored consistently.
//
// TODO[O2]: Port the calculator's PDF layout server-side, including:
//   - Contract header with partner branding + contract_nummer
//   - Klantgegevens block
//   - Sectoren / scope tabel
//   - Prijsopbouw met BTW-regime (6% renovatie waar van toepassing)
//   - Algemene voorwaarden (link of full text)
//   - Handtekening blok (image + datum + IP-adres ondertekening voor audit)

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
  klant_naam?: string;
  [key: string]: unknown;
}

export async function renderContractSigned(
  data: ContractSignedData,
  branding: PartnerBranding,
  lang: Lang,
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`Contract — ${branding.name}`);
  pdfDoc.setAuthor(branding.name);
  pdfDoc.setSubject("Getekend contract (stub — Slot O2)");
  pdfDoc.setCreator("Flancco Platform — generate-pdf");
  pdfDoc.setCreationDate(new Date());

  const fonts = await embedStandardFonts(pdfDoc);
  const page = pdfDoc.addPage(A4_PORTRAIT);

  const ctx = { pdfDoc, page, branding, lang, fonts, pageNum: 1, totalPages: 1 };

  const y = await drawHeader(ctx, {
    title: lang === "fr" ? "Contrat" : "Contract",
    subtitle: data.contract_nummer ? `#${data.contract_nummer}` : undefined,
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

  drawFooter(ctx);
  return await pdfDoc.save();
}
