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
      postcode: {
        title: 'Postcode van de werken',
        subtitle: 'Voer de postcode in van het adres waar de werken zullen worden uitgevoerd. Op basis hiervan bepalen we uw verzendkosten en het toepasselijke BTW-tarief.',
        label: 'Postcode',
        placeholder: 'Bijv. 9000',
        helperBE: 'Belgische postcode \u2014 alle BTW-tarieven beschikbaar.',
        helperFallback: 'Buitenlandse of ongeldige postcode \u2014 standaard 21% BTW van toepassing.',
        gemeenteLabel: 'Gemeente',
        gemeenteAuto: 'Automatisch ingevuld op basis van postcode.',
        gemeenteChoose: 'Selecteer de juiste gemeente:'
      },
      cards: {
        afstand: 'Afstand',
        afstandLabel: 'Afstand tot uw woning',
        afstandUnit: '(in km)',
        btw: 'BTW-tarief',
        btw21: '21% BTW',
        btw21sub: 'Standaardtarief',
        btw6: '6% BTW',
        btw6sub: 'Renovatie \u2014 woning ouder dan 10 jaar (enkel Belgi\u00eb)',
        btw6disabled: 'Enkel beschikbaar voor Belgische postcodes',
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
        title: 'Verklaring op eer \u2014 verlaagd btw-tarief van 6%',
        intro: 'Volgens KB nr. 20 (rubriek XXXVIII en XXXI van tabel A) kan het verlaagd btw-tarief van 6% enkel worden toegepast wanneer de woning aan beide onderstaande voorwaarden voldoet. Vink beide verklaringen aan om het tarief van 6% te bevestigen.',
        cond1: 'De woning is ouder dan 10 jaar (eerste ingebruikname meer dan 10 jaar geleden)',
        cond2: 'De woning wordt hoofdzakelijk als priv\u00e9woning gebruikt',
        cond3: 'De werken worden rechtstreeks aan de eindverbruiker gefactureerd',
        checkPrive: 'Ik verklaar op eer dat het gebouw waar de werken worden uitgevoerd uitsluitend of hoofdzakelijk wordt gebruikt als priv\u00e9woning, en dat ik de eindverbruiker ben aan wie deze werken rechtstreeks worden gefactureerd.',
        checkOuderdom: 'Ik verklaar op eer dat de eerste ingebruikname van het gebouw minstens tien jaar voorafgaat aan het eerste tijdstip waarop deze btw opeisbaar wordt.',
        disclaimer: 'Bij een onjuiste verklaring kan het verschil in btw (15%), evenals eventuele verwijlinteresten en boetes, integraal op u worden verhaald (KB nr. 20 \u2014 art. 1quater).'
      }
    },
    step2: {
      title: 'Uw gegevens',
      subtitle: 'Vul hieronder uw gegevens in om uw persoonlijke overeenkomst op te stellen.',
      personal: 'Persoonsgegevens',
      contact: 'Contactgegevens',
      naam: 'Naam',
      naamPh: 'Bijv. Jan Janssen',
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
    klantType: {
      title: 'U bent\u2026',
      subtitle: 'Selecteer het type klant zodat we de juiste gegevens vragen.',
      particulier: 'Particulier',
      particulierSub: 'Privé\u00ADpersoon zonder BTW-nummer',
      bedrijf: 'Bedrijf',
      bedrijfSub: 'Met BTW-nummer (B2B)',
      bedrijfsnaam: 'Bedrijfsnaam',
      bedrijfsnaamPh: 'Bijv. Janssen BV',
      btwNummer: 'BTW-nummer',
      btwNummerPh: 'BE0123456789',
      btwHelper: 'We controleren automatisch via VIES (EU BTW-register).',
      contactpersoon: 'Contactpersoon',
      contactpersoonPh: 'Naam contactpersoon binnen het bedrijf',
      viesValidating: 'BTW-nummer valideren\u2026',
      viesValid: 'Geverifieerd via VIES \u2014 gegevens automatisch ingevuld',
      viesInvalid: 'Ongeldig BTW-nummer (formaat of niet bekend in VIES-register)',
      viesError: 'Validatie tijdelijk niet beschikbaar \u2014 u kunt doorgaan, we valideren later'
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
    },
    validation: {
      required: 'Dit veld is verplicht.',
      invalidEmail: 'Vul een geldig e-mailadres in (bv. naam@voorbeeld.be).',
      invalidPhone: 'Vul een geldig Belgisch telefoonnummer in (bv. +32 4XX XX XX XX).',
      invalidPostcode: 'Vul een geldige postcode in (4 cijfers, bv. 9000).',
      invalidName: 'Vul minstens uw voornaam en familienaam in.',
      postcodeNotFound: 'Postcode niet gevonden in onze referentielijst \u2014 controleer de invoer.',
      remainingFieldsOne: 'Nog 1 verplicht veld in te vullen voor u verder kan.',
      remainingFieldsMany: 'Nog {count} verplichte velden in te vullen voor u verder kan.',
      okReady: 'Alle gegevens zijn correct ingevuld.',
      btw6NeedsBoth: 'Vink beide verklaringen aan of kies voor 21% BTW.',
      btw6Reverted: 'BTW automatisch teruggezet naar 21% omdat niet aan de voorwaarden werd voldaan.'
    },
    rapport: {
      contract: {
        tabLabel: 'Contract',
        tabSubtitle: 'Scope, klantgegevens en bijkomende afspraken voor deze opdracht.',
        scope: {
          title: 'Scope van de opdracht',
          aantalPanelen: 'Aantal panelen',
          frequentie: 'Frequentie',
          contractduur: 'Contractduur',
          btwTarief: 'BTW-tarief',
          totaalInclBtw: 'Totaal incl. BTW',
          totaalExclBtw: 'Totaal excl. BTW',
          eenheidsprijsBeurt: 'Eenheidsprijs per beurt',
          notSet: 'Niet ingevuld',
          btw6Verklaring: 'Verklaring 6% BTW geregistreerd op {datum}',
          btw6VerklaringMissing: 'Verklaring 6% BTW ontbreekt',
          frequentieJaarlijks: 'Jaarlijks',
          frequentieHalfjaarlijks: 'Halfjaarlijks',
          frequentieEenmalig: 'Eenmalig',
          duurEenmalig: 'Eenmalig',
          duurJaren: '{n} jaar'
        },
        klantContact: {
          title: 'Klant- en contactgegevens',
          naam: 'Naam',
          adres: 'Adres',
          postcode: 'Postcode',
          gemeente: 'Gemeente',
          email: 'E-mail',
          telefoon: 'Telefoon',
          klantType: 'Type klant',
          particulier: 'Particulier',
          bedrijf: 'Bedrijf',
          bedrijfsnaam: 'Bedrijfsnaam',
          btwNummer: 'BTW-nummer',
          contactpersoon: 'Contactpersoon',
          btwGevalideerd: 'BTW geverifieerd via VIES op {datum}'
        },
        instructies: {
          title: 'Speciale instructies voor de technieker',
          subtitle: 'Bijzonderheden die de technieker ter plekke moet weten (toegang, code, hond, parkeren, contactpersoon op locatie, ...).',
          placeholder: 'Bv. sleutel onder bloempot, hond aanwezig, parkeren op de oprit \u2014 bel klant 10 min voor aankomst.',
          charCounter: '{n}/{max} tekens',
          save: 'Instructies opslaan',
          saving: 'Opslaan\u2026',
          saved: 'Opgeslagen',
          saveSuccess: 'Instructies opgeslagen.',
          saveError: 'Opslaan mislukt. Probeer opnieuw.',
          tooLong: 'Maximum {max} tekens bereikt.'
        },
        handtekening: {
          title: 'Akkoord scope door klant',
          subtitle: 'Optioneel \u2014 klant kan ter plekke akkoord geven voor de geplande scope vóór start van de werken.',
          cta: 'Klant tekent ter plekke',
          modalTitle: 'Klant tekent voor akkoord scope',
          modalHint: 'Laat de klant hieronder tekenen. Door te tekenen bevestigt de klant dat de geplande werken overeenkomen met de afspraak.',
          clear: 'Wissen',
          confirm: 'Bevestig akkoord',
          cancel: 'Annuleren',
          signedAt: 'Akkoord getekend op {datum}',
          confirmClear: 'Bestaande scope-akkoord-handtekening wissen? Deze actie kan niet ongedaan worden gemaakt.',
          clearAction: 'Wis & opnieuw',
          saveSuccess: 'Akkoord scope opgeslagen.',
          saveError: 'Opslaan handtekening mislukt. Probeer opnieuw.',
          empty: 'Teken eerst een handtekening voor u bevestigt.'
        },
        emptyState: 'Selecteer eerst een onderhoudsbeurt om de contractgegevens te zien.'
      }
    },
    // Slot A4 — Werkplanning per-dag export (admin/planning.html)
    // Strings worden ge-spiegeld in de inline wpeT()-fallback in planning.html
    // zodat ze ook werken zonder geladen i18n-runtime; bij toekomstige admin-i18n
    // adoptie nemen deze keys het over zonder code-wijziging.
    planning: {
      werkplanningExport: {
        title: 'Werkplanning exporteren',
        subtitle: '{tech} \u2014 {datum}',
        metaCount: '{count} beurt vandaag',
        metaCountPlural: '{count} beurten vandaag',
        btnPdf: 'PDF downloaden',
        btnPdfSub: 'A4-document met alle beurten van de dag',
        btnPdfLoading: 'PDF wordt gegenereerd\u2026',
        btnWhatsapp: 'Stuur via WhatsApp',
        btnWhatsappSub: 'Opent WhatsApp met pre-fill bericht + PDF-link',
        btnRetry: 'Opnieuw proberen',
        close: 'Sluiten',
        successToast: 'Werkplanning gegenereerd',
        openInTab: 'Open PDF in nieuw tabblad',
        errorTitle: 'Werkplanning kon niet gegenereerd worden',
        errorTimeout: 'Het duurde te lang om de PDF te maken. Probeer opnieuw of contacteer support als dit blijft gebeuren.',
        errorNetwork: 'Geen verbinding met de PDF-service. Controleer je internet en probeer opnieuw.',
        errorAuth: 'Sessie verlopen. Log opnieuw in om de werkplanning te exporteren.',
        errorRate: 'Te veel exports na elkaar. Wacht even en probeer opnieuw.',
        errorGeneric: 'Er ging iets mis bij het genereren van de PDF.',
        errorMissingSession: 'Geen actieve admin-sessie gevonden \u2014 herlaad de pagina.',
        errorNoBeurten: 'Geen beurten gevonden voor deze technieker op deze dag.',
        waMessageNl: 'Hoi {voornaam}, hier je werkplanning voor {datum}: {url}',
        expiresHint: 'Link 7 dagen geldig.'
      }
    }
  });
})();
