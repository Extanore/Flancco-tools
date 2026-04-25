// Slot P — Shared pdf-lib utilities for the generic PDF-engine.
//
// Why a thin custom layer instead of a heavy templating library:
//   - Supabase Edge Runtime is Deno; pdf-lib via esm.sh is the only proven path
//     (see _shared/herroeping.ts).
//   - Templates differ in content but share branding/header/footer/colors/typography,
//     so a small set of well-typed helpers eliminates the bulk of duplication while
//     keeping each template free to compose its own layout.
//
// Conventions:
//   - All measurements in PDF points (1 pt = 1/72 inch).
//   - Coordinate origin is bottom-left (pdf-lib default).
//   - Dutch is the default language; FR strings live next to NL via `LangPack`.
//   - No external network calls inside helpers (logos are fetched explicitly by the
//     entry-point so caching/timeout is centralised).

import {
  PDFDocument,
  PDFFont,
  PDFPage,
  StandardFonts,
  rgb,
  RGB,
} from "https://esm.sh/pdf-lib@1.17.1";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type Lang = "nl" | "fr";

export interface PartnerBranding {
  /** Slug used to look up the partner in Supabase. */
  slug: string;
  /** Display name (bedrijfsnaam → naam → fallback). */
  name: string;
  /** Hex string e.g. "#1A1A2E". */
  primaryColor: string;
  /** Hex string e.g. "#E74C3C". */
  secondaryColor: string;
  /** Public URL to the partner logo. May be empty. */
  logoUrl: string;
  /** Encoded logo bytes (PNG/JPG) when pre-fetched. */
  logoBytes: Uint8Array | null;
  /** "PNG" | "JPG" | null when logoBytes is set. */
  logoMime: "image/png" | "image/jpeg" | null;
  address: string;
  postcode: string;
  gemeente: string;
  email: string;
  telefoon: string;
}

export interface FontPack {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
}

export interface PageContext {
  pdfDoc: PDFDocument;
  page: PDFPage;
  branding: PartnerBranding;
  lang: Lang;
  fonts: FontPack;
  /** Logical page number across the entire document (1-based). */
  pageNum: number;
  /** Total pages; if unknown at draw-time, set after the fact. */
  totalPages: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Layout constants — A4 portrait
// ─────────────────────────────────────────────────────────────────────────────

export const A4_PORTRAIT: [number, number] = [595.28, 841.89];
export const A4_LANDSCAPE: [number, number] = [841.89, 595.28];

export const MARGIN = {
  top: 56,
  right: 48,
  bottom: 48,
  left: 48,
} as const;

export const HEADER_HEIGHT = 64;
export const FOOTER_HEIGHT = 36;

// ─────────────────────────────────────────────────────────────────────────────
// Color helpers
// ─────────────────────────────────────────────────────────────────────────────

const HEX_RE = /^#?([0-9a-fA-F]{6})$/;
const SHORT_HEX_RE = /^#?([0-9a-fA-F]{3})$/;

/**
 * Parse a hex color string into a pdf-lib RGB. Falls back to the supplied default
 * when the input is malformed — never throws — so a bad partner-config does not
 * crash a PDF render.
 */
export function hexToRgb(hex: string | null | undefined, fallback: RGB = rgb(0.1, 0.1, 0.18)): RGB {
  if (!hex) return fallback;
  const long = HEX_RE.exec(hex);
  if (long) {
    const n = parseInt(long[1], 16);
    return rgb(((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255);
  }
  const short = SHORT_HEX_RE.exec(hex);
  if (short) {
    const r = parseInt(short[1][0] + short[1][0], 16);
    const g = parseInt(short[1][1] + short[1][1], 16);
    const b = parseInt(short[1][2] + short[1][2], 16);
    return rgb(r / 255, g / 255, b / 255);
  }
  return fallback;
}

export const PALETTE = {
  black: rgb(0.1, 0.1, 0.18),
  ink: rgb(0.13, 0.13, 0.18),
  muted: rgb(0.42, 0.42, 0.5),
  hairline: rgb(0.85, 0.85, 0.88),
  white: rgb(1, 1, 1),
  surface: rgb(0.96, 0.96, 0.97),
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Default branding (Flancco) — used when no partner_slug or partner not found
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_BRANDING: PartnerBranding = {
  slug: "flancco",
  name: "Flancco BV",
  primaryColor: "#1A1A2E",
  secondaryColor: "#E74C3C",
  logoUrl: "",
  logoBytes: null,
  logoMime: null,
  address: "Industrieweg 25",
  postcode: "9080",
  gemeente: "Lochristi",
  email: "info@flancco.be",
  telefoon: "",
};

// ─────────────────────────────────────────────────────────────────────────────
// Font loader
// ─────────────────────────────────────────────────────────────────────────────

export async function embedStandardFonts(pdfDoc: PDFDocument): Promise<FontPack> {
  const [regular, bold, italic] = await Promise.all([
    pdfDoc.embedFont(StandardFonts.Helvetica),
    pdfDoc.embedFont(StandardFonts.HelveticaBold),
    pdfDoc.embedFont(StandardFonts.HelveticaOblique),
  ]);
  return { regular, bold, italic };
}

// ─────────────────────────────────────────────────────────────────────────────
// i18n strings — minimal set needed by the engine itself
// ─────────────────────────────────────────────────────────────────────────────

interface LangPack {
  pageOf: (n: number, total: number) => string;
  generatedOn: (d: string) => string;
}

const NL: LangPack = {
  pageOf: (n, total) => `Pagina ${n} van ${total}`,
  generatedOn: (d) => `Gegenereerd op ${d}`,
};

const FR: LangPack = {
  pageOf: (n, total) => `Page ${n} sur ${total}`,
  generatedOn: (d) => `Généré le ${d}`,
};

export function strings(lang: Lang): LangPack {
  return lang === "fr" ? FR : NL;
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatters
// ─────────────────────────────────────────────────────────────────────────────

const NL_DATE = new Intl.DateTimeFormat("nl-BE", { day: "numeric", month: "long", year: "numeric" });
const FR_DATE = new Intl.DateTimeFormat("fr-BE", { day: "numeric", month: "long", year: "numeric" });
const NL_TIME = new Intl.DateTimeFormat("nl-BE", { hour: "2-digit", minute: "2-digit" });

export function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

export function formatDateNl(value: string | number | Date | null | undefined): string {
  const d = toDate(value);
  return d ? NL_DATE.format(d) : "";
}

export function formatDateFr(value: string | number | Date | null | undefined): string {
  const d = toDate(value);
  return d ? FR_DATE.format(d) : "";
}

export function formatDate(value: string | number | Date | null | undefined, lang: Lang): string {
  return lang === "fr" ? formatDateFr(value) : formatDateNl(value);
}

export function formatTime(value: string | number | Date | null | undefined): string {
  const d = toDate(value);
  return d ? NL_TIME.format(d) : "";
}

/**
 * Format a numeric value as € amount with 2 decimals, NL-BE convention
 * (comma as decimal separator, dot as thousands separator). Falls back to
 * "€ 0,00" on null / NaN so a malformed input never reaches the canvas.
 */
const CURRENCY_FMT = new Intl.NumberFormat("nl-BE", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatCurrency(amount: number | string | null | undefined): string {
  const n = typeof amount === "string" ? parseFloat(amount) : amount;
  if (n == null || typeof n !== "number" || !isFinite(n)) return "€ 0,00";
  // Intl uses U+00A0 (NBSP) between symbol and number; replace with space so
  // the WinAnsi sanitizer doesn't strip it.
  return CURRENCY_FMT.format(n).replace(/\u00A0/g, " ");
}

export function formatPostalAddress(parts: {
  address?: string | null;
  postcode?: string | null;
  gemeente?: string | null;
}): string {
  const line1 = (parts.address || "").trim();
  const line2 = [parts.postcode, parts.gemeente].map((s) => (s || "").trim()).filter(Boolean).join(" ");
  return [line1, line2].filter(Boolean).join(", ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Sanitisation — pdf-lib only ships WinAnsi-encoded standard fonts, so any
// character outside that codepage will crash drawText. For commercial input
// (klant_naam / adres) this is a real risk. We strip rather than reject so a
// bad character never blocks a render.
// ─────────────────────────────────────────────────────────────────────────────

const WIN_ANSI_REPLACEMENTS: Record<string, string> = {
  "\u2018": "'", "\u2019": "'", "\u201A": "'", "\u201B": "'",
  "\u201C": '"', "\u201D": '"', "\u201E": '"', "\u201F": '"',
  "\u2013": "-", "\u2014": "-", "\u2212": "-",
  "\u2026": "...",
  "\u00A0": " ", "\u202F": " ", "\u2009": " ",
  // Bullet (U+2022) → middle dot (U+00B7) — WinAnsi-safe.
  "\u2022": "\u00B7",
  // En-dash via U+2013 already mapped; em-dash via U+2014 already mapped.
};

export function sanitize(text: string | number | null | undefined): string {
  if (text == null) return "";
  let s = String(text);
  for (const [bad, good] of Object.entries(WIN_ANSI_REPLACEMENTS)) {
    if (s.includes(bad)) s = s.split(bad).join(good);
  }
  // Strip any remaining char outside WinAnsi range (printable + BE/FR diacritics).
  return s.replace(/[^\x20-\x7E\u00A1-\u017F]/g, "");
}

// ─────────────────────────────────────────────────────────────────────────────
// Text helpers
// ─────────────────────────────────────────────────────────────────────────────

export interface DrawTextOptions {
  x: number;
  y: number;
  size: number;
  font: PDFFont;
  color?: RGB;
  maxWidth?: number;
}

/**
 * Draw a single line, truncating with an ellipsis when it would overflow maxWidth.
 */
export function drawText(page: PDFPage, text: string, opts: DrawTextOptions): void {
  const safe = sanitize(text);
  if (!safe) return;
  let toDraw = safe;
  if (opts.maxWidth) {
    let w = opts.font.widthOfTextAtSize(toDraw, opts.size);
    if (w > opts.maxWidth) {
      const ell = "...";
      while (toDraw.length > 0 && w > opts.maxWidth) {
        toDraw = toDraw.slice(0, -1);
        w = opts.font.widthOfTextAtSize(toDraw + ell, opts.size);
      }
      toDraw = toDraw + ell;
    }
  }
  page.drawText(toDraw, {
    x: opts.x,
    y: opts.y,
    size: opts.size,
    font: opts.font,
    color: opts.color ?? PALETTE.ink,
  });
}

/**
 * Wrap `text` to fit within maxWidth and return the produced lines.
 */
export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const safe = sanitize(text);
  if (!safe) return [];
  const out: string[] = [];
  for (const paragraph of safe.split(/\r?\n/)) {
    const words = paragraph.split(/\s+/);
    let line = "";
    for (const word of words) {
      const test = line ? line + " " + word : word;
      const width = font.widthOfTextAtSize(test, size);
      if (width > maxWidth && line) {
        out.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) out.push(line);
    if (paragraph === "") out.push("");
  }
  return out;
}

/**
 * Draw multi-line text and return the new y-coordinate after the block.
 */
export function drawWrapped(
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  font: PDFFont,
  size: number,
  color: RGB,
  lineHeight: number,
): number {
  const lines = wrapText(text, font, size, maxWidth);
  let cursor = y;
  for (const line of lines) {
    if (line) page.drawText(line, { x, y: cursor, size, font, color });
    cursor -= lineHeight;
  }
  return cursor;
}

// ─────────────────────────────────────────────────────────────────────────────
// Header & footer
// ─────────────────────────────────────────────────────────────────────────────

const LOGO_MAX_HEIGHT = 36;
const LOGO_MAX_WIDTH = 140;

export interface HeaderOptions {
  /** Document-level title shown on the right-hand side of the header bar. */
  title: string;
  /** Optional subtitle directly below the title. */
  subtitle?: string;
}

/**
 * Draw a partner-branded header band at the top of the page. Returns the
 * y-coordinate where body content should start.
 */
export async function drawHeader(ctx: PageContext, opts: HeaderOptions): Promise<number> {
  const { page, branding, fonts } = ctx;
  const pageWidth = page.getWidth();
  const pageHeight = page.getHeight();
  const primary = hexToRgb(branding.primaryColor, PALETTE.black);

  // Background band
  page.drawRectangle({
    x: 0,
    y: pageHeight - HEADER_HEIGHT,
    width: pageWidth,
    height: HEADER_HEIGHT,
    color: primary,
  });

  // Logo (left). When no logo, we draw the partner name in white instead.
  let leftCursor = MARGIN.left;
  if (branding.logoBytes && branding.logoMime) {
    try {
      const img = branding.logoMime === "image/png"
        ? await ctx.pdfDoc.embedPng(branding.logoBytes)
        : await ctx.pdfDoc.embedJpg(branding.logoBytes);
      const scale = Math.min(LOGO_MAX_HEIGHT / img.height, LOGO_MAX_WIDTH / img.width);
      const w = img.width * scale;
      const h = img.height * scale;
      page.drawImage(img, {
        x: leftCursor,
        y: pageHeight - HEADER_HEIGHT + (HEADER_HEIGHT - h) / 2,
        width: w,
        height: h,
      });
      leftCursor += w + 16;
    } catch {
      // Fallback to text on any embed failure.
      drawText(page, branding.name, {
        x: leftCursor,
        y: pageHeight - HEADER_HEIGHT / 2 - 4,
        size: 14,
        font: fonts.bold,
        color: PALETTE.white,
      });
    }
  } else {
    drawText(page, branding.name, {
      x: leftCursor,
      y: pageHeight - HEADER_HEIGHT / 2 - 4,
      size: 14,
      font: fonts.bold,
      color: PALETTE.white,
    });
  }

  // Title (right)
  const titleSize = 12;
  const subtitleSize = 9;
  const safeTitle = sanitize(opts.title);
  const titleWidth = fonts.bold.widthOfTextAtSize(safeTitle, titleSize);
  const titleY = opts.subtitle
    ? pageHeight - HEADER_HEIGHT / 2 + 2
    : pageHeight - HEADER_HEIGHT / 2 - 4;
  page.drawText(safeTitle, {
    x: pageWidth - MARGIN.right - titleWidth,
    y: titleY,
    size: titleSize,
    font: fonts.bold,
    color: PALETTE.white,
  });
  if (opts.subtitle) {
    const safeSub = sanitize(opts.subtitle);
    const subW = fonts.regular.widthOfTextAtSize(safeSub, subtitleSize);
    page.drawText(safeSub, {
      x: pageWidth - MARGIN.right - subW,
      y: pageHeight - HEADER_HEIGHT / 2 - 12,
      size: subtitleSize,
      font: fonts.regular,
      color: rgb(1, 1, 1),
    });
  }

  return pageHeight - HEADER_HEIGHT - 24;
}

/**
 * Draw a thin footer with partner contact (left) + page numbering (right).
 */
export function drawFooter(ctx: PageContext): void {
  const { page, branding, fonts, lang, pageNum, totalPages } = ctx;
  const pageWidth = page.getWidth();
  const y = MARGIN.bottom - 18;

  // Hairline above footer
  page.drawLine({
    start: { x: MARGIN.left, y: MARGIN.bottom - 4 },
    end: { x: pageWidth - MARGIN.right, y: MARGIN.bottom - 4 },
    thickness: 0.5,
    color: PALETTE.hairline,
  });

  const left = [
    branding.name,
    formatPostalAddress({ address: branding.address, postcode: branding.postcode, gemeente: branding.gemeente }),
    [branding.email, branding.telefoon].filter(Boolean).join(" — "),
  ].filter(Boolean).join("  \u00B7  "); // U+00B7 middle dot — WinAnsi-safe

  drawText(page, left, {
    x: MARGIN.left,
    y,
    size: 7.5,
    font: fonts.regular,
    color: PALETTE.muted,
    maxWidth: pageWidth - MARGIN.left - MARGIN.right - 120,
  });

  const right = strings(lang).pageOf(pageNum, totalPages);
  const rightWidth = fonts.regular.widthOfTextAtSize(right, 7.5);
  page.drawText(right, {
    x: pageWidth - MARGIN.right - rightWidth,
    y,
    size: 7.5,
    font: fonts.regular,
    color: PALETTE.muted,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility: Uint8Array → base64 (kept here so each template can build attachments
// without touching the Storage API directly).
// ─────────────────────────────────────────────────────────────────────────────

export function uint8ToBase64(bytes: Uint8Array): string {
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
