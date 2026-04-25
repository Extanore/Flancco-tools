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

  global.flanccoTrack = flanccoTrack;
  global.flanccoTrackPageView = flanccoTrackPageView;
})(typeof window !== 'undefined' ? window : this);
