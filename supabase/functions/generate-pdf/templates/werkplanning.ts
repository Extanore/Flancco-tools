// Slot P — Werkplanning template
//
// Generates a per-day-per-technicien work-planning PDF that techniciens print or
// view on a phone before starting their shift. Audience is the technicien; the
// document is intentionally simple, dense, and high-contrast.
//
// Input contract (validated upstream in index.ts):
//   {
//     datum: ISO date string,                  // YYYY-MM-DD
//     technieker_naam: string,
//     technieker_telefoon?: string,
//     beurten: WerkplanningBeurt[]             // ordered by start_tijd
//   }
//
// Each beurt represents a planned visit. Fields beyond this minimum are optional
// — they're rendered when present and silently dropped when not, so this template
// can absorb additional context as the planning module evolves.

import { PDFDocument, PDFFont, PDFPage, rgb } from "https://esm.sh/pdf-lib@1.17.1";
import {
  A4_PORTRAIT,
  drawFooter,
  drawHeader,
  drawText,
  drawWrapped,
  embedStandardFonts,
  FontPack,
  formatDate,
  formatPostalAddress,
  hexToRgb,
  Lang,
  MARGIN,
  PALETTE,
  PartnerBranding,
  sanitize,
  wrapText,
} from "./_shared.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface WerkplanningBeurt {
  /** Internal id, used for footer reference; not shown unless needed. */
  id?: string;
  /** Customer display name. */
  klant_naam: string;
  /** Optional contact for the technicien on-site. */
  klant_telefoon?: string;
  klant_adres?: string;
  klant_postcode?: string;
  klant_gemeente?: string;
  /** "08:00" – "10:00", or just a start time. */
  tijd_slot?: string;
  start_tijd?: string;
  eind_tijd?: string;
  /** Short bullet-style summary of what to do on-site. */
  scope_samenvatting?: string;
  /** Free-form notes — special access, dog on premises, key-box code, etc. */
  special_instructions?: string;
  /** Number of panels (zonnepanelen) — when relevant. */
  aantal_panelen?: number;
  /** Sector slug e.g. "zon", "warmtepomp". Rendered as a tag. */
  sector?: string;
  /** Estimated duration in minutes — rendered next to the time slot. */
  geschatte_duur_min?: number;
}

export interface WerkplanningData {
  datum: string;
  technieker_naam: string;
  technieker_telefoon?: string;
  beurten: WerkplanningBeurt[];
  /** Optional global note shown directly under the header. */
  algemene_opmerking?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Layout constants
// ─────────────────────────────────────────────────────────────────────────────

const ROW_PADDING_Y = 10;
const SECTION_GAP = 10;
const BEURT_NUM_COL_WIDTH = 26;
const SCOPE_INDENT = 14;

// ─────────────────────────────────────────────────────────────────────────────
// i18n (template-local — keeps engine-level _shared lean)
// ─────────────────────────────────────────────────────────────────────────────

interface Strings {
  documentTitle: string;
  documentSubtitle: (date: string) => string;
  technicien: string;
  totalBeurten: (n: number) => string;
  noBeurten: string;
  scope: string;
  specialInstructions: string;
  contact: string;
  panels: (n: number) => string;
  estimatedDuration: (n: number) => string;
  generalNote: string;
}

// All strings stay within the WinAnsi range (Latin-1 Supplement + Latin Extended-A)
// so they survive the sanitizer in `_shared.ts` without modification. Use `\u00B1`
// rather than ± literal to keep the source file 7-bit ASCII and avoid editor/encoding
// surprises in CI.
const NL: Strings = {
  documentTitle: "Werkplanning",
  documentSubtitle: (d) => d,
  technicien: "Technicus",
  totalBeurten: (n) => `${n} beurt${n === 1 ? "" : "en"} ingepland`,
  noBeurten: "Geen beurten ingepland voor vandaag.",
  scope: "Werkomschrijving",
  specialInstructions: "Bijzonderheden",
  contact: "Contact",
  panels: (n) => `${n} paneel${n === 1 ? "" : "en"}`,
  estimatedDuration: (n) => `\u00B1${n} min`,
  generalNote: "Algemene opmerking",
};

const FR: Strings = {
  documentTitle: "Planning de travail",
  documentSubtitle: (d) => d,
  technicien: "Technicien",
  totalBeurten: (n) => `${n} intervention${n === 1 ? "" : "s"} planifi\u00E9e${n === 1 ? "" : "s"}`,
  noBeurten: "Aucune intervention planifi\u00E9e aujourd'hui.",
  scope: "Description du travail",
  specialInstructions: "Particularit\u00E9s",
  contact: "Contact",
  panels: (n) => `${n} panneau${n === 1 ? "" : "x"}`,
  estimatedDuration: (n) => `\u00B1${n} min`,
  generalNote: "Note g\u00E9n\u00E9rale",
};

const SECTOR_LABELS: Record<string, { nl: string; fr: string }> = {
  zon: { nl: "Zonnepanelen", fr: "Panneaux solaires" },
  warmtepomp: { nl: "Warmtepomp", fr: "Pompe \u00E0 chaleur" },
  ventilatie: { nl: "Ventilatie", fr: "Ventilation" },
  verwarming: { nl: "Verwarming", fr: "Chauffage" },
  airco: { nl: "Airco", fr: "Climatisation" },
};

function getStrings(lang: Lang): Strings {
  return lang === "fr" ? FR : NL;
}

function sectorLabel(slug: string | undefined, lang: Lang): string {
  if (!slug) return "";
  const entry = SECTOR_LABELS[slug.toLowerCase()];
  if (!entry) return slug;
  return lang === "fr" ? entry.fr : entry.nl;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public render
// ─────────────────────────────────────────────────────────────────────────────

export async function renderWerkplanning(
  data: WerkplanningData,
  branding: PartnerBranding,
  lang: Lang,
): Promise<Uint8Array> {
  const strings = getStrings(lang);
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`${strings.documentTitle} ${data.datum} — ${data.technieker_naam}`);
  pdfDoc.setAuthor(branding.name);
  pdfDoc.setSubject(strings.documentTitle);
  pdfDoc.setCreator("Flancco Platform — generate-pdf");
  pdfDoc.setCreationDate(new Date());

  const fonts = await embedStandardFonts(pdfDoc);

  // Pre-compute beurten layout: each beurt's required height. We paginate based
  // on remaining space; new pages re-draw header/footer.
  const sortedBeurten = [...data.beurten].sort((a, b) => {
    const ta = (a.start_tijd || a.tijd_slot || "").toString();
    const tb = (b.start_tijd || b.tijd_slot || "").toString();
    return ta.localeCompare(tb);
  });

  const pages: PDFPage[] = [];
  let page = pdfDoc.addPage(A4_PORTRAIT);
  pages.push(page);

  // pageNum + totalPages are placeholders; the footer pass below patches both
  // once pagination is complete.
  const ctxBase = {
    pdfDoc,
    branding,
    lang,
    fonts,
    pageNum: 1,
    totalPages: 1,
  };

  let y = await drawHeader(
    { ...ctxBase, page },
    {
      title: strings.documentTitle,
      subtitle: strings.documentSubtitle(formatDate(data.datum, lang)),
    },
  );

  // Sub-header bar with technicien name + total
  y = drawSubHeader(page, fonts.bold, fonts.regular, branding, y, {
    technicien: `${strings.technicien}: ${data.technieker_naam}`,
    technicienPhone: data.technieker_telefoon || "",
    total: strings.totalBeurten(sortedBeurten.length),
  });

  // Optional general note
  if (data.algemene_opmerking) {
    y = drawCallout(page, fonts.bold, fonts.regular, strings.generalNote, data.algemene_opmerking, y);
  }

  // Empty state
  if (sortedBeurten.length === 0) {
    drawText(page, strings.noBeurten, {
      x: MARGIN.left,
      y: y - 24,
      size: 12,
      font: fonts.italic,
      color: PALETTE.muted,
    });
  }

  // Beurten loop
  const contentWidth = page.getWidth() - MARGIN.left - MARGIN.right;
  const minY = MARGIN.bottom + 8;

  for (let i = 0; i < sortedBeurten.length; i++) {
    const beurt = sortedBeurten[i];
    const blockHeight = estimateBeurtHeight(beurt, fonts.regular, contentWidth);
    if (y - blockHeight < minY) {
      page = pdfDoc.addPage(A4_PORTRAIT);
      pages.push(page);
      y = await drawHeader(
        { ...ctxBase, page },
        {
          title: strings.documentTitle,
          subtitle: strings.documentSubtitle(formatDate(data.datum, lang)),
        },
      );
      y = drawSubHeader(page, fonts.bold, fonts.regular, branding, y, {
        technicien: `${strings.technicien}: ${data.technieker_naam}`,
        technicienPhone: data.technieker_telefoon || "",
        total: strings.totalBeurten(sortedBeurten.length),
      });
    }
    y = drawBeurt(page, fonts, beurt, i + 1, branding, lang, strings, y, contentWidth);
  }

  // Footer pass — total pages now known
  pages.forEach((p, idx) => {
    drawFooter({
      ...ctxBase,
      page: p,
      pageNum: idx + 1,
      totalPages: pages.length,
    });
  });

  return await pdfDoc.save();
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal layout helpers
// ─────────────────────────────────────────────────────────────────────────────

interface SubHeaderInput {
  technicien: string;
  technicienPhone: string;
  total: string;
}

function drawSubHeader(
  page: PDFPage,
  fontBold: PDFFont,
  fontRegular: PDFFont,
  branding: PartnerBranding,
  y: number,
  input: SubHeaderInput,
): number {
  const accent = hexToRgb(branding.secondaryColor, rgb(0.91, 0.3, 0.24));
  // Left: technicien block
  drawText(page, input.technicien, {
    x: MARGIN.left,
    y, size: 13, font: fontBold, color: PALETTE.ink,
  });
  if (input.technicienPhone) {
    drawText(page, input.technicienPhone, {
      x: MARGIN.left,
      y: y - 14,
      size: 9,
      font: fontRegular,
      color: PALETTE.muted,
    });
  }
  // Right: total beurten chip
  const totalWidth = fontBold.widthOfTextAtSize(sanitize(input.total), 9) + 18;
  page.drawRectangle({
    x: page.getWidth() - MARGIN.right - totalWidth,
    y: y - 4,
    width: totalWidth,
    height: 18,
    color: accent,
  });
  drawText(page, input.total, {
    x: page.getWidth() - MARGIN.right - totalWidth + 9,
    y: y + 1,
    size: 9,
    font: fontBold,
    color: PALETTE.white,
  });

  // Hairline divider
  page.drawLine({
    start: { x: MARGIN.left, y: y - (input.technicienPhone ? 24 : 12) },
    end: { x: page.getWidth() - MARGIN.right, y: y - (input.technicienPhone ? 24 : 12) },
    thickness: 0.5,
    color: PALETTE.hairline,
  });

  return y - (input.technicienPhone ? 38 : 26);
}

function drawCallout(
  page: PDFPage,
  fontBold: PDFFont,
  fontRegular: PDFFont,
  label: string,
  body: string,
  y: number,
): number {
  const contentWidth = page.getWidth() - MARGIN.left - MARGIN.right;
  const lines = wrapText(body, fontRegular, 9.5, contentWidth - 16);
  const blockHeight = 14 + lines.length * 12 + 8;
  page.drawRectangle({
    x: MARGIN.left,
    y: y - blockHeight,
    width: contentWidth,
    height: blockHeight,
    color: PALETTE.surface,
  });
  drawText(page, label, {
    x: MARGIN.left + 10,
    y: y - 14,
    size: 9,
    font: fontBold,
    color: PALETTE.muted,
  });
  let cursor = y - 26;
  for (const line of lines) {
    if (line) {
      page.drawText(line, {
        x: MARGIN.left + 10,
        y: cursor,
        size: 9.5,
        font: fontRegular,
        color: PALETTE.ink,
      });
    }
    cursor -= 12;
  }
  return cursor - 8;
}

function estimateBeurtHeight(
  beurt: WerkplanningBeurt,
  fontRegular: PDFFont,
  contentWidth: number,
): number {
  const innerWidth = contentWidth - BEURT_NUM_COL_WIDTH - SCOPE_INDENT - 8;
  let h = 0;
  h += 18; // klant_naam line
  h += 12; // address line (always reserved)
  if (beurt.klant_telefoon) h += 12;
  if (beurt.scope_samenvatting) {
    const lines = wrapText(beurt.scope_samenvatting, fontRegular, 9.5, innerWidth);
    h += 14 + lines.length * 12;
  }
  if (beurt.special_instructions) {
    const lines = wrapText(beurt.special_instructions, fontRegular, 9.5, innerWidth);
    h += 14 + lines.length * 12;
  }
  // Time + sector chip lane below the title
  h += 12;
  // Padding above + below
  h += ROW_PADDING_Y * 2;
  // Hairline + bottom gap
  h += SECTION_GAP;
  return h;
}

function drawBeurt(
  page: PDFPage,
  fonts: FontPack,
  beurt: WerkplanningBeurt,
  index: number,
  branding: PartnerBranding,
  lang: Lang,
  strings: Strings,
  y: number,
  contentWidth: number,
): number {
  const fontRegular = fonts.regular;
  const fontBold = fonts.bold;
  const fontItalic = fonts.italic;

  const primary = hexToRgb(branding.primaryColor, PALETTE.black);
  const innerX = MARGIN.left + BEURT_NUM_COL_WIDTH + SCOPE_INDENT;
  const innerWidth = contentWidth - BEURT_NUM_COL_WIDTH - SCOPE_INDENT - 8;

  // Top padding
  let cursor = y - ROW_PADDING_Y;

  // Beurt number badge
  const badgeSize = 22;
  page.drawRectangle({
    x: MARGIN.left,
    y: cursor - badgeSize + 4,
    width: badgeSize,
    height: badgeSize,
    color: primary,
  });
  const indexStr = String(index);
  const idxWidth = fontBold.widthOfTextAtSize(indexStr, 11);
  page.drawText(indexStr, {
    x: MARGIN.left + (badgeSize - idxWidth) / 2,
    y: cursor - badgeSize + 11,
    size: 11,
    font: fontBold,
    color: PALETTE.white,
  });

  // Klant naam (bold, big)
  drawText(page, beurt.klant_naam, {
    x: innerX,
    y: cursor - 6,
    size: 12.5,
    font: fontBold,
    color: PALETTE.ink,
    maxWidth: innerWidth,
  });
  cursor -= 18;

  // Time + sector + duration row
  const timeText = formatTimeWindow(beurt);
  const sectorText = sectorLabel(beurt.sector, lang);
  const durationText = beurt.geschatte_duur_min
    ? strings.estimatedDuration(beurt.geschatte_duur_min)
    : "";
  const panelsText = typeof beurt.aantal_panelen === "number" && beurt.aantal_panelen > 0
    ? strings.panels(beurt.aantal_panelen)
    : "";
  const metaParts = [timeText, sectorText, durationText, panelsText].filter(Boolean);
  if (metaParts.length > 0) {
    // Middle dot (U+00B7) — WinAnsi-safe separator.
    drawText(page, metaParts.join("   \u00B7   "), {
      x: innerX,
      y: cursor,
      size: 9.5,
      font: fontItalic,
      color: PALETTE.muted,
      maxWidth: innerWidth,
    });
    cursor -= 12;
  }

  // Address
  const addr = formatPostalAddress({
    address: beurt.klant_adres,
    postcode: beurt.klant_postcode,
    gemeente: beurt.klant_gemeente,
  });
  if (addr) {
    drawText(page, addr, {
      x: innerX,
      y: cursor,
      size: 10,
      font: fontRegular,
      color: PALETTE.ink,
      maxWidth: innerWidth,
    });
    cursor -= 12;
  }
  if (beurt.klant_telefoon) {
    drawText(page, `${strings.contact}: ${beurt.klant_telefoon}`, {
      x: innerX,
      y: cursor,
      size: 9.5,
      font: fontRegular,
      color: PALETTE.muted,
      maxWidth: innerWidth,
    });
    cursor -= 12;
  }

  if (beurt.scope_samenvatting) {
    cursor -= 4;
    drawText(page, strings.scope, {
      x: innerX,
      y: cursor,
      size: 9,
      font: fontBold,
      color: PALETTE.muted,
    });
    cursor -= 12;
    cursor = drawWrapped(
      page,
      beurt.scope_samenvatting,
      innerX,
      cursor,
      innerWidth,
      fontRegular,
      9.5,
      PALETTE.ink,
      12,
    );
  }

  if (beurt.special_instructions) {
    cursor -= 4;
    drawText(page, strings.specialInstructions, {
      x: innerX,
      y: cursor,
      size: 9,
      font: fontBold,
      color: hexToRgb(branding.secondaryColor, rgb(0.91, 0.3, 0.24)),
    });
    cursor -= 12;
    cursor = drawWrapped(
      page,
      beurt.special_instructions,
      innerX,
      cursor,
      innerWidth,
      fontRegular,
      9.5,
      PALETTE.ink,
      12,
    );
  }

  cursor -= ROW_PADDING_Y;
  // Hairline
  page.drawLine({
    start: { x: MARGIN.left, y: cursor },
    end: { x: page.getWidth() - MARGIN.right, y: cursor },
    thickness: 0.5,
    color: PALETTE.hairline,
  });
  return cursor - SECTION_GAP;
}

function formatTimeWindow(beurt: WerkplanningBeurt): string {
  if (beurt.tijd_slot) return beurt.tijd_slot;
  if (beurt.start_tijd && beurt.eind_tijd) return `${beurt.start_tijd} – ${beurt.eind_tijd}`;
  if (beurt.start_tijd) return beurt.start_tijd;
  return "";
}
