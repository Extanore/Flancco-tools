/*
 * Flancco Client Combobox — searchable klant-picker met grouped headers.
 *
 * Vervangt native <select> bij klant-selectie zodat bedrijfsnaam zichtbaar is
 * en contactpersonen visueel ingesprongen onder hun bedrijf staan.
 *
 * Vanilla JS, geen build-tooling. Laad via:
 *   <link rel="stylesheet" href="/admin/shared/client-combobox.css">
 *   <script src="/admin/shared/client-combobox.js"></script>
 *
 * Zie API-doc onderaan dit bestand of in admin/shared/client-combobox-demo.html.
 */
(function (global) {
  'use strict';

  // ------ Module-level state -------------------------------------------------

  var INSTANCE_COUNTER = 0;
  var SEARCH_DEBOUNCE_MS = 120;

  // ------ Utilities ----------------------------------------------------------

  /**
   * Normalise a string for accent/case-insensitive search comparison.
   * NFD-decompose then strip combining diacritics (U+0300–U+036F), then lowercase.
   */
  function normalize(str) {
    if (str == null) return '';
    return String(str)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase();
  }

  /**
   * Build a per-character map from the NFD-stripped lowercase form back to
   * the original source string. For each char in `normalized`, `map[i]` is
   * the index in `src` where that base character originated. This lets us
   * locate match ranges in the source even when accented characters were
   * decomposed (e.g. "É" → "E" + combining-acute, where the combining mark
   * is then stripped).
   *
   * Returns { normalized, map } where map.length === normalized.length and
   * map values are valid indices into src; an extra terminator map[length]
   * pointing to src.length is appended for boundary calculations.
   */
  function buildNormMap(src) {
    var s = String(src);
    var nMap = [];
    var nChars = [];
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      var decomposed = ch.normalize('NFD');
      for (var j = 0; j < decomposed.length; j++) {
        var dch = decomposed.charAt(j);
        // Strip combining diacritics (U+0300–U+036F)
        var code = dch.charCodeAt(0);
        if (code >= 0x0300 && code <= 0x036F) continue;
        nChars.push(dch.toLowerCase());
        nMap.push(i);
      }
    }
    nMap.push(s.length); // terminator for end-boundary lookups
    return { normalized: nChars.join(''), map: nMap };
  }

  /**
   * Append the given text to `parent`, wrapping the first occurrence of
   * `query` (case/accent-insensitive) in a <mark> element. Always uses
   * textContent — never innerHTML — to prevent XSS.
   */
  function appendHighlightedText(parent, text, query) {
    if (!text) return;
    var src = String(text);
    if (!query) {
      parent.appendChild(document.createTextNode(src));
      return;
    }
    var normQuery = normalize(query);
    if (!normQuery) {
      parent.appendChild(document.createTextNode(src));
      return;
    }
    var n = buildNormMap(src);
    var idx = n.normalized.indexOf(normQuery);
    if (idx === -1) {
      parent.appendChild(document.createTextNode(src));
      return;
    }
    var srcStart = n.map[idx];
    var srcEnd = n.map[idx + normQuery.length];
    var before = src.substring(0, srcStart);
    var match = src.substring(srcStart, srcEnd);
    var after = src.substring(srcEnd);
    if (before) parent.appendChild(document.createTextNode(before));
    var mark = document.createElement('mark');
    mark.className = 'fcb-highlight';
    mark.textContent = match;
    parent.appendChild(mark);
    if (after) parent.appendChild(document.createTextNode(after));
  }

  /** Lucide-style chevron-down (14px) icon as inline SVG. */
  function chevronDownSvg() {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'fcb-chevron');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    path.setAttribute('points', '6 9 12 15 18 9');
    svg.appendChild(path);
    return svg;
  }

  /** Lucide-style building-2 (12px) icon for company group rows. */
  function buildingSvg() {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'fcb-company-icon');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '12');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    var paths = [
      ['path', { d: 'M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z' }],
      ['path', { d: 'M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2' }],
      ['path', { d: 'M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2' }],
      ['path', { d: 'M10 6h4' }],
      ['path', { d: 'M10 10h4' }],
      ['path', { d: 'M10 14h4' }],
      ['path', { d: 'M10 18h4' }]
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

  // ------ Combobox instance --------------------------------------------------

  function Combobox(wrapperEl, options) {
    if (!wrapperEl || wrapperEl.nodeType !== 1) {
      throw new Error('FlanccoClientCombobox.attach: wrapperEl must be an Element');
    }
    options = options || {};

    this._wrapper = wrapperEl;
    this._uid = ++INSTANCE_COUNTER;
    this._items = Array.isArray(options.items) ? options.items.slice() : [];
    this._placeholder = options.placeholder || 'Kies klant…';
    this._emptyText = options.emptyText || 'Geen klanten gevonden';
    this._searchPlaceholder = options.searchPlaceholder || 'Zoek klant of bedrijf…';
    this._listboxLabel = options.listboxLabel || 'Klanten';
    this._onChange = typeof options.onChange === 'function' ? options.onChange : null;
    this._onClear = typeof options.onClear === 'function' ? options.onClear : null;

    this._value = options.initialValue != null ? options.initialValue : null;
    this._open = false;
    this._destroyed = false;
    this._activeIndex = -1; // pointer into the *filtered* selectable items
    this._query = '';
    this._debounceTimer = null;
    this._optionEls = []; // entries: { el, item, isSelectable, index } in render order

    this._onDocMouseDown = this._handleDocMouseDown.bind(this);
    this._onWindowResize = this._handleWindowResize.bind(this);
    this._onWindowScroll = this._handleWindowScroll.bind(this);

    this._build();
    this._render();
  }

  // ------ DOM construction ---------------------------------------------------

  Combobox.prototype._build = function () {
    var wrapper = this._wrapper;
    // Empty wrapper of any prior children (defensive against re-attach).
    while (wrapper.firstChild) wrapper.removeChild(wrapper.firstChild);
    wrapper.classList.add('fcb');

    var uid = this._uid;
    var triggerId = 'fcb-trigger-' + uid;
    var listboxId = 'fcb-listbox-' + uid;
    var liveId = 'fcb-live-' + uid;
    this._triggerId = triggerId;
    this._listboxId = listboxId;

    // Trigger button
    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.id = triggerId;
    trigger.className = 'fcb-trigger';
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', listboxId);
    trigger.setAttribute('aria-label', this._listboxLabel);

    var label = document.createElement('span');
    label.className = 'fcb-trigger-label';
    trigger.appendChild(label);

    var chevron = chevronDownSvg();
    trigger.appendChild(chevron);

    wrapper.appendChild(trigger);

    // Dropdown panel
    var panel = document.createElement('div');
    panel.className = 'fcb-panel';
    panel.setAttribute('hidden', '');

    var searchWrap = document.createElement('div');
    searchWrap.className = 'fcb-search';
    var search = document.createElement('input');
    search.type = 'text';
    search.className = 'fcb-search-input';
    search.placeholder = this._searchPlaceholder;
    search.setAttribute('autocomplete', 'off');
    search.setAttribute('autocapitalize', 'off');
    search.setAttribute('autocorrect', 'off');
    search.setAttribute('spellcheck', 'false');
    search.setAttribute('aria-controls', listboxId);
    search.setAttribute('aria-autocomplete', 'list');
    searchWrap.appendChild(search);
    panel.appendChild(searchWrap);

    var listbox = document.createElement('ul');
    listbox.id = listboxId;
    listbox.className = 'fcb-listbox';
    listbox.setAttribute('role', 'listbox');
    listbox.setAttribute('aria-label', this._listboxLabel);
    panel.appendChild(listbox);

    var live = document.createElement('div');
    live.id = liveId;
    live.className = 'fcb-sr-only';
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('aria-atomic', 'true');
    panel.appendChild(live);

    wrapper.appendChild(panel);

    this._trigger = trigger;
    this._triggerLabel = label;
    this._chevron = chevron;
    this._panel = panel;
    this._search = search;
    this._listbox = listbox;
    this._live = live;

    // Event wiring
    var self = this;
    trigger.addEventListener('click', function () {
      if (self._destroyed) return;
      if (self._open) self.close();
      else self.open();
    });
    trigger.addEventListener('keydown', function (e) {
      if (self._destroyed) return;
      // Allow opening via Enter/Space/ArrowDown when focused
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        self.open();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        self.open();
      }
    });

    search.addEventListener('input', function () {
      if (self._destroyed) return;
      if (self._debounceTimer) clearTimeout(self._debounceTimer);
      self._debounceTimer = setTimeout(function () {
        self._debounceTimer = null;
        self._query = search.value;
        self._activeIndex = -1;
        self._render();
        self._announceResultCount();
      }, SEARCH_DEBOUNCE_MS);
    });
    search.addEventListener('keydown', function (e) {
      self._handleListKeydown(e);
    });

    // Click selection on listbox (event delegation)
    listbox.addEventListener('click', function (e) {
      if (self._destroyed) return;
      var target = e.target;
      while (target && target !== listbox && !target.classList.contains('fcb-option')) {
        target = target.parentNode;
      }
      if (!target || target === listbox) return;
      if (target.getAttribute('aria-disabled') === 'true') return;
      var idx = parseInt(target.getAttribute('data-fcb-idx'), 10);
      if (isNaN(idx)) return;
      self._selectByOptionIndex(idx);
    });
    // Hover sets keyboard-active for a coherent UX
    listbox.addEventListener('mousemove', function (e) {
      if (self._destroyed) return;
      var target = e.target;
      while (target && target !== listbox && !target.classList.contains('fcb-option')) {
        target = target.parentNode;
      }
      if (!target || target === listbox) return;
      if (target.getAttribute('aria-disabled') === 'true') return;
      var idx = parseInt(target.getAttribute('data-fcb-idx'), 10);
      if (isNaN(idx)) return;
      var entry = self._optionEls[idx];
      if (!entry || !entry.isSelectable) return;
      self._setActiveIndexByOptionIndex(idx);
    });

    // Prevent panel mousedown from blurring search input
    panel.addEventListener('mousedown', function (e) {
      // Allow native scrollbar interaction by checking target
      if (e.target === panel || e.target === listbox) return;
      // Don't blur the search by default
      if (e.target !== search) {
        // Defer the blur by preventing default ONLY if we're about to act on it
        // (option clicks handled in click handler above)
      }
    });
  };

  // ------ Item normalisation + filtering -------------------------------------

  /**
   * Produce a single concatenated lowercase ASCII haystack for an item.
   */
  Combobox.prototype._itemHaystack = function (item) {
    var parts = [];
    if (item.label) parts.push(item.label);
    if (item.companyName) parts.push(item.companyName);
    if (item.meta) parts.push(item.meta);
    if (item.searchText) parts.push(item.searchText);
    return normalize(parts.join(' '));
  };

  /**
   * Compute filtered items as an ordered array of original-index pointers.
   * Group headers are kept only if at least one descendant item passes the filter.
   * A group spans from its index up to the next group of the same kind or any
   * higher-level kind (header > company).
   *
   * Logic:
   *   - kind=header opens a new section (resets current company)
   *   - kind=company belongs to the most recent header (if any)
   *   - items belong to the most recent company (if any) and most recent header
   *
   * On filter, we first decide which items match, then keep their
   * ancestor groups.
   */
  Combobox.prototype._computeFiltered = function () {
    var items = this._items;
    var query = this._query ? normalize(this._query.trim()) : '';
    var n = items.length;
    var keep = new Array(n);
    var matchAtLeastOne = false;
    var i;

    // First pass: ancestors for each index (header idx, company idx).
    var ancestors = new Array(n);
    var curHeader = -1;
    var curCompany = -1;
    for (i = 0; i < n; i++) {
      var it = items[i];
      if (!it || typeof it !== 'object') {
        ancestors[i] = { header: -1, company: -1 };
        continue;
      }
      if (it.type === 'group') {
        if (it.kind === 'header') {
          curHeader = i;
          curCompany = -1;
        } else if (it.kind === 'company') {
          curCompany = i;
        }
        ancestors[i] = { header: curHeader, company: curCompany };
      } else {
        ancestors[i] = { header: curHeader, company: curCompany };
      }
    }

    // Second pass: decide keep[] for items, then propagate to ancestors.
    for (i = 0; i < n; i++) {
      var item = items[i];
      if (!item || typeof item !== 'object') {
        keep[i] = false;
        continue;
      }
      if (item.type === 'group') {
        keep[i] = false; // tentative; promoted below if any child matches
        continue;
      }
      // type=item
      if (!query) {
        keep[i] = true;
        matchAtLeastOne = true;
      } else {
        var haystack = this._itemHaystack(item);
        if (haystack.indexOf(query) !== -1) {
          keep[i] = true;
          matchAtLeastOne = true;
        } else {
          keep[i] = false;
        }
      }
      if (keep[i]) {
        var a = ancestors[i];
        if (a.company !== -1) keep[a.company] = true;
        if (a.header !== -1) keep[a.header] = true;
      }
    }

    // Third pass: companies with no kept descendant items get hidden again.
    // (Above we marked them true if any descendant matched; descendants that
    // are themselves filtered out won't have promoted them.)
    // We also drop empty headers.
    // Re-derive cleanly.
    var hasChild = new Array(n);
    for (i = 0; i < n; i++) hasChild[i] = false;
    for (i = 0; i < n; i++) {
      if (items[i] && items[i].type === 'item' && keep[i]) {
        var a2 = ancestors[i];
        if (a2.company !== -1) hasChild[a2.company] = true;
        if (a2.header !== -1) hasChild[a2.header] = true;
      }
    }
    for (i = 0; i < n; i++) {
      if (items[i] && items[i].type === 'group') {
        keep[i] = hasChild[i];
      }
    }

    var visible = [];
    for (i = 0; i < n; i++) if (keep[i]) visible.push(i);

    return { visibleIndices: visible, anyMatch: matchAtLeastOne };
  };

  // ------ Rendering ----------------------------------------------------------

  Combobox.prototype._render = function () {
    this._renderTrigger();
    this._renderListbox();
    this._updateActiveDescendant();
  };

  Combobox.prototype._renderTrigger = function () {
    var label = this._triggerLabel;
    while (label.firstChild) label.removeChild(label.firstChild);

    var current = this._currentItem();
    if (current) {
      var name = document.createElement('span');
      name.className = 'fcb-trigger-name';
      name.textContent = current.label || '';
      label.appendChild(name);
      if (current.meta) {
        var meta = document.createElement('span');
        meta.className = 'fcb-trigger-meta';
        meta.textContent = ' · ' + current.meta;
        label.appendChild(meta);
      }
      this._trigger.classList.add('fcb-has-value');
      this._trigger.classList.remove('fcb-empty');
    } else {
      var placeholder = document.createElement('span');
      placeholder.className = 'fcb-trigger-placeholder';
      placeholder.textContent = this._placeholder;
      label.appendChild(placeholder);
      this._trigger.classList.remove('fcb-has-value');
      this._trigger.classList.add('fcb-empty');
    }
  };

  Combobox.prototype._renderListbox = function () {
    var listbox = this._listbox;
    while (listbox.firstChild) listbox.removeChild(listbox.firstChild);
    this._optionEls = [];

    var items = this._items;
    if (!items.length) {
      this._renderEmptyState(this._emptyText);
      return;
    }

    var filtered = this._computeFiltered();
    var visible = filtered.visibleIndices;
    if (!visible.length) {
      // No-results state when a search query is active; no-items state otherwise.
      var msg = this._query
        ? 'Geen resultaten'
        : this._emptyText;
      this._renderEmptyState(msg);
      return;
    }

    // Track whether the most recent rendered group is a "company" so item
    // indentation can be set correctly. A header resets this; a new company
    // sets it; a new header without company afterwards leaves items un-indented.
    var lastGroupKind = null; // null | 'header' | 'company'
    var anyHeaderRendered = false;

    var query = this._query ? this._query.trim() : '';

    for (var i = 0; i < visible.length; i++) {
      var origIdx = visible[i];
      var item = items[origIdx];
      var optionIndex = this._optionEls.length; // index into _optionEls (== DOM order)

      if (item.type === 'group') {
        var li = document.createElement('li');
        li.setAttribute('role', 'presentation');
        li.setAttribute('aria-disabled', 'true');
        li.setAttribute('data-fcb-idx', String(optionIndex));
        if (item.kind === 'header') {
          li.className = 'fcb-group-header';
          if (!anyHeaderRendered) li.classList.add('fcb-group-header--first');
          var hdrLabel = document.createElement('span');
          hdrLabel.className = 'fcb-group-header-label';
          hdrLabel.textContent = item.label || '';
          li.appendChild(hdrLabel);
          anyHeaderRendered = true;
          lastGroupKind = 'header';
        } else if (item.kind === 'company') {
          li.className = 'fcb-group-company';
          li.appendChild(buildingSvg());
          var companyLabel = document.createElement('span');
          companyLabel.className = 'fcb-group-company-label';
          appendHighlightedText(companyLabel, item.label || '', query);
          li.appendChild(companyLabel);
          if (item.meta) {
            var companyMeta = document.createElement('span');
            companyMeta.className = 'fcb-group-company-meta';
            companyMeta.textContent = ' · ' + item.meta;
            li.appendChild(companyMeta);
          }
          lastGroupKind = 'company';
        } else {
          // Unknown group kind; skip silently to avoid breaking layout.
          continue;
        }
        listbox.appendChild(li);
        this._optionEls.push({ el: li, item: item, isSelectable: false, origIdx: origIdx });
      } else if (item.type === 'item') {
        var optEl = document.createElement('li');
        optEl.className = 'fcb-option';
        optEl.id = 'fcb-opt-' + this._uid + '-' + optionIndex;
        optEl.setAttribute('role', 'option');
        optEl.setAttribute('data-fcb-idx', String(optionIndex));
        optEl.setAttribute('aria-selected', 'false');
        if (lastGroupKind === 'company') {
          optEl.classList.add('fcb-option--indented');
        }
        if (item.value === this._value && this._value != null) {
          optEl.classList.add('fcb-option--current');
        }

        var labelEl = document.createElement('span');
        labelEl.className = 'fcb-option-label';
        appendHighlightedText(labelEl, item.label || '', query);
        optEl.appendChild(labelEl);

        // Show companyName inline if there's no surrounding company group AND
        // companyName exists and differs from label — keeps the label honest in
        // search results when only items rendered without their parent group.
        if (item.companyName && lastGroupKind !== 'company') {
          var companyInline = document.createElement('span');
          companyInline.className = 'fcb-option-company';
          companyInline.appendChild(document.createTextNode(' — '));
          appendHighlightedText(companyInline, item.companyName, query);
          optEl.appendChild(companyInline);
        }

        if (item.meta) {
          var metaEl = document.createElement('span');
          metaEl.className = 'fcb-option-meta';
          metaEl.textContent = ' · ' + item.meta;
          optEl.appendChild(metaEl);
        }

        listbox.appendChild(optEl);
        this._optionEls.push({ el: optEl, item: item, isSelectable: true, origIdx: origIdx });
      }
    }

    // Auto-select first selectable as keyboard-active when search is non-empty,
    // so Enter selects something obvious.
    if (this._activeIndex === -1 && this._query) {
      var firstSel = this._firstSelectableIndex();
      if (firstSel !== -1) this._setActiveIndexByOptionIndex(firstSel);
    } else if (this._activeIndex !== -1) {
      // Keep prior keyboard-active if still selectable, otherwise reset.
      if (this._activeIndex >= this._optionEls.length || !this._optionEls[this._activeIndex].isSelectable) {
        this._activeIndex = -1;
      } else {
        this._optionEls[this._activeIndex].el.classList.add('fcb-option--active');
        this._optionEls[this._activeIndex].el.setAttribute('aria-selected', 'true');
      }
    }
  };

  Combobox.prototype._renderEmptyState = function (text) {
    var li = document.createElement('li');
    li.className = 'fcb-empty-state';
    li.setAttribute('role', 'presentation');
    li.setAttribute('aria-disabled', 'true');
    li.textContent = text;
    this._listbox.appendChild(li);
  };

  Combobox.prototype._announceResultCount = function () {
    var count = 0;
    for (var i = 0; i < this._optionEls.length; i++) {
      if (this._optionEls[i].isSelectable) count++;
    }
    var msg;
    if (count === 0) msg = 'Geen resultaten';
    else if (count === 1) msg = '1 resultaat';
    else msg = count + ' resultaten';
    this._live.textContent = msg;
  };

  // ------ Active-descendant management ---------------------------------------

  Combobox.prototype._firstSelectableIndex = function () {
    for (var i = 0; i < this._optionEls.length; i++) {
      if (this._optionEls[i].isSelectable) return i;
    }
    return -1;
  };

  Combobox.prototype._lastSelectableIndex = function () {
    for (var i = this._optionEls.length - 1; i >= 0; i--) {
      if (this._optionEls[i].isSelectable) return i;
    }
    return -1;
  };

  Combobox.prototype._nextSelectableIndex = function (from) {
    var n = this._optionEls.length;
    if (n === 0) return -1;
    var i = from;
    for (var step = 0; step < n; step++) {
      i = (i + 1) % n;
      if (this._optionEls[i].isSelectable) return i;
    }
    return -1;
  };

  Combobox.prototype._prevSelectableIndex = function (from) {
    var n = this._optionEls.length;
    if (n === 0) return -1;
    var i = from;
    for (var step = 0; step < n; step++) {
      i = (i - 1 + n) % n;
      if (this._optionEls[i].isSelectable) return i;
    }
    return -1;
  };

  Combobox.prototype._setActiveIndexByOptionIndex = function (idx) {
    // Clear previous
    if (this._activeIndex !== -1 && this._optionEls[this._activeIndex]) {
      this._optionEls[this._activeIndex].el.classList.remove('fcb-option--active');
      this._optionEls[this._activeIndex].el.setAttribute('aria-selected', 'false');
    }
    this._activeIndex = idx;
    if (idx === -1) {
      this._search.removeAttribute('aria-activedescendant');
      return;
    }
    var entry = this._optionEls[idx];
    if (!entry || !entry.isSelectable) {
      this._activeIndex = -1;
      this._search.removeAttribute('aria-activedescendant');
      return;
    }
    entry.el.classList.add('fcb-option--active');
    entry.el.setAttribute('aria-selected', 'true');
    this._search.setAttribute('aria-activedescendant', entry.el.id);
    this._scrollOptionIntoView(entry.el);
  };

  Combobox.prototype._updateActiveDescendant = function () {
    if (this._activeIndex === -1) {
      this._search.removeAttribute('aria-activedescendant');
      return;
    }
    var entry = this._optionEls[this._activeIndex];
    if (entry && entry.isSelectable) {
      this._search.setAttribute('aria-activedescendant', entry.el.id);
    } else {
      this._search.removeAttribute('aria-activedescendant');
    }
  };

  Combobox.prototype._scrollOptionIntoView = function (el) {
    var listbox = this._listbox;
    var elTop = el.offsetTop;
    var elBottom = elTop + el.offsetHeight;
    var viewTop = listbox.scrollTop;
    var viewBottom = viewTop + listbox.clientHeight;
    if (elTop < viewTop) {
      listbox.scrollTop = elTop;
    } else if (elBottom > viewBottom) {
      listbox.scrollTop = elBottom - listbox.clientHeight;
    }
  };

  // ------ Keyboard handling --------------------------------------------------

  Combobox.prototype._handleListKeydown = function (e) {
    var key = e.key;
    var selectable, target;

    if (key === 'ArrowDown') {
      e.preventDefault();
      if (!this._optionEls.length) return;
      target = this._activeIndex === -1
        ? this._firstSelectableIndex()
        : this._nextSelectableIndex(this._activeIndex);
      if (target !== -1) this._setActiveIndexByOptionIndex(target);
    } else if (key === 'ArrowUp') {
      e.preventDefault();
      if (!this._optionEls.length) return;
      target = this._activeIndex === -1
        ? this._lastSelectableIndex()
        : this._prevSelectableIndex(this._activeIndex);
      if (target !== -1) this._setActiveIndexByOptionIndex(target);
    } else if (key === 'Home') {
      e.preventDefault();
      target = this._firstSelectableIndex();
      if (target !== -1) this._setActiveIndexByOptionIndex(target);
    } else if (key === 'End') {
      e.preventDefault();
      target = this._lastSelectableIndex();
      if (target !== -1) this._setActiveIndexByOptionIndex(target);
    } else if (key === 'Enter') {
      e.preventDefault();
      if (this._activeIndex !== -1) {
        this._selectByOptionIndex(this._activeIndex);
      } else if (this._query && this._search.value) {
        var first = this._firstSelectableIndex();
        if (first !== -1) this._selectByOptionIndex(first);
      }
    } else if (key === 'Escape') {
      e.preventDefault();
      this.close();
      this._trigger.focus();
    } else if (key === 'Tab') {
      // Let Tab leave naturally; close panel.
      this.close();
    }
  };

  // ------ Selection ----------------------------------------------------------

  Combobox.prototype._selectByOptionIndex = function (idx) {
    var entry = this._optionEls[idx];
    if (!entry || !entry.isSelectable) return;
    var newValue = entry.item.value != null ? entry.item.value : null;
    var changed = newValue !== this._value;
    this._value = newValue;
    this.close();
    this._trigger.focus();
    this._renderTrigger();
    if (changed && this._onChange) {
      try { this._onChange(this._value, entry.item); } catch (err) { /* swallow user errors */ }
    }
  };

  Combobox.prototype._currentItem = function () {
    if (this._value == null) return null;
    for (var i = 0; i < this._items.length; i++) {
      var it = this._items[i];
      if (it && it.type === 'item' && it.value === this._value) return it;
    }
    return null;
  };

  // ------ Open/close ---------------------------------------------------------

  Combobox.prototype.open = function () {
    if (this._destroyed || this._open) return;
    this._open = true;
    this._panel.removeAttribute('hidden');
    this._wrapper.classList.add('fcb-open');
    this._trigger.setAttribute('aria-expanded', 'true');
    this._search.value = '';
    this._query = '';
    this._activeIndex = -1;
    this._render();
    // Position adjustment for viewport-bottom flip
    this._positionPanel();
    // Defer focus until after the panel is visible
    var self = this;
    setTimeout(function () {
      if (!self._destroyed && self._open) self._search.focus();
    }, 0);
    document.addEventListener('mousedown', this._onDocMouseDown, true);
    window.addEventListener('resize', this._onWindowResize, true);
    window.addEventListener('scroll', this._onWindowScroll, true);
    this._announceResultCount();
  };

  Combobox.prototype.close = function () {
    if (this._destroyed || !this._open) return;
    this._open = false;
    this._panel.setAttribute('hidden', '');
    this._wrapper.classList.remove('fcb-open', 'fcb-flip-up');
    this._trigger.setAttribute('aria-expanded', 'false');
    this._search.value = '';
    this._query = '';
    this._activeIndex = -1;
    this._search.removeAttribute('aria-activedescendant');
    this._live.textContent = '';
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    document.removeEventListener('mousedown', this._onDocMouseDown, true);
    window.removeEventListener('resize', this._onWindowResize, true);
    window.removeEventListener('scroll', this._onWindowScroll, true);
  };

  Combobox.prototype._positionPanel = function () {
    // If there is not enough space below the trigger, flip the panel above.
    var rect = this._trigger.getBoundingClientRect();
    var spaceBelow = window.innerHeight - rect.bottom;
    var spaceAbove = rect.top;
    var needed = Math.min(360, this._panel.scrollHeight || 360) + 8;
    if (spaceBelow < needed && spaceAbove > spaceBelow) {
      this._wrapper.classList.add('fcb-flip-up');
    } else {
      this._wrapper.classList.remove('fcb-flip-up');
    }
  };

  Combobox.prototype._handleDocMouseDown = function (e) {
    if (this._destroyed || !this._open) return;
    if (this._wrapper.contains(e.target)) return;
    this.close();
  };

  Combobox.prototype._handleWindowResize = function () {
    if (this._open) this._positionPanel();
  };

  Combobox.prototype._handleWindowScroll = function () {
    if (this._open) this._positionPanel();
  };

  // ------ Public API ---------------------------------------------------------

  Combobox.prototype.setItems = function (newItems) {
    if (this._destroyed) return;
    this._items = Array.isArray(newItems) ? newItems.slice() : [];
    // Drop value if no longer present
    if (this._value != null && !this._currentItem()) {
      this._value = null;
    }
    this._activeIndex = -1;
    this._render();
    if (this._open) this._announceResultCount();
  };

  Combobox.prototype.setValue = function (value) {
    if (this._destroyed) return;
    if (value == null) {
      this.clear();
      return;
    }
    var found = null;
    for (var i = 0; i < this._items.length; i++) {
      var it = this._items[i];
      if (it && it.type === 'item' && it.value === value) {
        found = it;
        break;
      }
    }
    if (!found) return;
    var changed = value !== this._value;
    this._value = value;
    this._renderTrigger();
    if (changed && this._onChange) {
      try { this._onChange(this._value, found); } catch (err) { /* swallow */ }
    }
  };

  Combobox.prototype.getValue = function () {
    return this._destroyed ? null : this._value;
  };

  Combobox.prototype.clear = function () {
    if (this._destroyed) return;
    if (this._value == null) {
      // Still fire onClear, but onChange only if state changed (no change here)
      if (this._onClear) {
        try { this._onClear(); } catch (err) { /* swallow */ }
      }
      return;
    }
    this._value = null;
    this._renderTrigger();
    if (this._onChange) {
      try { this._onChange(null, null); } catch (err) { /* swallow */ }
    }
    if (this._onClear) {
      try { this._onClear(); } catch (err) { /* swallow */ }
    }
  };

  Combobox.prototype.focus = function () {
    if (this._destroyed) return;
    this._trigger.focus();
  };

  Combobox.prototype.destroy = function () {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    document.removeEventListener('mousedown', this._onDocMouseDown, true);
    window.removeEventListener('resize', this._onWindowResize, true);
    window.removeEventListener('scroll', this._onWindowScroll, true);
    while (this._wrapper.firstChild) this._wrapper.removeChild(this._wrapper.firstChild);
    this._wrapper.classList.remove('fcb', 'fcb-open', 'fcb-flip-up');
    this._items = [];
    this._optionEls = [];
    this._trigger = null;
    this._triggerLabel = null;
    this._chevron = null;
    this._panel = null;
    this._search = null;
    this._listbox = null;
    this._live = null;
    this._onChange = null;
    this._onClear = null;
  };

  // ------ Public namespace ---------------------------------------------------

  global.FlanccoClientCombobox = {
    attach: function (wrapperEl, options) {
      return new Combobox(wrapperEl, options);
    }
  };

})(typeof window !== 'undefined' ? window : this);

/*
 * ====================================================================
 *  API SAMENVATTING (zie ook client-combobox-demo.html)
 * ====================================================================
 *
 *  attach(wrapperEl, options)  -> instance
 *
 *    options:
 *      items              Array van { type, kind?, label, value?, meta?,
 *                                     companyName?, searchText? }.
 *                         type === 'group'  -> kind 'header' | 'company'
 *                         type === 'item'   -> selectable row
 *      placeholder        Trigger placeholder (default: 'Kies klant…')
 *      emptyText          Empty list message (default: 'Geen klanten gevonden')
 *      searchPlaceholder  Search input placeholder
 *      listboxLabel       aria-label voor combobox + listbox
 *      initialValue       Pre-selected item.value
 *      onChange(value, item)
 *      onClear()
 *
 *  instance methods:
 *      setItems(newItems)
 *      setValue(value)            // null clears
 *      getValue()
 *      clear()
 *      open() / close()
 *      focus()
 *      destroy()
 *
 *  Wrapper: <div class="fcb"></div> — wordt door attach() leeggemaakt
 *  en gevuld met trigger + dropdown panel.
 *
 *  Multi-instance veilig (uniek uid per attach).
 *  Geen runtime dependencies.
 * ====================================================================
 */
