/**
 * Flancco Calculator — NL dictionary (Slot S baseline)
 * --------------------------------------------------------------
 * Geladen als JS in plaats van JSON om CSP-impact (connect-src) te
 * vermijden — pure registratie via window.flanccoI18n.registerDict.
 *
 * Migratie-gids voor nieuwe keys:
 *   1. Voeg key+waarde hier toe
 *   2. Voeg dezelfde key toe in fr.json.js (vertaling laten reviewen)
 *   3. In HTML: vervang hardcoded tekst door <element data-i18n="key">
 *   4. Geen buildstap nodig — refresh + zien.
 *
 * Conventies:
 *   - dot-notation per page-section: 'step1.title', 'shared.cta.next'
 *   - placeholders: {partner}, {amount}, {count} — geen complexere syntax
 *   - HTML in vertaling enkel via data-i18n-html (en zorgvuldig escapen
 *     van user-content vóór interpolation — niet van toepassing in
 *     statische copy zoals hier)
 */
(function () {
  if (!window.flanccoI18n) return;
  window.flanccoI18n.registerDict('nl', {
    common: {
      yes: 'Ja',
      no: 'Nee',
      back: '\u2190 Terug',
      next: 'Ga verder \u2192',
      cancel: 'Annuleren',
      save: 'Opslaan',
      required: 'verplicht',
      optional: 'optioneel',
      loading: 'Even geduld\u2026',
      retry: 'Opnieuw proberen'
    },
    header: {
      tagline: 'Onderhoud zoals het hoort'
    },
    step0: {
      title: 'Welke diensten wenst u?',
      subtitle: 'Selecteer de diensten waarvoor u een offerte wenst. U kunt meerdere diensten combineren in \u00e9\u00e9n overeenkomst.',
      cta: 'Ga verder \u2192',
      ctaHint: 'Selecteer minstens \u00e9\u00e9n dienst om verder te gaan'
    },
    step1: {
      title: 'Configureer uw diensten',
      subtitle: 'Vul hieronder uw installatiegegevens in en ontdek direct uw persoonlijke prijs.',
      ctaNext: 'Ga verder naar overeenkomst \u2192',
      ctaHint: 'Vul uw gegevens in en bekijk direct uw persoonlijke overeenkomst',
      cards: {
        afstand: 'Afstand',
        afstandLabel: 'Afstand tot uw woning',
        afstandUnit: '(in km)',
        btw: 'BTW-tarief',
        btw21: '21% BTW',
        btw21sub: 'Standaardtarief',
        btw6: '6% BTW',
        btw6sub: 'Renovatie \u2014 woning ouder dan 10 jaar (enkel Belgi\u00eb)',
        freq: 'Frequentie',
        freqJaarlijks: 'Jaarlijks',
        freqJaarlijksSub: '1 onderhoudsbeurt per jaar',
        freqHalfjaar: 'Halfjaarlijks',
        freqHalfjaarSub: '2 onderhoudsbeurten per jaar',
        duur: 'Contractduur',
        duurEenmalig: 'Eenmalige interventie',
        duurEenmaligSub: 'Standaardtarief, geen doorlopend contract',
        duur3: '3 jaar',
        duur5: '5 jaar',
        duurKortingSub: '5% korting op alle tarieven'
      },
      result: {
        title: 'Uw prijsindicatie per beurt',
        perBeurt: 'Per beurt',
        perJaar: 'Per jaar (2 beurten)',
        btwNote21: 'Alle bedragen incl. 21% btw',
        btwNote6: 'Alle bedragen incl. 6% btw'
      },
      btw6: {
        title: 'Verklaring op eer \u2014 verlaagd btw-tarief (6%)',
        intro: 'Om in aanmerking te komen voor het verlaagd btw-tarief van 6% moet de woning waar de werken uitgevoerd worden voldoen aan de volgende voorwaarden:',
        cond1: 'De woning is ouder dan 10 jaar (eerste ingebruikname meer dan 10 jaar geleden)',
        cond2: 'De woning wordt hoofdzakelijk als priv\u00e9woning gebruikt',
        cond3: 'De werken worden rechtstreeks aan de eindverbruiker gefactureerd',
        check: 'Ik verklaar op eer dat het gebouw waar de werken uitgevoerd worden langer dan 10 jaar in gebruik is als priv\u00e9woning en dat ik de eindverbruiker ben. Ik neem kennis dat bij onjuiste verklaring het verschil in btw (15%) verhaald kan worden.'
      }
    },
    step2: {
      title: 'Uw gegevens',
      subtitle: 'Vul hieronder uw gegevens in om uw persoonlijke overeenkomst op te stellen.',
      personal: 'Persoonsgegevens',
      contact: 'Contactgegevens',
      naam: 'Naam / Bedrijfsnaam',
      naamPh: 'Bijv. Jan Janssen of Janssen B.V.',
      straat: 'Straat',
      straatPh: 'Straatnaam',
      huisnr: 'Nr.',
      huisnrPh: '12A',
      postcode: 'Postcode',
      postcodePh: '9000',
      gemeente: 'Gemeente',
      gemeentePh: 'Gent',
      btwNr: 'BTW-nummer',
      contactPersoon: 'Contactpersoon',
      contactPersoonPh: 'Naam contactpersoon',
      tel: 'Telefoon',
      telPh: '+32 4...',
      email: 'E-mail',
      emailPh: 'jan@voorbeeld.be',
      privacy: 'Ik heb de {link} gelezen en ga akkoord met de verwerking van mijn gegevens.',
      privacyLink: 'privacyverklaring',
      ctaNext: 'Bekijk samenvatting \u2192',
      ctaBack: '\u2190 Terug'
    },
    step2b: {
      title: 'Uw offerte samengevat',
      subtitle: 'Controleer onderstaande gegevens voordat u doorgaat naar de overeenkomst.',
      ctaBack: '\u2190 Aanpassen',
      ctaNext: 'Akkoord, ga naar overeenkomst \u2192'
    },
    step3: {
      title: 'Uw overeenkomst',
      subtitle: 'Controleer onderstaande overeenkomst en onderteken digitaal.',
      ctaBack: '\u2190 Terug',
      ctaSubmit: 'Onderteken & verstuur',
      submitHint: 'Plaats uw handtekening en vink de akkoordverklaring aan om te versturen'
    },
    success: {
      title: 'Uw contract is succesvol ondertekend',
      subtitle: 'Uw PDF wordt automatisch gedownload. Bewaar dit als bevestiging.',
      subtitleSigning: 'Bedankt voor uw vertrouwen. U ontvangt een bevestiging per e-mail.',
      headerOvereenkomst: 'Uw overeenkomst',
      labelNr: 'Contractnummer',
      labelDatum: 'Datum',
      labelDiensten: 'Diensten',
      labelFreq: 'Frequentie',
      labelDuur: 'Contractduur',
      labelBedrag: 'Totaal per beurt',
      headerNext: 'Wat gebeurt er nu?',
      stepDownloaded: 'Uw contract PDF is automatisch gedownload \u2014 bewaar dit document',
      stepProcessed: 'Uw ondertekend contract wordt verwerkt door uw partner',
      stepPlanFirst: 'Wij plannen uw eerste onderhoudsbeurt in',
      stepCalled: 'U wordt telefonisch gecontacteerd voor een exacte datum',
      dlAgain: '\u2193 Download PDF opnieuw',
      dlContract: '\u2193 Download uw contract als PDF',
      contactQuestion: 'Vragen? Neem contact op met',
      freqJaarlijks: 'Jaarlijks (1\u00D7)',
      freqHalfjaarlijks: 'Halfjaarlijks (2\u00D7)',
      freqEenmalig: 'Eenmalig',
      duurEenmalig: 'Eenmalige interventie',
      duurJaarSingular: '{n} jaar',
      duurJaarPlural: '{n} jaar',
      seizoenPrefix: 'Wij plannen uw eerste onderhoudsbeurt in de periode {seizoenen}',
      nvt: 'n.v.t.'
    },
    languagePrompt: {
      title: 'Welke taal verkiest u?',
      subtitle: 'We hebben gemerkt dat uw postcode in Brussel ligt. Kies uw voorkeurstaal voor deze offerte.',
      nl: 'Nederlands',
      fr: 'Fran\u00e7ais',
      remember: 'Onthoud mijn keuze'
    },
    consent: {
      title: 'Communicatie-voorkeuren',
      subtitle: 'U kunt deze voorkeuren altijd later aanpassen via de opt-out-link in elke communicatie.',
      email_service: {
        label: 'Service-mails (vereist voor uitvoering contract)',
        help: 'Bevestiging van uw afspraken, factuur, rapport na onderhoudsbeurt en service-meldingen.'
      },
      email_marketing: {
        label: 'Marketing-mails (optioneel)',
        help: 'Tips, nieuwsbrief en promo-acties. Maximaal eenmaal per maand.'
      },
      sms: {
        label: 'SMS-herinneringen (optioneel)',
        help: 'Korte herinnering 24u voor uw beurt + dag-zelf met aankomsttijd technieker.'
      },
      whatsapp: {
        label: 'WhatsApp-berichten (optioneel)',
        help: 'Interactieve berichten met foto\'s van het rapport en mogelijkheid tot directe vragen.'
      }
    },
    optOut: {
      title: 'Uitschrijving bevestigd',
      subtitleSuccess: 'U ontvangt geen berichten meer via dit kanaal. Service-mails (afspraakbevestigingen, facturen) blijven u bereiken zolang uw contract loopt.',
      subtitleFail: 'We konden uw uitschrijving niet verwerken. Mogelijk is de link verlopen of al gebruikt.',
      contactHint: 'Vragen? Mail ons op {email}.',
      backHome: 'Terug naar de website',
      processing: 'Bezig met verwerken\u2026'
    },
    errors: {
      generic: 'Er is iets misgegaan. Probeer opnieuw of neem contact op.',
      requiredField: 'Dit veld is verplicht',
      invalidEmail: 'Ongeldig e-mailadres',
      invalidPostcode: 'Ongeldige postcode',
      invalidPhone: 'Ongeldig telefoonnummer',
      tooManySubmits: 'U heeft te vaak verzonden. Probeer over een uur opnieuw.'
    }
  });
})();
