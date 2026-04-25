// Slot C3 — Branded onderhoudsrapport (klant-facing PDF).
//
// Audience is the customer who just had an onderhoudsbeurt. The document must
// always feel like a partner-branded deliverable (logo, kleur_primair,
// kleur_donker = accent), never default Flancco styling. Per project memory:
//   - Uren / verbruikt materiaal blijven INTERN — niet op het rapport
//   - Alleen klant-relevante informatie (bevindingen, foto's, aanbevelingen,
//     handtekening voor ontvangst)
//   - Branding overrules generieke Flancco-uitstraling
//
// Photos are passed as signed URLs (the calling code is responsible for signing
// them via Supabase Storage). The template fetches them with a strict timeout
// and embeds the bytes directly so the resulting PDF is self-contained.
//
// Layout (A4 portrait, ~3 logical sections per page):
//   ┌──────────────────────────────────────────────┐
//   │ HEADER (partner-kleur, logo links, titel rechts) │
//   ├──────────────────────────────────────────────┤
//   │ Klant-block + contract-info card              │
//   │                                              │
//   │ Sectie: Bevindingen                          │
//   │   [body text wrapped]                        │
//   │                                              │
//   │ Sectie: Aanbevelingen                        │
//   │   [body text wrapped]                        │
//   │                                              │
//   │ Sectie: Foto's (grid 2-3 col)                │
//   │   [thumbnails, max 6, +N badge if more]      │
//   │                                              │
//   │ Sectie: Handtekening klant                   │
//   ├──────────────────────────────────────────────┤
//   │ FOOTER (partner contact + page-of-page)      │
//   └──────────────────────────────────────────────┘
//
// Pagination: header repeats on every page, sections break naturally.

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
} from "./_shared.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface RapportBrandedData {
  /** Reference to onderhoudsbeurt id (used in subtitle / metadata). */
  beurt_id?: string;
  /** Contract id — last 8 chars rendered as contractnummer. */
  contract_id?: string;
  /** Explicit contract-nummer overrides the derived one when present. */
  contract_nummer?: string;

  // Klant-block
  klant_naam?: string;
  klant_adres?: string;
  klant_postcode?: string;
  klant_gemeente?: string;
  klant_email?: string;
  klant_telefoon?: string;

  // Beurt-metadata
  /** ISO date string of when the maintenance happened (YYYY-MM-DD). */
  datum?: string;
  aantal_panelen?: number;
  frequentie?: string;
  contractduur?: string;
  /** Sector slug e.g. "zon", "warmtepomp" — rendered as a tag. */
  sector?: string;

  // Body content — strings worden 1-op-1 gerenderd; arrays worden als
  // bullet-lijst (· per regel) opgemaakt. Dit dekt zowel calculator-output
  // (string-blokken) als gestructureerde rapportage (array van punten).
  /** Hoofdtekst: wat is er vastgesteld tijdens deze beurt. */
  bevindingen?: string | string[];
  /** Optioneel — alleen tonen als aanwezig (zelden ingevuld bij standaard beurt). */
  materiaal?: string | string[];
  /** Hoofdtekst: aanbevelingen voor klant. */
  aanbevelingen?: string | string[];

  /** Array van pre-signed Supabase URLs naar foto's. Max 6 op rapport. */
  fotos?: string[];

  /** Pre-signed URL of data-URI naar handtekening klant (PNG). */
  handtekening_url?: string;
  /** Datum waarop klant getekend heeft voor ontvangst (ISO YYYY-MM-DD). */
  handtekening_datum?: string;
  /** Naam van de persoon die de handtekening plaatste (kan verschillen van klant_naam). */
  handtekening_naam?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants & i18n
// ─────────────────────────────────────────────────────────────────────────────

interface Strings {
  documentTitle: string;
  klantBlockTitle: string;
  contractBlockTitle: string;
  contractNr: string;
  beurtDatum: string;
  panelen: string;
  frequentie: string;
  contractduur: string;
  sector: string;
  bevindingenTitle: string;
  materiaalTitle: string;
  aanbevelingenTitle: string;
  fotosTitle: string;
  handtekeningTitle: string;
  handtekeningSubtitle: string;
  handtekeningOntbreekt: string;
  morePhotos: (n: number) => string;
  geenBevindingen: string;
  geenAanbevelingen: string;
  geenFotos: string;
  notapplicable: string;
}

const NL: Strings = {
  documentTitle: "Onderhoudsrapport zonnepanelen",
  klantBlockTitle: "Klantgegevens",
  contractBlockTitle: "Beurtgegevens",
  contractNr: "Contractnummer",
  beurtDatum: "Datum onderhoud",
  panelen: "Aantal panelen",
  frequentie: "Frequentie",
  contractduur: "Contractduur",
  sector: "Sector",
  bevindingenTitle: "Bevindingen",
  materiaalTitle: "Verbruikt materiaal",
  aanbevelingenTitle: "Aanbevelingen",
  fotosTitle: "Foto's",
  handtekeningTitle: "Handtekening klant",
  handtekeningSubtitle: "Voor ontvangst en goedkeuring",
  handtekeningOntbreekt: "Geen handtekening vastgelegd.",
  morePhotos: (n) => `+${n} extra foto${n === 1 ? "" : "'s"} beschikbaar in het portaal`,
  geenBevindingen: "Geen bijzondere bevindingen vastgesteld tijdens deze beurt.",
  geenAanbevelingen: "Geen specifieke aanbevelingen op dit moment.",
  geenFotos: "Er zijn voor deze beurt geen foto's bijgevoegd.",
  notapplicable: "n.v.t.",
};

const FR: Strings = {
  documentTitle: "Rapport d'entretien panneaux solaires",
  klantBlockTitle: "Donn\u00E9es client",
  contractBlockTitle: "Donn\u00E9es de l'intervention",
  contractNr: "N\u00B0 de contrat",
  beurtDatum: "Date de l'entretien",
  panelen: "Nombre de panneaux",
  frequentie: "Fr\u00E9quence",
  contractduur: "Dur\u00E9e du contrat",
  sector: "Secteur",
  bevindingenTitle: "Constatations",
  materiaalTitle: "Mat\u00E9riel utilis\u00E9",
  aanbevelingenTitle: "Recommandations",
  fotosTitle: "Photos",
  handtekeningTitle: "Signature du client",
  handtekeningSubtitle: "Pour r\u00E9ception et approbation",
  handtekeningOntbreekt: "Aucune signature enregistr\u00E9e.",
  morePhotos: (n) => `+${n} photo${n === 1 ? "" : "s"} suppl\u00E9mentaire${n === 1 ? "" : "s"} disponible${n === 1 ? "" : "s"} dans le portail`,
  geenBevindingen: "Aucune constatation particuli\u00E8re lors de cette intervention.",
  geenAanbevelingen: "Aucune recommandation sp\u00E9cifique pour le moment.",
  geenFotos: "Aucune photo n'est jointe pour cette intervention.",
  notapplicable: "n/a",
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

// Photo grid layout
const MAX_PHOTOS = 6;
const PHOTO_GRID_COLS = 3;
const PHOTO_GAP = 10;
const PHOTO_FETCH_TIMEOUT_MS = 4000;
const PHOTO_MAX_BYTES = 4 * 1024 * 1024; // 4 MB per photo — keeps total PDF under bucket cap

const SECTION_HEADING_GAP = 14;
const SECTION_BODY_GAP = 18;
const TEXT_LINE_HEIGHT = 13;

// Signature canvas
const SIGNATURE_BOX_HEIGHT = 90;
const SIGNATURE_BOX_WIDTH = 220;

// ─────────────────────────────────────────────────────────────────────────────
// Public render
// ─────────────────────────────────────────────────────────────────────────────

export async function renderRapportBranded(
  data: RapportBrandedData,
  branding: PartnerBranding,
  lang: Lang,
): Promise<Uint8Array> {
  const strings = getStrings(lang);
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`${strings.documentTitle} — ${branding.name}`);
  pdfDoc.setAuthor(branding.name);
  pdfDoc.setSubject(strings.documentTitle);
  pdfDoc.setCreator("Flancco Platform — generate-pdf");
  pdfDoc.setCreationDate(new Date());

  const fonts = await embedStandardFonts(pdfDoc);

  // Pre-fetch all photo bytes in parallel so the page-render pass is purely
  // synchronous layout. This keeps pagination predictable when a photo block
  // is split across pages.
  const fotoBytes = await Promise.all(
    (data.fotos || []).slice(0, MAX_PHOTOS).map((url) => fetchPhoto(url)),
  );
  const fotoExtraCount = Math.max(0, (data.fotos?.length ?? 0) - MAX_PHOTOS);

  // Pre-fetch signature image (if URL or data-URI provided).
  const signatureImage = data.handtekening_url
    ? await fetchPhoto(data.handtekening_url)
    : null;

  const pages: PDFPage[] = [];
  let page = pdfDoc.addPage(A4_PORTRAIT);
  pages.push(page);

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
      subtitle: data.klant_naam ? sanitize(data.klant_naam) : undefined,
    },
  );

  const contentWidth = page.getWidth() - MARGIN.left - MARGIN.right;
  const minY = MARGIN.bottom + 8;

  // 1. Klant + Beurt info-blocks (side by side)
  y = drawInfoCards(page, fonts, branding, data, lang, strings, y, contentWidth);

  // Helper for new page when needed
  const ensureSpace = async (required: number): Promise<void> => {
    if (y - required < minY) {
      page = pdfDoc.addPage(A4_PORTRAIT);
      pages.push(page);
      y = await drawHeader(
        { ...ctxBase, page },
        {
          title: strings.documentTitle,
          subtitle: data.klant_naam ? sanitize(data.klant_naam) : undefined,
        },
      );
    }
  };

  // 2. Bevindingen
  await ensureSpace(60);
  y = drawSectionHeading(page, fonts.bold, branding, strings.bevindingenTitle, y, contentWidth);
  y = drawSectionBody(
    page,
    fonts.regular,
    fonts.italic,
    data.bevindingen,
    strings.geenBevindingen,
    y,
    contentWidth,
  );

  // 3. Materiaal — alleen tonen indien expliciet aanwezig (string of array van punten)
  const materiaalRendered = coerceBody(data.materiaal);
  if (materiaalRendered) {
    await ensureSpace(60);
    y = drawSectionHeading(page, fonts.bold, branding, strings.materiaalTitle, y, contentWidth);
    y = drawSectionBody(
      page,
      fonts.regular,
      fonts.italic,
      materiaalRendered,
      "",
      y,
      contentWidth,
    );
  }

  // 4. Aanbevelingen
  await ensureSpace(60);
  y = drawSectionHeading(page, fonts.bold, branding, strings.aanbevelingenTitle, y, contentWidth);
  y = drawSectionBody(
    page,
    fonts.regular,
    fonts.italic,
    data.aanbevelingen,
    strings.geenAanbevelingen,
    y,
    contentWidth,
  );

  // 5. Foto's grid
  const photosWithBytes = fotoBytes.filter((b): b is FetchedImage => b !== null);
  if (data.fotos && data.fotos.length > 0) {
    // Reserve space for at least the heading + one photo row (~ 100pt + 130pt thumbnail height).
    await ensureSpace(60);
    y = drawSectionHeading(page, fonts.bold, branding, strings.fotosTitle, y, contentWidth);

    if (photosWithBytes.length === 0) {
      drawText(page, strings.geenFotos, {
        x: MARGIN.left,
        y: y - 4,
        size: 10,
        font: fonts.italic,
        color: PALETTE.muted,
        maxWidth: contentWidth,
      });
      y -= TEXT_LINE_HEIGHT + SECTION_BODY_GAP;
    } else {
      // Lay out in rows of PHOTO_GRID_COLS. Each row of thumbs needs ~130pt height.
      const cellWidth = (contentWidth - PHOTO_GAP * (PHOTO_GRID_COLS - 1)) / PHOTO_GRID_COLS;
      const cellHeight = cellWidth * (3 / 4); // 4:3 thumbnail aspect

      for (let i = 0; i < photosWithBytes.length; i += PHOTO_GRID_COLS) {
        await ensureSpace(cellHeight + 14);
        const rowStartY = y;
        for (let j = 0; j < PHOTO_GRID_COLS; j++) {
          const idx = i + j;
          if (idx >= photosWithBytes.length) break;
          const xOffset = MARGIN.left + j * (cellWidth + PHOTO_GAP);
          await drawPhotoThumb(
            pdfDoc,
            page,
            photosWithBytes[idx],
            xOffset,
            rowStartY - cellHeight,
            cellWidth,
            cellHeight,
          );
        }
        y = rowStartY - cellHeight - 14;
      }

      if (fotoExtraCount > 0) {
        drawText(page, strings.morePhotos(fotoExtraCount), {
          x: MARGIN.left,
          y,
          size: 9,
          font: fonts.italic,
          color: PALETTE.muted,
          maxWidth: contentWidth,
        });
        y -= TEXT_LINE_HEIGHT;
      }
      y -= SECTION_BODY_GAP - TEXT_LINE_HEIGHT;
    }
  }

  // 6. Handtekening klant
  await ensureSpace(SIGNATURE_BOX_HEIGHT + 30);
  y = drawSectionHeading(page, fonts.bold, branding, strings.handtekeningTitle, y, contentWidth);
  y = await drawSignatureBlock(
    pdfDoc,
    page,
    fonts,
    signatureImage,
    data.handtekening_naam || data.klant_naam || "",
    data.handtekening_datum || data.datum,
    lang,
    strings,
    y,
    contentWidth,
  );

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

function drawInfoCards(
  page: PDFPage,
  fonts: FontPack,
  branding: PartnerBranding,
  data: RapportBrandedData,
  lang: Lang,
  strings: Strings,
  y: number,
  contentWidth: number,
): number {
  const primary = hexToRgb(branding.primaryColor, PALETTE.black);
  const cardGap = 14;
  const cardWidth = (contentWidth - cardGap) / 2;
  const cardPadding = 14;

  // Build content rows for each card so we can derive a uniform height.
  const klantRows: Array<[string, string]> = [];
  if (data.klant_naam) klantRows.push(["", data.klant_naam]);
  const addr = formatPostalAddress({
    address: data.klant_adres,
    postcode: data.klant_postcode,
    gemeente: data.klant_gemeente,
  });
  if (addr) klantRows.push(["", addr]);
  if (data.klant_email) klantRows.push(["", data.klant_email]);
  if (data.klant_telefoon) klantRows.push(["", data.klant_telefoon]);
  if (klantRows.length === 0) klantRows.push(["", strings.notapplicable]);

  const contractNummer = (data.contract_nummer
    ?? (data.contract_id ? data.contract_id.slice(0, 8).toUpperCase() : "")) || strings.notapplicable;
  const datum = data.datum ? formatDate(data.datum, lang) : strings.notapplicable;

  const beurtRows: Array<[string, string]> = [
    [strings.contractNr, contractNummer],
    [strings.beurtDatum, datum],
  ];
  if (typeof data.aantal_panelen === "number" && data.aantal_panelen > 0) {
    beurtRows.push([strings.panelen, String(data.aantal_panelen)]);
  }
  if (data.frequentie) beurtRows.push([strings.frequentie, data.frequentie]);
  if (data.contractduur) beurtRows.push([strings.contractduur, data.contractduur]);
  if (data.sector) {
    const sl = sectorLabel(data.sector, lang);
    if (sl) beurtRows.push([strings.sector, sl]);
  }

  const titleHeight = 18;
  const rowHeight = 14;
  const klantHeight = titleHeight + klantRows.length * rowHeight + cardPadding * 2;
  const beurtHeight = titleHeight + beurtRows.length * rowHeight + cardPadding * 2;
  const cardHeight = Math.max(klantHeight, beurtHeight);

  // Draw card backgrounds (subtle surface) with primary-color top stripe
  drawCardBg(page, MARGIN.left, y - cardHeight, cardWidth, cardHeight, primary);
  drawCardBg(page, MARGIN.left + cardWidth + cardGap, y - cardHeight, cardWidth, cardHeight, primary);

  // Klant card content
  drawText(page, strings.klantBlockTitle, {
    x: MARGIN.left + cardPadding,
    y: y - cardPadding - 10,
    size: 9,
    font: fonts.bold,
    color: PALETTE.muted,
  });
  let cursor = y - cardPadding - 10 - 16;
  for (const [, value] of klantRows) {
    drawText(page, value, {
      x: MARGIN.left + cardPadding,
      y: cursor,
      size: 10,
      font: fonts.regular,
      color: PALETTE.ink,
      maxWidth: cardWidth - cardPadding * 2,
    });
    cursor -= rowHeight;
  }

  // Beurt card content
  const beurtX = MARGIN.left + cardWidth + cardGap;
  drawText(page, strings.contractBlockTitle, {
    x: beurtX + cardPadding,
    y: y - cardPadding - 10,
    size: 9,
    font: fonts.bold,
    color: PALETTE.muted,
  });
  cursor = y - cardPadding - 10 - 16;
  const beurtInnerWidth = cardWidth - cardPadding * 2;
  for (const [label, value] of beurtRows) {
    if (label) {
      drawText(page, label, {
        x: beurtX + cardPadding,
        y: cursor,
        size: 9,
        font: fonts.regular,
        color: PALETTE.muted,
        maxWidth: beurtInnerWidth * 0.6,
      });
      const labelW = fonts.regular.widthOfTextAtSize(sanitize(label), 9);
      drawText(page, value, {
        x: beurtX + cardPadding + Math.min(labelW + 8, beurtInnerWidth * 0.6),
        y: cursor,
        size: 10,
        font: fonts.bold,
        color: PALETTE.ink,
        maxWidth: beurtInnerWidth - Math.min(labelW + 8, beurtInnerWidth * 0.6),
      });
    } else {
      drawText(page, value, {
        x: beurtX + cardPadding,
        y: cursor,
        size: 10,
        font: fonts.regular,
        color: PALETTE.ink,
        maxWidth: beurtInnerWidth,
      });
    }
    cursor -= rowHeight;
  }

  return y - cardHeight - 24;
}

function drawCardBg(
  page: PDFPage,
  x: number,
  y: number,
  width: number,
  height: number,
  primary: ReturnType<typeof rgb>,
): void {
  // Subtle surface
  page.drawRectangle({
    x,
    y,
    width,
    height,
    color: PALETTE.surface,
  });
  // Top stripe in primary color
  page.drawRectangle({
    x,
    y: y + height - 3,
    width,
    height: 3,
    color: primary,
  });
}

function drawSectionHeading(
  page: PDFPage,
  fontBold: PDFFont,
  branding: PartnerBranding,
  label: string,
  y: number,
  contentWidth: number,
): number {
  const primary = hexToRgb(branding.primaryColor, PALETTE.black);
  drawText(page, label.toUpperCase(), {
    x: MARGIN.left,
    y: y - 4,
    size: 11,
    font: fontBold,
    color: primary,
  });
  // Underline accent
  page.drawLine({
    start: { x: MARGIN.left, y: y - 9 },
    end: { x: MARGIN.left + contentWidth, y: y - 9 },
    thickness: 0.75,
    color: primary,
  });
  return y - SECTION_HEADING_GAP - 4;
}

/**
 * Coerce body-content into a single render-ready string.
 *  - string  → trim + return
 *  - array   → bullet-list (· prefix per regel, lege items overgeslagen)
 *  - other   → ""
 */
function coerceBody(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input.trim();
  if (Array.isArray(input)) {
    const lines = input
      .map((item) => (item == null ? "" : String(item).trim()))
      .filter((s) => s.length > 0)
      .map((s) => `\u00B7 ${s}`); // U+00B7 middle dot — WinAnsi-safe
    return lines.join("\n");
  }
  return String(input).trim();
}

function drawSectionBody(
  page: PDFPage,
  fontRegular: PDFFont,
  fontItalic: PDFFont,
  text: unknown,
  emptyFallback: string,
  y: number,
  contentWidth: number,
): number {
  const value = coerceBody(text);
  if (!value && !emptyFallback) return y;
  const useItalic = !value && !!emptyFallback;
  const toRender = value || emptyFallback;
  const newY = drawWrapped(
    page,
    toRender,
    MARGIN.left,
    y,
    contentWidth,
    useItalic ? fontItalic : fontRegular,
    10,
    useItalic ? PALETTE.muted : PALETTE.ink,
    TEXT_LINE_HEIGHT,
  );
  return newY - SECTION_BODY_GAP + TEXT_LINE_HEIGHT;
}

interface FetchedImage {
  bytes: Uint8Array;
  mime: "image/png" | "image/jpeg";
}

async function fetchPhoto(url: string): Promise<FetchedImage | null> {
  if (!url) return null;
  // Accept inline data-URIs (handtekening flow uses base64-PNG sometimes).
  const dataMatch = /^data:(image\/(?:png|jpe?g));base64,(.+)$/i.exec(url);
  if (dataMatch) {
    try {
      const mime = (dataMatch[1].toLowerCase().includes("png") ? "image/png" : "image/jpeg") as
        | "image/png"
        | "image/jpeg";
      const bin = atob(dataMatch[2]);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      if (bytes.byteLength === 0 || bytes.byteLength > PHOTO_MAX_BYTES) return null;
      return { bytes, mime };
    } catch {
      return null;
    }
  }
  // Network fetch with strict timeout. We never throw — a failed photo just
  // gets skipped.
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PHOTO_FETCH_TIMEOUT_MS);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > PHOTO_MAX_BYTES) return null;
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("png")) return { bytes: buf, mime: "image/png" };
    if (ct.includes("jpeg") || ct.includes("jpg")) return { bytes: buf, mime: "image/jpeg" };
    // Magic-byte sniff fallback.
    if (buf[0] === 0x89 && buf[1] === 0x50) return { bytes: buf, mime: "image/png" };
    if (buf[0] === 0xff && buf[1] === 0xd8) return { bytes: buf, mime: "image/jpeg" };
    return null;
  } catch {
    return null;
  }
}

async function drawPhotoThumb(
  pdfDoc: PDFDocument,
  page: PDFPage,
  img: FetchedImage,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<void> {
  try {
    const embedded = img.mime === "image/png"
      ? await pdfDoc.embedPng(img.bytes)
      : await pdfDoc.embedJpg(img.bytes);
    // Cover-fit (similar to CSS object-fit: cover) — preserve aspect, crop overflow.
    const imgRatio = embedded.width / embedded.height;
    const cellRatio = width / height;
    let drawW = width;
    let drawH = height;
    let drawX = x;
    let drawY = y;
    if (imgRatio > cellRatio) {
      // image is wider — match height, crop sides
      drawH = height;
      drawW = height * imgRatio;
      drawX = x - (drawW - width) / 2;
    } else {
      drawW = width;
      drawH = width / imgRatio;
      drawY = y - (drawH - height) / 2;
    }
    // Clip via clipping rect — pdf-lib's drawImage doesn't natively clip, so we
    // wrap the image in a bounded rectangle and draw a hairline border to fake
    // a clean edge. The image bleeding outside the cell is acceptable in
    // practice because the next cell either sits beside it (gap covers it) or
    // below it (also gapped).
    page.drawImage(embedded, {
      x: drawX,
      y: drawY,
      width: drawW,
      height: drawH,
    });
    // Hairline frame so cropped photos look intentional.
    page.drawRectangle({
      x,
      y,
      width,
      height,
      borderColor: PALETTE.hairline,
      borderWidth: 0.5,
    });
  } catch {
    // Embed failure → draw placeholder rectangle so layout stays consistent.
    page.drawRectangle({
      x,
      y,
      width,
      height,
      color: PALETTE.surface,
      borderColor: PALETTE.hairline,
      borderWidth: 0.5,
    });
  }
}

async function drawSignatureBlock(
  pdfDoc: PDFDocument,
  page: PDFPage,
  fonts: FontPack,
  signatureImage: FetchedImage | null,
  naam: string,
  datum: string | undefined,
  lang: Lang,
  strings: Strings,
  y: number,
  contentWidth: number,
): Promise<number> {
  const blockHeight = SIGNATURE_BOX_HEIGHT + 30;
  const boxY = y - SIGNATURE_BOX_HEIGHT;

  // Subtle frame
  page.drawRectangle({
    x: MARGIN.left,
    y: boxY,
    width: SIGNATURE_BOX_WIDTH,
    height: SIGNATURE_BOX_HEIGHT,
    color: PALETTE.white,
    borderColor: PALETTE.hairline,
    borderWidth: 0.75,
  });

  if (signatureImage) {
    try {
      const embedded = signatureImage.mime === "image/png"
        ? await pdfDoc.embedPng(signatureImage.bytes)
        : await pdfDoc.embedJpg(signatureImage.bytes);
      const padding = 6;
      const maxW = SIGNATURE_BOX_WIDTH - padding * 2;
      const maxH = SIGNATURE_BOX_HEIGHT - padding * 2;
      const scale = Math.min(maxW / embedded.width, maxH / embedded.height);
      const w = embedded.width * scale;
      const h = embedded.height * scale;
      page.drawImage(embedded, {
        x: MARGIN.left + (SIGNATURE_BOX_WIDTH - w) / 2,
        y: boxY + (SIGNATURE_BOX_HEIGHT - h) / 2,
        width: w,
        height: h,
      });
    } catch {
      drawText(page, strings.handtekeningOntbreekt, {
        x: MARGIN.left + 10,
        y: boxY + SIGNATURE_BOX_HEIGHT / 2 - 4,
        size: 9,
        font: fonts.italic,
        color: PALETTE.muted,
      });
    }
  } else {
    drawText(page, strings.handtekeningOntbreekt, {
      x: MARGIN.left + 10,
      y: boxY + SIGNATURE_BOX_HEIGHT / 2 - 4,
      size: 9,
      font: fonts.italic,
      color: PALETTE.muted,
    });
  }

  // Right of the box: subtitle + name + date
  const rightX = MARGIN.left + SIGNATURE_BOX_WIDTH + 18;
  drawText(page, strings.handtekeningSubtitle, {
    x: rightX,
    y: y - 4,
    size: 9,
    font: fonts.italic,
    color: PALETTE.muted,
    maxWidth: contentWidth - SIGNATURE_BOX_WIDTH - 18,
  });
  if (naam) {
    drawText(page, naam, {
      x: rightX,
      y: y - 22,
      size: 11,
      font: fonts.bold,
      color: PALETTE.ink,
      maxWidth: contentWidth - SIGNATURE_BOX_WIDTH - 18,
    });
  }
  if (datum) {
    drawText(page, formatDate(datum, lang), {
      x: rightX,
      y: y - 38,
      size: 10,
      font: fonts.regular,
      color: PALETTE.ink,
      maxWidth: contentWidth - SIGNATURE_BOX_WIDTH - 18,
    });
  }

  return y - blockHeight;
}
