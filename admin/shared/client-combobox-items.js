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
 *   - selectableHeaders: bool — als true, krijgen company-headers value=
 *                       'bedrijf:<client_id>' zodat ze selectable worden in
 *                       FlanccoClientCombobox (bedrijf-zelf-keuze, Slot T)
 *   - clientContacts: array van rauwe `client_contacts`-rijen. Wanneer
 *                     aanwezig, worden de contactpersonen-sub-items gebouwd
 *                     uit deze array i.p.v. uit clients.contact_person.
 *                     Sub-item value-prefix wordt 'contact:<client_contact_id>'
 *                     wanneer selectableHeaders=true (bedrijf-vs-persoon
 *                     onderscheid in resolver). Zonder selectableHeaders blijft
 *                     value=client.id voor backwards-compat.
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
    var contacts = Array.isArray(opts.clientContacts) ? opts.clientContacts : null;
    var selectableHeaders = !!opts.selectableHeaders;

    // Index client_contacts per client_id voor snelle lookup
    var contactsByClient = {};
    if (contacts) {
      contacts.forEach(function (cc) {
        if (!cc || !cc.client_id) return;
        if (!contactsByClient[cc.client_id]) contactsByClient[cc.client_id] = [];
        contactsByClient[cc.client_id].push(cc);
      });
      // Sorteer per bedrijf: primary eerst, dan alfabetisch op last_name
      Object.keys(contactsByClient).forEach(function (cid) {
        contactsByClient[cid].sort(function (a, b) {
          if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
          var an = ((a.last_name || '') + ' ' + (a.first_name || '')).trim();
          var bn = ((b.last_name || '') + ' ' + (b.first_name || '')).trim();
          return an.localeCompare(bn, 'nl', { sensitivity: 'base' });
        });
      });
    }

    function contactDisplayName(cc) {
      var fn = (cc.first_name || '').trim();
      var ln = (cc.last_name || '').trim();
      var name = (fn + ' ' + ln).trim();
      return name || (cc.email || 'Contact ' + String(cc.id).slice(0, 6));
    }

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
        // Hoeveel echte contactpersonen heeft dit bedrijf? Wanneer client_contacts
        // beschikbaar is, gebruiken we die count; anders fallback op clients-rij-aantal.
        var contactList = null;
        var contactCount = bucket.contacts.length;
        if (contacts) {
          // Verzamel client_contacts voor alle clients-rijen onder deze bedrijfsnaam
          var ccCollected = [];
          bucket.contacts.forEach(function (cl) {
            (contactsByClient[cl.id] || []).forEach(function (cc) { ccCollected.push(cc); });
          });
          contactList = ccCollected;
          contactCount = ccCollected.length || bucket.contacts.length;
        }

        var primaryClient = bucket.contacts[0];
        var headerMeta = contactCount === 1
          ? clientCity(primaryClient)
          : (contactCount + ' contactpersonen');

        // Company-group header — selectable als bedrijf-zelf-keuze gewenst is.
        // value-prefix 'bedrijf:' onderscheidt later in de save-resolver van 'contact:'.
        var headerItem = {
          type: 'group',
          kind: 'company',
          label: bucket.name,
          meta: headerMeta
        };
        if (selectableHeaders) {
          headerItem.selectable = true;
          headerItem.value = 'bedrijf:' + primaryClient.id;
          headerItem.searchText = (bucket.name + ' bedrijf').toLowerCase();
        }
        items.push(headerItem);

        if (contactList && contactList.length) {
          // Render contact_contacts-rijen als sub-items (juiste multi-contact pad)
          contactList.forEach(function (cc) {
            var dn = contactDisplayName(cc);
            // Bedrijf-stad als fallback voor meta wanneer contact zelf geen stad heeft
            var srcClient = bucket.contacts.find(function (cl) { return cl.id === cc.client_id; }) || primaryClient;
            var meta = clientCity(srcClient);
            if (cc.role) meta = (meta ? cc.role + ' · ' + meta : cc.role);
            items.push({
              type: 'item',
              label: dn,
              value: selectableHeaders ? ('contact:' + cc.id) : srcClient.id,
              meta: meta,
              companyName: bucket.name,
              searchText: [dn, cc.role || '', bucket.name, meta, cc.email || '', cc.phone || ''].join(' ').toLowerCase()
            });
          });
        } else {
          // Fallback: gebruik clients.contact_person als display (legacy mode,
          // geen client_contacts opgegeven door caller)
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
        }
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
