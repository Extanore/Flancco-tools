// Slot D — Facturatie-overzicht (intern, partner-facing PDF).
//
// Doelpubliek = de partner-organisatie. Het document somt alle afgewerkte
// onderhoudsbeurten op binnen een gekozen periode, met daarbij de bedragen die
// nodig zijn om naar de eindklant door te factureren én om de Flancco-partner-
// verrekening te onderbouwen. Geen klant-facing copy: dit is een werkdocument.
//
// Layout (A4 landscape — 9 kolommen passen niet comfortabel op portrait):
//   ┌──────────────────────────────────────────────────────────────────────┐
//   │ HEADER (partner-kleur, logo links, titel + periode rechts)            │
//   ├──────────────────────────────────────────────────────────────────────┤
//   │ KPI-strip (4 cards): aantal beurten · excl btw · incl btw · marge     │
//   │                                                                      │
//   │ TABEL kolommen:                                                      │
//   │   Datum | Klant | Sector | # | Excl btw | Incl btw |                 │
//   │   Planning fee | Partner-marge | Door te factureren                  │
//   │                                                                      │
//   │ TOTAAL-rij onderaan elk page-block                                   │
//   ├──────────────────────────────────────────────────────────────────────┤
//   │ FOOTER (partner contact + interne disclaimer + page-of-page)         │
//   └──────────────────────────────────────────────────────────────────────┘
//
// Pagination: header + tabel-headerrij worden op elke pagina opnieuw getekend.
// Een ensureSpace() helper voegt automatisch een nieuwe pagina toe wanneer een
// rij niet meer past tussen content-cursor en footer-margin.

import { PDFDocument, PDFPage } from "https://esm.sh/pdf-lib@1.17.1";
import {
  A4_LANDSCAPE,
  drawFooter,
  drawHeader,
  drawText,
  embedStandardFonts,
  FontPack,
  formatCurrency,
  formatDate,
  hexToRgb,
  Lang,
  MARGIN,
  PALETTE,
  PartnerBranding,
  sanitize,
} from "./_shared.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface FacturatieBeurtRow {
  /** ISO YYYY-MM-DD van de uitvoer-datum (of plan_datum als fallback). */
  datum?: string | null;
  klant_naam?: string | null;
  /** Sector slug, e.g. "zonnepanelen", "warmtepomp", "ventilatie", "verwarming", "ic", "klussen". */
  sector?: string | null;
  aantal_panelen?: number | null;
  /** Eindklantprijs excl. btw voor deze beurt. */
  bedrag_excl_btw?: number | null;
  /** Eindklantprijs incl. btw voor deze beurt — = "Door te factureren naar klant". */
  bedrag_incl_btw?: number | null;
  /** Planning fee Flancco voor deze beurt (in euro). */
  planning_fee?: number | null;
  /** Partner-marge voor deze beurt (in euro). */
  partner_marge?: number | null;
}

export interface FacturatieTotalen {
  aantal_beurten: number;
  totaal_excl_btw: number;
  totaal_incl_btw: number;
  totaal_planning_fee: number;
  totaal_marge: number;
}

export interface FacturatieOverzichtData {
  /** ISO YYYY-MM-DD — start van de periode (inclusief). */
  periode_van?: string;
  /** ISO YYYY-MM-DD — einde van de periode (inclusief). */
  periode_tot?: string;
  /** Voor de subtitle: "week 17 (2026)", "april 2026 — juni 2026", "2026". */
  periode_label?: string;
  /** Periode-type voor i18n-subtitle. */
  periode_type?: "week" | "maand" | "jaar";
  /** Optionele filter-context die in subtitel meegegeven wordt. */
  alleen_gefactureerd?: boolean;
  beurten?: FacturatieBeurtRow[];
  /** Pre-berekende totalen. Wordt ook server-side hercomputed bij verschil. */
  totalen?: FacturatieTotalen;
}

// ─────────────────────────────────────────────────────────────────────────────
// i18n
// ─────────────────────────────────────────────────────────────────────────────

interface Strings {
  documentTitle: string;
  subtitleWeek: (p: string) => string;
  subtitleMaand: (p: string) => string;
  subtitleJaar: (p: string) => string;
  subtitleAlleen: string;
  kpiCount: string;
  kpiExcl: string;
  kpiIncl: string;
  kpiMarge: string;
  kolomDatum: string;
  kolomKlant: string;
  kolomSector: string;
  kolomPanelen: string;
  kolomExcl: string;
  kolomIncl: string;
  kolomPlanning: string;
  kolomMarge: string;
  kolomDoor: string;
  totaalLabel: string;
  geenData: string;
  internDisclaimer: string;
  gegenereerdOp: (d: string) => string;
}

const NL: Strings = {
  documentTitle: "Facturatie-overzicht",
  subtitleWeek: (p) => `Afgewerkte beurten in week ${p}`,
  subtitleMaand: (p) => `Afgewerkte beurten over ${p}`,
  subtitleJaar: (p) => `Afgewerkte beurten in ${p}`,
  subtitleAlleen: " (alleen gefactureerd)",
  kpiCount: "Aantal beurten",
  kpiExcl: "Omzet excl. btw",
  kpiIncl: "Omzet incl. btw",
  kpiMarge: "Partner-marge",
  kolomDatum: "Datum",
  kolomKlant: "Klant",
  kolomSector: "Sector",
  kolomPanelen: "#",
  kolomExcl: "Excl. btw",
  kolomIncl: "Incl. btw",
  kolomPlanning: "Planning fee",
  kolomMarge: "Marge",
  kolomDoor: "Door te factureren",
  totaalLabel: "Totaal",
  geenData: "Geen afgewerkte beurten in deze periode.",
  internDisclaimer: "Intern document \u2014 niet bestemd voor de eindklant.",
  gegenereerdOp: (d) => `Gegenereerd op ${d}`,
};

const FR: Strings = {
  documentTitle: "Aper\u00E7u de facturation",
  subtitleWeek: (p) => `Interventions cl\u00F4tur\u00E9es en semaine ${p}`,
  subtitleMaand: (p) => `Interventions cl\u00F4tur\u00E9es sur ${p}`,
  subtitleJaar: (p) => `Interventions cl\u00F4tur\u00E9es en ${p}`,
  subtitleAlleen: " (uniquement factur\u00E9es)",
  kpiCount: "Nombre d'interventions",
  kpiExcl: "Chiffre d'affaires HTVA",
  kpiIncl: "Chiffre d'affaires TTC",
  kpiMarge: "Marge partenaire",
  kolomDatum: "Date",
  kolomKlant: "Client",
  kolomSector: "Secteur",
  kolomPanelen: "#",
  kolomExcl: "HTVA",
  kolomIncl: "TTC",
  kolomPlanning: "Frais planning",
  kolomMarge: "Marge",
  kolomDoor: "\u00C0 refacturer",
  totaalLabel: "Total",
  geenData: "Aucune intervention cl\u00F4tur\u00E9e sur cette p\u00E9riode.",
  internDisclaimer: "Document interne \u2014 non destin\u00E9 au client final.",
  gegenereerdOp: (d) => `G\u00E9n\u00E9r\u00E9 le ${d}`,
};

const SECTOR_LABELS: Record<string, { nl: string; fr: string }> = {
  zonnepanelen: { nl: "Zonnepanelen", fr: "Panneaux solaires" },
  zon: { nl: "Zonnepanelen", fr: "Panneaux solaires" },
  warmtepomp: { nl: "Warmtepomp", fr: "Pompe \u00E0 chaleur" },
  ventilatie: { nl: "Ventilatie", fr: "Ventilation" },
  verwarming: { nl: "Verwarming", fr: "Chauffage" },
  airco: { nl: "Airco", fr: "Climatisation" },
  ic: { nl: "Industrial Cleaning", fr: "Industrial Cleaning" },
  klussen: { nl: "Klussen", fr: "Petits travaux" },
};

function getStrings(lang: Lang): Strings {
  return lang === "fr" ? FR : NL;
}

function sectorLabel(slug: string | null | undefined, lang: Lang): string {
  if (!slug) return "";
  const entry = SECTOR_LABELS[String(slug).toLowerCase()];
  if (!entry) return String(slug);
  return lang === "fr" ? entry.fr : entry.nl;
}

// ─────────────────────────────────────────────────────────────────────────────
// Layout constants — A4 landscape (842 × 595 pt). Content width = 842 - 96 = 746.
// Kolom-breedtes opgeteld = contentWidth. We ankeren de getalkolommen rechts,
// tekst-kolommen links.
// ─────────────────────────────────────────────────────────────────────────────

const ROW_HEIGHT = 18;
const TABLE_HEADER_HEIGHT = 22;
const KPI_HEIGHT = 56;
const KPI_GAP = 12;
const SECTION_GAP = 16;

interface Column {
  key: keyof FacturatieBeurtRow | "marge_calc" | "spacer";
  label: keyof Strings;
  width: number;
  /** Hoe de waarde gerenderd wordt: text (sanitize), number, currency, date. */
  type: "text" | "date" | "int" | "currency" | "sector";
  /** "left" | "right" — getalkolommen rechts geanker. */
  align: "left" | "right";
}

// Som = 746pt. Kolommen op landscape A4 met 48pt margins.
const COLUMNS: Column[] = [
  { key: "datum", label: "kolomDatum", width: 78, type: "date", align: "left" },
  { key: "klant_naam", label: "kolomKlant", width: 168, type: "text", align: "left" },
  { key: "sector", label: "kolomSector", width: 96, type: "sector", align: "left" },
  { key: "aantal_panelen", label: "kolomPanelen", width: 38, type: "int", align: "right" },
  { key: "bedrag_excl_btw", label: "kolomExcl", width: 70, type: "currency", align: "right" },
  { key: "bedrag_incl_btw", label: "kolomIncl", width: 70, type: "currency", align: "right" },
  { key: "planning_fee", label: "kolomPlanning", width: 70, type: "currency", align: "right" },
  { key: "partner_marge", label: "kolomMarge", width: 72, type: "currency", align: "right" },
  { key: "bedrag_incl_btw", label: "kolomDoor", width: 84, type: "currency", align: "right" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function num(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return isFinite(n) ? n : 0;
}

function intStr(v: unknown): string {
  const n = num(v);
  return n > 0 ? String(Math.round(n)) : "";
}

function buildSubtitle(strings: Strings, data: FacturatieOverzichtData): string {
  const label = (data.periode_label || "").trim();
  if (!label) return "";
  let base: string;
  switch (data.periode_type) {
    case "week":
      base = strings.subtitleWeek(label);
      break;
    case "jaar":
      base = strings.subtitleJaar(label);
      break;
    case "maand":
    default:
      base = strings.subtitleMaand(label);
      break;
  }
  return data.alleen_gefactureerd ? base + strings.subtitleAlleen : base;
}

function recomputeTotalen(rows: FacturatieBeurtRow[]): FacturatieTotalen {
  let excl = 0, incl = 0, fee = 0, marge = 0;
  for (const r of rows) {
    excl += num(r.bedrag_excl_btw);
    incl += num(r.bedrag_incl_btw);
    fee += num(r.planning_fee);
    marge += num(r.partner_marge);
  }
  return {
    aantal_beurten: rows.length,
    totaal_excl_btw: excl,
    totaal_incl_btw: incl,
    totaal_planning_fee: fee,
    totaal_marge: marge,
  };
}

function formatCellValue(col: Column, row: FacturatieBeurtRow, lang: Lang): string {
  switch (col.type) {
    case "date":
      return formatDate(row.datum ?? null, lang);
    case "int":
      return intStr(row.aantal_panelen);
    case "currency":
      // Map kolom naar correct numeric veld — currency-cellen lezen niet altijd
      // direct van .key (bv. de "Door te factureren" deelt zelfde key als incl.btw).
      // Voor deze template is row[col.key] altijd het juiste veld, behalve voor
      // de marge_calc-spec — niet van toepassing in COLUMNS hierboven.
      return formatCurrency(num((row as Record<string, unknown>)[col.key as string]));
    case "sector":
      return sectorLabel(row.sector ?? null, lang);
    case "text":
    default:
      return sanitize(row.klant_naam ?? "");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public render
// ─────────────────────────────────────────────────────────────────────────────

export async function renderFacturatieOverzicht(
  data: FacturatieOverzichtData,
  branding: PartnerBranding,
  lang: Lang,
): Promise<Uint8Array> {
  const strings = getStrings(lang);
  const rows = Array.isArray(data.beurten) ? data.beurten : [];
  const totalen = data.totalen && typeof data.totalen === "object"
    ? data.totalen
    : recomputeTotalen(rows);

  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`${strings.documentTitle} \u2014 ${branding.name}`);
  pdfDoc.setAuthor(branding.name);
  pdfDoc.setSubject(strings.documentTitle);
  pdfDoc.setCreator("Flancco Platform \u2014 generate-pdf");
  pdfDoc.setCreationDate(new Date());

  const fonts = await embedStandardFonts(pdfDoc);
  const pages: PDFPage[] = [];
  let page = pdfDoc.addPage(A4_LANDSCAPE);
  pages.push(page);

  const ctxBase = {
    pdfDoc,
    branding,
    lang,
    fonts,
    pageNum: 1,
    totalPages: 1,
  };

  const subtitle = buildSubtitle(strings, data);
  let y = await drawHeader(
    { ...ctxBase, page },
    { title: strings.documentTitle, subtitle },
  );

  const contentWidth = page.getWidth() - MARGIN.left - MARGIN.right;
  const minY = MARGIN.bottom + 30; // ruimte voor footer + intern-disclaimer

  // 1. KPI-strip
  y = drawKpiStrip(page, fonts, branding, strings, totalen, y, contentWidth);
  y -= SECTION_GAP;

  // 2. Tabel — header + rijen
  if (rows.length === 0) {
    drawText(page, strings.geenData, {
      x: MARGIN.left,
      y: y - 4,
      size: 11,
      font: fonts.italic,
      color: PALETTE.muted,
      maxWidth: contentWidth,
    });
  } else {
    y = drawTableHeader(page, fonts, branding, strings, y);

    const ensureSpace = async (required: number): Promise<void> => {
      if (y - required < minY) {
        page = pdfDoc.addPage(A4_LANDSCAPE);
        pages.push(page);
        y = await drawHeader(
          { ...ctxBase, page },
          { title: strings.documentTitle, subtitle },
        );
        y = drawTableHeader(page, fonts, branding, strings, y);
      }
    };

    for (let i = 0; i < rows.length; i++) {
      await ensureSpace(ROW_HEIGHT);
      drawTableRow(page, fonts, rows[i], i, lang, y);
      y -= ROW_HEIGHT;
    }

    // Totaal-rij — accent-styling, altijd op huidige pagina (bij overflow extra
    // pagina + her-tekenen tabel-header zou misleidend zijn).
    await ensureSpace(ROW_HEIGHT + 4);
    drawTotaalRow(page, fonts, branding, strings, totalen, y);
    y -= ROW_HEIGHT + 4;
  }

  // Footer pass — total pages now known
  pages.forEach((p, idx) => {
    drawFacturatieFooter({
      ...ctxBase,
      page: p,
      pageNum: idx + 1,
      totalPages: pages.length,
    }, strings);
  });

  return await pdfDoc.save();
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal renderers
// ─────────────────────────────────────────────────────────────────────────────

interface KpiCard {
  label: string;
  value: string;
}

function drawKpiStrip(
  page: PDFPage,
  fonts: FontPack,
  branding: PartnerBranding,
  strings: Strings,
  totalen: FacturatieTotalen,
  y: number,
  contentWidth: number,
): number {
  const primary = hexToRgb(branding.primaryColor, PALETTE.black);

  const cards: KpiCard[] = [
    { label: strings.kpiCount, value: String(totalen.aantal_beurten) },
    { label: strings.kpiExcl, value: formatCurrency(totalen.totaal_excl_btw) },
    { label: strings.kpiIncl, value: formatCurrency(totalen.totaal_incl_btw) },
    { label: strings.kpiMarge, value: formatCurrency(totalen.totaal_marge) },
  ];

  const cardWidth = (contentWidth - KPI_GAP * (cards.length - 1)) / cards.length;
  const cardX = (i: number) => MARGIN.left + i * (cardWidth + KPI_GAP);
  const cardY = y - KPI_HEIGHT;

  for (let i = 0; i < cards.length; i++) {
    const x = cardX(i);
    // Background surface
    page.drawRectangle({
      x,
      y: cardY,
      width: cardWidth,
      height: KPI_HEIGHT,
      color: PALETTE.surface,
    });
    // Top stripe in primary color
    page.drawRectangle({
      x,
      y: cardY + KPI_HEIGHT - 3,
      width: cardWidth,
      height: 3,
      color: primary,
    });
    // Label
    drawText(page, cards[i].label, {
      x: x + 12,
      y: cardY + KPI_HEIGHT - 18,
      size: 8.5,
      font: fonts.bold,
      color: PALETTE.muted,
      maxWidth: cardWidth - 24,
    });
    // Value
    drawText(page, cards[i].value, {
      x: x + 12,
      y: cardY + 14,
      size: 16,
      font: fonts.bold,
      color: PALETTE.ink,
      maxWidth: cardWidth - 24,
    });
  }

  return cardY;
}

function drawTableHeader(
  page: PDFPage,
  fonts: FontPack,
  branding: PartnerBranding,
  strings: Strings,
  y: number,
): number {
  const primary = hexToRgb(branding.primaryColor, PALETTE.black);
  const headerY = y - TABLE_HEADER_HEIGHT;

  // Achtergrond — primary-kleur band
  let totalWidth = 0;
  for (const c of COLUMNS) totalWidth += c.width;
  page.drawRectangle({
    x: MARGIN.left,
    y: headerY,
    width: totalWidth,
    height: TABLE_HEADER_HEIGHT,
    color: primary,
  });

  let cursorX = MARGIN.left;
  for (const col of COLUMNS) {
    const text = (strings as unknown as Record<string, string>)[col.label] || "";
    const safe = sanitize(text);
    if (col.align === "right") {
      const w = fonts.bold.widthOfTextAtSize(safe, 9);
      drawText(page, safe, {
        x: cursorX + col.width - 8 - Math.min(w, col.width - 16),
        y: headerY + 7,
        size: 9,
        font: fonts.bold,
        color: PALETTE.white,
        maxWidth: col.width - 16,
      });
    } else {
      drawText(page, safe, {
        x: cursorX + 8,
        y: headerY + 7,
        size: 9,
        font: fonts.bold,
        color: PALETTE.white,
        maxWidth: col.width - 16,
      });
    }
    cursorX += col.width;
  }

  return headerY;
}

function drawTableRow(
  page: PDFPage,
  fonts: FontPack,
  row: FacturatieBeurtRow,
  index: number,
  lang: Lang,
  y: number,
): void {
  const rowY = y - ROW_HEIGHT;

  // Zebra-stripe op even rijen voor leesbaarheid bij dichte tabellen.
  if (index % 2 === 0) {
    let totalWidth = 0;
    for (const c of COLUMNS) totalWidth += c.width;
    page.drawRectangle({
      x: MARGIN.left,
      y: rowY,
      width: totalWidth,
      height: ROW_HEIGHT,
      color: PALETTE.surface,
    });
  }

  let cursorX = MARGIN.left;
  for (const col of COLUMNS) {
    const value = formatCellValue(col, row, lang);
    if (!value) {
      cursorX += col.width;
      continue;
    }
    const isMargeCol = col.label === "kolomMarge";
    const font = isMargeCol ? fonts.bold : fonts.regular;
    if (col.align === "right") {
      const w = font.widthOfTextAtSize(sanitize(value), 9);
      drawText(page, value, {
        x: cursorX + col.width - 8 - Math.min(w, col.width - 16),
        y: rowY + 5,
        size: 9,
        font,
        color: PALETTE.ink,
        maxWidth: col.width - 16,
      });
    } else {
      drawText(page, value, {
        x: cursorX + 8,
        y: rowY + 5,
        size: 9,
        font,
        color: PALETTE.ink,
        maxWidth: col.width - 16,
      });
    }
    cursorX += col.width;
  }

  // Hairline onderkant voor scheiding
  page.drawLine({
    start: { x: MARGIN.left, y: rowY },
    end: { x: cursorX, y: rowY },
    thickness: 0.4,
    color: PALETTE.hairline,
  });
}

function drawTotaalRow(
  page: PDFPage,
  fonts: FontPack,
  branding: PartnerBranding,
  strings: Strings,
  totalen: FacturatieTotalen,
  y: number,
): void {
  const rowY = y - ROW_HEIGHT - 2;
  const primary = hexToRgb(branding.primaryColor, PALETTE.black);

  // Totaal heeft een dunne primary-band onder + bold tekst.
  let totalWidth = 0;
  for (const c of COLUMNS) totalWidth += c.width;

  page.drawLine({
    start: { x: MARGIN.left, y: y },
    end: { x: MARGIN.left + totalWidth, y: y },
    thickness: 1.5,
    color: primary,
  });

  // Mapping per kolom: totaal-waarde of leeg.
  const totaalMap: Record<string, string> = {
    kolomDatum: strings.totaalLabel,
    kolomKlant: "",
    kolomSector: "",
    kolomPanelen: "",
    kolomExcl: formatCurrency(totalen.totaal_excl_btw),
    kolomIncl: formatCurrency(totalen.totaal_incl_btw),
    kolomPlanning: formatCurrency(totalen.totaal_planning_fee),
    kolomMarge: formatCurrency(totalen.totaal_marge),
    kolomDoor: formatCurrency(totalen.totaal_incl_btw),
  };

  let cursorX = MARGIN.left;
  for (const col of COLUMNS) {
    const value = totaalMap[col.label] || "";
    if (!value) {
      cursorX += col.width;
      continue;
    }
    const safe = sanitize(value);
    if (col.align === "right") {
      const w = fonts.bold.widthOfTextAtSize(safe, 10);
      drawText(page, value, {
        x: cursorX + col.width - 8 - Math.min(w, col.width - 16),
        y: rowY + 6,
        size: 10,
        font: fonts.bold,
        color: PALETTE.ink,
        maxWidth: col.width - 16,
      });
    } else {
      drawText(page, value, {
        x: cursorX + 8,
        y: rowY + 6,
        size: 10,
        font: fonts.bold,
        color: primary,
        maxWidth: col.width - 16,
      });
    }
    cursorX += col.width;
  }
}

// Custom footer that adds the "intern document" disclaimer above the standard
// page-of-page line.
function drawFacturatieFooter(
  ctx: {
    pdfDoc: PDFDocument;
    page: PDFPage;
    branding: PartnerBranding;
    lang: Lang;
    fonts: FontPack;
    pageNum: number;
    totalPages: number;
  },
  strings: Strings,
): void {
  const { page, fonts } = ctx;
  // Intern-disclaimer net boven de standaard footer-line — opvallend in muted
  // grey + italic zodat duidelijk is dat dit geen klantdocument is.
  const pageWidth = page.getWidth();
  drawText(page, strings.internDisclaimer, {
    x: MARGIN.left,
    y: MARGIN.bottom + 6,
    size: 7.5,
    font: fonts.italic,
    color: PALETTE.muted,
    maxWidth: pageWidth - MARGIN.left - MARGIN.right,
  });
  drawFooter(ctx);
}
