// Gedeelde helper voor het MODELFORMULIER VOOR HERROEPING conform Europese richtlijn 2011/83/EU.
// Genereert een 1-pagina PDF met pdf-lib (Deno-compatibel via esm.sh).
//
// Juridische basis:
// - EU Richtlijn 2011/83/EU, bijlage I, deel B — modelformulier voor herroeping.
// - Belgisch recht: boek VI WER, art. VI.47 e.v. (Overeenkomsten op afstand).
// - Bij ontbreken van dit formulier in de precontractuele/contractuele informatie, wordt de
//   14-daagse termijn met 12 maanden verlengd (art. VI.53 WER).
//
// Gebruik:
//   import { generateHerroepingsformulierPdf } from "../_shared/herroeping.ts";
//   const bytes = await generateHerroepingsformulierPdf({ partnerName, partnerAddress, partnerEmail });
//   // bytes is Uint8Array — base64 encode voor Resend attachment.

import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";

export interface HerroepingContext {
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
export async function generateHerroepingsformulierPdf(ctx: HerroepingContext): Promise<Uint8Array> {
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
export function uint8ToBase64(bytes: Uint8Array): string {
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
