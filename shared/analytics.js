/**
 * Flancco Partner Platform — Analytics helper (Slot 0)
 * --------------------------------------------------------------
 * Dunne wrapper rond Plausible Analytics (cookieless, GDPR-conform).
 * Doel: één centrale, defensieve API voor alle pagina's en future slots,
 * zodat we later van endpoint kunnen wisselen (proxy, self-host) zonder
 * elke call-site te raken.
 *
 * Plausible-script wordt vóór dit bestand geladen (zie <head>-snippet);
 * de queue-stub `window.plausible.q` zorgt dat events die vóór script-load
 * vuren niet verloren gaan. Bij blokkade (adblocker, CSP-fout, offline)
 * degradeert deze helper stil — geen exception, geen UI-impact.
 *
 * Geen side effects bij load. Functies zijn pure no-ops zolang de host-app
 * ze niet aanroept.
 */
(function (global) {
  'use strict';

  /**
   * Verstuur een custom event naar Plausible.
   *
   * @param {string} eventName  — Naam van het event (bv. 'Contract Signed').
   *                              Hou consistent met de event-tabel in
   *                              docs/slots/slot-0-event-logging.md.
   * @param {object} [props]    — Optionele properties (key/value strings of
   *                              numbers). Plausible ondersteunt geen geneste
   *                              objecten — flatten waar nodig.
   * @returns {void}            — Fire-and-forget; geen Promise, geen return.
   *
   * @example
   *   flanccoTrack('Calculator Started', { partner: 'novectra' });
   *   flanccoTrack('Contract Signed', { partner: 'cwsolar', panelen: 24 });
   */
  function flanccoTrack(eventName, props) {
    if (typeof eventName !== 'string' || !eventName) return;
    try {
      if (typeof global.plausible === 'function') {
        if (props && typeof props === 'object') {
          global.plausible(eventName, { props: props });
        } else {
          global.plausible(eventName);
        }
      }
    } catch (err) {
      if (global.console && typeof global.console.debug === 'function') {
        global.console.debug('[flanccoTrack] suppressed:', err && err.message);
      }
    }
  }

  /**
   * Markeer een SPA-achtige view-wissel als pageview. Het admin-dashboard en
   * de wizards wisselen tussen schermen zonder URL-verandering — Plausible
   * registreert dan geen automatische pageview. Roep deze helper aan bij elke
   * relevante view-switch om drop-off-analyse mogelijk te maken.
   *
   * @param {string} name — Logische schermnaam (bv. 'admin/contracten',
   *                        'wizard/step-3-handtekening'). Gebruik path-stijl
   *                        zonder leading slash voor consistentie in de
   *                        Plausible-rapporten.
   * @returns {void}
   *
   * @example
   *   flanccoTrackPageView('admin/planning');
   *   flanccoTrackPageView('wizard/step-2-klantgegevens');
   */
  function flanccoTrackPageView(name) {
    if (typeof name !== 'string' || !name) return;
    try {
      if (typeof global.plausible === 'function') {
        global.plausible('pageview', { u: location.origin + '/' + name.replace(/^\/+/, '') });
      }
    } catch (err) {
      if (global.console && typeof global.console.debug === 'function') {
        global.console.debug('[flanccoTrackPageView] suppressed:', err && err.message);
      }
    }
  }

  /**
   * Drop-off-detectie voor multi-step flows (calculator, wizard). Vuurt één
   * keer een event af zodra de gebruiker de tab verlaat (sluit, navigeert weg
   * of mobile-app terug naar achtergrond) ZONDER de flow te voltooien.
   *
   * Idempotent: koppelt aan zowel `beforeunload` als `pagehide` (Safari /
   * iOS-vriendelijk) en gebruikt een interne flag zodat het event maar één
   * keer afgaat — ongeacht welk pad eerst vuurt.
   *
   * Bij voltooien van de flow (bv. handtekening geplaatst) moet caller
   * `cancel()` aanroepen op het returned handle om dubbele tellingen te
   * voorkomen.
   *
   * @param {function|number|string} stepProvider — getter voor de huidige
   *        stap; mag een functie zijn die `String|number` returnt, of een
   *        statische waarde. Wordt op het moment van drop-off uitgelezen, niet
   *        bij setup, zodat de juiste stap wordt geregistreerd.
   * @param {string} [partner] — partner-slug voor segmentatie.
   * @returns {{cancel: function}} — handle met `.cancel()` om de listener
   *        te verwijderen na succesvolle voltooiing.
   *
   * @example
   *   var dropOff = flanccoTrackDropOff(function () { return currentStep; }, 'novectra');
   *   // ... later, na succesvol ondertekenen:
   *   dropOff.cancel();
   */
  function flanccoTrackDropOff(stepProvider, partner) {
    var triggered = false;
    var canceled = false;

    function readStep() {
      try {
        if (typeof stepProvider === 'function') return String(stepProvider());
        if (stepProvider != null) return String(stepProvider);
      } catch (_) { /* noop */ }
      return 'unknown';
    }

    function fire() {
      if (triggered || canceled) return;
      triggered = true;
      try {
        flanccoTrack('Calculator Drop Off', {
          step: readStep(),
          partner: (typeof partner === 'string' && partner) || 'unknown'
        });
      } catch (_) { /* analytics nooit blokkerend */ }
    }

    try {
      global.addEventListener('beforeunload', fire);
      global.addEventListener('pagehide', fire);
    } catch (_) { /* SSR / test-env */ }

    return {
      cancel: function () {
        canceled = true;
        try {
          global.removeEventListener('beforeunload', fire);
          global.removeEventListener('pagehide', fire);
        } catch (_) { /* noop */ }
      }
    };
  }

  global.flanccoTrack = flanccoTrack;
  global.flanccoTrackPageView = flanccoTrackPageView;
  global.flanccoTrackDropOff = flanccoTrackDropOff;
})(typeof window !== 'undefined' ? window : this);
