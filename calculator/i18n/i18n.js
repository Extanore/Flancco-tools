/**
 * Flancco Calculator — i18n runtime (Slot S)
 * --------------------------------------------------------------
 * Lichte, dependency-vrije i18n-laag voor de publieke calculator.
 * Doel: eerste-bezoek taalkeuze automatisch correct (NL voor Vlaanderen,
 * FR voor Wallonië, taalkeuze-prompt voor Brussel) zonder zware framework.
 *
 * Detectie-volgorde (van hoog naar laag):
 *   1. Expliciete setLang() of URL-fragment "#lang=fr"
 *   2. Cookie 'flancco_lang' (1 jaar geldig)
 *   3. URL-prefix "/fr/" of query "?lang=fr"
 *   4. Postcode-derived (Wallonië auto-FR, Brussel auto-prompt) — via setLangFromPostcode()
 *   5. Browser navigator.language (eerste hit op nl|fr)
 *   6. Default 'nl'
 *
 * Translation-strategie:
 *   - data-i18n="key"            → vervangt textContent
 *   - data-i18n-html="key"       → vervangt innerHTML (gebruik enkel voor vertrouwde keys met HTML)
 *   - data-i18n-attr="placeholder:key1,title:key2" → zet meerdere attributes per element
 *   - Programmatisch: window.t('key', { partner: 'Novectra' }) → string met {placeholder} interpolation
 *
 * Brussel-prompt:
 *   Bij eerste bezoek met Brussel-postcode (1000-1299) toont de helper een
 *   modale taalkeuze. Keuze wordt gepersisteerd in cookie. Bij hergebruik
 *   geen prompt meer.
 *
 * Geen runtime-fetch, geen async load: vertalingen worden statisch ingebed
 * via window.__I18N_DATA__ in de HTML, of geladen via een eenvoudige
 * <script src=".json.js">. Houdt CSP-impact nul (geen connect-src nodig).
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'flancco_lang';
  var DEFAULT_LANG = 'nl';
  var SUPPORTED = ['nl', 'fr'];

  // Belgische postcode-zones voor taalkeuze.
  // Gemengd: 1000-1299 = Brussel (taalkeuze-prompt), elders auto.
  var POSTCODE_FR_RANGES = [
    [1300, 1499], // Waals-Brabant
    [4000, 4999], // Luik
    [5000, 5999], // Namen
    [6000, 6999], // Henegouwen + Luxemburg-NL-overlap
    [7000, 7999]  // Henegouwen-west
  ];
  var POSTCODE_BRUSSEL_RANGE = [1000, 1299];

  var listeners = [];
  var currentLang = null;
  var dictionaries = { nl: {}, fr: {} };

  // -------- helpers --------

  function getCookie(name) {
    try {
      var pairs = (document.cookie || '').split(';');
      for (var i = 0; i < pairs.length; i++) {
        var p = pairs[i].trim();
        if (p.indexOf(name + '=') === 0) return decodeURIComponent(p.substring(name.length + 1));
      }
    } catch (_) {}
    return null;
  }

  function setCookie(name, value, days) {
    try {
      var expires = '';
      if (days) {
        var d = new Date();
        d.setTime(d.getTime() + days * 86400000);
        expires = '; expires=' + d.toUTCString();
      }
      var secure = (location.protocol === 'https:') ? '; Secure' : '';
      document.cookie = name + '=' + encodeURIComponent(value) + expires + '; path=/; SameSite=Lax' + secure;
    } catch (_) {}
  }

  function isSupported(lang) {
    return SUPPORTED.indexOf(lang) !== -1;
  }

  function detectFromUrl() {
    try {
      // Hash fragment: #lang=fr → highest precedence (sharable links)
      var hash = (location.hash || '').toLowerCase();
      var hashMatch = hash.match(/lang=([a-z]{2})/);
      if (hashMatch && isSupported(hashMatch[1])) return hashMatch[1];

      // Query string: ?lang=fr
      var search = (location.search || '').toLowerCase();
      var queryMatch = search.match(/[?&]lang=([a-z]{2})/);
      if (queryMatch && isSupported(queryMatch[1])) return queryMatch[1];

      // Path prefix: /fr/...
      var pathMatch = (location.pathname || '').match(/^\/(nl|fr)(\/|$)/);
      if (pathMatch && isSupported(pathMatch[1])) return pathMatch[1];
    } catch (_) {}
    return null;
  }

  function detectFromBrowser() {
    try {
      var nav = navigator || {};
      var langs = nav.languages || [nav.language || nav.userLanguage || ''];
      for (var i = 0; i < langs.length; i++) {
        var l = String(langs[i] || '').toLowerCase().slice(0, 2);
        if (isSupported(l)) return l;
      }
    } catch (_) {}
    return null;
  }

  function detectInitial() {
    return detectFromUrl()
      || getCookie(STORAGE_KEY)
      || detectFromBrowser()
      || DEFAULT_LANG;
  }

  // -------- core API --------

  /**
   * Vertaal een key. Bij ontbreken in de huidige taal: fallback naar NL,
   * dan naar de key zelf (zichtbaar in dev — nooit lege string).
   * @param {string} key — dot-notation toegestaan: 'step1.title'
   * @param {object} [params] — interpolation values voor {placeholder}
   * @returns {string}
   */
  function t(key, params) {
    if (typeof key !== 'string' || !key) return '';
    var dict = dictionaries[currentLang] || {};
    var value = lookup(dict, key);
    if (value == null && currentLang !== DEFAULT_LANG) {
      value = lookup(dictionaries[DEFAULT_LANG] || {}, key);
    }
    if (value == null) {
      if (global.console && global.console.debug) {
        global.console.debug('[i18n] missing key:', key, '(' + currentLang + ')');
      }
      return key;
    }
    if (params && typeof params === 'object') {
      value = String(value).replace(/\{(\w+)\}/g, function (m, p) {
        return params[p] != null ? String(params[p]) : m;
      });
    }
    return value;
  }

  function lookup(obj, key) {
    if (key.indexOf('.') === -1) return obj[key];
    var parts = key.split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null || typeof cur !== 'object') return null;
      cur = cur[parts[i]];
    }
    return cur;
  }

  /**
   * Pas alle data-i18n* attributes toe binnen een container (default document).
   * Idempotent — kan veilig meerdere keren aangeroepen worden (na DOM-mutaties).
   */
  function applyI18n(rootEl) {
    var root = rootEl || document;
    if (!root || typeof root.querySelectorAll !== 'function') return;

    var textNodes = root.querySelectorAll('[data-i18n]');
    for (var i = 0; i < textNodes.length; i++) {
      var el = textNodes[i];
      var key = el.getAttribute('data-i18n');
      if (key) el.textContent = t(key);
    }

    var htmlNodes = root.querySelectorAll('[data-i18n-html]');
    for (var j = 0; j < htmlNodes.length; j++) {
      var elH = htmlNodes[j];
      var keyH = elH.getAttribute('data-i18n-html');
      if (keyH) elH.innerHTML = t(keyH);
    }

    var attrNodes = root.querySelectorAll('[data-i18n-attr]');
    for (var k = 0; k < attrNodes.length; k++) {
      var elA = attrNodes[k];
      var spec = elA.getAttribute('data-i18n-attr');
      if (!spec) continue;
      var pairs = spec.split(',');
      for (var p = 0; p < pairs.length; p++) {
        var bits = pairs[p].split(':');
        if (bits.length === 2) {
          var attrName = bits[0].trim();
          var attrKey = bits[1].trim();
          if (attrName && attrKey) elA.setAttribute(attrName, t(attrKey));
        }
      }
    }

    // Update <html lang> voor screen-readers + browser-spell-check
    try { document.documentElement.setAttribute('lang', currentLang); } catch (_) {}
  }

  /**
   * Wissel actieve taal. Persisteert in cookie en re-applied alle data-i18n.
   * @param {'nl'|'fr'} lang
   * @param {object} [options] — { silent: true } skipt notify naar listeners
   */
  function setLang(lang, options) {
    if (!isSupported(lang)) return;
    if (lang === currentLang) return;
    currentLang = lang;
    setCookie(STORAGE_KEY, lang, 365);
    applyI18n();
    if (!options || !options.silent) notifyListeners();
  }

  /**
   * Auto-switch op basis van Belgische postcode.
   * Vlaanderen: NL. Wallonië: FR. Brussel: triggert prompt (callback).
   * @param {string|number} postcode
   * @param {function} [onBrussels] — callback bij Brussel-postcode (toon UI prompt)
   */
  function setLangFromPostcode(postcode, onBrussels) {
    var pc = parseInt(String(postcode || '').trim(), 10);
    if (!pc || pc < 1000 || pc > 9999) return;

    // Cookie aanwezig? Klant heeft al gekozen — respecteer dat.
    if (getCookie(STORAGE_KEY)) return;

    if (pc >= POSTCODE_BRUSSEL_RANGE[0] && pc <= POSTCODE_BRUSSEL_RANGE[1]) {
      // Brussel — laat caller de prompt afhandelen (heeft toegang tot UI-context).
      if (typeof onBrussels === 'function') onBrussels();
      return;
    }

    for (var i = 0; i < POSTCODE_FR_RANGES.length; i++) {
      var r = POSTCODE_FR_RANGES[i];
      if (pc >= r[0] && pc <= r[1]) {
        setLang('fr');
        return;
      }
    }
    // Vlaanderen-range (default NL — nothing to switch)
  }

  /**
   * Registreer callback voor taal-wisselingen. Componenten die zelf moeten
   * herrenderen (bv. JS-gebouwde lijsten) abonneren via deze hook.
   * @param {function(currentLang)} cb
   */
  function onLangChange(cb) {
    if (typeof cb === 'function') listeners.push(cb);
  }

  function notifyListeners() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](currentLang); } catch (_) {}
    }
  }

  /**
   * Registreer of vervang een dictionary. Wordt typisch aangeroepen door
   * de inline-loader script-tags (zie nl.json.js / fr.json.js).
   */
  function registerDict(lang, dict) {
    if (!isSupported(lang) || !dict || typeof dict !== 'object') return;
    dictionaries[lang] = dict;
    if (lang === currentLang) applyI18n();
  }

  function getLang() { return currentLang; }
  function getSupported() { return SUPPORTED.slice(); }

  // -------- bootstrap --------

  function init() {
    currentLang = detectInitial();
    if (!isSupported(currentLang)) currentLang = DEFAULT_LANG;

    // Run initial application zodra DOM klaar is.
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { applyI18n(); }, { once: true });
    } else {
      applyI18n();
    }
  }

  // Public API
  global.flanccoI18n = {
    t: t,
    setLang: setLang,
    getLang: getLang,
    getSupported: getSupported,
    setLangFromPostcode: setLangFromPostcode,
    onLangChange: onLangChange,
    registerDict: registerDict,
    applyI18n: applyI18n,
    // Slot S — read-only access voor consumers die expliciet een specifieke
    // taal willen renderen los van de huidige UI-lang (bv. PDF-templates die
    // een eerder ondertekend FR-contract opnieuw genereren in een NL-admin
    // sessie). Returns een nieuwe shallow-copy zodat caller-mutaties geen
    // impact hebben op de interne registry.
    getDicts: function () {
      return { nl: dictionaries.nl, fr: dictionaries.fr };
    }
  };
  // Convenience global voor inline calls in HTML / event handlers.
  global.t = t;

  init();
})(typeof window !== 'undefined' ? window : this);
