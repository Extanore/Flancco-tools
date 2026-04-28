/*
 * Flancco Werklocatie Picker — kies-kaart UI voor multi-locatie klanten.
 *
 * Slot T Spoor C: wanneer een klant meerdere werklocaties heeft, MOET de
 * gebruiker er één kiezen vóór save (losse opdracht / interventie / contract /
 * bouwdroger uitgeven). Single-locatie klanten: auto-select primary, geen UI-
 * prompt.
 *
 * Vanilla JS, geen build-tooling. Laad via:
 *   <link rel="stylesheet" href="/admin/shared/werklocatie-picker.css">
 *   <script src="/admin/shared/werklocatie-picker.js"></script>
 *
 * Zie API-doc onderaan dit bestand of in admin/shared/werklocatie-picker-demo.html.
 */
(function (global) {
  'use strict';

  // ------ Module-level state -------------------------------------------------

  var INSTANCE_COUNTER = 0;

  // ------ Utilities ----------------------------------------------------------

  /** Trim helper that returns '' for null/undefined/non-string. */
  function safeStr(v) {
    if (v == null) return '';
    var s = String(v);
    return s;
  }

  /** Filter the location-cache down to rows matching `clientId`. */
  function filterByClient(allLocations, clientId) {
    if (!Array.isArray(allLocations) || !clientId) return [];
    var out = [];
    for (var i = 0; i < allLocations.length; i++) {
      var row = allLocations[i];
      if (row && row.client_id === clientId) out.push(row);
    }
    return out;
  }

  /**
   * Order locations so primary comes first, then by label asc (case/accent-
   * insensitive), with rows lacking labels coming last.
   */
  function sortLocations(locations) {
    var copy = locations.slice();
    copy.sort(function (a, b) {
      var ap = a && a.is_primary ? 1 : 0;
      var bp = b && b.is_primary ? 1 : 0;
      if (ap !== bp) return bp - ap;
      var al = safeStr(a && a.label).toLowerCase();
      var bl = safeStr(b && b.label).toLowerCase();
      if (!al && bl) return 1;
      if (al && !bl) return -1;
      if (al < bl) return -1;
      if (al > bl) return 1;
      return 0;
    });
    return copy;
  }

  /** Compose street + house number, trimming nulls. */
  function formatStreetLine(loc) {
    if (!loc) return '';
    var street = safeStr(loc.street).trim();
    var hn = safeStr(loc.house_number).trim();
    if (street && hn) return street + ' ' + hn;
    return street || hn;
  }

  /** Compose postal code + city, trimming nulls. */
  function formatPlaceLine(loc) {
    if (!loc) return '';
    var pc = safeStr(loc.postal_code).trim();
    var city = safeStr(loc.city).trim();
    if (pc && city) return pc + ' ' + city;
    return pc || city;
  }

  /** Lucide map-pin (16px) icon used for single-locatie summary + empty-state. */
  function mapPinSvg(size) {
    var s = size || 16;
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'fwp-icon');
    svg.setAttribute('width', String(s));
    svg.setAttribute('height', String(s));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    var paths = [
      ['path',   { d: 'M20 10c0 7-8 13-8 13s-8-6-8-13a8 8 0 0 1 16 0Z' }],
      ['circle', { cx: '12', cy: '10', r: '3' }]
    ];
    for (var i = 0; i < paths.length; i++) {
      var el = document.createElementNS('http://www.w3.org/2000/svg', paths[i][0]);
      var attrs = paths[i][1];
      for (var k in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, k)) el.setAttribute(k, attrs[k]);
      }
      svg.appendChild(el);
    }
    return svg;
  }

  /** Lucide plus (16px) icon used for "+ Nieuwe werklocatie"-button. */
  function plusSvg() {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'fwp-card-add-icon');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    var l1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    l1.setAttribute('x1', '12'); l1.setAttribute('y1', '5');
    l1.setAttribute('x2', '12'); l1.setAttribute('y2', '19');
    var l2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    l2.setAttribute('x1', '5');  l2.setAttribute('y1', '12');
    l2.setAttribute('x2', '19'); l2.setAttribute('y2', '12');
    svg.appendChild(l1);
    svg.appendChild(l2);
    return svg;
  }

  // ------ Picker instance ----------------------------------------------------

  function Picker(wrapperEl, options) {
    if (!wrapperEl || wrapperEl.nodeType !== 1) {
      throw new Error('FlanccoWerklocatiePicker.attach: wrapperEl must be an Element');
    }
    options = options || {};

    this._wrapper = wrapperEl;
    this._uid = ++INSTANCE_COUNTER;
    this._allLocations = Array.isArray(options.allClientLocations) ? options.allClientLocations.slice() : [];
    this._clientId = options.clientId != null ? options.clientId : null;
    this._allowNew = options.allowNew === true;
    this._autoSelectIfSingle = options.autoSelectIfSingle !== false; // default true
    this._onChange = typeof options.onChange === 'function' ? options.onChange : null;
    this._onAddNew = typeof options.onAddNew === 'function' ? options.onAddNew : null;

    this._value = options.initialValue != null ? options.initialValue : null;
    this._destroyed = false;
    this._cardEls = [];        // [{ el, location, index }]
    this._addBtn = null;
    this._liveRegion = null;
    this._onCardClickBound = this._handleCardClick.bind(this);
    this._onCardKeyBound = this._handleCardKey.bind(this);
    this._onAddClickBound = this._handleAddClick.bind(this);
    this._onAddKeyBound = this._handleAddKey.bind(this);

    this._build();
    this._render();
  }

  // ------ DOM construction ---------------------------------------------------

  Picker.prototype._build = function () {
    var wrapper = this._wrapper;
    while (wrapper.firstChild) wrapper.removeChild(wrapper.firstChild);
    wrapper.classList.add('fwp');

    // Live region for screen-reader announcements (always present, hidden).
    var live = document.createElement('div');
    live.id = 'fwp-live-' + this._uid;
    live.className = 'fwp-sr-only';
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('aria-atomic', 'true');
    wrapper.appendChild(live);
    this._liveRegion = live;

    // Body container: rebuilt fully on _render (cheap with at most ~20 locations).
    var body = document.createElement('div');
    body.className = 'fwp-body';
    wrapper.appendChild(body);
    this._body = body;
  };

  // ------ Render -------------------------------------------------------------

  Picker.prototype._render = function () {
    if (this._destroyed) return;
    this._teardownCardListeners();
    this._cardEls = [];
    this._addBtn = null;

    var body = this._body;
    while (body.firstChild) body.removeChild(body.firstChild);

    var locations = sortLocations(filterByClient(this._allLocations, this._clientId));

    // -- 0 locaties: empty-state -------------------------------------------
    if (locations.length === 0) {
      this._renderEmpty(body);
      // Clear current value when the underlying location list became empty.
      if (this._value !== null) {
        this._value = null;
        this._fireChange(null, null);
      }
      return;
    }

    // -- 1 locatie + autoSelectIfSingle: render summary, auto-select -------
    if (locations.length === 1 && this._autoSelectIfSingle) {
      var only = locations[0];
      this._renderSummary(body, only);
      if (this._value !== only.id) {
        this._value = only.id;
        this._fireChange(only.id, only);
      }
      return;
    }

    // -- Multi-locatie OR autoSelectIfSingle disabled: render grid ---------
    this._renderGrid(body, locations);

    // If the current value is no longer in this client's list, drop it.
    if (this._value != null) {
      var stillValid = false;
      for (var i = 0; i < locations.length; i++) {
        if (locations[i].id === this._value) { stillValid = true; break; }
      }
      if (!stillValid) {
        this._value = null;
        this._fireChange(null, null);
        this._refreshAriaChecked();
      }
    }
  };

  Picker.prototype._renderSummary = function (body, location) {
    var summary = document.createElement('div');
    summary.className = 'fwp-summary';
    summary.appendChild(mapPinSvg(16));
    var iconWrap = summary.lastChild;
    iconWrap.classList.add('fwp-summary-icon');

    var sBody = document.createElement('div');
    sBody.className = 'fwp-summary-body';

    var sLabel = document.createElement('span');
    sLabel.className = 'fwp-summary-label';
    sLabel.textContent = safeStr(location.label) || 'Werklocatie';
    sBody.appendChild(sLabel);

    var addr = formatStreetLine(location);
    var place = formatPlaceLine(location);
    var combined = [addr, place].filter(function (x) { return !!x; }).join(', ');
    if (combined) {
      var sAddr = document.createElement('span');
      sAddr.className = 'fwp-summary-address';
      sAddr.textContent = combined;
      sBody.appendChild(sAddr);
    }

    summary.appendChild(sBody);
    body.appendChild(summary);
  };

  Picker.prototype._renderGrid = function (body, locations) {
    var grid = document.createElement('div');
    grid.className = 'fwp-grid';
    grid.setAttribute('role', 'radiogroup');
    grid.setAttribute('aria-label', 'Werklocatie kiezen');

    // Determine focusable card: active value if present, else first.
    var activeIdx = 0;
    for (var i = 0; i < locations.length; i++) {
      if (this._value != null && locations[i].id === this._value) { activeIdx = i; break; }
    }

    for (var j = 0; j < locations.length; j++) {
      var loc = locations[j];
      var checked = (this._value === loc.id);
      var card = this._buildCard(loc, checked, j === activeIdx);
      grid.appendChild(card);
      this._cardEls.push({ el: card, location: loc, index: j });
    }

    if (this._allowNew) {
      var add = this._buildAddCard();
      grid.appendChild(add);
      this._addBtn = add;
    }

    body.appendChild(grid);
    this._setupCardListeners();
  };

  Picker.prototype._buildCard = function (loc, isChecked, isFocusable) {
    var card = document.createElement('div');
    card.className = 'fwp-card';
    card.setAttribute('role', 'radio');
    card.setAttribute('aria-checked', isChecked ? 'true' : 'false');
    card.tabIndex = isFocusable ? 0 : -1;
    card.setAttribute('data-location-id', safeStr(loc.id));

    var header = document.createElement('div');
    header.className = 'fwp-card-header';

    var lbl = document.createElement('span');
    lbl.className = 'fwp-card-label';
    var labelText = safeStr(loc.label).trim();
    lbl.textContent = labelText || 'Locatie zonder naam';
    header.appendChild(lbl);

    if (loc.is_primary) {
      var badge = document.createElement('span');
      badge.className = 'fwp-badge-primary';
      badge.textContent = 'Primair';
      badge.setAttribute('aria-label', 'Primaire locatie');
      header.appendChild(badge);
    }
    card.appendChild(header);

    var addrLine = formatStreetLine(loc);
    var placeLine = formatPlaceLine(loc);

    if (!addrLine && !placeLine) {
      var emptyAddr = document.createElement('span');
      emptyAddr.className = 'fwp-card-empty';
      emptyAddr.textContent = 'Geen adres ingevuld';
      card.appendChild(emptyAddr);
    } else {
      if (addrLine) {
        var addrEl = document.createElement('span');
        addrEl.className = 'fwp-card-address';
        addrEl.textContent = addrLine;
        card.appendChild(addrEl);
      }
      if (placeLine) {
        var placeEl = document.createElement('span');
        placeEl.className = 'fwp-card-place';
        placeEl.textContent = placeLine;
        card.appendChild(placeEl);
      }
    }

    return card;
  };

  Picker.prototype._buildAddCard = function () {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fwp-card-add';
    btn.appendChild(plusSvg());
    var lbl = document.createElement('span');
    lbl.textContent = 'Nieuwe werklocatie';
    btn.appendChild(lbl);
    btn.setAttribute('aria-label', 'Nieuwe werklocatie toevoegen');
    return btn;
  };

  Picker.prototype._renderEmpty = function (body) {
    var box = document.createElement('div');
    box.className = 'fwp-empty';

    var icon = mapPinSvg(28);
    icon.classList.add('fwp-empty-icon');
    box.appendChild(icon);

    var p = document.createElement('p');
    p.className = 'fwp-empty-text';
    p.textContent = 'Deze klant heeft geen werklocaties geregistreerd. Voeg er één toe via klant-beheer.';
    box.appendChild(p);

    if (this._allowNew) {
      var add = this._buildAddCard();
      box.appendChild(add);
      this._addBtn = add;
    }

    body.appendChild(box);
    this._setupCardListeners();
  };

  // ------ Event listeners ----------------------------------------------------

  Picker.prototype._setupCardListeners = function () {
    for (var i = 0; i < this._cardEls.length; i++) {
      var card = this._cardEls[i].el;
      card.addEventListener('click', this._onCardClickBound);
      card.addEventListener('keydown', this._onCardKeyBound);
    }
    if (this._addBtn) {
      this._addBtn.addEventListener('click', this._onAddClickBound);
      this._addBtn.addEventListener('keydown', this._onAddKeyBound);
    }
  };

  Picker.prototype._teardownCardListeners = function () {
    for (var i = 0; i < this._cardEls.length; i++) {
      var card = this._cardEls[i].el;
      card.removeEventListener('click', this._onCardClickBound);
      card.removeEventListener('keydown', this._onCardKeyBound);
    }
    if (this._addBtn) {
      this._addBtn.removeEventListener('click', this._onAddClickBound);
      this._addBtn.removeEventListener('keydown', this._onAddKeyBound);
    }
  };

  Picker.prototype._handleCardClick = function (e) {
    var card = e.currentTarget;
    var id = card.getAttribute('data-location-id');
    if (id) this._selectId(id, /*announce*/ true);
  };

  Picker.prototype._handleCardKey = function (e) {
    var key = e.key;
    if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
      e.preventDefault();
      var id = e.currentTarget.getAttribute('data-location-id');
      if (id) this._selectId(id, true);
      return;
    }
    if (key === 'ArrowDown' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowLeft') {
      e.preventDefault();
      this._moveFocus(e.currentTarget, key);
      return;
    }
    if (key === 'Home') {
      e.preventDefault();
      if (this._cardEls.length > 0) this._focusCard(0);
      return;
    }
    if (key === 'End') {
      e.preventDefault();
      if (this._cardEls.length > 0) this._focusCard(this._cardEls.length - 1);
      return;
    }
  };

  Picker.prototype._handleAddClick = function () {
    if (this._onAddNew) {
      try { this._onAddNew(); } catch (err) {
        if (typeof console !== 'undefined' && console && typeof console.error === 'function') {
          console.error('FlanccoWerklocatiePicker onAddNew threw:', err);
        }
      }
    }
  };

  Picker.prototype._handleAddKey = function (e) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      this._handleAddClick();
    }
  };

  Picker.prototype._moveFocus = function (currentEl, key) {
    var idx = -1;
    for (var i = 0; i < this._cardEls.length; i++) {
      if (this._cardEls[i].el === currentEl) { idx = i; break; }
    }
    if (idx === -1) return;
    var delta = (key === 'ArrowDown' || key === 'ArrowRight') ? 1 : -1;
    var nextIdx = idx + delta;
    if (nextIdx < 0) nextIdx = this._cardEls.length - 1;
    if (nextIdx >= this._cardEls.length) nextIdx = 0;
    this._focusCard(nextIdx);
  };

  Picker.prototype._focusCard = function (index) {
    if (index < 0 || index >= this._cardEls.length) return;
    // Update tabindexes so only the focused card is in tab order.
    for (var i = 0; i < this._cardEls.length; i++) {
      this._cardEls[i].el.tabIndex = (i === index) ? 0 : -1;
    }
    this._cardEls[index].el.focus();
  };

  // ------ Selection ----------------------------------------------------------

  Picker.prototype._selectId = function (id, announce) {
    var locations = sortLocations(filterByClient(this._allLocations, this._clientId));
    var found = null;
    for (var i = 0; i < locations.length; i++) {
      if (locations[i].id === id) { found = locations[i]; break; }
    }
    if (!found) return;
    if (this._value === found.id) {
      // Already selected — still focus the card for keyboard flow consistency.
      this._refreshAriaChecked();
      return;
    }
    this._value = found.id;
    this._refreshAriaChecked();
    this._fireChange(found.id, found);
    if (announce && this._liveRegion) {
      var lbl = safeStr(found.label).trim() || 'werklocatie';
      this._liveRegion.textContent = 'Locatie geselecteerd: ' + lbl;
    }
  };

  Picker.prototype._refreshAriaChecked = function () {
    var focusableSet = false;
    for (var i = 0; i < this._cardEls.length; i++) {
      var entry = this._cardEls[i];
      var checked = (entry.location.id === this._value);
      entry.el.setAttribute('aria-checked', checked ? 'true' : 'false');
      if (checked) {
        entry.el.tabIndex = 0;
        focusableSet = true;
      } else {
        entry.el.tabIndex = -1;
      }
    }
    // Ensure at least one card is focusable when no value is set.
    if (!focusableSet && this._cardEls.length > 0) {
      this._cardEls[0].el.tabIndex = 0;
    }
  };

  Picker.prototype._fireChange = function (id, location) {
    if (!this._onChange) return;
    try {
      this._onChange(id, location);
    } catch (err) {
      if (typeof console !== 'undefined' && console && typeof console.error === 'function') {
        console.error('FlanccoWerklocatiePicker onChange threw:', err);
      }
    }
  };

  // ------ Public methods -----------------------------------------------------

  Picker.prototype.setClient = function (clientId) {
    if (this._destroyed) return;
    if (clientId === this._clientId) return;
    this._clientId = clientId != null ? clientId : null;
    this._value = null;
    this._render();
  };

  Picker.prototype.setLocations = function (newAllLocations) {
    if (this._destroyed) return;
    this._allLocations = Array.isArray(newAllLocations) ? newAllLocations.slice() : [];
    this._render();
  };

  Picker.prototype.setValue = function (locationId) {
    if (this._destroyed) return;
    if (locationId == null) {
      this.clear();
      return;
    }
    // Verify it belongs to current client.
    var locations = filterByClient(this._allLocations, this._clientId);
    var found = null;
    for (var i = 0; i < locations.length; i++) {
      if (locations[i].id === locationId) { found = locations[i]; break; }
    }
    if (!found) return;
    if (this._value === found.id) return;
    this._value = found.id;
    this._refreshAriaChecked();
    this._fireChange(found.id, found);
  };

  Picker.prototype.getValue = function () {
    return this._value;
  };

  Picker.prototype.clear = function () {
    if (this._destroyed) return;
    if (this._value === null) return;
    this._value = null;
    this._refreshAriaChecked();
    this._fireChange(null, null);
  };

  Picker.prototype.destroy = function () {
    if (this._destroyed) return;
    this._teardownCardListeners();
    var w = this._wrapper;
    if (w) {
      while (w.firstChild) w.removeChild(w.firstChild);
      w.classList.remove('fwp');
    }
    this._cardEls = [];
    this._addBtn = null;
    this._liveRegion = null;
    this._body = null;
    this._wrapper = null;
    this._allLocations = [];
    this._onChange = null;
    this._onAddNew = null;
    this._destroyed = true;
  };

  // ------ Public API ---------------------------------------------------------

  global.FlanccoWerklocatiePicker = {
    /**
     * Attach the picker to a wrapper element.
     *
     * @param {HTMLElement} wrapperEl  Empty container that will host the picker.
     * @param {Object} options
     * @param {string} options.clientId  Required — current klant.id (UUID).
     * @param {Array}  options.allClientLocations  Full cache of all client_locations rows.
     * @param {string} [options.initialValue]  Pre-selected client_location_id.
     * @param {function} [options.onChange]  (locationId, location) => void
     * @param {boolean} [options.allowNew=false]  Render "+ Nieuwe werklocatie"-button.
     * @param {function} [options.onAddNew]  Called when "+ Nieuwe"-button clicked (host handles form).
     * @param {boolean} [options.autoSelectIfSingle=true]  Auto-select when only 1 locatie.
     * @returns {Object} Instance with: setClient, setLocations, setValue, getValue, clear, destroy.
     */
    attach: function (wrapperEl, options) {
      return new Picker(wrapperEl, options);
    }
  };

})(typeof window !== 'undefined' ? window : this);
