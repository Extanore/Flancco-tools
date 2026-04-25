/**
 * Flancco postcode-lookup (Slot O2)
 * --------------------------------------------------------------
 * Lazy-loader voor calculator/data/be-postcodes.json (≈80 KB).
 * Bestand wordt 1× opgehaald bij eerste lookup en gecached in module-scope.
 *
 * API:
 *   await window.flanccoPostcodes.lookup('9050')
 *     → { found: true,  postcode: '9050', deelgemeenten: ['Gentbrugge','Ledeberg'] }
 *     → { found: false, postcode: '9050' }
 *     → { found: null,  postcode: '9050', error: 'unavailable' }   // soft-fail
 *
 *   window.flanccoPostcodes.warmup()       // optioneel pre-fetchen
 *
 * Geen build-stap, registreert zich op window.
 */
(function () {
  'use strict';

  // Absolute path: vanuit /admin/contracten-wizard.html zou een relatieve
  // 'data/be-postcodes.json' resolveren naar /admin/data/... → 404 + silent
  // soft-fail. Absolute /calculator/... werkt vanuit beide origins.
  var DATA_URL  = '/calculator/data/be-postcodes.json';
  var FETCH_TTL = 30 * 1000; // 30s om concurrente requests samen te voegen

  var cache  = null;        // resolved object van postcode → array
  var inflight = null;      // huidige Promise tijdens fetch
  var lastErrAt = 0;

  function loadOnce() {
    if (cache) return Promise.resolve(cache);
    if (inflight) return inflight;
    // Soft-fail back-off: bij eerdere fout wachten we 5s voor retry
    if (lastErrAt && (Date.now() - lastErrAt) < 5000) {
      return Promise.resolve(null);
    }

    inflight = fetch(DATA_URL, { credentials: 'omit', cache: 'force-cache' })
      .then(function (resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.json();
      })
      .then(function (data) {
        cache = data;
        return cache;
      })
      .catch(function (err) {
        lastErrAt = Date.now();
        try { console.warn('[postcode-lookup] load failed', err && err.message); } catch (_) {}
        return null;
      })
      .then(function (val) {
        // Cleanup inflight na korte TTL zodat dedupe blijft werken
        setTimeout(function () { inflight = null; }, FETCH_TTL);
        return val;
      });

    return inflight;
  }

  function lookup(postcode) {
    var key = String(postcode || '').replace(/[^\d]/g, '').substring(0, 4);
    if (key.length !== 4) {
      return Promise.resolve({ found: false, postcode: key, error: 'invalid_format' });
    }
    return loadOnce().then(function (data) {
      if (!data) return { found: null, postcode: key, error: 'unavailable' };
      var entry = data[key];
      if (!entry || !entry.length) return { found: false, postcode: key };
      var deelgemeenten = entry
        .map(function (e) { return e && e.gemeente; })
        .filter(Boolean);
      return { found: true, postcode: key, deelgemeenten: deelgemeenten };
    });
  }

  function warmup() { return loadOnce(); }

  window.flanccoPostcodes = {
    lookup: lookup,
    warmup: warmup
  };
})();
