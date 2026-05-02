// Slot X — Partner-Flancco contract template (one-size-fits-all)
// =============================================================
// Genereert het juridisch contract tussen Flancco BV en het partner-bedrijf.
// Variabele velden: partner-bedrijfsnaam, BTW, contactpersoon, sectoren, marge%,
// datum, handtekening. Vaste tekst: algemene voorwaarden, opzegtermijn, GDPR,
// BE-recht, etc.
//
// Gebruikt door publieke wizard `/onboard/` stap 4 (server-side rendering vermijdt
// client-side HTML-spoofing van een juridisch document). Output naar bucket
// `partner-contracts`.

import { PDFDocument } from "https://esm.sh/pdf-lib@1.17.1";
import {
  A4_PORTRAIT,
  drawFooter,
  drawHeader,
  drawText,
  drawWrapped,
  embedStandardFonts,
  FontPack,
  Lang,
  MARGIN,
  PageContext,
  PALETTE,
  PartnerBranding,
  wrapText,
} from "./_shared.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface PartnerContractSignedData {
  /** Optional reference to the partner-application that produced this contract. */
  application_id?: string;

  // Partner-bedrijf
  partner_bedrijfsnaam: string;
  partner_btw_nummer?: string;
  partner_adres?: string;
  partner_postcode?: string;
  partner_gemeente?: string;
  partner_website?: string;

  // Contactpersoon (vertegenwoordiger partner)
  contactpersoon_voornaam?: string;
  contactpersoon_naam?: string;
  contactpersoon_email: string;
  contactpersoon_telefoon?: string;
  contactpersoon_functie?: string;

  // Contract-voorwaarden
  /** Lijst van slugs: 'warmtepomp' | 'zonnepanelen' | 'ventilatie'. */
  sectoren: string[];
  /** Globale marge in % (10-15) — bewust binnen marktconforme zonnepaneel-tarieven. */
  marge_pct: number;

  // Signing
  /** ISO timestamp when the partner countersigned. */
  signing_datum: string;
  signing_ip?: string;
  /** PNG base64 (data-URL of raw). */
  handtekening_base64?: string;

  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants — Flancco-side identificatie. Niet uit env (zou bij compromised
// edge-runtime overgeschreven kunnen worden) en niet uit DB (zou bij data-leak
// vervalsbaar zijn). Vast in de juridisch-template-laag.
// ─────────────────────────────────────────────────────────────────────────────

const FLANCCO_LEGAL_NAME = "Flancco BV";
const FLANCCO_ADDRESS = "Industrieweg 25, 9080 Lochristi";
const FLANCCO_VAT = "BE0XXXXXXXXX"; // TODO: vervang door definitief BTW-nummer
const FLANCCO_REPRESENTATIVE = "Gillian Geernaert";

// ─────────────────────────────────────────────────────────────────────────────
// i18n
// ─────────────────────────────────────────────────────────────────────────────

const SECTOR_LABELS: Record<Lang, Record<string, string>> = {
  nl: {
    warmtepomp: "Warmtepomp",
    zonnepanelen: "Zonnepanelen",
    ventilatie: "Ventilatie",
  },
  fr: {
    warmtepomp: "Pompe a chaleur",
    zonnepanelen: "Panneaux solaires",
    ventilatie: "Ventilation",
  },
};

interface Strings {
  documentTitle: string;
  signatureTitle: string;
  betweenSigned: string;
  party1: string;
  representedBy: (name: string, role: string) => string;
  hereinafterFlancco: string;
  party2: string;
  hereinafterPartner: string;
  agreed: string;
  art1Title: string;
  art1Body: (sectors: string) => string;
  art2Title: string;
  art2Body: (margePct: number) => string;
  art3Title: string;
  art3Body: string;
  art4Title: string;
  art4Body: string;
  art5Title: string;
  art5Body: string;
  art6Title: string;
  art6Body: string;
  art7Title: string;
  art7Body: string;
  signedOn: (date: string) => string;
  ipLabel: (ip: string) => string;
  forFlancco: string;
  forPartner: string;
  signed: string;
  zaakvoerder: string;
  vatLabel: string;
}

const NL: Strings = {
  documentTitle: "Partnercontract",
  signatureTitle: "Ondertekening",
  betweenSigned: "Tussen ondergetekenden:",
  party1: "Partij 1 — Flancco BV",
  representedBy: (name, role) => `Vertegenwoordigd door ${name}, ${role}`,
  hereinafterFlancco: '(hierna "Flancco")',
  party2: "Partij 2 — Partner",
  hereinafterPartner: '(hierna "de Partner")',
  agreed: "Wordt overeengekomen wat volgt:",
  art1Title: "Artikel 1 — Voorwerp",
  art1Body: (sectors) =>
    `Flancco stelt zijn platform en technieker-netwerk ter beschikking van de Partner voor het uitvoeren van onderhoud- en servicewerk in de volgende sectoren: ${sectors}. De Partner blijft eigenaar van de commerciele relatie met de eindklant; Flancco is verantwoordelijk voor de uitvoering ter plaatse.`,
  art2Title: "Artikel 2 — Marge en facturatie",
  art2Body: (margePct) =>
    `De Partner past een marge toe van ${margePct}% bovenop de Flancco-basisprijs. Deze marge geldt globaal over alle overeengekomen sectoren. Flancco factureert maandelijks aan de Partner voor de geleverde diensten op basis van de afgewerkte beurten in het Flancco-platform; de Partner factureert de eindklant volgens eigen voorwaarden en blijft volledig verantwoordelijk voor de inning.`,
  art3Title: "Artikel 3 — Duur en opzegging",
  art3Body:
    "Deze overeenkomst treedt in werking op de datum van ondertekening en is gesloten voor onbepaalde duur. Elke partij kan de overeenkomst beeindigen mits een schriftelijke opzegtermijn van een (1) maand. Lopende klantcontracten worden uitgevoerd tot aan hun contractuele einddatum. Bij ernstige tekortkoming kan de overeenkomst met onmiddellijke ingang verbroken worden, na schriftelijke ingebrekestelling van vijftien (15) dagen die zonder gevolg blijft.",
  art4Title: "Artikel 4 — Verantwoordelijkheden",
  art4Body:
    "De Partner is verantwoordelijk voor de commerciele klantrelatie, het correct doorgeven van klantgegevens, de inning van facturen en de regelmatigheid van zijn activiteit (vergunningen, BTW, sociale verplichtingen). Flancco is verantwoordelijk voor de kwaliteit van de technische uitvoering door zijn technici, de planning, de rapportage en de naleving van de geldende veiligheidsnormen.",
  art5Title: "Artikel 5 — GDPR en data",
  art5Body:
    "Flancco treedt op als verwerkingsverantwoordelijke voor de operationele data (planning, technische rapporten, facturatie). De Partner blijft verwerkingsverantwoordelijke voor de commerciele klantdata (offertes, marketing, eigen administratie). Beide partijen respecteren de Algemene Verordening Gegevensbescherming (Verordening 2016/679) en in het bijzonder artikel 32 inzake passende technische en organisatorische maatregelen. Klantcontactgegevens worden niet voor andere doeleinden gebruikt dan de uitvoering van deze overeenkomst.",
  art6Title: "Artikel 6 — Aansprakelijkheid",
  art6Body:
    "De aansprakelijkheid van Flancco is beperkt tot het bedrag dat door haar verzekering effectief wordt uitgekeerd, en in elk geval tot de vergoeding van de directe schade die rechtstreeks voortvloeit uit de uitvoering van de prestatie. Flancco is niet aansprakelijk voor indirecte schade, gederfde winst, reputatieschade of verlies van klanten van de Partner.",
  art7Title: "Artikel 7 — Geschillen en bevoegde rechtbank",
  art7Body:
    "Deze overeenkomst wordt beheerst door het Belgische recht. Bij geschillen zoeken partijen eerst een minnelijke oplossing. Indien geen akkoord wordt bereikt, valt elk geschil onder de uitsluitende bevoegdheid van de rechtbanken van het gerechtelijk arrondissement Gent, afdeling Gent.",
  signedOn: (date) => `Elektronisch ondertekend op ${date}`,
  ipLabel: (ip) => `IP-adres: ${ip}`,
  forFlancco: "Voor Flancco BV",
  forPartner: "Voor de Partner",
  signed: "[ondertekend]",
  zaakvoerder: "Zaakvoerder",
  vatLabel: "BTW",
};

const FR: Strings = {
  documentTitle: "Contrat de partenariat",
  signatureTitle: "Signature",
  betweenSigned: "Entre les soussignes:",
  party1: "Partie 1 — Flancco BV",
  representedBy: (name, role) => `Representee par ${name}, ${role}`,
  hereinafterFlancco: '(ci-apres "Flancco")',
  party2: "Partie 2 — Partenaire",
  hereinafterPartner: '(ci-apres "le Partenaire")',
  agreed: "Il est convenu ce qui suit:",
  art1Title: "Article 1 — Objet",
  art1Body: (sectors) =>
    `Flancco met a disposition du Partenaire sa plateforme et son reseau de techniciens pour la prestation de services d'entretien et de service dans les secteurs suivants: ${sectors}. Le Partenaire conserve la relation commerciale avec le client final; Flancco est responsable de l'execution sur site.`,
  art2Title: "Article 2 — Marge et facturation",
  art2Body: (margePct) =>
    `Le Partenaire applique une marge de ${margePct}% au-dessus du prix de base Flancco. Cette marge est globale sur tous les secteurs convenus. Flancco facture mensuellement le Partenaire pour les prestations livrees sur base des interventions cloturees dans la plateforme; le Partenaire facture le client final selon ses propres conditions et reste entierement responsable du recouvrement.`,
  art3Title: "Article 3 — Duree et resiliation",
  art3Body:
    "Le present contrat entre en vigueur a la date de signature et est conclu pour une duree indeterminee. Chaque partie peut resilier moyennant un preavis ecrit d'un (1) mois. Les contrats clients en cours sont honores jusqu'a leur terme contractuel. En cas de manquement grave, le contrat peut etre resilie avec effet immediat apres une mise en demeure ecrite de quinze (15) jours restee sans suite.",
  art4Title: "Article 4 — Responsabilites",
  art4Body:
    "Le Partenaire est responsable de la relation commerciale avec le client final, de la transmission correcte des donnees clients, du recouvrement des factures et de la conformite reglementaire de son activite (licences, TVA, obligations sociales). Flancco est responsable de la qualite de l'execution technique par ses techniciens, de la planification, du rapport et du respect des normes de securite en vigueur.",
  art5Title: "Article 5 — RGPD et donnees",
  art5Body:
    "Flancco agit en tant que responsable du traitement pour les donnees operationnelles (planification, rapports techniques, facturation). Le Partenaire reste responsable du traitement pour les donnees clients commerciales (offres, marketing, administration propre). Les deux parties respectent le Reglement General sur la Protection des Donnees (Reglement 2016/679) et en particulier l'article 32 relatif aux mesures de securite techniques et organisationnelles appropriees. Les coordonnees clients ne sont pas utilisees a d'autres fins que l'execution du present contrat.",
  art6Title: "Article 6 — Responsabilite",
  art6Body:
    "La responsabilite de Flancco est limitee au montant effectivement verse par son assurance et, en tout etat de cause, a l'indemnisation du dommage direct decoulant directement de l'execution de la prestation. Flancco n'est pas responsable des dommages indirects, du manque a gagner, du dommage de reputation ni de la perte de clients du Partenaire.",
  art7Title: "Article 7 — Litiges et tribunal competent",
  art7Body:
    "Le present contrat est regi par le droit belge. En cas de litige, les parties cherchent d'abord une solution amiable. A defaut d'accord, tout litige releve de la competence exclusive des tribunaux de l'arrondissement judiciaire de Gand, division Gand.",
  signedOn: (date) => `Signe electroniquement le ${date}`,
  ipLabel: (ip) => `Adresse IP: ${ip}`,
  forFlancco: "Pour Flancco BV",
  forPartner: "Pour le Partenaire",
  signed: "[signe]",
  zaakvoerder: "Directeur",
  vatLabel: "TVA",
};

function getStrings(lang: Lang): Strings {
  return lang === "fr" ? FR : NL;
}

// ─────────────────────────────────────────────────────────────────────────────
// Layout constants
// ─────────────────────────────────────────────────────────────────────────────

const BODY_SIZE = 9.5;
const BODY_LINE_HEIGHT = 13;
const ARTICLE_TITLE_SIZE = 11;
const ARTICLE_GAP = 18;
const PARTY_BLOCK_HEIGHT = 78;
const MIN_Y_BEFORE_NEW_PAGE = MARGIN.bottom + 60;

// ─────────────────────────────────────────────────────────────────────────────
// Public render
// ─────────────────────────────────────────────────────────────────────────────

export async function renderPartnerContractSigned(
  data: PartnerContractSignedData,
  branding: PartnerBranding,
  lang: Lang,
): Promise<Uint8Array> {
  const strings = getStrings(lang);
  const partner = sanitizePartnerData(data);

  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`${strings.documentTitle} — ${partner.partner_bedrijfsnaam}`);
  pdfDoc.setAuthor(FLANCCO_LEGAL_NAME);
  pdfDoc.setSubject(strings.documentTitle);
  pdfDoc.setCreator("Flancco Platform — generate-pdf");
  pdfDoc.setCreationDate(new Date());

  const fonts = await embedStandardFonts(pdfDoc);

  // We collect pages so we can patch footer pageNumbers in a second pass once
  // we know the total. This mirrors the werkplanning template approach.
  const pages: ReturnType<typeof pdfDoc.addPage>[] = [];

  let page = pdfDoc.addPage(A4_PORTRAIT);
  pages.push(page);

  let ctx: PageContext = {
    pdfDoc,
    page,
    branding,
    lang,
    fonts,
    pageNum: 1,
    totalPages: 1,
  };

  // ── Pagina 1: Header + Partijen ───────────────────────────────────────────
  let y = await drawHeader(ctx, {
    title: strings.documentTitle,
    subtitle: partner.partner_bedrijfsnaam,
  });

  // "Tussen ondergetekenden:"
  drawText(page, strings.betweenSigned, {
    x: MARGIN.left,
    y: y - 8,
    size: 11,
    font: fonts.bold,
    color: PALETTE.ink,
  });

  // Partij 1 — Flancco BV
  let cursor = y - 32;
  cursor = drawFlanccoParty(page, fonts, strings, cursor);

  // Partij 2 — Partner
  cursor -= 14;
  cursor = drawPartnerParty(page, fonts, strings, partner, cursor);

  // "Wordt overeengekomen wat volgt:"
  cursor -= 18;
  drawText(page, strings.agreed, {
    x: MARGIN.left,
    y: cursor,
    size: 11,
    font: fonts.bold,
    color: PALETTE.ink,
  });
  cursor -= 22;

  // ── Artikelen 1 t/m 7 met automatische paginering ─────────────────────────
  const sectorList = formatSectorList(partner.sectoren, lang);
  const articles: Array<{ title: string; body: string }> = [
    { title: strings.art1Title, body: strings.art1Body(sectorList) },
    { title: strings.art2Title, body: strings.art2Body(partner.marge_pct) },
    { title: strings.art3Title, body: strings.art3Body },
    { title: strings.art4Title, body: strings.art4Body },
    { title: strings.art5Title, body: strings.art5Body },
    { title: strings.art6Title, body: strings.art6Body },
    { title: strings.art7Title, body: strings.art7Body },
  ];

  const contentWidth = page.getWidth() - MARGIN.left - MARGIN.right;

  for (const article of articles) {
    const requiredHeight = estimateArticleHeight(article, fonts.regular, contentWidth);
    if (cursor - requiredHeight < MIN_Y_BEFORE_NEW_PAGE) {
      page = pdfDoc.addPage(A4_PORTRAIT);
      pages.push(page);
      ctx = { ...ctx, page, pageNum: pages.length };
      cursor = await drawHeader(ctx, {
        title: strings.documentTitle,
        subtitle: partner.partner_bedrijfsnaam,
      }) - 8;
    }
    cursor = drawArticle(page, fonts, article.title, article.body, cursor, contentWidth);
  }

  // ── Pagina ondertekening (altijd verse pagina voor leesbaarheid) ─────────
  page = pdfDoc.addPage(A4_PORTRAIT);
  pages.push(page);
  ctx = { ...ctx, page, pageNum: pages.length };
  let sigY = await drawHeader(ctx, {
    title: strings.signatureTitle,
    subtitle: partner.partner_bedrijfsnaam,
  });

  await drawSignatureBlock(ctx, fonts, strings, partner, sigY);

  // ── Footer-pass: nu we totaal-aantal-paginas weten ────────────────────────
  pages.forEach((p, idx) => {
    drawFooter({
      ...ctx,
      page: p,
      pageNum: idx + 1,
      totalPages: pages.length,
    });
  });

  return await pdfDoc.save();
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

interface SanitizedPartnerData {
  partner_bedrijfsnaam: string;
  partner_btw_nummer: string;
  partner_adres: string;
  partner_postcode: string;
  partner_gemeente: string;
  contactpersoon_voornaam: string;
  contactpersoon_naam: string;
  contactpersoon_email: string;
  contactpersoon_telefoon: string;
  contactpersoon_functie: string;
  sectoren: string[];
  marge_pct: number;
  signing_datum: string;
  signing_ip: string;
  handtekening_base64: string;
}

function sanitizePartnerData(data: PartnerContractSignedData): SanitizedPartnerData {
  // Defensief: zorg dat geen enkel veld undefined is en dat marge een
  // realistische waarde heeft. PDF-rendering mag nooit crashen door rare input.
  const margeRaw = typeof data.marge_pct === "number" && Number.isFinite(data.marge_pct)
    ? data.marge_pct
    : 0;
  const marge_pct = Math.max(0, Math.min(100, Math.round(margeRaw * 100) / 100));

  const sectoren = Array.isArray(data.sectoren)
    ? data.sectoren.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    : [];

  return {
    partner_bedrijfsnaam: (data.partner_bedrijfsnaam || "").trim(),
    partner_btw_nummer: (data.partner_btw_nummer || "").trim(),
    partner_adres: (data.partner_adres || "").trim(),
    partner_postcode: (data.partner_postcode || "").trim(),
    partner_gemeente: (data.partner_gemeente || "").trim(),
    contactpersoon_voornaam: (data.contactpersoon_voornaam || "").trim(),
    contactpersoon_naam: (data.contactpersoon_naam || "").trim(),
    contactpersoon_email: (data.contactpersoon_email || "").trim(),
    contactpersoon_telefoon: (data.contactpersoon_telefoon || "").trim(),
    contactpersoon_functie: (data.contactpersoon_functie || "").trim(),
    sectoren,
    marge_pct,
    signing_datum: (data.signing_datum || "").trim(),
    signing_ip: (data.signing_ip || "").trim(),
    handtekening_base64: (data.handtekening_base64 || "").trim(),
  };
}

function formatSectorList(slugs: string[], lang: Lang): string {
  const labels = SECTOR_LABELS[lang];
  const fallback = SECTOR_LABELS.nl;
  const mapped = slugs.map((s) => labels[s] || fallback[s] || s);
  if (mapped.length === 0) return "—";
  return mapped.join(", ");
}

function drawFlanccoParty(
  page: ReturnType<PDFDocument["addPage"]>,
  fonts: FontPack,
  strings: Strings,
  startY: number,
): number {
  drawText(page, strings.party1, {
    x: MARGIN.left,
    y: startY,
    size: 10,
    font: fonts.bold,
    color: PALETTE.ink,
  });
  drawText(page, FLANCCO_LEGAL_NAME, {
    x: MARGIN.left,
    y: startY - 14,
    size: 10,
    font: fonts.bold,
    color: PALETTE.ink,
  });
  drawText(page, FLANCCO_ADDRESS, {
    x: MARGIN.left,
    y: startY - 28,
    size: 9,
    font: fonts.regular,
    color: PALETTE.muted,
  });
  drawText(page, `${strings.vatLabel}: ${FLANCCO_VAT}`, {
    x: MARGIN.left,
    y: startY - 42,
    size: 9,
    font: fonts.regular,
    color: PALETTE.muted,
  });
  drawText(page, strings.representedBy(FLANCCO_REPRESENTATIVE, strings.zaakvoerder), {
    x: MARGIN.left,
    y: startY - 56,
    size: 9,
    font: fonts.italic,
    color: PALETTE.muted,
  });
  drawText(page, strings.hereinafterFlancco, {
    x: MARGIN.left,
    y: startY - 70,
    size: 9,
    font: fonts.regular,
    color: PALETTE.muted,
  });
  return startY - PARTY_BLOCK_HEIGHT;
}

function drawPartnerParty(
  page: ReturnType<PDFDocument["addPage"]>,
  fonts: FontPack,
  strings: Strings,
  partner: SanitizedPartnerData,
  startY: number,
): number {
  drawText(page, strings.party2, {
    x: MARGIN.left,
    y: startY,
    size: 10,
    font: fonts.bold,
    color: PALETTE.ink,
  });
  drawText(page, partner.partner_bedrijfsnaam || "—", {
    x: MARGIN.left,
    y: startY - 14,
    size: 10,
    font: fonts.bold,
    color: PALETTE.ink,
  });

  let lineY = startY - 28;
  const addressLine = [
    partner.partner_adres,
    [partner.partner_postcode, partner.partner_gemeente].filter(Boolean).join(" "),
  ].filter(Boolean).join(", ");
  if (addressLine) {
    drawText(page, addressLine, {
      x: MARGIN.left,
      y: lineY,
      size: 9,
      font: fonts.regular,
      color: PALETTE.muted,
    });
    lineY -= 14;
  }

  if (partner.partner_btw_nummer) {
    drawText(page, `${strings.vatLabel}: ${partner.partner_btw_nummer}`, {
      x: MARGIN.left,
      y: lineY,
      size: 9,
      font: fonts.regular,
      color: PALETTE.muted,
    });
    lineY -= 14;
  }

  const contactName = [partner.contactpersoon_voornaam, partner.contactpersoon_naam]
    .filter(Boolean).join(" ").trim() || partner.contactpersoon_email || "—";
  const role = partner.contactpersoon_functie || strings.zaakvoerder;
  drawText(page, strings.representedBy(contactName, role), {
    x: MARGIN.left,
    y: lineY,
    size: 9,
    font: fonts.italic,
    color: PALETTE.muted,
  });
  lineY -= 14;

  drawText(page, strings.hereinafterPartner, {
    x: MARGIN.left,
    y: lineY,
    size: 9,
    font: fonts.regular,
    color: PALETTE.muted,
  });

  return lineY - 14;
}

function estimateArticleHeight(
  article: { title: string; body: string },
  fontRegular: FontPack["regular"],
  contentWidth: number,
): number {
  const lines = wrapText(article.body, fontRegular, BODY_SIZE, contentWidth);
  return ARTICLE_TITLE_SIZE + 4 + lines.length * BODY_LINE_HEIGHT + ARTICLE_GAP;
}

function drawArticle(
  page: ReturnType<PDFDocument["addPage"]>,
  fonts: FontPack,
  title: string,
  body: string,
  startY: number,
  contentWidth: number,
): number {
  drawText(page, title, {
    x: MARGIN.left,
    y: startY,
    size: ARTICLE_TITLE_SIZE,
    font: fonts.bold,
    color: PALETTE.ink,
  });
  const bodyY = startY - 16;
  const cursor = drawWrapped(
    page,
    body,
    MARGIN.left,
    bodyY,
    contentWidth,
    fonts.regular,
    BODY_SIZE,
    PALETTE.ink,
    BODY_LINE_HEIGHT,
  );
  return cursor - (ARTICLE_GAP - BODY_LINE_HEIGHT);
}

async function drawSignatureBlock(
  ctx: PageContext,
  fonts: FontPack,
  strings: Strings,
  partner: SanitizedPartnerData,
  startY: number,
): Promise<void> {
  const { page } = ctx;

  // Datum + IP regel
  const formattedDate = formatSigningDate(partner.signing_datum, ctx.lang);
  drawText(page, strings.signedOn(formattedDate), {
    x: MARGIN.left,
    y: startY - 8,
    size: 10,
    font: fonts.regular,
    color: PALETTE.ink,
  });
  if (partner.signing_ip) {
    drawText(page, strings.ipLabel(partner.signing_ip), {
      x: MARGIN.left,
      y: startY - 24,
      size: 8,
      font: fonts.regular,
      color: PALETTE.muted,
    });
  }

  // Twee kolommen voor handtekeningen
  const col1X = MARGIN.left;
  const col2X = MARGIN.left + 280;
  const blockTop = startY - 64;

  // Kolom 1 — Flancco
  drawText(page, strings.forFlancco, {
    x: col1X,
    y: blockTop,
    size: 11,
    font: fonts.bold,
    color: PALETTE.ink,
  });
  drawText(page, FLANCCO_REPRESENTATIVE, {
    x: col1X,
    y: blockTop - 18,
    size: 10,
    font: fonts.regular,
    color: PALETTE.ink,
  });
  drawText(page, strings.zaakvoerder, {
    x: col1X,
    y: blockTop - 32,
    size: 9,
    font: fonts.italic,
    color: PALETTE.muted,
  });
  // Placeholder t/m Flancco-handtekening-image beschikbaar (Slot X v2)
  drawText(page, strings.signed, {
    x: col1X,
    y: blockTop - 80,
    size: 9,
    font: fonts.italic,
    color: PALETTE.muted,
  });

  // Kolom 2 — Partner
  const partnerName = [partner.contactpersoon_voornaam, partner.contactpersoon_naam]
    .filter(Boolean).join(" ").trim() || partner.contactpersoon_email || "—";

  drawText(page, strings.forPartner, {
    x: col2X,
    y: blockTop,
    size: 11,
    font: fonts.bold,
    color: PALETTE.ink,
  });
  drawText(page, partnerName, {
    x: col2X,
    y: blockTop - 18,
    size: 10,
    font: fonts.regular,
    color: PALETTE.ink,
  });
  drawText(page, partner.partner_bedrijfsnaam, {
    x: col2X,
    y: blockTop - 32,
    size: 9,
    font: fonts.italic,
    color: PALETTE.muted,
  });

  // Embed handtekening-image (PNG base64)
  if (partner.handtekening_base64) {
    try {
      const base64 = partner.handtekening_base64.replace(/^data:image\/png;base64,/, "");
      const sigBytes = base64ToBytes(base64);
      if (sigBytes.length > 0) {
        const sigImg = await ctx.pdfDoc.embedPng(sigBytes);
        // Schaal naar max 200x80 pt — strakke vakgrens binnen kolom 2.
        const maxW = 200;
        const maxH = 80;
        const scale = Math.min(maxW / sigImg.width, maxH / sigImg.height, 1);
        const w = sigImg.width * scale;
        const h = sigImg.height * scale;
        page.drawImage(sigImg, {
          x: col2X,
          y: blockTop - 56 - h,
          width: w,
          height: h,
        });
      }
    } catch (e) {
      // Bewust niet hard fail-en op een corrupte handtekening — het contract
      // bevat de tekstuele identificatie en het signing_datum/IP-stempel.
      const msg = e instanceof Error ? e.message : "unknown";
      console.warn(`[partner_contract_signed] handtekening embed failed: ${msg}`);
    }
  }
}

function formatSigningDate(iso: string, lang: Lang): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleDateString(lang === "fr" ? "fr-BE" : "nl-BE", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function base64ToBytes(b64: string): Uint8Array {
  try {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array(0);
  }
}
