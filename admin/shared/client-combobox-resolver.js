/*
 * Flancco Client Combobox — value-resolver.
 *
 * Parseert de geselecteerde value uit FlanccoClientCombobox naar concrete
 * DB-kolommen ({client_id, client_contact_id}) zodat save-handlers de juiste
 * waarden naar onderhoudsbeurten / contracten / bouwdrogers / interventies
 * kunnen schrijven.
 *
 * Value-prefix conventie (Slot T):
 *   'bedrijf:<client_id>'      → { client_id: <id>, client_contact_id: null }
 *                                 (= "het bedrijf zelf, geen specifieke persoon")
 *   'contact:<client_contact_id>' → { client_id: <lookup>, client_contact_id: <id> }
 *                                 (lookup via allClientContacts-array)
 *   '<client_id>' (no prefix)  → { client_id: <id>, client_contact_id: null }
 *                                 (legacy mode — geen prefix opgegeven door caller)
 *   'contract:<contract_id>'   → { contract_id: <id>, client_id: null,
 *                                  client_contact_id: null } (legacy ni-klant flow)
 *   '__new'                    → { isNew: true } (contract-wizard magic)
 *
 * Laad via:
 *   <script src="/admin/shared/client-combobox-resolver.js"></script>
 */
(function (global) {
  'use strict';

  /**
   * Parse combobox-value naar resolved object.
   * @param {string} value - de combobox-value
   * @param {Array} allClientContacts - cache van rauwe client_contacts-rijen
   *                                    (nodig voor 'contact:'-prefix → client_id lookup)
   * @returns {Object} { client_id, client_contact_id, contract_id?, isNew?, raw }
   */
  function resolve(value, allClientContacts) {
    var out = {
      client_id: null,
      client_contact_id: null,
      contract_id: null,
      isNew: false,
      raw: value || null
    };
    if (!value) return out;
    var str = String(value);

    if (str === '__new') {
      out.isNew = true;
      return out;
    }

    if (str.indexOf('bedrijf:') === 0) {
      out.client_id = str.slice(8) || null;
      return out;
    }

    if (str.indexOf('contact:') === 0) {
      var contactId = str.slice(8);
      out.client_contact_id = contactId || null;
      // Lookup client_id via cache
      if (contactId && Array.isArray(allClientContacts)) {
        var match = allClientContacts.find(function (cc) { return cc && cc.id === contactId; });
        if (match) out.client_id = match.client_id || null;
      }
      return out;
    }

    if (str.indexOf('contract:') === 0) {
      out.contract_id = str.slice(9) || null;
      return out;
    }

    // Legacy: raw UUID zonder prefix → client_id
    out.client_id = str;
    return out;
  }

  global.FlanccoClientResolver = { resolve: resolve };
})(typeof window !== 'undefined' ? window : this);
