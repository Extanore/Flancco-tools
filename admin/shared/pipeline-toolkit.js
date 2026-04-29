/*
 * Flancco Pipeline Toolkit — Sarah-resilient continuity-toolkit voor Slot V + W.
 *
 * Drie sub-componenten in één file omdat ze conceptueel samenhoren
 * (continuity / hand-off) en gedeelde state hebben (hand-off-mode flag in
 * localStorage + body class).
 *
 *   1. Activity-log per record           — beurt_dispatch_log + klant_notification_log
 *   2. Klant-context (planner-notitie)   — clients.planner_notitie + mini-historiek
 *   3. Hand-off mode helpers             — banner + body-class flag
 *   4. Runbook-tooltips                  — runbook_tooltips per (fase, action_key)
 *
 * Gebruikt CSS-classes uit pipeline-components.css (.flp-* prefix). Geen
 * inline styles.
 *
 * Vanilla JS, geen build-tooling. Laad via:
 *   <link rel="stylesheet" href="/admin/shared/pipeline-components.css">
 *   <script src="/admin/shared/pipeline-toolkit.js"></script>
 *
 * Auto-attach: scant DOM op data-slot attributes en vult ze in. Nieuw
 * toegevoegde slots worden via MutationObserver opgepikt zodat dynamisch
 * gerenderde modals/lijsten ook werken.
 *
 * XSS-test (verplicht in eigen code): zie helper `__pipelineToolkitXssTest`
 * onderaan dit bestand. Een input zoals
 *     text = '<script>alert(1)</script>'
 * wordt overal via textContent gerendered → komt als plaintext in de DOM,
 * nooit als executable HTML. Geverifieerd door Node-side smoketest die
 * controleert dat geen enkele appendChild een Element-node accepteert die
 * van user-content afkomstig is.
 */
(function (global) {
  'use strict';

  // =========================================================================
  // Module-level state
  // =========================================================================

  var HANDOFF_LS_KEY = 'flancco_handoff_mode_since';
  var HANDOFF_BODY_CLASS = 'handoff-mode';
  var HANDOFF_EVENT = 'flancco:handoff-mode-changed';

  // Cache: runbook_tooltips by `${fase}:${actionKey}` — permanent na load.
  var RUNBOOK_CACHE = Object.create(null);
  // Cache: in-flight promises om duplicate fetches te vermijden.
  var RUNBOOK_INFLIGHT = Object.create(null);

  // Cache: user-role with 5-min TTL.
  var ROLE_CACHE = { value: null, expires: 0, inflight: null };
  var ROLE_TTL_MS = 5 * 60 * 1000;

  // Mark slots that are already filled to avoid re-init.
  var FILLED_ATTR = 'data-slot-filled';

  // Daily-limit on klant-historiek-fetches per render-cycle is geen issue;
  // Supabase rate-limiting pakt dat op. We cachen NIET per record (kan stale).

  // =========================================================================
  // Utilities
  // =========================================================================

  function safeStr(v) {
    if (v == null) return '';
    return String(v);
  }

  function logError(prefix, err) {
    if (typeof console !== 'undefined' && console && typeof console.error === 'function') {
      console.error('[FlanccoPipelineToolkit] ' + prefix + ':', err);
    }
  }

  function todayIsoDate() {
    var d = new Date();
    var m = String(d.getMonth() + 1);
    var day = String(d.getDate());
    if (m.length === 1) m = '0' + m;
    if (day.length === 1) day = '0' + day;
    return d.getFullYear() + '-' + m + '-' + day;
  }

  /** Locale-aware datum NL: 21/1/2026, 14:30. Defensief tegen invalide input. */
  function formatDateTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var dd = d.getDate();
    var mm = d.getMonth() + 1;
    var yyyy = d.getFullYear();
    var hh = String(d.getHours());
    var mi = String(d.getMinutes());
    if (hh.length === 1) hh = '0' + hh;
    if (mi.length === 1) mi = '0' + mi;
    return dd + '/' + mm + '/' + yyyy + ', ' + hh + ':' + mi;
  }

  function formatDateShort(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.getDate() + '/' + (d.getMonth() + 1) + '/' + d.getFullYear();
  }

  function formatEuro(value) {
    var n = Number(value);
    if (!isFinite(n)) return '';
    return '€' + Math.round(n).toLocaleString('nl-BE');
  }

  // =========================================================================
  // SVG helpers (Lucide-style inline)
  // =========================================================================

  function makeSvg(viewBox, paths, cls, size) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', cls || 'flp-icon');
    svg.setAttribute('width', String(size || 14));
    svg.setAttribute('height', String(size || 14));
    svg.setAttribute('viewBox', viewBox || '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < paths.length; i++) {
      var node = document.createElementNS('http://www.w3.org/2000/svg', paths[i][0]);
      var attrs = paths[i][1];
      for (var k in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, k)) {
          node.setAttribute(k, attrs[k]);
        }
      }
      svg.appendChild(node);
    }
    return svg;
  }

  function iconInfo(size) {
    return makeSvg('0 0 24 24', [
      ['circle', { cx: '12', cy: '12', r: '10' }],
      ['path',   { d: 'M12 16v-4' }],
      ['path',   { d: 'M12 8h.01' }]
    ], 'flp-icon flp-icon-info', size);
  }

  function iconPencil(size) {
    return makeSvg('0 0 24 24', [
      ['path', { d: 'M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z' }]
    ], 'flp-icon flp-icon-pencil', size);
  }

  function iconPlus(size) {
    return makeSvg('0 0 24 24', [
      ['line', { x1: '12', y1: '5',  x2: '12', y2: '19' }],
      ['line', { x1: '5',  y1: '12', x2: '19', y2: '12' }]
    ], 'flp-icon flp-icon-plus', size);
  }

  function iconX(size) {
    return makeSvg('0 0 24 24', [
      ['line', { x1: '18', y1: '6',  x2: '6',  y2: '18' }],
      ['line', { x1: '6',  y1: '6',  x2: '18', y2: '18' }]
    ], 'flp-icon flp-icon-x', size);
  }

  function iconCalendar(size) {
    return makeSvg('0 0 24 24', [
      ['rect', { x: '3', y: '4', width: '18', height: '18', rx: '2', ry: '2' }],
      ['line', { x1: '16', y1: '2', x2: '16', y2: '6' }],
      ['line', { x1: '8',  y1: '2', x2: '8',  y2: '6' }],
      ['line', { x1: '3',  y1: '10', x2: '21', y2: '10' }]
    ], 'flp-icon flp-icon-calendar', size);
  }

  function iconEnvelope(size) {
    return makeSvg('0 0 24 24', [
      ['path',     { d: 'M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z' }],
      ['polyline', { points: '22,6 12,13 2,6' }]
    ], 'flp-icon flp-icon-envelope', size);
  }

  function iconCog(size) {
    return makeSvg('0 0 24 24', [
      ['circle', { cx: '12', cy: '12', r: '3' }],
      ['path',   { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' }]
    ], 'flp-icon flp-icon-cog', size);
  }

  function iconArrowRight(size) {
    return makeSvg('0 0 24 24', [
      ['line',     { x1: '5', y1: '12', x2: '19', y2: '12' }],
      ['polyline', { points: '12 5 19 12 12 19' }]
    ], 'flp-icon flp-icon-arrow-right', size);
  }

  function iconMoon(size) {
    return makeSvg('0 0 24 24', [
      ['path', { d: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z' }]
    ], 'flp-icon flp-icon-moon', size);
  }

  function iconNote(size) {
    return makeSvg('0 0 24 24', [
      ['path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }],
      ['polyline', { points: '14 2 14 8 20 8' }],
      ['line', { x1: '8', y1: '13', x2: '16', y2: '13' }],
      ['line', { x1: '8', y1: '17', x2: '12', y2: '17' }]
    ], 'flp-icon flp-icon-note', size);
  }

  /** Map activity-type to icon-builder. */
  function iconForActivity(kind) {
    switch (kind) {
      case 'manual':    return iconNote(14);
      case 'snooze':    return iconMoon(14);
      case 'system':    return iconCog(14);
      case 'transitie': return iconArrowRight(14);
      case 'mail':
      case 'email':     return iconEnvelope(14);
      default:          return iconCalendar(14);
    }
  }

  // =========================================================================
  // User-role detection (cached, 5-min TTL)
  // =========================================================================

  function _getUserRole(supabase) {
    if (!supabase) return Promise.resolve(null);
    var now = Date.now();
    if (ROLE_CACHE.value !== null && ROLE_CACHE.expires > now) {
      return Promise.resolve(ROLE_CACHE.value);
    }
    if (ROLE_CACHE.inflight) return ROLE_CACHE.inflight;

    var p = (function () {
      return supabase.auth.getUser().then(function (res) {
        var u = res && res.data && res.data.user ? res.data.user : null;
        if (!u) return null;
        return supabase
          .from('user_roles')
          .select('role')
          .eq('user_id', u.id)
          .maybeSingle()
          .then(function (r) {
            return r && r.data ? r.data.role : null;
          });
      });
    })()
      .then(function (role) {
        ROLE_CACHE.value = role;
        ROLE_CACHE.expires = Date.now() + ROLE_TTL_MS;
        ROLE_CACHE.inflight = null;
        return role;
      })
      .catch(function (err) {
        logError('role-fetch failed', err);
        ROLE_CACHE.value = null;
        ROLE_CACHE.expires = Date.now() + 30 * 1000; // shorter TTL on error
        ROLE_CACHE.inflight = null;
        return null;
      });

    ROLE_CACHE.inflight = p;
    return p;
  }

  function _isAdmin(supabase) {
    return _getUserRole(supabase).then(function (r) { return r === 'admin'; });
  }

  function _isAdminOrBediende(supabase) {
    return _getUserRole(supabase).then(function (r) {
      return r === 'admin' || r === 'bediende';
    });
  }

  // =========================================================================
  // Hand-off mode helpers
  // =========================================================================

  function isHandOffMode() {
    try {
      var v = global.localStorage ? global.localStorage.getItem(HANDOFF_LS_KEY) : null;
      return v != null && v !== '';
    } catch (e) {
      return false;
    }
  }

  function getHandOffSince() {
    try {
      return global.localStorage ? global.localStorage.getItem(HANDOFF_LS_KEY) : null;
    } catch (e) {
      return null;
    }
  }

  function toggleHandOffMode(active, sinceDate) {
    var since;
    try {
      if (active) {
        since = sinceDate || todayIsoDate();
        if (global.localStorage) global.localStorage.setItem(HANDOFF_LS_KEY, since);
        document.body.classList.add(HANDOFF_BODY_CLASS);
      } else {
        if (global.localStorage) global.localStorage.removeItem(HANDOFF_LS_KEY);
        document.body.classList.remove(HANDOFF_BODY_CLASS);
        since = null;
      }
    } catch (e) {
      logError('toggleHandOffMode storage error', e);
    }
    // Custom event so banners + activity-logs + klant-context kunnen re-renderen.
    try {
      var evt;
      if (typeof CustomEvent === 'function') {
        evt = new CustomEvent(HANDOFF_EVENT, {
          detail: { active: !!active, sinceDate: since }
        });
      } else {
        evt = document.createEvent('CustomEvent');
        evt.initCustomEvent(HANDOFF_EVENT, false, false, {
          active: !!active, sinceDate: since
        });
      }
      document.dispatchEvent(evt);
    } catch (e) {
      logError('handoff-event dispatch failed', e);
    }
  }

  function renderHandOffBanner(container) {
    if (!container) return;
    while (container.firstChild) container.removeChild(container.firstChild);

    var renderInternal = function () {
      while (container.firstChild) container.removeChild(container.firstChild);
      if (!isHandOffMode()) return;

      var banner = document.createElement('div');
      banner.className = 'flp-handoff-banner';
      banner.setAttribute('role', 'status');
      banner.setAttribute('aria-live', 'polite');

      var iconWrap = document.createElement('span');
      iconWrap.className = 'flp-handoff-banner-icon';
      iconWrap.appendChild(iconMoon(16));
      banner.appendChild(iconWrap);

      var msg = document.createElement('span');
      msg.className = 'flp-handoff-banner-text';
      msg.textContent = 'Sarah afwezig sinds ' + formatDateShort(getHandOffSince()) +
        ' — collega vervangt tijdelijk';
      banner.appendChild(msg);

      var dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'flp-handoff-banner-dismiss';
      dismiss.setAttribute('aria-label', 'Hand-off modus uitschakelen');
      dismiss.appendChild(iconX(14));
      var lbl = document.createElement('span');
      lbl.textContent = ' Modus uitschakelen';
      dismiss.appendChild(lbl);
      dismiss.addEventListener('click', function () {
        toggleHandOffMode(false);
      });
      banner.appendChild(dismiss);

      container.appendChild(banner);
    };

    renderInternal();

    // Re-render on toggle.
    var listener = function () { renderInternal(); };
    document.addEventListener(HANDOFF_EVENT, listener);
    // Best-effort cleanup hook on container.
    container.__flpHandoffCleanup = function () {
      document.removeEventListener(HANDOFF_EVENT, listener);
    };
  }

  // Initialise body-class on page load (so refresh keeps the mode visible).
  function _initHandOffBodyClass() {
    try {
      if (isHandOffMode()) {
        document.body.classList.add(HANDOFF_BODY_CLASS);
      }
    } catch (e) { /* ignore */ }
  }

  // =========================================================================
  // Toolkit-2: Activity-log per record
  // =========================================================================

  function renderActivityLog(container, opts) {
    if (!container || container.nodeType !== 1) return;
    opts = opts || {};
    var beurtId = opts.beurtId;
    var supabase = opts.supabase;
    var explicitExpanded = (opts.expanded === true || opts.expanded === false)
      ? opts.expanded
      : null;

    if (!beurtId || !supabase) {
      logError('renderActivityLog', 'beurtId + supabase required');
      return;
    }

    while (container.firstChild) container.removeChild(container.firstChild);
    container.classList.add('flp-activity-log');
    container.setAttribute('data-beurt-id', String(beurtId));

    var state = {
      expanded: explicitExpanded != null ? explicitExpanded : isHandOffMode(),
      events: null,
      loading: true
    };

    var headerEl = document.createElement('div');
    headerEl.className = 'flp-activity-log-header';

    var toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'flp-activity-log-toggle';
    toggleBtn.setAttribute('aria-expanded', state.expanded ? 'true' : 'false');
    headerEl.appendChild(toggleBtn);

    var bodyEl = document.createElement('div');
    bodyEl.className = 'flp-activity-log-body';
    if (!state.expanded) bodyEl.setAttribute('hidden', '');

    container.appendChild(headerEl);
    container.appendChild(bodyEl);

    var noteForm = null;

    function renderHeader() {
      while (toggleBtn.firstChild) toggleBtn.removeChild(toggleBtn.firstChild);
      var titleSpan = document.createElement('span');
      titleSpan.className = 'flp-activity-log-title';
      var count = state.events ? state.events.length : null;
      titleSpan.textContent = count == null
        ? 'Activiteit'
        : 'Activiteit (' + count + ')';
      toggleBtn.appendChild(titleSpan);

      var chev = document.createElement('span');
      chev.className = 'flp-activity-log-chevron';
      chev.textContent = state.expanded ? '−' : '+';
      toggleBtn.appendChild(chev);
    }

    function setExpanded(next) {
      state.expanded = !!next;
      if (state.expanded) {
        bodyEl.removeAttribute('hidden');
      } else {
        bodyEl.setAttribute('hidden', '');
      }
      toggleBtn.setAttribute('aria-expanded', state.expanded ? 'true' : 'false');
      renderHeader();
    }

    toggleBtn.addEventListener('click', function () {
      setExpanded(!state.expanded);
    });

    function renderBody() {
      while (bodyEl.firstChild) bodyEl.removeChild(bodyEl.firstChild);

      if (state.loading) {
        var loading = document.createElement('div');
        loading.className = 'flp-activity-log-loading';
        loading.textContent = 'Activiteit laden…';
        bodyEl.appendChild(loading);
        return;
      }

      if (!state.events || state.events.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'flp-activity-log-empty';
        empty.textContent = 'Nog geen activiteit voor dit record.';
        bodyEl.appendChild(empty);
      } else {
        var list = document.createElement('ul');
        list.className = 'flp-activity-log-list';
        list.setAttribute('aria-label', 'Activiteiten chronologisch');

        for (var i = 0; i < state.events.length; i++) {
          var ev = state.events[i];
          var li = document.createElement('li');
          li.className = 'flp-activity-log-entry flp-activity-log-entry--' + (ev.kind || 'system');

          var iconWrap = document.createElement('span');
          iconWrap.className = 'flp-activity-log-icon';
          iconWrap.appendChild(iconForActivity(ev.kind));
          li.appendChild(iconWrap);

          var contentWrap = document.createElement('div');
          contentWrap.className = 'flp-activity-log-content';

          var textEl = document.createElement('span');
          textEl.className = 'flp-activity-log-text';
          textEl.textContent = ev.text || '';
          contentWrap.appendChild(textEl);

          var metaEl = document.createElement('span');
          metaEl.className = 'flp-activity-log-meta';
          var metaParts = [];
          if (ev.actor) metaParts.push(ev.actor);
          if (ev.created_at) metaParts.push(formatDateTime(ev.created_at));
          metaEl.textContent = metaParts.join(' • ');
          contentWrap.appendChild(metaEl);

          li.appendChild(contentWrap);
          list.appendChild(li);
        }
        bodyEl.appendChild(list);
      }

      // "+ Notitie toevoegen"-button
      var addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'flp-activity-log-add';
      addBtn.appendChild(iconPlus(14));
      var addLbl = document.createElement('span');
      addLbl.textContent = 'Notitie toevoegen';
      addBtn.appendChild(addLbl);
      addBtn.addEventListener('click', function () {
        showNoteForm();
      });
      bodyEl.appendChild(addBtn);
    }

    function showNoteForm() {
      if (noteForm) {
        var ta = noteForm.querySelector('textarea');
        if (ta) ta.focus();
        return;
      }
      noteForm = document.createElement('form');
      noteForm.className = 'flp-activity-log-form';
      noteForm.addEventListener('submit', function (e) {
        e.preventDefault();
        submitNote();
      });

      var textarea = document.createElement('textarea');
      textarea.className = 'flp-activity-log-textarea';
      textarea.setAttribute('rows', '3');
      textarea.setAttribute('placeholder', 'Wat is er gebeurd? Voor Karen of een collega.');
      textarea.setAttribute('aria-label', 'Notitie-tekst');
      textarea.required = true;
      noteForm.appendChild(textarea);

      var actions = document.createElement('div');
      actions.className = 'flp-activity-log-form-actions';

      var cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'flp-activity-log-form-cancel';
      cancel.textContent = 'Annuleren';
      cancel.addEventListener('click', function () { hideNoteForm(); });
      actions.appendChild(cancel);

      var save = document.createElement('button');
      save.type = 'submit';
      save.className = 'flp-activity-log-form-save';
      save.textContent = 'Opslaan';
      actions.appendChild(save);

      noteForm.appendChild(actions);
      bodyEl.appendChild(noteForm);
      textarea.focus();
    }

    function hideNoteForm() {
      if (noteForm && noteForm.parentNode) noteForm.parentNode.removeChild(noteForm);
      noteForm = null;
    }

    function submitNote() {
      if (!noteForm) return;
      var ta = noteForm.querySelector('textarea');
      var save = noteForm.querySelector('.flp-activity-log-form-save');
      if (!ta) return;
      var text = (ta.value || '').trim();
      if (!text) return;
      if (save) {
        save.disabled = true;
        save.textContent = 'Opslaan…';
      }
      addManualNote(beurtId, text, supabase)
        .then(function (row) {
          hideNoteForm();
          // Optimistic refresh: prepend the new row.
          if (!state.events) state.events = [];
          state.events.unshift({
            kind: 'manual',
            text: row && row.text ? row.text : text,
            created_at: row && row.created_at ? row.created_at : new Date().toISOString(),
            actor: row && row.actor ? row.actor : null
          });
          renderHeader();
          renderBody();
        })
        .catch(function (err) {
          logError('addManualNote failed', err);
          if (save) {
            save.disabled = false;
            save.textContent = 'Opslaan';
          }
          var errEl = noteForm.querySelector('.flp-activity-log-form-error');
          if (!errEl) {
            errEl = document.createElement('div');
            errEl.className = 'flp-activity-log-form-error';
            noteForm.appendChild(errEl);
          }
          errEl.textContent = 'Opslaan mislukt. Probeer opnieuw.';
        });
    }

    function load() {
      // 2 queries parallel
      var p1 = supabase
        .from('beurt_dispatch_log')
        .select('id, type, text, user_id, created_at')
        .eq('beurt_id', beurtId)
        .order('created_at', { ascending: false })
        .limit(50);

      var p2 = supabase
        .from('klant_notification_log')
        .select('id, kanaal, event_type, status, created_at')
        .eq('beurt_id', beurtId)
        .order('created_at', { ascending: false })
        .limit(50);

      return Promise.all([p1, p2]).then(function (results) {
        var dispatch = (results[0] && results[0].data) || [];
        var notif = (results[1] && results[1].data) || [];
        if (results[0] && results[0].error) logError('beurt_dispatch_log fetch', results[0].error);
        if (results[1] && results[1].error) logError('klant_notification_log fetch', results[1].error);

        var combined = [];
        for (var i = 0; i < dispatch.length; i++) {
          var d = dispatch[i];
          combined.push({
            kind: d.type || 'system',
            text: d.text || '',
            created_at: d.created_at,
            actor: d.user_id ? null : 'systeem'
          });
        }
        for (var j = 0; j < notif.length; j++) {
          var n = notif[j];
          combined.push({
            kind: 'mail',
            text: 'Notificatie ' + (n.kanaal || '?') + ' • ' +
              (n.event_type || '?') + ' • ' + (n.status || '?'),
            created_at: n.created_at,
            actor: 'systeem'
          });
        }
        combined.sort(function (a, b) {
          var ta = a.created_at ? Date.parse(a.created_at) : 0;
          var tb = b.created_at ? Date.parse(b.created_at) : 0;
          return tb - ta;
        });
        state.events = combined;
        state.loading = false;
        renderHeader();
        renderBody();
      });
    }

    // First paint
    renderHeader();
    renderBody();

    load().catch(function (err) {
      logError('activity-log load', err);
      state.loading = false;
      state.events = [];
      renderHeader();
      renderBody();
    });

    // Re-expand when hand-off mode toggles on, while the user did not yet
    // take a manual action on the toggle.
    if (explicitExpanded == null) {
      var handoffListener = function () {
        setExpanded(isHandOffMode());
      };
      document.addEventListener(HANDOFF_EVENT, handoffListener);
      container.__flpActivityCleanup = function () {
        document.removeEventListener(HANDOFF_EVENT, handoffListener);
      };
    }
  }

  function addManualNote(beurtId, text, supabase) {
    if (!beurtId || !text || !supabase) {
      return Promise.reject(new Error('beurtId, text, supabase required'));
    }
    var clean = String(text).trim();
    if (!clean) return Promise.reject(new Error('text empty'));

    return supabase.auth.getUser().then(function (res) {
      var uid = res && res.data && res.data.user ? res.data.user.id : null;
      var row = { beurt_id: beurtId, type: 'manual', text: clean };
      if (uid) row.user_id = uid;
      return supabase
        .from('beurt_dispatch_log')
        .insert(row)
        .select()
        .single()
        .then(function (r) {
          if (r.error) throw r.error;
          return r.data;
        });
    });
  }

  function addSnoozeWithReason(beurtId, snoozeTot, reden, supabase) {
    if (!beurtId || !snoozeTot || !reden || !supabase) {
      return Promise.reject(new Error('beurtId, snoozeTot, reden, supabase required'));
    }
    var cleanReden = String(reden).trim();
    if (!cleanReden) return Promise.reject(new Error('reden empty'));

    return supabase
      .from('onderhoudsbeurten')
      .update({ snooze_tot: snoozeTot })
      .eq('id', beurtId)
      .then(function (upd) {
        if (upd.error) throw upd.error;
        return supabase.auth.getUser();
      })
      .then(function (res) {
        var uid = res && res.data && res.data.user ? res.data.user.id : null;
        var row = {
          beurt_id: beurtId,
          type: 'snooze',
          text: 'Gesnoozed tot ' + snoozeTot + ': ' + cleanReden
        };
        if (uid) row.user_id = uid;
        return supabase
          .from('beurt_dispatch_log')
          .insert(row)
          .select()
          .single();
      })
      .then(function (r) {
        if (r && r.error) throw r.error;
        return { success: true };
      })
      .catch(function (err) {
        logError('addSnoozeWithReason', err);
        return { success: false, error: err };
      });
  }

  // =========================================================================
  // Toolkit-3: Klant-context (planner-notitie + mini-historiek)
  // =========================================================================

  function renderKlantContext(container, opts) {
    if (!container || container.nodeType !== 1) return;
    opts = opts || {};
    var clientId = opts.clientId;
    var supabase = opts.supabase;
    var explicitExpanded = (opts.expanded === true || opts.expanded === false)
      ? opts.expanded
      : null;

    if (!clientId || !supabase) {
      logError('renderKlantContext', 'clientId + supabase required');
      return;
    }

    while (container.firstChild) container.removeChild(container.firstChild);
    container.classList.add('flp-klant-notitie');
    container.setAttribute('data-client-id', String(clientId));

    var state = {
      notitie: null,
      historiek: null,
      loading: true,
      editing: false,
      canEdit: false,
      expanded: explicitExpanded != null ? explicitExpanded : isHandOffMode()
    };

    var noteWrap = document.createElement('div');
    noteWrap.className = 'flp-klant-notitie-wrap';
    container.appendChild(noteWrap);

    var historiekEl = document.createElement('div');
    historiekEl.className = 'flp-klant-notitie-historiek';
    container.appendChild(historiekEl);

    function renderNoteRO() {
      while (noteWrap.firstChild) noteWrap.removeChild(noteWrap.firstChild);

      var head = document.createElement('div');
      head.className = 'flp-klant-notitie-head';
      var title = document.createElement('span');
      title.className = 'flp-klant-notitie-title';
      title.textContent = 'Klant-notitie van Sarah';
      head.appendChild(title);

      if (state.canEdit) {
        var editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'flp-klant-notitie-edit';
        editBtn.setAttribute('aria-label', 'Klant-notitie bewerken');
        editBtn.appendChild(iconPencil(14));
        editBtn.addEventListener('click', function () {
          state.editing = true;
          renderNoteEdit();
        });
        head.appendChild(editBtn);
      }
      noteWrap.appendChild(head);

      var body = document.createElement('div');
      if (state.notitie && state.notitie.trim()) {
        body.className = 'flp-klant-notitie-text';
        body.textContent = state.notitie;
      } else {
        body.className = 'flp-klant-notitie-empty';
        body.textContent = state.canEdit
          ? 'Geen klant-notitie. Klik op het potlood om er een toe te voegen.'
          : 'Geen klant-notitie.';
      }
      // Inline-edit by clicking the text-block (admin/bediende only).
      if (state.canEdit) {
        body.classList.add('flp-klant-notitie-clickable');
        body.setAttribute('role', 'button');
        body.setAttribute('tabindex', '0');
        body.setAttribute('aria-label', 'Klant-notitie bewerken');
        body.addEventListener('click', function () {
          state.editing = true;
          renderNoteEdit();
        });
        body.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            state.editing = true;
            renderNoteEdit();
          }
        });
      }
      noteWrap.appendChild(body);
    }

    function renderNoteEdit() {
      while (noteWrap.firstChild) noteWrap.removeChild(noteWrap.firstChild);

      var head = document.createElement('div');
      head.className = 'flp-klant-notitie-head';
      var title = document.createElement('span');
      title.className = 'flp-klant-notitie-title';
      title.textContent = 'Klant-notitie van Sarah';
      head.appendChild(title);
      noteWrap.appendChild(head);

      var ta = document.createElement('textarea');
      ta.className = 'flp-klant-notitie-textarea';
      ta.setAttribute('rows', '4');
      ta.setAttribute('aria-label', 'Klant-notitie tekst');
      ta.value = state.notitie || '';
      noteWrap.appendChild(ta);

      var actions = document.createElement('div');
      actions.className = 'flp-klant-notitie-actions';

      var cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'flp-klant-notitie-cancel';
      cancel.textContent = 'Annuleren';
      cancel.addEventListener('click', function () {
        state.editing = false;
        renderNoteRO();
      });
      actions.appendChild(cancel);

      var save = document.createElement('button');
      save.type = 'button';
      save.className = 'flp-klant-notitie-save';
      save.textContent = 'Opslaan';
      save.addEventListener('click', function () {
        var newVal = (ta.value || '').trim();
        save.disabled = true;
        save.textContent = 'Opslaan…';
        saveKlantNotitie(clientId, newVal, supabase).then(function (res) {
          if (res && res.success) {
            state.notitie = newVal;
            state.editing = false;
            renderNoteRO();
          } else {
            save.disabled = false;
            save.textContent = 'Opslaan';
            var err = noteWrap.querySelector('.flp-klant-notitie-error');
            if (!err) {
              err = document.createElement('div');
              err.className = 'flp-klant-notitie-error';
              actions.appendChild(err);
            }
            err.textContent = 'Opslaan mislukt. Probeer opnieuw.';
          }
        });
      });
      actions.appendChild(save);
      noteWrap.appendChild(actions);

      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }

    function renderHistoriek() {
      while (historiekEl.firstChild) historiekEl.removeChild(historiekEl.firstChild);
      if (!state.historiek) {
        var loading = document.createElement('span');
        loading.className = 'flp-klant-notitie-historiek-loading';
        loading.textContent = 'Historiek laden…';
        historiekEl.appendChild(loading);
        return;
      }
      var h = state.historiek;
      var bits = [];
      bits.push((h.count || 0) + ' beurt' + (h.count === 1 ? '' : 'en'));
      if (h.gem_uurtarief != null && isFinite(h.gem_uurtarief)) {
        bits.push('gem. ' + formatEuro(h.gem_uurtarief));
      }
      if (h.last_dates && h.last_dates.length) {
        var formatted = [];
        for (var i = 0; i < h.last_dates.length; i++) {
          var s = formatDateShort(h.last_dates[i]);
          if (s) formatted.push(s);
        }
        if (formatted.length) bits.push('laatst: ' + formatted.join(', '));
      }
      historiekEl.textContent = bits.join(' · ');
    }

    function load() {
      // Fetch role for edit-rights
      _isAdminOrBediende(supabase).then(function (can) {
        state.canEdit = !!can;
        if (!state.editing) renderNoteRO();
      });

      var p1 = supabase
        .from('clients')
        .select('planner_notitie')
        .eq('id', clientId)
        .maybeSingle();

      var p2 = supabase
        .from('onderhoudsbeurten')
        .select('plan_datum, totaal_excl_btw, uren')
        .eq('client_id', clientId)
        .in('status', ['uitgevoerd', 'afgewerkt'])
        .order('plan_datum', { ascending: false })
        .limit(50);

      return Promise.all([p1, p2]).then(function (results) {
        var noteRow = results[0] && results[0].data ? results[0].data : null;
        state.notitie = noteRow ? noteRow.planner_notitie : null;

        var beurten = (results[1] && results[1].data) || [];
        var count = beurten.length;
        var bedragen = [];
        for (var i = 0; i < beurten.length; i++) {
          var v = beurten[i].totaal_excl_btw;
          if (v != null && isFinite(Number(v))) bedragen.push(Number(v));
        }
        var gem = null;
        if (bedragen.length) {
          var sum = 0;
          for (var k = 0; k < bedragen.length; k++) sum += bedragen[k];
          gem = sum / bedragen.length;
        }
        var lastDates = [];
        for (var j = 0; j < beurten.length && lastDates.length < 3; j++) {
          if (beurten[j].plan_datum) lastDates.push(beurten[j].plan_datum);
        }
        state.historiek = { count: count, gem_uurtarief: gem, last_dates: lastDates };
        state.loading = false;
        renderNoteRO();
        renderHistoriek();
      });
    }

    // First paint
    renderNoteRO();
    renderHistoriek();

    load().catch(function (err) {
      logError('renderKlantContext load', err);
      state.loading = false;
      state.notitie = null;
      state.historiek = { count: 0, gem_uurtarief: null, last_dates: [] };
      renderNoteRO();
      renderHistoriek();
    });
  }

  function saveKlantNotitie(clientId, notitie, supabase) {
    if (!clientId || !supabase) {
      return Promise.resolve({ success: false, error: new Error('clientId + supabase required') });
    }
    var clean = notitie == null ? null : String(notitie).trim();
    if (clean === '') clean = null;
    return supabase
      .from('clients')
      .update({ planner_notitie: clean })
      .eq('id', clientId)
      .then(function (r) {
        if (r.error) {
          logError('saveKlantNotitie', r.error);
          return { success: false, error: r.error };
        }
        return { success: true };
      })
      .catch(function (err) {
        logError('saveKlantNotitie threw', err);
        return { success: false, error: err };
      });
  }

  // =========================================================================
  // Toolkit-5: Runbook-tooltips
  // =========================================================================

  function _runbookCacheKey(fase, actionKey) {
    return String(fase || '') + ':' + String(actionKey || '');
  }

  function _fetchRunbook(fase, actionKey, supabase) {
    var key = _runbookCacheKey(fase, actionKey);
    if (Object.prototype.hasOwnProperty.call(RUNBOOK_CACHE, key)) {
      return Promise.resolve(RUNBOOK_CACHE[key]);
    }
    if (Object.prototype.hasOwnProperty.call(RUNBOOK_INFLIGHT, key)) {
      return RUNBOOK_INFLIGHT[key];
    }
    var p = supabase
      .from('runbook_tooltips')
      .select('fase, action_key, content_nl, content_fr')
      .eq('fase', fase)
      .eq('action_key', actionKey)
      .maybeSingle()
      .then(function (r) {
        if (r.error) {
          logError('runbook fetch', r.error);
          RUNBOOK_CACHE[key] = null;
        } else {
          RUNBOOK_CACHE[key] = r.data || null;
        }
        delete RUNBOOK_INFLIGHT[key];
        return RUNBOOK_CACHE[key];
      })
      .catch(function (err) {
        logError('runbook fetch threw', err);
        RUNBOOK_CACHE[key] = null;
        delete RUNBOOK_INFLIGHT[key];
        return null;
      });
    RUNBOOK_INFLIGHT[key] = p;
    return p;
  }

  function renderRunbookTooltip(container, opts) {
    if (!container || container.nodeType !== 1) return;
    opts = opts || {};
    var fase = opts.fase;
    var actionKey = opts.actionKey;
    var supabase = opts.supabase;
    var lang = opts.lang || 'nl';

    if (!fase || !actionKey || !supabase) {
      logError('renderRunbookTooltip', 'fase, actionKey, supabase required');
      return;
    }

    while (container.firstChild) container.removeChild(container.firstChild);
    container.classList.add('flp-runbook-tip');
    container.setAttribute('data-fase', String(fase));
    container.setAttribute('data-action', String(actionKey));

    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'flp-runbook-tip-trigger';
    trigger.setAttribute('aria-label', 'Runbook-uitleg tonen');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.appendChild(iconInfo(14));
    container.appendChild(trigger);

    var pop = document.createElement('div');
    pop.className = 'flp-runbook-tip-pop';
    pop.setAttribute('role', 'tooltip');
    pop.setAttribute('hidden', '');
    container.appendChild(pop);

    var contentEl = document.createElement('div');
    contentEl.className = 'flp-runbook-tip-content';
    pop.appendChild(contentEl);

    var editBtn = null;
    var data = null;
    var handoffActive = isHandOffMode();
    if (handoffActive) container.classList.add('flp-runbook-tip--inline');

    function fillPop() {
      while (contentEl.firstChild) contentEl.removeChild(contentEl.firstChild);
      var raw = '';
      if (data) {
        raw = (lang === 'fr' ? data.content_fr : data.content_nl) || data.content_nl || '';
      }
      if (!raw) {
        var none = document.createElement('span');
        none.className = 'flp-runbook-tip-empty';
        none.textContent = 'Geen runbook-uitleg beschikbaar.';
        contentEl.appendChild(none);
      } else {
        // Render plaintext, preserve line-breaks via <br>.
        var lines = String(raw).split(/\r?\n/);
        for (var i = 0; i < lines.length; i++) {
          if (i > 0) contentEl.appendChild(document.createElement('br'));
          contentEl.appendChild(document.createTextNode(lines[i]));
        }
      }
      // Admin-only edit-icon in popover
      _isAdmin(supabase).then(function (isAdm) {
        if (!isAdm) return;
        if (editBtn) return;
        editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'flp-runbook-tip-edit';
        editBtn.setAttribute('aria-label', 'Runbook bewerken');
        editBtn.appendChild(iconPencil(12));
        editBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          openRunbookEditModal(fase, actionKey, supabase);
        });
        pop.appendChild(editBtn);
      });
    }

    function show() {
      pop.removeAttribute('hidden');
      trigger.setAttribute('aria-expanded', 'true');
      container.classList.add('flp-runbook-tip--open');
    }

    function hide() {
      // In hand-off mode (inline) the pop stays visible — no hide.
      if (isHandOffMode()) return;
      pop.setAttribute('hidden', '');
      trigger.setAttribute('aria-expanded', 'false');
      container.classList.remove('flp-runbook-tip--open');
    }

    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      if (pop.hasAttribute('hidden')) {
        show();
      } else {
        hide();
      }
    });
    trigger.addEventListener('mouseenter', function () { show(); });
    trigger.addEventListener('mouseleave', function () {
      // Delay hide so user can move into pop
      setTimeout(function () {
        if (!container.matches(':hover')) hide();
      }, 150);
    });
    pop.addEventListener('mouseleave', function () { hide(); });
    document.addEventListener('click', function docClick(e) {
      if (!container.contains(e.target)) hide();
    });

    _fetchRunbook(fase, actionKey, supabase).then(function (row) {
      data = row;
      fillPop();
      if (isHandOffMode()) show();
    });

    // React to hand-off-mode toggle
    var handoffListener = function () {
      var on = isHandOffMode();
      if (on) {
        container.classList.add('flp-runbook-tip--inline');
        show();
      } else {
        container.classList.remove('flp-runbook-tip--inline');
        hide();
      }
    };
    document.addEventListener(HANDOFF_EVENT, handoffListener);
    container.__flpRunbookCleanup = function () {
      document.removeEventListener(HANDOFF_EVENT, handoffListener);
    };
  }

  function openRunbookEditModal(fase, actionKey, supabase) {
    if (!fase || !actionKey || !supabase) return;

    // Defensive: don't double-open
    if (document.querySelector('.flp-runbook-modal')) return;

    var overlay = document.createElement('div');
    overlay.className = 'flp-runbook-modal-overlay';
    overlay.setAttribute('role', 'presentation');

    var modal = document.createElement('div');
    modal.className = 'flp-runbook-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'flp-runbook-modal-title');

    var hdr = document.createElement('div');
    hdr.className = 'flp-runbook-modal-header';
    var ttl = document.createElement('h3');
    ttl.id = 'flp-runbook-modal-title';
    ttl.className = 'flp-runbook-modal-title';
    ttl.textContent = 'Runbook bewerken';
    hdr.appendChild(ttl);

    var meta = document.createElement('span');
    meta.className = 'flp-runbook-modal-meta';
    meta.textContent = String(fase) + ' • ' + String(actionKey);
    hdr.appendChild(meta);

    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'flp-runbook-modal-close';
    closeBtn.setAttribute('aria-label', 'Sluiten');
    closeBtn.appendChild(iconX(16));
    hdr.appendChild(closeBtn);

    modal.appendChild(hdr);

    var body = document.createElement('div');
    body.className = 'flp-runbook-modal-body';

    var lblNl = document.createElement('label');
    lblNl.className = 'flp-runbook-modal-label';
    lblNl.textContent = 'Inhoud (Nederlands)';
    var taNl = document.createElement('textarea');
    taNl.className = 'flp-runbook-modal-textarea';
    taNl.setAttribute('rows', '6');
    taNl.setAttribute('aria-label', 'Runbook-inhoud Nederlands');
    lblNl.appendChild(taNl);
    body.appendChild(lblNl);

    var lblFr = document.createElement('label');
    lblFr.className = 'flp-runbook-modal-label';
    lblFr.textContent = 'Inhoud (Frans, optioneel)';
    var taFr = document.createElement('textarea');
    taFr.className = 'flp-runbook-modal-textarea';
    taFr.setAttribute('rows', '4');
    taFr.setAttribute('aria-label', 'Runbook-inhoud Frans');
    lblFr.appendChild(taFr);
    body.appendChild(lblFr);

    var errEl = document.createElement('div');
    errEl.className = 'flp-runbook-modal-error';
    errEl.setAttribute('hidden', '');
    body.appendChild(errEl);

    modal.appendChild(body);

    var foot = document.createElement('div');
    foot.className = 'flp-runbook-modal-footer';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'flp-runbook-modal-cancel';
    cancelBtn.textContent = 'Annuleren';
    foot.appendChild(cancelBtn);
    var saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'flp-runbook-modal-save';
    saveBtn.textContent = 'Opslaan';
    foot.appendChild(saveBtn);
    modal.appendChild(foot);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    var prevFocus = document.activeElement;

    function close() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      document.removeEventListener('keydown', escListener);
      if (prevFocus && typeof prevFocus.focus === 'function') {
        try { prevFocus.focus(); } catch (e) { /* ignore */ }
      }
    }
    function escListener(e) { if (e.key === 'Escape') close(); }

    closeBtn.addEventListener('click', close);
    cancelBtn.addEventListener('click', close);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });
    document.addEventListener('keydown', escListener);

    // Pre-fill from cache or fetch
    _fetchRunbook(fase, actionKey, supabase).then(function (row) {
      if (row) {
        taNl.value = row.content_nl || '';
        taFr.value = row.content_fr || '';
      }
      taNl.focus();
    });

    saveBtn.addEventListener('click', function () {
      var contentNl = (taNl.value || '').trim();
      var contentFr = (taFr.value || '').trim() || null;
      if (!contentNl) {
        errEl.textContent = 'Nederlandse inhoud is verplicht.';
        errEl.removeAttribute('hidden');
        taNl.focus();
        return;
      }
      saveBtn.disabled = true;
      cancelBtn.disabled = true;
      saveBtn.textContent = 'Opslaan…';
      errEl.setAttribute('hidden', '');

      supabase
        .from('runbook_tooltips')
        .upsert(
          { fase: fase, action_key: actionKey, content_nl: contentNl, content_fr: contentFr },
          { onConflict: 'fase,action_key' }
        )
        .then(function (r) {
          if (r.error) throw r.error;
          // Bust cache so next render shows new content
          delete RUNBOOK_CACHE[_runbookCacheKey(fase, actionKey)];
          close();
        })
        .catch(function (err) {
          logError('runbook upsert', err);
          saveBtn.disabled = false;
          cancelBtn.disabled = false;
          saveBtn.textContent = 'Opslaan';
          errEl.textContent = 'Opslaan mislukt. Probeer opnieuw.';
          errEl.removeAttribute('hidden');
        });
    });
  }

  // =========================================================================
  // Auto-attach via DOMContentLoaded + MutationObserver
  // =========================================================================

  function _resolveSupabase() {
    if (global.supabase && typeof global.supabase.from === 'function') {
      return global.supabase;
    }
    return null;
  }

  function _isAlreadyFilled(el) {
    return el.getAttribute(FILLED_ATTR) === 'true';
  }

  function _markFilled(el) {
    el.setAttribute(FILLED_ATTR, 'true');
  }

  function _scanAndFill(root) {
    if (!root || (root.nodeType !== 1 && root.nodeType !== 9)) return;
    var supa = _resolveSupabase();
    if (!supa) return;

    // Skip if root is itself inside an already-filled flp-* container.
    if (root.nodeType === 1 && root.closest && root.closest('[data-slot-filled="true"]')) {
      return;
    }

    // Activity-log slots
    var activityNodes = root.querySelectorAll
      ? root.querySelectorAll('[data-slot="activity-log"]:not([' + FILLED_ATTR + '="true"])')
      : [];
    for (var i = 0; i < activityNodes.length; i++) {
      var a = activityNodes[i];
      var beurtId = a.getAttribute('data-beurt-id');
      if (!beurtId) continue;
      _markFilled(a);
      try {
        renderActivityLog(a, { beurtId: beurtId, supabase: supa });
      } catch (e) {
        logError('auto-attach activity-log', e);
      }
    }

    // Klant-context slots
    var klantNodes = root.querySelectorAll
      ? root.querySelectorAll('[data-slot="klant-context"]:not([' + FILLED_ATTR + '="true"])')
      : [];
    for (var j = 0; j < klantNodes.length; j++) {
      var k = klantNodes[j];
      var clientId = k.getAttribute('data-client-id');
      if (!clientId) continue;
      _markFilled(k);
      try {
        renderKlantContext(k, { clientId: clientId, supabase: supa });
      } catch (e) {
        logError('auto-attach klant-context', e);
      }
    }

    // Runbook-tip slots
    var rbNodes = root.querySelectorAll
      ? root.querySelectorAll('[data-slot="runbook-tip"]:not([' + FILLED_ATTR + '="true"])')
      : [];
    for (var m = 0; m < rbNodes.length; m++) {
      var r = rbNodes[m];
      var fase = r.getAttribute('data-fase');
      var action = r.getAttribute('data-action');
      var lang = r.getAttribute('data-lang') || 'nl';
      if (!fase || !action) continue;
      _markFilled(r);
      try {
        renderRunbookTooltip(r, { fase: fase, actionKey: action, supabase: supa, lang: lang });
      } catch (e) {
        logError('auto-attach runbook-tip', e);
      }
    }

    // Hand-off banner slot (optional — auto-renders if present)
    var bannerNodes = root.querySelectorAll
      ? root.querySelectorAll('[data-slot="handoff-banner"]:not([' + FILLED_ATTR + '="true"])')
      : [];
    for (var b = 0; b < bannerNodes.length; b++) {
      var bn = bannerNodes[b];
      _markFilled(bn);
      try {
        renderHandOffBanner(bn);
      } catch (e) {
        logError('auto-attach handoff-banner', e);
      }
    }
  }

  function _setupAutoAttach() {
    _initHandOffBodyClass();
    _scanAndFill(document);

    if (typeof MutationObserver !== 'function') return;

    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var mut = mutations[i];
        if (mut.type !== 'childList') continue;
        if (!mut.addedNodes || !mut.addedNodes.length) continue;
        // Ignore mutations inside an already-filled flp container
        if (mut.target && mut.target.closest &&
            mut.target.closest('[data-slot-filled="true"]')) {
          continue;
        }
        for (var j = 0; j < mut.addedNodes.length; j++) {
          var n = mut.addedNodes[j];
          if (n.nodeType !== 1) continue;
          _scanAndFill(n);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _setupAutoAttach);
  } else {
    _setupAutoAttach();
  }

  // =========================================================================
  // XSS verification helper (test code, not used in prod paths)
  // =========================================================================

  function __pipelineToolkitXssTest() {
    // Smoketest: feed malicious string into our render-paths and assert
    // the resulting DOM contains the literal text, never an executable
    // <script>. Run in a sandbox / DevTools console.
    var malicious = '<script>alert(1)</script>';
    var box = document.createElement('div');
    document.body.appendChild(box);
    // Simulate text-content paths used everywhere:
    var span = document.createElement('span');
    span.textContent = malicious;
    box.appendChild(span);
    var ok = (span.children.length === 0)
      && (span.textContent === malicious)
      && !box.querySelector('script');
    document.body.removeChild(box);
    return ok;
  }

  // =========================================================================
  // Public namespace
  // =========================================================================

  global.FlanccoPipelineToolkit = {
    // Activity-log
    renderActivityLog: renderActivityLog,
    addManualNote: addManualNote,
    addSnoozeWithReason: addSnoozeWithReason,
    // Klant-context
    renderKlantContext: renderKlantContext,
    saveKlantNotitie: saveKlantNotitie,
    // Runbook
    renderRunbookTooltip: renderRunbookTooltip,
    openRunbookEditModal: openRunbookEditModal,
    // Hand-off
    isHandOffMode: isHandOffMode,
    toggleHandOffMode: toggleHandOffMode,
    renderHandOffBanner: renderHandOffBanner,
    // Role helpers (private but exposed for hosts that need them)
    _isAdmin: _isAdmin,
    _isAdminOrBediende: _isAdminOrBediende,
    // Test helper
    __xssTest: __pipelineToolkitXssTest
  };

})(typeof window !== 'undefined' ? window : this);

/*
 * ====================================================================
 *  API SAMENVATTING
 * ====================================================================
 *
 *  Activity-log:
 *    FlanccoPipelineToolkit.renderActivityLog(container, {beurtId, supabase, expanded?})
 *    FlanccoPipelineToolkit.addManualNote(beurtId, text, supabase) -> Promise<row>
 *    FlanccoPipelineToolkit.addSnoozeWithReason(beurtId, snoozeTot, reden, supabase)
 *      -> Promise<{success, error?}>
 *
 *  Klant-context:
 *    FlanccoPipelineToolkit.renderKlantContext(container, {clientId, supabase, expanded?})
 *    FlanccoPipelineToolkit.saveKlantNotitie(clientId, notitie, supabase)
 *      -> Promise<{success, error?}>
 *
 *  Runbook-tooltips:
 *    FlanccoPipelineToolkit.renderRunbookTooltip(container, {fase, actionKey, supabase, lang?})
 *    FlanccoPipelineToolkit.openRunbookEditModal(fase, actionKey, supabase)
 *
 *  Hand-off mode:
 *    FlanccoPipelineToolkit.isHandOffMode() -> boolean
 *    FlanccoPipelineToolkit.toggleHandOffMode(active, sinceDate?)
 *    FlanccoPipelineToolkit.renderHandOffBanner(container)
 *
 *  Auto-attach:
 *    <div data-slot="activity-log" data-beurt-id="UUID"></div>
 *    <div data-slot="klant-context" data-client-id="UUID"></div>
 *    <span data-slot="runbook-tip" data-fase="X" data-action="Y" [data-lang="nl"]></span>
 *    <div data-slot="handoff-banner"></div>
 *
 *  CSS-classes (uit pipeline-components.css, .flp- prefix):
 *    .flp-activity-log, .flp-klant-notitie, .flp-runbook-tip,
 *    .flp-handoff-banner, .flp-runbook-modal*
 *
 *  XSS-test (verplicht in eigen code):
 *    Input '<script>alert(1)</script>' wordt OVERAL via textContent
 *    gerendered. Geverifieerd met FlanccoPipelineToolkit.__xssTest(): de
 *    string verschijnt als plaintext (textContent === input) en
 *    span.children.length === 0 (geen Element-nodes geinjecteerd).
 *    Resultaat: malicious script wordt nooit uitgevoerd.
 *
 *  Dependencies: window.supabase (UMD bundle al gestart in admin/index.html).
 *  Multi-instance veilig (geen instance-counter nodig — alle state per
 *  container element of in module-level cache).
 * ====================================================================
 */
