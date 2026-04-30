/**
 * Slot Y / Stage 1 — Curated Lucide-iconset voor Flancco platform.
 *
 * Levert ~36 inline SVG-iconen (zonder buitenste <svg>-wrapper) gegroepeerd
 * per categorie zodat admin's icon-picker de set logisch kan tonen. De
 * calculator en admin renderen via window.flanccoRenderIcon(name, attrs)
 * — die voegt de wrapper met consistente attributen (viewBox/stroke/fill) toe.
 *
 * SVG path-data is rechtstreeks afkomstig uit lucide-static@1.14.0
 * (https://unpkg.com/lucide-static@latest/icons/<name>.svg) — geen approximaties.
 *
 * Geen externe dependency: deze file is volledig zelfvoorzienend en kan
 * via een simpele <script src="/shared/lucide-icons.js"></script> worden
 * geladen door zowel calculator als admin.
 */
(function () {
  'use strict';

  var SVG = {
    // ── Energie & rendement ──────────────────────────────────────
    'zap': '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />',
    'sun': '<circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" />',
    'leaf': '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z" /><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12" />',
    'gauge': '<path d="m12 14 4-4" /><path d="M3.34 19a10 10 0 1 1 17.32 0" />',
    'trending-up': '<path d="M16 7h6v6" /><path d="m22 7-8.5 8.5-5-5L2 17" />',
    'battery-charging': '<path d="m11 7-3 5h4l-3 5" /><path d="M14.856 6H16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.935" /><path d="M22 14v-4" /><path d="M5.14 18H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2.936" />',

    // ── Water & schoonmaak ───────────────────────────────────────
    'droplet': '<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z" />',
    'droplets': '<path d="M7 16.3c2.2 0 4-1.83 4-4.05 0-1.16-.57-2.26-1.71-3.19S7.29 6.75 7 5.3c-.29 1.45-1.14 2.84-2.29 3.76S3 11.1 3 12.25c0 2.22 1.8 4.05 4 4.05z" /><path d="M12.56 6.6A10.97 10.97 0 0 0 14 3.02c.5 2.5 2 4.9 4 6.5s3 3.5 3 5.5a6.98 6.98 0 0 1-11.91 4.97" />',
    'spray-can': '<path d="M3 3h.01" /><path d="M7 5h.01" /><path d="M11 7h.01" /><path d="M3 7h.01" /><path d="M7 9h.01" /><path d="M3 11h.01" /><rect width="4" height="4" x="15" y="5" /><path d="m19 9 2 2v10c0 .6-.4 1-1 1h-6c-.6 0-1-.4-1-1V11l2-2" /><path d="m13 14 8-2" /><path d="m13 19 8-2" />',
    'sparkles': '<path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z" /><path d="M20 2v4" /><path d="M22 4h-4" /><circle cx="4" cy="20" r="2" />',
    'waves': '<path d="M2 12q2.5 2 5 0t5 0 5 0 5 0" /><path d="M2 19q2.5 2 5 0t5 0 5 0 5 0" /><path d="M2 5q2.5 2 5 0t5 0 5 0 5 0" />',
    'brush': '<path d="m11 10 3 3" /><path d="M6.5 21A3.5 3.5 0 1 0 3 17.5a2.62 2.62 0 0 1-.708 1.792A1 1 0 0 0 3 21z" /><path d="M9.969 17.031 21.378 5.624a1 1 0 0 0-3.002-3.002L6.967 14.031" />',

    // ── Garantie & kwaliteit ─────────────────────────────────────
    'shield-check': '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="m9 12 2 2 4-4" />',
    'award': '<path d="m15.477 12.89 1.515 8.526a.5.5 0 0 1-.81.47l-3.58-2.687a1 1 0 0 0-1.197 0l-3.586 2.686a.5.5 0 0 1-.81-.469l1.514-8.526" /><circle cx="12" cy="8" r="6" />',
    'badge-check': '<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z" /><path d="m9 12 2 2 4-4" />',
    'star': '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z" />',
    'thumbs-up': '<path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" /><path d="M7 10v12" />',
    'check-circle': '<path d="M21.801 10A10 10 0 1 1 17 3.335" /><path d="m9 11 3 3L22 4" />',

    // ── Service & onderhoud ──────────────────────────────────────
    'wrench': '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z" />',
    'hammer': '<path d="m15 12-9.373 9.373a1 1 0 0 1-3.001-3L12 9" /><path d="m18 15 4-4" /><path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172v-.344a2 2 0 0 0-.586-1.414l-1.657-1.657A6 6 0 0 0 12.516 3H9l1.243 1.243A6 6 0 0 1 12 8.485V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5" />',
    'settings': '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" /><circle cx="12" cy="12" r="3" />',
    'hard-hat': '<path d="M10 10V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v5" /><path d="M14 6a6 6 0 0 1 6 6v3" /><path d="M4 15v-3a6 6 0 0 1 6-6" /><rect x="2" y="15" width="20" height="4" rx="1" />',
    'headphones': '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3" />',
    'calendar-check': '<path d="M8 2v4" /><path d="M16 2v4" /><rect width="18" height="18" x="3" y="4" rx="2" /><path d="M3 10h18" /><path d="m9 16 2 2 4-4" />',

    // ── Klimaat & comfort ────────────────────────────────────────
    'thermometer': '<path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z" />',
    'snowflake': '<path d="m10 20-1.25-2.5L6 18" /><path d="M10 4 8.75 6.5 6 6" /><path d="m14 20 1.25-2.5L18 18" /><path d="m14 4 1.25 2.5L18 6" /><path d="m17 21-3-6h-4" /><path d="m17 3-3 6 1.5 3" /><path d="M2 12h6.5L10 9" /><path d="m20 10-1.5 2 1.5 2" /><path d="M22 12h-6.5L14 15" /><path d="m4 10 1.5 2L4 14" /><path d="m7 21 3-6-1.5-3" /><path d="m7 3 3 6h4" />',
    'wind': '<path d="M12.8 19.6A2 2 0 1 0 14 16H2" /><path d="M17.5 8a2.5 2.5 0 1 1 2 4H2" /><path d="M9.8 4.4A2 2 0 1 1 11 8H2" />',
    'fan': '<path d="M10.827 16.379a6.082 6.082 0 0 1-8.618-7.002l5.412 1.45a6.082 6.082 0 0 1 7.002-8.618l-1.45 5.412a6.082 6.082 0 0 1 8.618 7.002l-5.412-1.45a6.082 6.082 0 0 1-7.002 8.618l1.45-5.412Z" /><path d="M12 12v.01" />',
    'home': '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" /><path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />',
    'flame': '<path d="M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4" />',

    // ── Algemeen ─────────────────────────────────────────────────
    'info': '<circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" />',
    'tag': '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" /><circle cx="7.5" cy="7.5" r=".5" fill="currentColor" />',
    'package': '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z" /><path d="M12 22V12" /><polyline points="3.29 7 12 12 20.71 7" /><path d="m7.5 4.27 9 5.15" />',
    'eye': '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" /><circle cx="12" cy="12" r="3" />',
    'heart': '<path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5" />',
    'flag': '<path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528" />'
  };

  var CATEGORIES = [
    {
      key: 'energie',
      label_nl: 'Energie & rendement',
      label_fr: 'Énergie & rendement',
      icons: ['zap', 'sun', 'leaf', 'gauge', 'trending-up', 'battery-charging']
    },
    {
      key: 'water',
      label_nl: 'Water & schoonmaak',
      label_fr: 'Eau & nettoyage',
      icons: ['droplet', 'droplets', 'spray-can', 'sparkles', 'waves', 'brush']
    },
    {
      key: 'garantie',
      label_nl: 'Garantie & kwaliteit',
      label_fr: 'Garantie & qualité',
      icons: ['shield-check', 'award', 'badge-check', 'star', 'thumbs-up', 'check-circle']
    },
    {
      key: 'service',
      label_nl: 'Service & onderhoud',
      label_fr: 'Service & entretien',
      icons: ['wrench', 'hammer', 'settings', 'hard-hat', 'headphones', 'calendar-check']
    },
    {
      key: 'klimaat',
      label_nl: 'Klimaat & comfort',
      label_fr: 'Climat & confort',
      icons: ['thermometer', 'snowflake', 'wind', 'fan', 'home', 'flame']
    },
    {
      key: 'algemeen',
      label_nl: 'Algemeen',
      label_fr: 'Général',
      icons: ['info', 'tag', 'package', 'eye', 'heart', 'flag']
    }
  ];

  /**
   * Globale registry-API. Categories + svg dictionary zijn read-only voor
   * consumers. Mutaties horen via een nieuwe versie van dit bestand te lopen.
   */
  window.flanccoIcons = {
    categories: CATEGORIES,
    svg: SVG,
    /**
     * Returnt true als de naam bekend is in de set.
     */
    has: function (name) {
      return Object.prototype.hasOwnProperty.call(SVG, name);
    },
    /**
     * Lijst van alle icoon-namen (alfabetisch).
     */
    names: function () {
      var out = [];
      for (var k in SVG) { if (Object.prototype.hasOwnProperty.call(SVG, k)) out.push(k); }
      return out.sort();
    }
  };

  /**
   * Rendert een Lucide-icoon als SVG-string (geen DOM-node — caller bepaalt
   * waar het terechtkomt). Onbekende namen → lege string (graceful fallback)
   * zodat een typo of stale config nooit een TypeError genereert.
   *
   * @param {string} name           Icon-key (bv. 'zap', 'shield-check').
   * @param {object} [attrs]        Optionele attributen.
   * @param {number|string} [attrs.size=24]   Breedte+hoogte in px (default 24).
   * @param {string} [attrs.className]        Extra CSS-class op de wrapper.
   * @param {string} [attrs.strokeWidth='2']  Stroke-width override.
   * @returns {string} SVG-markup, of '' bij onbekend icoon.
   */
  window.flanccoRenderIcon = function (name, attrs) {
    attrs = attrs || {};
    var inner = SVG[name];
    if (!inner) return '';
    var size = attrs.size != null ? String(attrs.size) : '24';
    var sw = attrs.strokeWidth != null ? String(attrs.strokeWidth) : '2';
    var cls = attrs.className ? ' class="' + String(attrs.className).replace(/"/g, '&quot;') + '"' : '';
    return '<svg' + cls +
      ' width="' + size + '"' +
      ' height="' + size + '"' +
      ' viewBox="0 0 24 24"' +
      ' fill="none"' +
      ' stroke="currentColor"' +
      ' stroke-width="' + sw + '"' +
      ' stroke-linecap="round"' +
      ' stroke-linejoin="round"' +
      ' aria-hidden="true">' +
      inner +
      '</svg>';
  };
})();
