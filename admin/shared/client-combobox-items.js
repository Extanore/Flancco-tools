/*
 * Flancco Client Combobox — items builder.
 *
 * Helper die rauwe `clients`-rijen (uit Supabase) omzet naar het items-formaat
 * van FlanccoClientCombobox. Centraal zodat alle 4 call-sites
 * (qa-client, ni-klant, wiz-client, uitgeef-client) dezelfde groepering +
 * sortering + label-opmaak gebruiken.
 *
 * Output-volgorde:
 *   1. "Bedrijven" header
 *      - Per uniek company_name: company-group label + alle contactpersonen
 *      - Bedrijven alfabetisch, contactpersonen daarbinnen alfabetisch
 *   2. "Particulieren" header (alleen als er particulieren zijn)
 *      - Klanten zonder company_name (of client_type='particulier'), alfabetisch
 *
 * API:
 *   var items = window.FlanccoClientItems.build(allClients, options);
 *
 * Options:
 *   - filterPartnerId: alleen klanten met deze partner_id (default: null = alle)
 *   - extraItems: array van extra-items (bv. legacy contracten) — toegevoegd
 *                 als eigen sectie onderaan met header 'extraHeaderLabel'
 *   - extraHeaderLabel: header-tekst voor extraItems (default 'Andere')
 */
(function (global) {
  'use strict';

  function clientLabel(c) {
    if (!c) return '—';
    var name = (c.contact_person || '').trim();
    if (name) return name;
    if (c.email) return c.email;
    if (c.id) return 'Klant ' + String(c.id).slice(0, 6);
    return '—';
  }

  function clientCity(c) {
    return (c && c.city) ? String(c.city).trim() : '';
  }

  function companyName(c) {
    return (c && c.company_name) ? String(c.company_name).trim() : '';
  }

  function isParticulier(c) {
    if (!c) return true;
    var ct = (c.client_type || '').toLowerCase();
    if (ct === 'particulier') return true;
    if (ct === 'bedrijf') return false;
    // Geen client_type → fallback: bedrijf alleen als company_name ingevuld
    return !companyName(c);
  }

  /**
   * Bouw items-array voor FlanccoClientCombobox.
   * @param {Array} clients - rauwe rows uit `clients`-tabel
   * @param {Object} [opts]
   * @returns {Array}
   */
  function build(clients, opts) {
    opts = opts || {};
    var list = Array.isArray(clients) ? clients.slice() : [];

    // Optionele partner-filter (gebruikt door wiz-client)
    if (opts.filterPartnerId) {
      list = list.filter(function (c) {
        return c && c.partner_id === opts.filterPartnerId;
      });
    }

    // Splits in bedrijven vs particulieren
    var bedrijven = [];      // klanten met company_name (groepeerbaar)
    var bedrijfZonderNaam = []; // type=bedrijf maar company_name leeg → in bedrijven-sectie als losse rij
    var particulieren = [];

    list.forEach(function (c) {
      if (isParticulier(c)) {
        particulieren.push(c);
      } else if (companyName(c)) {
        bedrijven.push(c);
      } else {
        // type=bedrijf maar geen bedrijfsnaam — toon onder bedrijven, ongegroepeerd
        bedrijfZonderNaam.push(c);
      }
    });

    // Groepeer bedrijven per company_name (case-insensitive)
    var byCompany = {};
    bedrijven.forEach(function (c) {
      var key = companyName(c).toLowerCase();
      if (!byCompany[key]) byCompany[key] = { name: companyName(c), contacts: [] };
      byCompany[key].contacts.push(c);
    });

    // Sorteer bedrijfsnamen alfabetisch
    var sortedCompanyKeys = Object.keys(byCompany).sort(function (a, b) {
      return byCompany[a].name.localeCompare(byCompany[b].name, 'nl', { sensitivity: 'base' });
    });

    // Bouw items
    var items = [];

    var hasBedrijfData = sortedCompanyKeys.length > 0 || bedrijfZonderNaam.length > 0;

    if (hasBedrijfData) {
      items.push({ type: 'group', kind: 'header', label: 'Bedrijven' });

      sortedCompanyKeys.forEach(function (key) {
        var bucket = byCompany[key];
        // Company-group header (niet-selectable, visuele grouping)
        items.push({
          type: 'group',
          kind: 'company',
          label: bucket.name,
          meta: bucket.contacts.length === 1 ? clientCity(bucket.contacts[0]) : (bucket.contacts.length + ' contactpersonen')
        });

        // Sorteer contactpersonen binnen het bedrijf
        bucket.contacts.sort(function (a, b) {
          return clientLabel(a).localeCompare(clientLabel(b), 'nl', { sensitivity: 'base' });
        });

        bucket.contacts.forEach(function (c) {
          items.push({
            type: 'item',
            label: clientLabel(c),
            value: c.id,
            meta: clientCity(c),
            companyName: bucket.name,
            searchText: [clientLabel(c), bucket.name, clientCity(c), c.email || '', c.phone || ''].join(' ').toLowerCase()
          });
        });
      });

      // Bedrijven zonder bedrijfsnaam (data-inconsistentie: client_type=bedrijf
      // maar company_name leeg) → eigen company-group "Zonder bedrijfsnaam"
      // zodat ze niet visueel bij de laatste echte bedrijfsgroep horen.
      if (bedrijfZonderNaam.length) {
        items.push({
          type: 'group',
          kind: 'company',
          label: 'Zonder bedrijfsnaam',
          meta: bedrijfZonderNaam.length + ' rij' + (bedrijfZonderNaam.length === 1 ? '' : 'en')
        });
        bedrijfZonderNaam.sort(function (a, b) {
          return clientLabel(a).localeCompare(clientLabel(b), 'nl', { sensitivity: 'base' });
        });
        bedrijfZonderNaam.forEach(function (c) {
          items.push({
            type: 'item',
            label: clientLabel(c),
            value: c.id,
            meta: clientCity(c),
            searchText: [clientLabel(c), clientCity(c), c.email || ''].join(' ').toLowerCase()
          });
        });
      }
    }

    if (particulieren.length) {
      items.push({ type: 'group', kind: 'header', label: 'Particulieren' });
      particulieren.sort(function (a, b) {
        return clientLabel(a).localeCompare(clientLabel(b), 'nl', { sensitivity: 'base' });
      });
      particulieren.forEach(function (c) {
        items.push({
          type: 'item',
          label: clientLabel(c),
          value: c.id,
          meta: clientCity(c),
          searchText: [clientLabel(c), clientCity(c), c.email || ''].join(' ').toLowerCase()
        });
      });
    }

    // Optionele extra-sectie (gebruikt door ni-klant voor legacy-contracten)
    if (Array.isArray(opts.extraItems) && opts.extraItems.length) {
      items.push({ type: 'group', kind: 'header', label: opts.extraHeaderLabel || 'Andere' });
      opts.extraItems.forEach(function (it) { items.push(it); });
    }

    return items;
  }

  // Expose
  global.FlanccoClientItems = { build: build };
})(typeof window !== 'undefined' ? window : this);
