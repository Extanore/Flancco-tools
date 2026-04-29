/*
 * Flancco Pipeline Components — shared engine voor Slot V (Onderhoud) en
 * Slot W (Flancco-werk) pipeline-paginas.
 *
 * Eén API met `mode`-parameter ('onderhoud' | 'flancco') zodat fase-logica,
 * tab-bar, aging-strip en card-rendering door beide hostpagina's hergebruikt
 * kan worden.
 *
 * Vanilla JS, geen build-tooling. Laad via:
 *   <link rel="stylesheet" href="/admin/shared/pipeline-components.css">
 *   <script src="/admin/shared/pipeline-components.js"></script>
 *
 * Slot-placeholders (data-slot="...") worden later gevuld door
 * pipeline-toolkit.js — deze module rendert enkel de container-elementen.
 *
 * Zie API-doc onderaan dit bestand of in admin/shared/pipeline-components-demo.html.
 */
(function (global) {
  'use strict';

  // ------ Constants ----------------------------------------------------------

  var INSTANCE_COUNTER = 0;
  var SEARCH_DEBOUNCE_MS = 150;
  var MOBILE_BREAKPOINT = 768;
  var MS_PER_HOUR = 60 * 60 * 1000;
  var MS_PER_DAY = 24 * MS_PER_HOUR;

  /** Fase-keys in display-order (afgewerkt zit niet in pipeline). */
  var FASE_KEYS = ['in_te_plannen', 'ingepland', 'uitgevoerd', 'rapportage', 'uitgestuurd_facturatie'];

  /** Default labels per fase (mode-aware overrides hieronder). */
  var FASE_LABELS = {
    onderhoud: {
      in_te_plannen:           'In te plannen',
      ingepland:               'Ingepland',
      uitgevoerd:              'Uitgevoerd',
      rapportage:              'Rapportage',
      uitgestuurd_facturatie:  'Uitgestuurd facturatie'
    },
    flancco: {
      in_te_plannen:           'In te plannen',
      ingepland:               'In uitvoering',
      uitgevoerd:              'Uitgevoerd',
      rapportage:              'Rapportage',
      uitgestuurd_facturatie:  'Uitgestuurd facturatie'
    }
  };

  /** Aging buckets met thresholds in dagen + visuele kleur. */
  var AGING_BUCKETS = [
    { key: '<7d',    minD: 0,  maxD: 7,         label: '< 7 dagen',  color: 'green'  },
    { key: '7-14d',  minD: 7,  maxD: 14,        label: '7 – 14 dagen',  color: 'yellow' },
    { key: '14-30d', minD: 14, maxD: 30,        label: '14 – 30 dagen', color: 'orange' },
    { key: '>30d',   minD: 30, maxD: Infinity,  label: '> 30 dagen',    color: 'red'    }
  ];

  /**
   * Prefilter-mapping voor de "Pipeline-status vandaag" dashboard-tegel.
   * Mapping van bucket-key → (a) optionele auto-fase, (b) predicate, (c) label.
   * Caller (admin/index.html) leest typically uit `localStorage.flancco_pipeline_prefilter`
   * en geeft door via `attachPage(wrapperEl, { initialBucketFilter: 'sla_breach' })`.
   */
  var PREFILTER_KEYS = ['sla_breach', 'overdue', 'vandaag_plan', 'vandaag_uitvoering', 'wacht_rapport'];

  var PREFILTER_TO_FASE = {
    sla_breach:          null,                 // geen specifieke fase, filter cross-fase
    overdue:             'in_te_plannen',
    vandaag_plan:        'ingepland',
    vandaag_uitvoering:  'uitgevoerd',
    wacht_rapport:       'rapportage'
  };

  var PREFILTER_LABEL = {
    sla_breach:          'SLA-breach',
    overdue:             'Overdue (in te plannen >7d)',
    vandaag_plan:        'Vandaag plan-datum',
    vandaag_uitvoering:  'Vandaag uitvoering',
    wacht_rapport:       'Wacht op rapport'
  };

  /**
   * Predicate-functies per prefilter-key. Krijgen `(record, ctx)` waarbij
   * ctx.partnerSlaMap een Map<partner_id, slaConfig> is en ctx.todayIso de
   * iso-datum van vandaag (YYYY-MM-DD) — eenmaal pre-computed per render.
   */
  var PREFILTER_PREDICATE = {
    sla_breach: function (record, ctx) {
      if (!record) return false;
      var slaMap = ctx && ctx.partnerSlaMap;
      if (!slaMap || typeof slaMap.get !== 'function') return false;
      var pid = record.partner_id || (record.contract && record.contract.partner_id);
      if (!pid) return false;
      var partnerSla = slaMap.get(pid);
      if (!partnerSla) return false;
      var sla = computeSlaBreach(record, partnerSla);
      return !!(sla && sla.isBreach);
    },
    overdue: function (record, ctx) {
      if (!record || record._fase !== 'in_te_plannen') return false;
      var aging = (record._aging) ? record._aging : computeAging(record);
      return aging.agingDagen > 7;
    },
    vandaag_plan: function (record, ctx) {
      if (!record || record._fase !== 'ingepland') return false;
      return safeIsoDate(record.plan_datum) === ctx.todayIso;
    },
    vandaag_uitvoering: function (record, ctx) {
      if (!record || record._fase !== 'uitgevoerd') return false;
      return safeIsoDate(record.plan_datum) === ctx.todayIso;
    },
    wacht_rapport: function (record) {
      return !!(record && record._fase === 'rapportage');
    }
  };

  // ------ Utilities ----------------------------------------------------------

  /**
   * Coerce een Date / ISO-string / 'YYYY-MM-DD' naar een 'YYYY-MM-DD' string.
   * Returnt '' indien niet parseerbaar. Local-tz om consistent te zijn met
   * `plan_datum`-velden die als DATE in PG zonder tijd worden opgeslagen.
   */
  function safeIsoDate(value) {
    if (!value) return '';
    if (typeof value === 'string') {
      // Snelle check: 'YYYY-MM-DD' prefix.
      if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
    }
    var d = (value instanceof Date) ? value : new Date(value);
    if (isNaN(d.getTime())) return '';
    var yyyy = d.getFullYear();
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    return yyyy + '-' + mm + '-' + dd;
  }

  /** Defensive string coercion. */
  function safeStr(v) {
    if (v == null) return '';
    return String(v);
  }

  /** Trim helper that handles non-strings. */
  function safeTrim(v) {
    return safeStr(v).trim();
  }

  /**
   * Normalise a string for accent/case-insensitive search comparison.
   * NFD-decompose then strip combining diacritics, then lowercase.
   */
  function normalize(str) {
    if (str == null) return '';
    return String(str)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase();
  }

  /**
   * Set `el`'s text content to `value`, defensive against null/undefined.
   * Always uses textContent — never innerHTML — to prevent XSS.
   */
  function setText(el, value) {
    el.textContent = safeStr(value);
  }

  /**
   * Append an element with the given tag, classNames and text. Returns the
   * element for further chaining.
   */
  function makeEl(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = String(text);
    return el;
  }

  /** Format a Date or ISO-string as `dd/mm/yyyy`. */
  function formatDateNL(value) {
    if (!value) return '';
    var d = (value instanceof Date) ? value : new Date(value);
    if (isNaN(d.getTime())) return '';
    var dd = String(d.getDate()).padStart(2, '0');
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var yyyy = d.getFullYear();
    return dd + '/' + mm + '/' + yyyy;
  }

  /** Format duration in hours (number) as e.g. "2u 30min" or "3u". */
  function formatDurationHours(hours) {
    if (hours == null || isNaN(hours)) return '';
    var h = Math.floor(hours);
    var m = Math.round((hours - h) * 60);
    if (m === 60) { h += 1; m = 0; }
    if (h === 0 && m === 0) return '';
    if (m === 0) return h + 'u';
    if (h === 0) return m + 'min';
    return h + 'u ' + String(m).padStart(2, '0') + 'min';
  }

  /** Compose a Google Maps URL for an address-string. */
  function googleMapsUrl(addressParts) {
    var parts = [];
    if (Array.isArray(addressParts)) {
      for (var i = 0; i < addressParts.length; i++) {
        var p = safeTrim(addressParts[i]);
        if (p) parts.push(p);
      }
    } else if (addressParts) {
      var s = safeTrim(addressParts);
      if (s) parts.push(s);
    }
    if (!parts.length) return null;
    var q = encodeURIComponent(parts.join(', '));
    return 'https://www.google.com/maps/search/?api=1&query=' + q;
  }

  /** Sanitise a phone number for tel:-link (digits + leading +). */
  function telHref(raw) {
    var s = safeStr(raw).replace(/[^0-9+]/g, '');
    if (!s) return null;
    return 'tel:' + s;
  }

  /** Sanitise an email string for mailto:-link. */
  function mailtoHref(raw) {
    var s = safeTrim(raw);
    if (!s || s.indexOf('@') === -1) return null;
    return 'mailto:' + encodeURIComponent(s).replace(/%40/gi, '@');
  }

  // ------ Lucide-style inline SVG icons --------------------------------------

  function buildSvg(viewBox, paths, extraClass) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'flp-icon' + (extraClass ? ' ' + extraClass : ''));
    svg.setAttribute('width',  '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', viewBox || '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < paths.length; i++) {
      var spec = paths[i];
      var el = document.createElementNS('http://www.w3.org/2000/svg', spec[0]);
      var attrs = spec[1];
      for (var k in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, k)) el.setAttribute(k, attrs[k]);
      }
      svg.appendChild(el);
    }
    return svg;
  }

  function iconPhone()    { return buildSvg('0 0 24 24', [['path', { d: 'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92Z' }]]); }
  function iconMail()     { return buildSvg('0 0 24 24', [['rect', { x: '2', y: '4', width: '20', height: '16', rx: '2' }], ['polyline', { points: '22,6 12,13 2,6' }]]); }
  function iconMapPin()   { return buildSvg('0 0 24 24', [['path', { d: 'M20 10c0 7-8 13-8 13s-8-6-8-13a8 8 0 0 1 16 0Z' }], ['circle', { cx: '12', cy: '10', r: '3' }]]); }
  function iconCalendar() { return buildSvg('0 0 24 24', [['rect', { x: '3', y: '4', width: '18', height: '18', rx: '2' }], ['line', { x1: '16', y1: '2', x2: '16', y2: '6' }], ['line', { x1: '8', y1: '2', x2: '8', y2: '6' }], ['line', { x1: '3', y1: '10', x2: '21', y2: '10' }]]); }
  function iconClock()    { return buildSvg('0 0 24 24', [['circle', { cx: '12', cy: '12', r: '10' }], ['polyline', { points: '12,6 12,12 16,14' }]]); }
  function iconUser()     { return buildSvg('0 0 24 24', [['path', { d: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2' }], ['circle', { cx: '12', cy: '7', r: '4' }]]); }
  function iconWrench()   { return buildSvg('0 0 24 24', [['path', { d: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z' }]]); }
  function iconCheck()    { return buildSvg('0 0 24 24', [['polyline', { points: '20,6 9,17 4,12' }]]); }
  function iconX()        { return buildSvg('0 0 24 24', [['line', { x1: '18', y1: '6', x2: '6', y2: '18' }], ['line', { x1: '6', y1: '6', x2: '18', y2: '18' }]]); }
  function iconAlert()    { return buildSvg('0 0 24 24', [['circle', { cx: '12', cy: '12', r: '10' }], ['line', { x1: '12', y1: '8', x2: '12', y2: '12' }], ['line', { x1: '12', y1: '16', x2: '12.01', y2: '16' }]]); }
  function iconSearch()   { return buildSvg('0 0 24 24', [['circle', { cx: '11', cy: '11', r: '8' }], ['line', { x1: '21', y1: '21', x2: '16.65', y2: '16.65' }]]); }
  function iconSparkles() { return buildSvg('0 0 24 24', [['path', { d: 'M12 3l1.9 5.8L20 11l-5.8 1.9L12 19l-1.9-5.8L4 11l5.8-1.9L12 3Z' }]]); }

  // ------ Fase-engine --------------------------------------------------------

  /**
   * Compute which pipeline fase a record belongs to.
   *
   * Verwacht een denormalised record met:
   *   record.id, record.status, record.snooze_tot, record.contract,
   *   record.rapport (optioneel; truthy = rapport-rij bestaat),
   *   record.beurt_uren (optioneel array {goedgekeurd_op, ...}),
   *   record.gefactureerd (boolean), record.last_status_change_at, record.created_at.
   *
   * @param {Object} record
   * @param {string} [mode='onderhoud']
   * @returns {string|null} Fase-key of null als record niet zichtbaar in pipeline.
   */
  function computeFase(record, mode) {
    if (!record || typeof record !== 'object') return null;
    mode = mode || 'onderhoud';

    var status = safeStr(record.status).toLowerCase();
    if (status === 'afgewerkt') return 'afgewerkt';
    if (status === 'geannuleerd') return null;

    // Mode=onderhoud filtert eenmalige contracten weg (recurrent only).
    if (mode === 'onderhoud') {
      var contract = record.contract || {};
      if (contract && contract.is_eenmalig === true) return null;
    }

    if (status === 'in_te_plannen') {
      // Snoozed records vallen tijdelijk uit de fase.
      var snooze = record.snooze_tot;
      if (snooze) {
        var snoozeDate = (snooze instanceof Date) ? snooze : new Date(snooze);
        if (!isNaN(snoozeDate.getTime())) {
          var todayMs = startOfDayMs(new Date());
          if (snoozeDate.getTime() > todayMs) return null;
        }
      }
      return 'in_te_plannen';
    }

    if (status === 'ingepland') return 'ingepland';

    if (status === 'uitgevoerd' || status === 'in_uitvoering') {
      var hasRapport = !!record.rapport;
      var urenList = Array.isArray(record.beurt_uren) ? record.beurt_uren : [];
      var allApproved = urenList.length > 0 && urenList.every(function (u) { return !!(u && u.goedgekeurd_op); });
      var anyUnapproved = urenList.length > 0 && !allApproved;
      var gefactureerd = !!record.gefactureerd;

      if (allApproved && !gefactureerd) return 'uitgestuurd_facturatie';
      if (hasRapport && (status === 'uitgevoerd' || status === 'afgewerkt') && anyUnapproved) return 'rapportage';
      if (hasRapport) return 'rapportage';
      return 'uitgevoerd';
    }

    return null;
  }

  /** Local-time start-of-day in ms (avoids TZ drift on aging math). */
  function startOfDayMs(d) {
    var x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
    return x.getTime();
  }

  /**
   * Compute aging-bucket for a record. Counts hours/days since
   * `last_status_change_at` (fallback: `created_at`).
   *
   * @returns {{bucket, label, color, isBreach, agingDagen, agingUren}}
   */
  function computeAging(record, slaUren) {
    if (!record || typeof record !== 'object') {
      return { bucket: '<7d', label: '0d in fase', color: 'green', isBreach: false, agingDagen: 0, agingUren: 0 };
    }
    var ref = record.last_status_change_at || record.created_at;
    var refDate = ref ? ((ref instanceof Date) ? ref : new Date(ref)) : null;
    if (!refDate || isNaN(refDate.getTime())) {
      return { bucket: '<7d', label: '0d in fase', color: 'green', isBreach: false, agingDagen: 0, agingUren: 0 };
    }
    var nowMs = Date.now();
    var diffMs = Math.max(0, nowMs - refDate.getTime());
    var agingUren = diffMs / MS_PER_HOUR;
    var agingDagen = Math.floor(diffMs / MS_PER_DAY);

    var bucket = '<7d';
    var color = 'green';
    for (var i = 0; i < AGING_BUCKETS.length; i++) {
      var b = AGING_BUCKETS[i];
      if (agingDagen >= b.minD && agingDagen < b.maxD) {
        bucket = b.key;
        color = b.color;
        break;
      }
    }

    var isBreach = (typeof slaUren === 'number' && slaUren > 0 && agingUren > slaUren);
    var label = agingDagen + 'd in fase';

    return { bucket: bucket, label: label, color: color, isBreach: isBreach, agingDagen: agingDagen, agingUren: agingUren };
  }

  /**
   * Compute SLA breach status given partner SLA-config.
   *
   * @param {Object} record
   * @param {Object} partnerSlaConfig {sla_fase_1_uren, sla_fase_2_uren, sla_fase_4_uren, sla_fase_5_uren}
   * @returns {{isBreach, breachUren, slaUrenLimit}}
   */
  function computeSlaBreach(record, partnerSlaConfig) {
    var fase = record && record._fase ? record._fase : null;
    if (!fase) {
      return { isBreach: false, breachUren: 0, slaUrenLimit: 0 };
    }
    var key;
    switch (fase) {
      case 'in_te_plannen':          key = 'sla_fase_1_uren'; break;
      case 'ingepland':              key = 'sla_fase_2_uren'; break;
      case 'rapportage':             key = 'sla_fase_4_uren'; break;
      case 'uitgestuurd_facturatie': key = 'sla_fase_5_uren'; break;
      default: key = null;
    }
    if (!key || !partnerSlaConfig || partnerSlaConfig[key] == null) {
      return { isBreach: false, breachUren: 0, slaUrenLimit: 0 };
    }
    var limit = Number(partnerSlaConfig[key]);
    if (!isFinite(limit) || limit <= 0) {
      return { isBreach: false, breachUren: 0, slaUrenLimit: 0 };
    }
    var aging = computeAging(record, limit);
    return {
      isBreach: aging.isBreach,
      breachUren: aging.isBreach ? Math.floor(aging.agingUren - limit) : 0,
      slaUrenLimit: limit
    };
  }

  // ------ Slot placeholders (data-slot) --------------------------------------

  /** Add a `data-slot=...` placeholder for pipeline-toolkit.js to fill later. */
  function appendSlot(parent, slotName, dataAttrs, tag) {
    var el = document.createElement(tag || 'div');
    el.setAttribute('data-slot', slotName);
    if (dataAttrs && typeof dataAttrs === 'object') {
      for (var k in dataAttrs) {
        if (!Object.prototype.hasOwnProperty.call(dataAttrs, k)) continue;
        var v = dataAttrs[k];
        if (v == null) continue;
        el.setAttribute('data-' + k, String(v));
      }
    }
    el.classList.add('flp-slot');
    el.classList.add('flp-slot--' + slotName);
    parent.appendChild(el);
    return el;
  }

  // ------ Aging-badge --------------------------------------------------------

  function renderAgingBadge(parent, aging, slaResult) {
    var badge = makeEl('span', 'flp-aging-badge flp-aging-badge--' + aging.color);
    if (slaResult && slaResult.isBreach) {
      badge.classList.add('flp-aging-badge--breach');
      badge.classList.add('flp-aging-badge--red');
      badge.classList.remove('flp-aging-badge--' + aging.color);
      badge.appendChild(iconAlert());
      var lblBreach = makeEl('span', 'flp-aging-badge__label', 'SLA-breach · ' + aging.agingDagen + 'd');
      badge.appendChild(lblBreach);
      badge.setAttribute('aria-label', 'SLA-overschrijding, ' + aging.agingDagen + ' dagen in deze fase');
    } else {
      badge.appendChild(iconClock());
      var lbl = makeEl('span', 'flp-aging-badge__label', aging.label);
      badge.appendChild(lbl);
      badge.setAttribute('aria-label', aging.label);
    }
    parent.appendChild(badge);
    return badge;
  }

  // ------ Tab-bar ------------------------------------------------------------

  /**
   * Render a tab-bar inside `container`. Replaces existing children.
   *
   * @param {HTMLElement} container
   * @param {Object} opts
   *   tabs:       Array of {key, label, color, faseClass?}
   *   activeKey:  string
   *   counts:     Object {key → number}
   *   onChange:   (newKey) => void
   */
  function renderTabBar(container, opts) {
    if (!container) return;
    while (container.firstChild) container.removeChild(container.firstChild);
    container.classList.add('flp-tab-bar');
    container.setAttribute('role', 'tablist');
    var tabs = (opts && Array.isArray(opts.tabs)) ? opts.tabs : [];
    var activeKey = opts ? opts.activeKey : null;
    var counts = (opts && opts.counts) ? opts.counts : {};
    var onChange = (opts && typeof opts.onChange === 'function') ? opts.onChange : null;

    for (var i = 0; i < tabs.length; i++) {
      (function (tab, idx) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'flp-tab';
        if (tab.faseClass) btn.classList.add(tab.faseClass);
        if (tab.key === activeKey) btn.classList.add('flp-tab--active');
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-selected', tab.key === activeKey ? 'true' : 'false');
        btn.setAttribute('data-tab-key', tab.key);
        btn.tabIndex = (tab.key === activeKey) ? 0 : -1;

        var dot = makeEl('span', 'flp-tab__color');
        if (tab.color) dot.style.background = tab.color;
        btn.appendChild(dot);

        var lbl = makeEl('span', 'flp-tab__label', tab.label || '');
        btn.appendChild(lbl);

        var c = counts[tab.key];
        if (c == null) c = 0;
        var badge = makeEl('span', 'flp-tab__count', String(c));
        if (c === 0) badge.classList.add('flp-tab__count--empty');
        btn.appendChild(badge);

        btn.addEventListener('click', function () {
          if (onChange) {
            try { onChange(tab.key); } catch (e) { /* swallow */ }
          }
        });

        container.appendChild(btn);
      })(tabs[i], i);
    }
  }

  // ------ Aging-strip --------------------------------------------------------

  /**
   * Render aging-bucket strip with counts. Toggle-pattern: clicking active
   * bucket clears the filter.
   *
   * @param {HTMLElement} container
   * @param {Object} opts
   *   records:     Array of records (with _aging precomputed OR records[i].last_status_change_at)
   *   slaConfig:   partner SLA-config (for breach-counts; optional)
   *   activeBucket: string|null
   *   onBucketFilter: (bucketKey|null) => void
   */
  function renderAgingStrip(container, opts) {
    if (!container) return;
    while (container.firstChild) container.removeChild(container.firstChild);
    container.classList.add('flp-aging-strip');
    container.setAttribute('role', 'group');
    container.setAttribute('aria-label', 'Filter op aging-bucket');

    var records = (opts && Array.isArray(opts.records)) ? opts.records : [];
    var activeBucket = opts ? opts.activeBucket : null;
    var onBucketFilter = (opts && typeof opts.onBucketFilter === 'function') ? opts.onBucketFilter : null;
    var slaConfig = opts ? opts.slaConfig : null;

    // Tally per-bucket.
    var counts = {};
    var breachCount = 0;
    for (var i = 0; i < AGING_BUCKETS.length; i++) counts[AGING_BUCKETS[i].key] = 0;

    for (var j = 0; j < records.length; j++) {
      var r = records[j];
      var aging = r && r._aging ? r._aging : computeAging(r);
      if (counts[aging.bucket] != null) counts[aging.bucket]++;
      if (slaConfig) {
        var sla = computeSlaBreach(r, slaConfig);
        if (sla.isBreach) breachCount++;
      }
    }

    for (var k = 0; k < AGING_BUCKETS.length; k++) {
      (function (bucket) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'flp-aging-bucket flp-aging-bucket--' + bucket.color;
        if (activeBucket === bucket.key) btn.classList.add('flp-aging-bucket--active');
        btn.setAttribute('aria-pressed', activeBucket === bucket.key ? 'true' : 'false');
        btn.setAttribute('data-bucket-key', bucket.key);

        var dot = makeEl('span', 'flp-aging-bucket__dot');
        btn.appendChild(dot);
        btn.appendChild(makeEl('span', 'flp-aging-bucket__label', bucket.label));
        btn.appendChild(makeEl('span', 'flp-aging-bucket__count', String(counts[bucket.key])));

        btn.addEventListener('click', function () {
          if (!onBucketFilter) return;
          var next = (activeBucket === bucket.key) ? null : bucket.key;
          try { onBucketFilter(next); } catch (e) { /* swallow */ }
        });

        container.appendChild(btn);
      })(AGING_BUCKETS[k]);
    }

    if (breachCount > 0) {
      var info = makeEl('span', 'flp-aging-strip__breach', breachCount + ' SLA-breach');
      info.appendChild(iconAlert());
      // Reorder so icon appears first.
      info.insertBefore(iconAlert(), info.firstChild);
      container.appendChild(info);
    }
  }

  // ------ Card-rendering -----------------------------------------------------

  function renderCommonHeader(card, record) {
    var header = makeEl('div', 'flp-card__header');

    var topRow = makeEl('div', 'flp-card__top-row');

    var aging = record._aging || computeAging(record);
    var slaResult = record._slaResult || { isBreach: false };
    renderAgingBadge(topRow, aging, slaResult);

    var refWrap = makeEl('div', 'flp-card__ref-wrap');
    var ref = makeEl('span', 'flp-card__ref');
    ref.textContent = '#' + safeStr(record.referentie || record.ref_nummer || record.id || '').slice(0, 12);
    refWrap.appendChild(ref);
    topRow.appendChild(refWrap);

    header.appendChild(topRow);

    var klant = makeEl('h3', 'flp-card__klant');
    klant.textContent = safeStr(record.klant_naam || record.klant_label || (record.contract && record.contract.klant_naam) || 'Onbekende klant');
    header.appendChild(klant);

    card.appendChild(header);
  }

  function renderClientContextSlot(card, record) {
    appendSlot(card, 'klant-context', {
      'client-id':         record.client_id || '',
      'client-contact-id': record.client_contact_id || '',
      'beurt-id':          record.id || ''
    });
  }

  function renderContactRow(card, record) {
    var row = makeEl('div', 'flp-card__contact-row');

    var phoneRaw = record.klant_telefoon || (record.contract && record.contract.klant_telefoon);
    var emailRaw = record.klant_email || (record.contract && record.contract.klant_email);

    var addrParts = [
      record.klant_adres || (record.contract && record.contract.klant_adres),
      [
        record.klant_postcode || (record.contract && record.contract.klant_postcode),
        record.klant_gemeente || (record.contract && record.contract.klant_gemeente)
      ].filter(Boolean).join(' ')
    ].filter(Boolean);

    var telH = telHref(phoneRaw);
    if (telH) {
      var aPhone = document.createElement('a');
      aPhone.href = telH;
      aPhone.className = 'flp-card__contact-link flp-card__contact-link--phone';
      aPhone.appendChild(iconPhone());
      aPhone.appendChild(makeEl('span', 'flp-card__contact-link-text', safeStr(phoneRaw)));
      aPhone.setAttribute('aria-label', 'Bel ' + safeStr(phoneRaw));
      row.appendChild(aPhone);
    }

    var mailH = mailtoHref(emailRaw);
    if (mailH) {
      var aMail = document.createElement('a');
      aMail.href = mailH;
      aMail.className = 'flp-card__contact-link flp-card__contact-link--mail';
      aMail.appendChild(iconMail());
      aMail.appendChild(makeEl('span', 'flp-card__contact-link-text', safeStr(emailRaw)));
      aMail.setAttribute('aria-label', 'Mail ' + safeStr(emailRaw));
      row.appendChild(aMail);
    }

    var mapsH = googleMapsUrl(addrParts);
    if (mapsH) {
      var aMap = document.createElement('a');
      aMap.href = mapsH;
      aMap.target = '_blank';
      aMap.rel = 'noopener noreferrer';
      aMap.className = 'flp-card__contact-link flp-card__contact-link--map';
      aMap.appendChild(iconMapPin());
      aMap.appendChild(makeEl('span', 'flp-card__contact-link-text', addrParts.join(', ')));
      aMap.setAttribute('aria-label', 'Toon op Google Maps');
      row.appendChild(aMap);
    }

    if (row.firstChild) card.appendChild(row);
  }

  function renderScopeRow(card, record) {
    var scope = makeEl('div', 'flp-card__scope');

    var sector = record.sector || (record.contract && record.contract.sector);
    if (sector) {
      var s = makeEl('span', 'flp-card__scope-item');
      s.appendChild(iconWrench());
      s.appendChild(makeEl('span', null, formatSector(sector)));
      scope.appendChild(s);
    }

    var panelen = record.aantal_panelen || (record.contract && record.contract.aantal_panelen);
    if (panelen) {
      var p = makeEl('span', 'flp-card__scope-item');
      p.appendChild(iconSparkles());
      p.appendChild(makeEl('span', null, panelen + ' panelen'));
      scope.appendChild(p);
    }

    var duurUren = record.geschatte_duur_uren || record.duur_uren;
    if (duurUren) {
      var d = makeEl('span', 'flp-card__scope-item');
      d.appendChild(iconClock());
      d.appendChild(makeEl('span', null, formatDurationHours(Number(duurUren))));
      scope.appendChild(d);
    }

    var laatst = record.laatst_uitgevoerd_op;
    if (laatst) {
      var l = makeEl('span', 'flp-card__scope-item');
      l.appendChild(iconCalendar());
      l.appendChild(makeEl('span', null, 'Laatst: ' + formatDateNL(laatst)));
      scope.appendChild(l);
    }

    if (scope.firstChild) card.appendChild(scope);
  }

  function formatSector(s) {
    var t = safeStr(s).toLowerCase();
    if (!t) return '';
    return t.charAt(0).toUpperCase() + t.slice(1).replace(/_/g, ' ');
  }

  function renderActivityLogSlot(card, record) {
    appendSlot(card, 'activity-log', {
      'beurt-id': record.id || '',
      'fase':     record._fase || ''
    });
  }

  function renderActionRow(card, buttons, record, mode, opts) {
    var row = makeEl('div', 'flp-card__actions');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Acties');

    for (var i = 0; i < buttons.length; i++) {
      (function (btnSpec) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'flp-action-btn flp-action-btn--' + (btnSpec.variant || 'secondary');
        btn.setAttribute('data-action', btnSpec.actionKey);
        if (btnSpec.icon) btn.appendChild(btnSpec.icon);
        btn.appendChild(makeEl('span', null, btnSpec.label || ''));

        // Adjacent runbook-tip slot — pipeline-toolkit fills it.
        var tipSlot = document.createElement('span');
        tipSlot.setAttribute('data-slot', 'runbook-tip');
        tipSlot.setAttribute('data-fase', record._fase || '');
        tipSlot.setAttribute('data-action', btnSpec.actionKey);
        tipSlot.setAttribute('data-beurt-id', record.id || '');
        tipSlot.className = 'flp-slot flp-slot--runbook-tip flp-runbook-tip';
        btn.appendChild(tipSlot);

        btn.addEventListener('click', function (e) {
          e.preventDefault();
          if (opts && typeof opts.onAction === 'function') {
            try { opts.onAction(btnSpec.actionKey, record, btn); } catch (err) { /* swallow */ }
          }
        });

        row.appendChild(btn);
      })(buttons[i]);
    }

    card.appendChild(row);
  }

  /**
   * Render a dispatcher card (fase 1: In te plannen).
   */
  function renderDispatcherCard(record, mode, opts) {
    var card = makeEl('div', 'flp-card flp-card--dispatcher');
    card.setAttribute('role', 'article');
    card.setAttribute('data-record-id', safeStr(record.id || ''));
    card.setAttribute('data-fase', 'in_te_plannen');

    renderCommonHeader(card, record);
    renderClientContextSlot(card, record);
    renderContactRow(card, record);
    renderScopeRow(card, record);
    renderActivityLogSlot(card, record);

    var buttons = [
      { actionKey: 'plan_in',  label: 'Plan in',   variant: 'primary',   icon: iconCalendar() },
      { actionKey: 'snooze',   label: 'Snooze',    variant: 'secondary', icon: iconClock()    },
      { actionKey: 'annuleer', label: 'Annuleer',  variant: 'danger',    icon: iconX()        }
    ];
    renderActionRow(card, buttons, record, mode, opts);

    return card;
  }

  /**
   * Render a schedule card (fase 2: Ingepland / In uitvoering).
   */
  function renderScheduleCard(record, mode, opts) {
    var card = makeEl('div', 'flp-card flp-card--schedule');
    card.setAttribute('role', 'article');
    card.setAttribute('data-record-id', safeStr(record.id || ''));
    card.setAttribute('data-fase', 'ingepland');

    renderCommonHeader(card, record);
    renderClientContextSlot(card, record);

    // Schedule-specific row: datum + technieker.
    var schedRow = makeEl('div', 'flp-card__sched-row');

    var planDatum = record.plan_datum || record.geplande_datum;
    if (planDatum) {
      var dEl = makeEl('span', 'flp-card__scope-item flp-card__scope-item--strong');
      dEl.appendChild(iconCalendar());
      dEl.appendChild(makeEl('span', null, formatDateNL(planDatum)));
      schedRow.appendChild(dEl);
    }
    var techNaam = record.technieker_naam || (record.technieker && record.technieker.naam);
    if (techNaam) {
      var tEl = makeEl('span', 'flp-card__scope-item');
      tEl.appendChild(iconUser());
      tEl.appendChild(makeEl('span', null, techNaam));
      schedRow.appendChild(tEl);
    }
    var duurUren = record.geschatte_duur_uren || record.duur_uren;
    if (duurUren) {
      var duEl = makeEl('span', 'flp-card__scope-item');
      duEl.appendChild(iconClock());
      duEl.appendChild(makeEl('span', null, formatDurationHours(Number(duurUren))));
      schedRow.appendChild(duEl);
    }
    if (schedRow.firstChild) card.appendChild(schedRow);

    // Reminder-status indicator.
    renderReminderStatus(card, record);

    // Address row (with map link).
    renderContactRow(card, record);
    renderActivityLogSlot(card, record);

    var buttons = [
      { actionKey: 'verplaats',     label: 'Verplaats',         variant: 'primary',   icon: iconCalendar() },
      { actionKey: 'bel_klant',     label: 'Bel klant',         variant: 'secondary', icon: iconPhone()    },
      { actionKey: 'terug_fase_1',  label: 'Terug naar plannen', variant: 'secondary', icon: iconX()        }
    ];
    renderActionRow(card, buttons, record, mode, opts);

    return card;
  }

  function renderReminderStatus(card, record) {
    var planDatum = record.plan_datum || record.geplande_datum;
    if (!planDatum) return;
    var planDate = (planDatum instanceof Date) ? planDatum : new Date(planDatum);
    if (isNaN(planDate.getTime())) return;

    var hoursUntil = (planDate.getTime() - Date.now()) / MS_PER_HOUR;
    var reminderSent = !!(record.reminder_24h_email_ts || record.reminder_24h_sms_ts || record.reminder_24h_whatsapp_ts);

    var indicator = makeEl('div', 'flp-card__reminder');
    if (reminderSent) {
      indicator.classList.add('flp-card__reminder--ok');
      indicator.appendChild(iconCheck());
      indicator.appendChild(makeEl('span', null, 'Herinnering verzonden'));
    } else if (hoursUntil > 0 && hoursUntil < 48) {
      indicator.classList.add('flp-card__reminder--warn');
      indicator.appendChild(iconAlert());
      indicator.appendChild(makeEl('span', null, 'Geen herinnering, < 48u'));
    } else {
      return; // niet zinvol om te tonen
    }
    card.appendChild(indicator);
  }

  /**
   * Render an action card for fases 3, 4, 5.
   */
  function renderActionCard(record, fase, mode, opts) {
    var card = makeEl('div', 'flp-card flp-card--action');
    card.classList.add('flp-card--' + fase);
    card.setAttribute('role', 'article');
    card.setAttribute('data-record-id', safeStr(record.id || ''));
    card.setAttribute('data-fase', fase);

    renderCommonHeader(card, record);
    renderClientContextSlot(card, record);
    renderScopeRow(card, record);
    renderActivityLogSlot(card, record);

    var buttons = [];
    if (fase === 'uitgevoerd') {
      buttons.push({ actionKey: 'markeer_uitgevoerd', label: 'Markeer uitgevoerd', variant: 'primary',  icon: iconCheck() });
      buttons.push({ actionKey: 'bewerk_uren',         label: 'Bewerk uren',        variant: 'secondary', icon: iconClock() });
    } else if (fase === 'rapportage') {
      buttons.push({ actionKey: 'maak_rapport', label: 'Maak rapport', variant: 'primary', icon: iconWrench() });
      if (mode === 'flancco') {
        buttons.push({ actionKey: 'skip_naar_facturatie', label: 'Direct naar facturatie', variant: 'secondary', icon: iconCheck() });
      }
      buttons.push({ actionKey: 'bewerk_uren', label: 'Bewerk uren', variant: 'secondary', icon: iconClock() });
    } else if (fase === 'uitgestuurd_facturatie') {
      buttons.push({ actionKey: 'markeer_afgewerkt', label: 'Markeer afgewerkt', variant: 'primary', icon: iconCheck() });
      buttons.push({ actionKey: 'bekijk_factuur',     label: 'Bekijk factuur',    variant: 'secondary' });
    }
    renderActionRow(card, buttons, record, mode, opts);

    return card;
  }

  /**
   * Render an empty-state for a given fase.
   */
  function renderEmptyState(container, fase, mode) {
    if (!container) return;
    while (container.firstChild) container.removeChild(container.firstChild);
    var box = makeEl('div', 'flp-empty-state');
    var iconWrap = makeEl('div', 'flp-empty-state__icon');
    iconWrap.appendChild(iconCheck());
    box.appendChild(iconWrap);

    var label = (FASE_LABELS[mode] && FASE_LABELS[mode][fase]) || fase;
    var msgMap = {
      in_te_plannen:           'Alles ingepland! Geen records die nog gepland moeten worden.',
      ingepland:               'Geen records ingepland op dit moment.',
      uitgevoerd:              'Geen uitgevoerde records die nog actie nodig hebben.',
      rapportage:              'Geen rapporten in behandeling.',
      uitgestuurd_facturatie:  'Geen records in facturatie-fase.'
    };
    var p = makeEl('p', 'flp-empty-state__text', msgMap[fase] || ('Geen records in ' + label + '.'));
    box.appendChild(p);

    var hint = makeEl('p', 'flp-empty-state__hint');
    if (fase !== 'in_te_plannen') {
      hint.textContent = 'Bekijk fase 1 voor records die actie nodig hebben.';
    } else {
      hint.textContent = 'Records verschijnen automatisch wanneer ze gepland moeten worden.';
    }
    box.appendChild(hint);

    container.appendChild(box);
  }

  // ------ Page-level controller ----------------------------------------------

  function PipelinePage(wrapperEl, opts) {
    if (!wrapperEl || wrapperEl.nodeType !== 1) {
      throw new Error('FlanccoPipeline.attachPage: wrapperEl must be an Element');
    }
    opts = opts || {};
    this._wrapper = wrapperEl;
    this._uid = ++INSTANCE_COUNTER;
    this._mode = opts.mode === 'flancco' ? 'flancco' : 'onderhoud';
    this._supabase = opts.supabase || null;
    this._dataFilter = (typeof opts.dataFilter === 'function') ? opts.dataFilter : null;
    this._onAction = (typeof opts.onAction === 'function') ? opts.onAction : null;
    this._partnerSlaMap = (opts.partnerSlaMap instanceof Map) ? opts.partnerSlaMap : new Map();
    this._records = Array.isArray(opts.initialRecords) ? opts.initialRecords.slice() : [];
    this._activeFase = 'in_te_plannen';
    this._activeBucket = null;
    this._searchQuery = '';
    this._destroyed = false;
    this._searchDebounce = null;
    this._channel = null;

    // Slot V/W dashboard-tegel prefilter. Whitelist op PREFILTER_KEYS;
    // onbekende waarden worden silently genegeerd zodat caller nooit hoeft
    // te valideren (defensief — typisch komt input uit localStorage).
    var rawPrefilter = (opts.initialBucketFilter == null) ? null : String(opts.initialBucketFilter);
    this._prefilter = (rawPrefilter && PREFILTER_KEYS.indexOf(rawPrefilter) !== -1) ? rawPrefilter : null;

    // Activeer mapped fase indien prefilter een fase impliceert.
    if (this._prefilter) {
      var mappedFase = PREFILTER_TO_FASE[this._prefilter];
      if (mappedFase && FASE_KEYS.indexOf(mappedFase) !== -1) {
        this._activeFase = mappedFase;
      }
    }

    this._build();
    this._render();

    // Optional realtime subscription via Supabase.
    if (this._supabase && opts.realtimeTable) {
      this._setupRealtime(opts.realtimeTable);
    }

    // Keyboard shortcuts.
    this._onKeydownBound = this._handleKeydown.bind(this);
    document.addEventListener('keydown', this._onKeydownBound);
  }

  PipelinePage.prototype._build = function () {
    var w = this._wrapper;
    while (w.firstChild) w.removeChild(w.firstChild);
    w.classList.add('flp-page');

    // Hand-off banner slot — toolkit fills.
    var handoffSlot = document.createElement('div');
    handoffSlot.setAttribute('data-slot', 'handoff-banner');
    handoffSlot.className = 'flp-slot flp-slot--handoff-banner flp-handoff-banner-slot';
    w.appendChild(handoffSlot);

    // Prefilter-banner host. Hidden tot _render() bepaalt of er een prefilter actief is.
    var prefilterBanner = makeEl('div', 'flp-prefilter-banner');
    prefilterBanner.setAttribute('role', 'status');
    prefilterBanner.hidden = true;
    var prefilterLabel = makeEl('span', 'flp-prefilter-banner__label');
    var prefilterClear = document.createElement('button');
    prefilterClear.type = 'button';
    prefilterClear.className = 'flp-prefilter-banner__clear';
    prefilterClear.setAttribute('aria-label', 'Prefilter wissen');
    prefilterClear.textContent = '×';
    prefilterBanner.appendChild(prefilterLabel);
    prefilterBanner.appendChild(prefilterClear);
    w.appendChild(prefilterBanner);

    var toolbar = makeEl('div', 'flp-toolbar');

    var tabBar = makeEl('div', 'flp-tab-bar');
    toolbar.appendChild(tabBar);

    var filtersWrap = makeEl('div', 'flp-toolbar__filters');

    var searchWrap = makeEl('div', 'flp-toolbar__search');
    searchWrap.appendChild(iconSearch());
    var searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'flp-toolbar__search-input';
    searchInput.placeholder = 'Zoek op klant of referentie…';
    searchInput.setAttribute('autocomplete', 'off');
    searchInput.setAttribute('aria-label', 'Zoeken in pipeline');
    searchWrap.appendChild(searchInput);
    filtersWrap.appendChild(searchWrap);

    toolbar.appendChild(filtersWrap);

    var agingStrip = makeEl('div', 'flp-aging-strip');
    toolbar.appendChild(agingStrip);

    w.appendChild(toolbar);

    var body = makeEl('div', 'flp-page__body');
    var cardList = makeEl('div', 'flp-card-list');
    body.appendChild(cardList);
    w.appendChild(body);

    // Live region for SR-announcements.
    var live = makeEl('div', 'flp-sr-only');
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('aria-atomic', 'true');
    w.appendChild(live);

    this._tabBar = tabBar;
    this._agingStrip = agingStrip;
    this._cardList = cardList;
    this._searchInput = searchInput;
    this._live = live;
    this._prefilterBanner = prefilterBanner;
    this._prefilterLabel = prefilterLabel;
    this._prefilterClear = prefilterClear;

    var self = this;
    searchInput.addEventListener('input', function () {
      if (self._searchDebounce) clearTimeout(self._searchDebounce);
      self._searchDebounce = setTimeout(function () {
        self._searchQuery = safeTrim(searchInput.value);
        self._render();
      }, SEARCH_DEBOUNCE_MS);
    });

    prefilterClear.addEventListener('click', function () {
      self._setPrefilter(null);
    });
  };

  PipelinePage.prototype._buildTabs = function () {
    var labels = FASE_LABELS[this._mode] || FASE_LABELS.onderhoud;
    return [
      { key: 'in_te_plannen',          label: labels.in_te_plannen,          color: '#E74C3C', faseClass: 'flp-tab--fase1' },
      { key: 'ingepland',              label: labels.ingepland,              color: '#1A1A2E', faseClass: 'flp-tab--fase2' },
      { key: 'uitgevoerd',             label: labels.uitgevoerd,             color: '#F59E0B', faseClass: 'flp-tab--fase3' },
      { key: 'rapportage',             label: labels.rapportage,             color: '#8B5CF6', faseClass: 'flp-tab--fase4' },
      { key: 'uitgestuurd_facturatie', label: labels.uitgestuurd_facturatie, color: '#16A34A', faseClass: 'flp-tab--fase5' }
    ];
  };

  PipelinePage.prototype._enrichRecords = function () {
    var enriched = [];
    var mode = this._mode;
    var slaMap = this._partnerSlaMap;
    var filter = this._dataFilter;

    for (var i = 0; i < this._records.length; i++) {
      var r = this._records[i];
      if (!r) continue;
      if (filter) {
        try {
          if (!filter(r)) continue;
        } catch (e) { continue; }
      }
      var fase = computeFase(r, mode);
      if (!fase || fase === 'afgewerkt') continue;

      var partnerSla = null;
      var pid = r.partner_id || (r.contract && r.contract.partner_id);
      if (pid && slaMap && typeof slaMap.get === 'function') {
        partnerSla = slaMap.get(pid) || null;
      }
      var slaKey;
      switch (fase) {
        case 'in_te_plannen':          slaKey = 'sla_fase_1_uren'; break;
        case 'ingepland':              slaKey = 'sla_fase_2_uren'; break;
        case 'rapportage':             slaKey = 'sla_fase_4_uren'; break;
        case 'uitgestuurd_facturatie': slaKey = 'sla_fase_5_uren'; break;
        default: slaKey = null;
      }
      var slaUren = (partnerSla && slaKey && partnerSla[slaKey] != null) ? Number(partnerSla[slaKey]) : null;
      var aging = computeAging(r, slaUren);
      r._fase = fase;
      r._aging = aging;
      r._slaResult = computeSlaBreach(r, partnerSla || {});
      enriched.push(r);
    }
    return enriched;
  };

  PipelinePage.prototype._render = function () {
    if (this._destroyed) return;
    var enriched = this._enrichRecords();

    // Counts per fase.
    var counts = {};
    for (var k = 0; k < FASE_KEYS.length; k++) counts[FASE_KEYS[k]] = 0;
    for (var i = 0; i < enriched.length; i++) {
      var key = enriched[i]._fase;
      if (counts[key] != null) counts[key]++;
    }

    var self = this;
    renderTabBar(this._tabBar, {
      tabs: this._buildTabs(),
      activeKey: this._activeFase,
      counts: counts,
      onChange: function (key) { self._setActiveFase(key); }
    });

    // Pre-filter banner (Slot V/W dashboard-tegel pre-filter).
    this._renderPrefilterBanner();

    // Records voor actieve fase. Wanneer prefilter='sla_breach' is er geen
    // mapped fase — dan tonen we cross-fase en laten we de tab puur als
    // visuele context staan (gebruiker kan nog steeds tab wisselen).
    var faseRecords = enriched.filter(function (r) { return r._fase === self._activeFase; });

    renderAgingStrip(this._agingStrip, {
      records: faseRecords,
      slaConfig: null,
      activeBucket: this._activeBucket,
      onBucketFilter: function (bucket) { self._setBucketFilter(bucket); }
    });

    // Pre-compute prefilter ctx (todayIso + slaMap) — eenmaal per render.
    var prefilterCtx = null;
    var prefilterPredicate = null;
    if (this._prefilter) {
      prefilterCtx = {
        partnerSlaMap: this._partnerSlaMap,
        todayIso: safeIsoDate(new Date())
      };
      prefilterPredicate = PREFILTER_PREDICATE[this._prefilter] || null;
    }

    // sla_breach filtert cross-fase op de volledige enriched-set; de andere
    // prefilters mappen 1-op-1 op een fase, dus blijven binnen faseRecords.
    var basePool = (this._prefilter === 'sla_breach') ? enriched : faseRecords;

    // Apply prefilter + bucket filter + search.
    var displayed = basePool.filter(function (r) {
      if (prefilterPredicate) {
        try {
          if (!prefilterPredicate(r, prefilterCtx)) return false;
        } catch (e) { return false; }
      }
      if (self._activeBucket && r._aging && r._aging.bucket !== self._activeBucket) return false;
      if (self._searchQuery) {
        var hay = normalize([
          safeStr(r.klant_naam),
          safeStr(r.contract && r.contract.klant_naam),
          safeStr(r.referentie || r.id),
          safeStr(r.klant_email),
          safeStr(r.klant_gemeente)
        ].join(' '));
        if (hay.indexOf(normalize(self._searchQuery)) === -1) return false;
      }
      return true;
    });

    this._renderList(displayed);

    if (this._live) {
      var liveSuffix = this._prefilter ? ' (prefilter: ' + (PREFILTER_LABEL[this._prefilter] || this._prefilter) + ')' : '';
      this._live.textContent = displayed.length + ' record' + (displayed.length === 1 ? '' : 's') + ' in ' + this._activeFase + liveSuffix;
    }

    // Hand-off-mode visual cue.
    if (document.body && document.body.classList && document.body.classList.contains('handoff-mode')) {
      this._wrapper.classList.add('flp-page--handoff');
    } else {
      this._wrapper.classList.remove('flp-page--handoff');
    }
  };

  /** Toon/verberg prefilter-banner op basis van `this._prefilter`. */
  PipelinePage.prototype._renderPrefilterBanner = function () {
    var banner = this._prefilterBanner;
    var label = this._prefilterLabel;
    if (!banner || !label) return;
    if (!this._prefilter) {
      banner.hidden = true;
      banner.removeAttribute('data-prefilter');
      label.textContent = '';
      return;
    }
    var displayLabel = PREFILTER_LABEL[this._prefilter] || this._prefilter;
    banner.hidden = false;
    banner.setAttribute('data-prefilter', this._prefilter);
    label.textContent = 'Prefilter: ' + displayLabel;
  };

  PipelinePage.prototype._renderList = function (records) {
    var list = this._cardList;
    while (list.firstChild) list.removeChild(list.firstChild);

    if (!records.length) {
      renderEmptyState(list, this._activeFase, this._mode);
      return;
    }

    var fase = this._activeFase;
    var mode = this._mode;
    var actionOpts = { onAction: this._onAction };

    // Mobile-vs-desktop class on container — CSS handles layout-switch.
    if (window.innerWidth < MOBILE_BREAKPOINT) {
      list.classList.add('flp-card-list--mobile');
      list.classList.remove('flp-card-list--desktop');
    } else {
      list.classList.add('flp-card-list--desktop');
      list.classList.remove('flp-card-list--mobile');
    }

    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      var card;
      if (fase === 'in_te_plannen') card = renderDispatcherCard(r, mode, actionOpts);
      else if (fase === 'ingepland') card = renderScheduleCard(r, mode, actionOpts);
      else card = renderActionCard(r, fase, mode, actionOpts);
      list.appendChild(card);
    }
  };

  PipelinePage.prototype._setActiveFase = function (key) {
    if (FASE_KEYS.indexOf(key) === -1) return;
    if (this._activeFase === key) return;
    this._activeFase = key;
    this._activeBucket = null;
    // Wanneer er een fase-gebonden prefilter actief is en gebruiker switcht
    // weg van die fase, clear prefilter (cross-fase 'sla_breach' blijft staan).
    if (this._prefilter && this._prefilter !== 'sla_breach') {
      var mapped = PREFILTER_TO_FASE[this._prefilter];
      if (mapped && mapped !== key) {
        this._prefilter = null;
      }
    }
    this._render();
  };

  PipelinePage.prototype._setBucketFilter = function (bucket) {
    this._activeBucket = bucket;
    this._render();
  };

  /**
   * Mute prefilter-state. `null` clears.
   * Bij set: activeert mapped fase (indien aanwezig) zoals constructor doet.
   */
  PipelinePage.prototype._setPrefilter = function (key) {
    var next = (key && PREFILTER_KEYS.indexOf(String(key)) !== -1) ? String(key) : null;
    if (this._prefilter === next) return;
    this._prefilter = next;
    if (next) {
      var mappedFase = PREFILTER_TO_FASE[next];
      if (mappedFase && FASE_KEYS.indexOf(mappedFase) !== -1) {
        this._activeFase = mappedFase;
      }
    }
    // Clear bucket-filter zodat prefilter niet onverwacht door bucket wordt gemaskt.
    this._activeBucket = null;
    this._render();
  };

  PipelinePage.prototype._handleKeydown = function (e) {
    if (this._destroyed) return;
    // Ignore keystrokes inside inputs/textareas.
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
      // Allow `/` shortcut even from non-input — search input opens.
      if (e.key === '/' && !(t.tagName === 'INPUT' && t.type !== 'checkbox' && t.type !== 'radio')) {
        return;
      }
      return;
    }
    if (e.key === '/') {
      e.preventDefault();
      if (this._searchInput) this._searchInput.focus();
    } else if (e.key === 'j' || e.key === 'J') {
      e.preventDefault();
      this._cycleFase(+1);
    } else if (e.key === 'k' || e.key === 'K') {
      e.preventDefault();
      this._cycleFase(-1);
    } else if (e.key === 'Escape') {
      if (this._activeBucket) {
        this._setBucketFilter(null);
      }
    }
  };

  PipelinePage.prototype._cycleFase = function (delta) {
    var idx = FASE_KEYS.indexOf(this._activeFase);
    if (idx === -1) idx = 0;
    var next = (idx + delta + FASE_KEYS.length) % FASE_KEYS.length;
    this._setActiveFase(FASE_KEYS[next]);
  };

  PipelinePage.prototype._setupRealtime = function (tableName) {
    var self = this;
    try {
      this._channel = this._supabase
        .channel('flp-' + tableName + '-' + this._uid)
        .on('postgres_changes', { event: '*', schema: 'public', table: tableName }, function () {
          // Caller is expected to re-supply records via setRecords on event.
          self._render();
        })
        .subscribe();
    } catch (e) {
      // Realtime is optional; fail silently.
    }
  };

  // ------ Public methods (page) ----------------------------------------------

  PipelinePage.prototype.setRecords = function (records) {
    if (this._destroyed) return;
    this._records = Array.isArray(records) ? records.slice() : [];
    this._render();
  };

  PipelinePage.prototype.setActiveFase = function (key) {
    if (this._destroyed) return;
    this._setActiveFase(key);
  };

  PipelinePage.prototype.setBucketFilter = function (bucket) {
    if (this._destroyed) return;
    this._setBucketFilter(bucket);
  };

  /**
   * Set or clear de "Pipeline-status vandaag" prefilter post-mount.
   * @param {string|null} key Een van PREFILTER_KEYS, of null om te wissen.
   */
  PipelinePage.prototype.setPrefilter = function (key) {
    if (this._destroyed) return;
    this._setPrefilter(key);
  };

  PipelinePage.prototype.refresh = function () {
    if (this._destroyed) return;
    this._render();
  };

  PipelinePage.prototype.destroy = function () {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._searchDebounce) clearTimeout(this._searchDebounce);
    if (this._onKeydownBound) document.removeEventListener('keydown', this._onKeydownBound);
    if (this._channel && typeof this._channel.unsubscribe === 'function') {
      try { this._channel.unsubscribe(); } catch (e) { /* swallow */ }
    }
    var w = this._wrapper;
    if (w) {
      while (w.firstChild) w.removeChild(w.firstChild);
      w.classList.remove('flp-page', 'flp-page--handoff');
    }
    this._records = [];
    this._wrapper = null;
    this._tabBar = null;
    this._agingStrip = null;
    this._cardList = null;
    this._searchInput = null;
    this._live = null;
    this._prefilterBanner = null;
    this._prefilterLabel = null;
    this._prefilterClear = null;
    this._supabase = null;
    this._dataFilter = null;
    this._onAction = null;
    this._partnerSlaMap = null;
    this._channel = null;
  };

  // ------ Public API ---------------------------------------------------------

  global.FlanccoPipeline = {
    /** Compute fase-key for a single record. */
    computeFase: computeFase,
    /** Compute aging-bucket for a single record. */
    computeAging: computeAging,
    /** Compute SLA-breach status for a single record. */
    computeSlaBreach: computeSlaBreach,
    /**
     * Render top-level pipeline-page (returns instance).
     *
     * @param {HTMLElement} wrapperEl
     * @param {Object} opts
     * @param {('onderhoud'|'flancco')} [opts.mode]
     * @param {Object} [opts.supabase]                 Supabase client voor optionele realtime-subscribe.
     * @param {Function} [opts.dataFilter]             (record) => bool — caller-side filter.
     * @param {Function} [opts.onAction]               (actionKey, record, btnEl) => void.
     * @param {Map} [opts.partnerSlaMap]               Map<partner_id, {sla_fase_X_uren}>.
     * @param {Array} [opts.initialRecords]            Initiële record-set.
     * @param {string} [opts.realtimeTable]            Tabelnaam voor postgres_changes.
     * @param {('sla_breach'|'overdue'|'vandaag_plan'|'vandaag_uitvoering'|'wacht_rapport')} [opts.initialBucketFilter]
     *   Wanneer aanwezig: opent pipeline met die filter pre-applied + visuele banner met clear-knop.
     *   Caller leest typically uit `localStorage.flancco_pipeline_prefilter` en clear na consume.
     *   Mapping: 'overdue' → fase 'in_te_plannen' (>7d), 'vandaag_plan' → 'ingepland' op vandaag,
     *   'vandaag_uitvoering' → 'uitgevoerd' op vandaag, 'wacht_rapport' → 'rapportage'.
     *   'sla_breach' is cross-fase (geen auto-tab) en filtert obv `partnerSlaMap`.
     * @returns {Object} { setRecords, setActiveFase, setBucketFilter, setPrefilter, refresh, destroy }
     */
    attachPage: function (wrapperEl, opts) { return new PipelinePage(wrapperEl, opts); },
    /** Render a tab-bar standalone (e.g. for embedded views). */
    renderTabBar: renderTabBar,
    /** Render an aging-strip standalone. */
    renderAgingStrip: renderAgingStrip,
    /** Render a fase-1 card. */
    renderDispatcherCard: renderDispatcherCard,
    /** Render a fase-2 card. */
    renderScheduleCard: renderScheduleCard,
    /** Render a fase-3/4/5 card. */
    renderActionCard: renderActionCard,
    /** Render an empty-state for a fase. */
    renderEmptyState: renderEmptyState,
    /** Internal constants exposed for hosts that want to align tab-colors. */
    constants: {
      FASE_KEYS:    FASE_KEYS.slice(),
      FASE_LABELS:  JSON.parse(JSON.stringify(FASE_LABELS)),
      AGING_BUCKETS: AGING_BUCKETS.map(function (b) { return Object.assign({}, b); })
    }
  };

})(typeof window !== 'undefined' ? window : this);

/*
 * ====================================================================
 *  API SAMENVATTING
 * ====================================================================
 *
 *  FlanccoPipeline.computeFase(record, mode)        -> 'in_te_plannen'|...|'afgewerkt'|null
 *  FlanccoPipeline.computeAging(record, slaUren?)   -> {bucket, label, color, isBreach, agingDagen, agingUren}
 *  FlanccoPipeline.computeSlaBreach(record, slaCfg) -> {isBreach, breachUren, slaUrenLimit}
 *
 *  FlanccoPipeline.attachPage(wrapperEl, {
 *    mode:                'onderhoud' | 'flancco',
 *    supabase:            supabase-client (optional, voor realtime),
 *    dataFilter:          (record) => bool,
 *    onAction:            (actionKey, record, btnEl) => void,
 *    partnerSlaMap:       Map<partner_id, {sla_fase_1_uren, ...}>,
 *    initialRecords:      Array,
 *    realtimeTable:       string (optional, voor postgres_changes subscribe),
 *    initialBucketFilter: 'sla_breach'|'overdue'|'vandaag_plan'|'vandaag_uitvoering'|'wacht_rapport'
 *                         (optional — opent met dashboard-tegel pre-filter + banner)
 *  }) -> { setRecords, setActiveFase, setBucketFilter, setPrefilter, refresh, destroy }
 *
 *  FlanccoPipeline.renderTabBar(container, {tabs, activeKey, counts, onChange})
 *  FlanccoPipeline.renderAgingStrip(container, {records, slaConfig, activeBucket, onBucketFilter})
 *  FlanccoPipeline.renderDispatcherCard(record, mode, {onAction}) -> HTMLElement
 *  FlanccoPipeline.renderScheduleCard(record, mode, {onAction})   -> HTMLElement
 *  FlanccoPipeline.renderActionCard(record, fase, mode, {onAction}) -> HTMLElement
 *  FlanccoPipeline.renderEmptyState(container, fase, mode)
 *
 *  Slot-placeholders (data-slot="...") worden later gevuld door
 *  pipeline-toolkit.js. Beschikbaar:
 *      data-slot="handoff-banner"
 *      data-slot="klant-context"   (data-client-id, data-client-contact-id, data-beurt-id)
 *      data-slot="activity-log"    (data-beurt-id, data-fase)
 *      data-slot="runbook-tip"     (data-fase, data-action, data-beurt-id)
 *
 *  Keyboard shortcuts (binnen attachPage):
 *      J / K   tab-prev/next
 *      /       focus zoek
 *      Esc     clear bucket-filter
 *
 *  Multi-instance veilig (uniek uid per attach).
 *  Geen runtime dependencies; werkt met of zonder Supabase.
 * ====================================================================
 */
