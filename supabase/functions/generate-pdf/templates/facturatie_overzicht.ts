// Slot P — STUB for facturatie-overzicht (will be implemented in Slot D).
//
// Use case: Maandelijks per-partner overzicht van uitgevoerde beurten met
// forfait + planning fee + marge — bron-document voor de Flancco↔partner
// verrekening. Geen klant-facing document; intern en richting partner.
//
// TODO[D]: Implement layout:
//   - Periode header (maand / kwartaal)
//   - Tabel: datum | klant | aantal panelen | forfait | planning_fee | marge_pct | totaal
//   - Subtotaal per sector
//   - Totaal te factureren / te crediteren
//   - Reconciliatie-checksum tegen contracten.pdf_url status

import { PDFDocument } from "https://esm.sh/pdf-lib@1.17.1";
import {
  A4_LANDSCAPE,
  drawFooter,
  drawHeader,
  drawText,
  embedStandardFonts,
  Lang,
  MARGIN,
  PALETTE,
  PartnerBranding,
} from "./_shared.ts";

export interface FacturatieOverzichtData {
  periode_van?: string;
  periode_tot?: string;
  partner_id?: string;
  [key: string]: unknown;
}

export async function renderFacturatieOverzicht(
  data: FacturatieOverzichtData,
  branding: PartnerBranding,
  lang: Lang,
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`Facturatie-overzicht — ${branding.name}`);
  pdfDoc.setAuthor(branding.name);
  pdfDoc.setSubject("Facturatie-overzicht (stub — Slot D)");
  pdfDoc.setCreator("Flancco Platform — generate-pdf");
  pdfDoc.setCreationDate(new Date());

  const fonts = await embedStandardFonts(pdfDoc);
  const page = pdfDoc.addPage(A4_LANDSCAPE);

  const ctx = { pdfDoc, page, branding, lang, fonts, pageNum: 1, totalPages: 1 };

  // ASCII arrow keeps WinAnsi-safe without depending on the sanitizer.
  const periodeStr = data.periode_van && data.periode_tot
    ? `${data.periode_van} -> ${data.periode_tot}`
    : undefined;

  const y = await drawHeader(ctx, {
    title: lang === "fr" ? "Aperçu de facturation" : "Facturatie-overzicht",
    subtitle: periodeStr,
  });

  drawText(page, lang === "fr"
    ? "Ce modèle de facturation sera implémenté dans le slot D."
    : "Dit facturatie-template wordt in slot D ingevuld.", {
    x: MARGIN.left,
    y: y - 20,
    size: 11,
    font: fonts.italic,
    color: PALETTE.muted,
  });

  drawFooter(ctx);
  return await pdfDoc.save();
}
