// Slot P — STUB for branded onderhouds-rapport (will be implemented in Slot C3).
//
// This stub exists so the dispatcher in index.ts can route to all four templates
// today. It produces a 1-page placeholder with the partner header so the wiring
// can be validated end-to-end before C3 fleshes out the real layout.
//
// TODO[C3]: Implement full rapport with sections:
//   - Vooraf-foto's per onderdeel
//   - Bevindingen / acties uitgevoerd
//   - Verbruikt materiaal (intern only — niet op output, zie MEMORY)
//   - Aanbevelingen
//   - Klant-handtekening voor ontvangst
// Branding moet altijd partner-stijl zijn (logo, kleuren), niet generiek Flancco.

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

export interface RapportBrandedData {
  /** Reference to onderhoudsbeurt id when known. */
  beurt_id?: string;
  /** Customer + visit metadata that C3 will expand. */
  klant_naam?: string;
  datum?: string;
  /** Free-form payload that C3 will replace with a real schema. */
  [key: string]: unknown;
}

export async function renderRapportBranded(
  data: RapportBrandedData,
  branding: PartnerBranding,
  lang: Lang,
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`Onderhoudsrapport — ${branding.name}`);
  pdfDoc.setAuthor(branding.name);
  pdfDoc.setSubject("Onderhoudsrapport (stub — Slot C3)");
  pdfDoc.setCreator("Flancco Platform — generate-pdf");
  pdfDoc.setCreationDate(new Date());

  const fonts = await embedStandardFonts(pdfDoc);
  const page = pdfDoc.addPage(A4_PORTRAIT);

  const ctx = {
    pdfDoc,
    page,
    branding,
    lang,
    fonts,
    pageNum: 1,
    totalPages: 1,
  };

  const y = await drawHeader(ctx, {
    title: lang === "fr" ? "Rapport d'entretien" : "Onderhoudsrapport",
    subtitle: data.klant_naam ? String(data.klant_naam) : undefined,
  });

  drawText(page, lang === "fr"
    ? "Ce modèle de rapport sera implémenté dans le slot C3."
    : "Dit rapport-template wordt in slot C3 ingevuld.", {
    x: MARGIN.left,
    y: y - 20,
    size: 11,
    font: fonts.italic,
    color: PALETTE.muted,
  });

  drawText(page, lang === "fr"
    ? "Référence beurt: " + (data.beurt_id ?? "n/a")
    : "Beurt-referentie: " + (data.beurt_id ?? "n/a"), {
    x: MARGIN.left,
    y: y - 40,
    size: 10,
    font: fonts.regular,
    color: PALETTE.ink,
  });

  drawFooter(ctx);
  return await pdfDoc.save();
}
