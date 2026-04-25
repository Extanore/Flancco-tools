/**
 * Flancco shared validators (Slot O2)
 * --------------------------------------------------------------
 * Pure-functie validators voor herbruik in calculator + admin-wizard.
 * Geen DOM-koppeling, geen i18n-koppeling — caller bepaalt label-tekst.
 *
 * Gebruik:
 *   if (!window.flanccoValidators.email(value)) showError('email');
 *   var fmt = window.flanccoValidators.formatPhoneBE(rawValue);
 *
 * Geen build-stap, registreert zich op window.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- regexes
  var REGEX_POSTCODE_BE = /^[1-9]\d{3}$/;          // 1000-9999
  var REGEX_EMAIL       = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  // Telefoon: minstens 8 cijfers wereldwijd, maximum 16 (E.164 = 15)
  var REGEX_PHONE_LOOSE = /^[0-9+\s().\-]{8,20}$/;
  var REGEX_VAT_BE      = /^BE0?\d{9,10}$/i;

  // ------------------------------------------------------------- normalizers
  function trim(v) { return (v == null ? '' : String(v)).trim(); }

  function normalizePhone(value) {
    var v = trim(value);
    if (!v) return '';
    // Strip all whitespace, dots, dashes, parens — keep leading +
    var hasPlus = v.charAt(0) === '+';
    var digits  = v.replace(/[^\d]/g, '');
    if (!digits) return '';
    if (hasPlus) return '+' + digits;
    // Belgian local numbers starting with 0 → +32
    if (digits.charAt(0) === '0') return '+32' + digits.substring(1);
    return digits;
  }

  function formatPhoneBE(value) {
    // Visuele opmaak +32 4XX XX XX XX of +32 X XXX XX XX (vast nr.)
    var n = normalizePhone(value);
    if (!n) return '';
    if (n.indexOf('+32') !== 0) return n; // niet-BE: laat ongemoeid
    var rest = n.substring(3); // zonder +32
    if (rest.length < 8 || rest.length > 10) return n;
    // Mobiel: 9 cijfers, begint met 4 → +32 4XX XX XX XX
    if (rest.length === 9 && rest.charAt(0) === '4') {
      return '+32 ' + rest.substring(0, 3) + ' ' + rest.substring(3, 5)
           + ' ' + rest.substring(5, 7) + ' ' + rest.substring(7, 9);
    }
    // Vast nummer met 9 cijfers
    if (rest.length === 9) {
      return '+32 ' + rest.charAt(0) + ' ' + rest.substring(1, 4)
           + ' ' + rest.substring(4, 6) + ' ' + rest.substring(6, 9);
    }
    return '+32 ' + rest;
  }

  function normalizePostcode(value) {
    return trim(value).replace(/[^\d]/g, '').substring(0, 4);
  }

  // ---------------------------------------------------------------- checks
  function nonEmpty(value)        { return trim(value).length > 0; }
  function postcodeBE(value)      { return REGEX_POSTCODE_BE.test(trim(value)); }
  function email(value)           { return REGEX_EMAIL.test(trim(value)); }
  function phoneAny(value) {
    var n = normalizePhone(value);
    return n.length >= 9 && n.length <= 16 && REGEX_PHONE_LOOSE.test(value);
  }
  function fullName(value) {
    var v = trim(value);
    if (v.length < 2) return false;
    // Minstens 2 woorden, of 1 woord ≥ 3 chars (admin-wizard heeft splits)
    var parts = v.split(/\s+/).filter(function (p) { return p.length > 0; });
    if (parts.length >= 2) return parts.every(function (p) { return p.length >= 1; });
    return parts[0].length >= 3;
  }

  // -------------------------------------------------------- postcode → lang
  function langFromPostcode(pc) {
    // Strict: alleen pure 4-cijfer BE postcode telt; alle ruis (langere reeksen,
    // letters, etc.) → null zodat caller niet per ongeluk lang-switch triggert
    // op buitenlandse codes met BE-achtig prefix (bv. NL '9999XX').
    var raw = (pc == null ? '' : String(pc)).trim();
    if (!/^[1-9]\d{3}$/.test(raw)) return null;
    var n = parseInt(raw, 10);
    if (n >= 1000 && n <= 1299) return 'brussels'; // prompt user
    if ((n >= 1300 && n <= 1499) || (n >= 4000 && n <= 7999)) return 'fr';
    return 'nl';
  }

  // -------------------------------------------------------- public registry
  window.flanccoValidators = {
    // regexes (read-only handig voor frontend HTML5 pattern attr)
    REGEX_POSTCODE_BE: REGEX_POSTCODE_BE,
    REGEX_EMAIL: REGEX_EMAIL,
    REGEX_VAT_BE: REGEX_VAT_BE,

    // normalizers
    normalizePhone: normalizePhone,
    formatPhoneBE: formatPhoneBE,
    normalizePostcode: normalizePostcode,

    // pure checks
    nonEmpty: nonEmpty,
    postcodeBE: postcodeBE,
    email: email,
    phoneAny: phoneAny,
    fullName: fullName,
    langFromPostcode: langFromPostcode
  };
})();
