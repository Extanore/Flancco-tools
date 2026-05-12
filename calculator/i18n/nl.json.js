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
        afstandComputed: 'Automatisch berekend op basis van uw postcode.',
        afstandFallback: 'Geschatte afstand — we koppelen uw postcode bij het inplannen.',
        afstandWaiting: 'Vul eerst uw postcode in om de afstand te berekenen.',
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
      ctaBack: '\u2190 Terug',
      fieldsFilled: 'velden ingevuld'
    },
    // Slot S \u2014 In-browser samenvatting (review-step) labels
    summary: {
      benefits: 'Wat wij voor u doen',
      calc: 'Uw berekening',
      yourData: 'Uw gegevens',
      labelNaam: 'Naam',
      labelAdres: 'Adres',
      labelEmail: 'Email',
      labelTelefoon: 'Telefoon',
      transport: 'Verplaatsing ({km} km boven gratis zone)',
      contractKorting: 'Contractkorting ({duur} jaar, \u2212{pct}%)',
      perBeurtTotaal: 'Totaal per beurt',
      btwNote: 'incl. {pct}% btw \u00b7 {freq} \u00b7 {duur}',
      perJaar2: 'Per jaar (2 beurten): {bedrag}',
      tipUpsell: '<strong>Tip:</strong> Kies een contract van 3 of 5 jaar en bespaar 5% op elke beurt. Dat is {savings} korting per beurt. <a href="#" data-action="adjust-duur">Aanpassen</a>'
    },
    // Slot S \u2014 Contract-PDF + in-browser contract-render dictionary.
    // Spiegel altijd in fr.json.js. Wordt gebruikt door buildContractHTMLShared
    // (PDF-pad) en generateContract() (review-pad in calculator).
    contract: {
      htmlLang: 'nl',
      title: 'Contract',
      header: {
        dienstverlening: 'Dienstverleningsovereenkomst'
      },
      partijen: {
        tussen: 'Tussen',
        gevestigdTe: 'gevestigd te',
        hiernaDienstverlener: 'hierna "de Dienstverlener",',
        en: 'En',
        hiernaKlant: 'hierna "de Klant", gezamenlijk "de Partijen".'
      },
      label: {
        naamBedrijfsnaam: 'Naam / Bedrijfsnaam',
        adres: 'Adres',
        postcodeGemeente: 'Postcode + Gemeente',
        contactpersoon: 'Contactpersoon',
        telefoon: 'Telefoon',
        email: 'E-mail',
        btwNummer: 'BTW-nummer'
      },
      artikelPrefix: 'Artikel',
      artikel: {
        voorwerp: {
          heading: 'Voorwerp',
          intro: 'De Dienstverlener verbindt zich ertoe de volgende diensten uit te voeren op het hierboven vermelde adres:'
        },
        tarieven: {
          heading: 'Tarieven',
          inclBtw: 'Alle bedragen zijn in euro en inclusief {pct}% btw.',
          omschrijving: 'Omschrijving',
          bedrag: 'Bedrag',
          bijkomendeKosten: 'Bijkomende kosten',
          tarief: 'Tarief',
          uwBerekening: 'Uw berekening',
          uwPrijsoverzicht: 'Uw prijsoverzicht',
          subtotaalExcl: 'Subtotaal excl. BTW',
          btwLine: 'BTW {pct}%',
          totaalPerBeurt: 'Totaal per beurt incl. BTW',
          totaalPerBeurtPlain: 'Totaal per beurt: {bedrag} incl. {pct}% btw',
          perJaar: 'Per jaar (2 beurten): {bedrag}',
          totaalIncl: 'Totaal incl. BTW',
          transportLine: 'Verplaatsing: {km} km \u00d7 {tarief} = {totaal}',
          kortingLine: 'Contractkorting ({duur} jaar, -{pct}%): - {bedrag}',
          verplaatsingBoven: 'Verplaatsing boven {km} km'
        },
        frequentie: {
          heading: 'Frequentie',
          gekozen: 'Gekozen frequentie: <strong>{freq}</strong>',
          inplanning: 'De onderhoudsbeurten worden in onderling overleg ingepland. De Dienstverlener contacteert de Klant minstens twee (2) weken op voorhand.'
        },
        contractduur: {
          heading: 'Contractduur',
          gekozen: 'Gekozen contractduur: <strong>{duur}</strong>',
          body: 'Bij een contract van 3 of 5 jaar wordt een korting van 5% toegepast. Het contract vangt aan op de datum van ondertekening. Behoudens schriftelijke opzegging (2 maanden opzegtermijn) wordt het stilzwijgend verlengd per jaar.'
        },
        prijsindexatie: {
          heading: 'Prijsindexatie',
          body: 'Tarieven worden jaarlijks ge\u00efndexeerd op basis van de consumptieprijsindex (CPI).'
        },
        facturatie: {
          heading: 'Facturatie en betaling',
          body: 'Facturen zijn betaalbaar binnen 30 kalenderdagen na factuurdatum.'
        },
        uitvoering: {
          heading: 'Uitvoering',
          body: 'De Dienstverlener voert het onderhoud uit met eigen gekwalificeerd personeel. De Klant zorgt voor vrije toegang tot de installatie(s).'
        },
        annulatie: {
          heading: 'Annulatie',
          bodyVar: 'Bij annulatie minder dan 48 uur v\u00f3\u00f3r de geplande interventie wordt een annulatiekost van {bedrag} aangerekend.',
          bodyDefault: 'Bij annulatie minder dan 48 uur v\u00f3\u00f3r de geplande interventie wordt een annulatiekost aangerekend.'
        },
        aansprakelijkheid: {
          heading: 'Aansprakelijkheid',
          body: 'De Dienstverlener is verzekerd voor beroeps- en uitbatingsaansprakelijkheid. Niet aansprakelijk voor reeds bestaande schade of indirecte gevolgschade.'
        },
        attestBtw6: {
          heading: 'Attest verlaagd btw-tarief (6%)',
          verklaring: 'Verklaring op eer door de opdrachtgever',
          intro: 'Ondergetekende, <strong>{naam}</strong>, verklaart op eer dat:',
          introCompact: 'Ondergetekende, <strong>{naam}</strong>, verklaart op eer dat het gebouw{adresPart} langer dan 10 jaar in gebruik is als priv\u00e9woning, de werken rechtstreeks aan de eindverbruiker worden gefactureerd, en de woning hoofdzakelijk voor priv\u00e9doeleinden wordt aangewend.',
          adresPartTpl: ' gelegen te <strong>{adres}</strong>',
          li1Tpl: 'Het gebouw gelegen te <strong>{adres}</strong> langer dan 10 jaar in gebruik is als priv\u00e9woning',
          li2: 'De werken rechtstreeks aan de eindverbruiker worden gefactureerd',
          li3: 'De woning hoofdzakelijk voor priv\u00e9doeleinden wordt aangewend',
          disclaimer: 'Bij onjuiste verklaring is de opdrachtgever aansprakelijk voor het verschil tussen het verlaagd (6%) en het normaal (21%) btw-tarief, vermeerderd met eventuele boetes en interesten.'
        },
        herroeping: {
          heading: 'Herroepingsrecht',
          bodyShort: 'De Klant heeft het recht om binnen 14 kalenderdagen na ondertekening deze overeenkomst zonder opgave van redenen te herroepen, conform de Europese richtlijn 2011/83/EU.',
          bodyLong: 'De Klant heeft het recht om binnen 14 kalenderdagen na ondertekening deze overeenkomst zonder opgave van redenen te herroepen, conform de Europese richtlijn 2011/83/EU. Het herroepingsformulier wordt meegestuurd met de bevestigingsmail.'
        }
      },
      sig: {
        heading: 'Ondertekening',
        intro: 'Door ondertekening verklaart de Klant akkoord te gaan met alle bepalingen van deze Overeenkomst.',
        repBy: 'Vertegenwoordigd door de Dienstverlener',
        datum: 'Datum',
        deKlant: 'De Klant',
        naam: 'Naam',
        namens: 'Namens',
        signaturePlaceholder: 'Teken hier uw handtekening',
        signatureLabel: 'Handtekening:',
        signatureHint: 'teken met uw muis of vinger',
        wissen: 'Wissen',
        handtekeningAlt: 'Handtekening',
        accept: 'Ik, <strong>{naam}</strong>, verklaar deze overeenkomst gelezen te hebben en ga akkoord met alle hierin vermelde voorwaarden en tarieven. Ik begrijp dat deze digitale ondertekening rechtsgeldig is conform de EU eIDAS-verordening.',
        acceptBedrijfOnly: 'Ondergetekende verklaart gemachtigd te zijn om namens <strong>{naam}</strong> deze overeenkomst aan te gaan, deze gelezen te hebben en akkoord te gaan met alle hierin vermelde voorwaarden en tarieven. Deze digitale ondertekening is rechtsgeldig conform de EU eIDAS-verordening.'
      },
      sectorLabel: {
        zonnepanelen: 'Zonnepanelen',
        warmtepomp: 'Warmtepomp',
        ventilatie: 'Ventilatie',
        verwarming: 'Verwarming',
        ic: 'Industrial Cleaning',
        klussen: 'Klussen'
      },
      freq: {
        jaarlijks: 'Jaarlijks (1x/jaar)',
        halfjaarlijks: 'Halfjaarlijks (2x/jaar)',
        eenmalig: 'Eenmalig',
        jaarlijksShort: 'Jaarlijks (1\u00d7)',
        halfjaarlijksShort: 'Halfjaarlijks (2\u00d7)'
      },
      duur: {
        eenmalig: 'Eenmalige interventie',
        jaarSuffix: ' jaar',
        jaarKorting: ' jaar (5% korting)'
      },
      daktype: {
        hellend: 'hellend dak',
        plat: 'plat dak',
        grond: 'grondopstelling'
      },
      formule: {
        allin: 'all-in',
        basic: 'basic',
        allinFull: 'all-in formule',
        basicFull: 'basic formule'
      },
      sectorDesc: {
        zonnepanelenLine: 'reiniging van {n} zonnepanelen ({daktype})',
        warmtepompLine: 'onderhoud van {n} binnenunit(s) ({formule})',
        ventilatieLine: 'onderhoud ventilatiesysteem {systeem} met {n} ventielen',
        verwarmingLine: 'onderhoud {keteltype}ketel'
      },
      defaults: {
        nvt: 'n.v.t.',
        emDash: '\u2014'
      },
      currency: {
        eurDefault: '\u20ac 20'
      }
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
      viesError: 'Validatie tijdelijk niet beschikbaar \u2014 u kunt doorgaan, we valideren later',
      viesFallbackNotice: 'VIES is tijdelijk niet bereikbaar \u2014 uw BTW-nummer wordt later automatisch geverifieerd. U kan in alle vertrouwen doorgaan met ondertekenen.',
      // Slot T A5 \u2014 bedrijf-only sub-toggle
      bedrijfOnlyTitle: 'Wie tekent dit contract?',
      bedrijfOnlyContactTitle: 'Specifieke contactpersoon',
      bedrijfOnlyContactSub: 'contractuele ondertekenaar met voor- en achternaam',
      bedrijfOnlyCompanyTitle: 'Het bedrijf zelf',
      bedrijfOnlyCompanySub: 'geen vaste contactpersoon, ondertekening \u00abnamens [bedrijfsnaam]\u00bb',
      bedrijfOnlyDisclaimer: 'Door te ondertekenen verklaart u gemachtigd te zijn om namens dit bedrijf contractuele verbintenissen aan te gaan. Onder Belgisch recht is een ondertekening \u00abnamens [bedrijfsnaam]\u00bb door een gemachtigde rechtsgeldig mits bevoegdheid kan worden aangetoond.'
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
      subtitle: 'Service-kanalen zijn nodig voor de uitvoering van uw contract. Marketing kunt u op elk moment uitschakelen via de opt-out-link.',
      email_service: {
        label: 'Service-mails (vereist voor uitvoering contract)',
        help: 'Bevestiging van uw afspraken, factuur, rapport na onderhoudsbeurt en service-meldingen.'
      },
      whatsapp: {
        label: 'WhatsApp-berichten (vereist voor uitvoering contract)',
        help: 'Het werkrapport met foto\'s van uw installatie wordt na elke beurt via WhatsApp bezorgd, samen met directe contactmogelijkheid bij vragen.'
      },
      email_marketing: {
        label: 'Marketing-mails (optioneel)',
        help: 'Tips, nieuwsbrief en promo-acties. Maximaal eenmaal per maand. U kunt zich op elk moment uitschrijven.'
      },
      // Slot X — sms-keys behouden voor backward-compat met admin-side UI;
      // niet meer gerendered in calculator.
      sms: {
        label: 'SMS-herinneringen (optioneel)',
        help: 'Korte herinnering 24u voor uw beurt + dag-zelf met aankomsttijd technieker.'
      }
    },
    // Slot F — Klant-facing multi-kanaal notificaties (email/SMS/WhatsApp)
    // Deze keys worden gerendered in send-klant-notification-email/-sms/-whatsapp
    // en in eventuele admin-kant trigger-knoppen. Spiegel altijd in fr.json.js.
    notification: {
      reminder_24h: {
        emailSubject: 'Herinnering: morgen onderhoud zonnepanelen',
        emailHeader: 'Tot morgen',
        emailIntroNamed: 'Beste {klant}, een korte herinnering aan uw geplande onderhoudsbeurt.',
        emailIntroAnon: 'Een korte herinnering aan uw geplande onderhoudsbeurt.',
        emailDateLabel: 'Datum',
        emailTimeLabel: 'Aankomst',
        emailTimeFullDay: 'Ganse dag',
        emailNote: 'Zorg ervoor dat de panelen toegankelijk zijn en dat eventuele toegangscodes/sleutels klaar liggen.',
        emailContactCta: 'Iets aan te passen? Antwoord op deze mail.',
        smsBody: '{partner}: herinnering — onderhoud zonnepanelen morgen {datum}{tijd, select, leeg{} other{ om {tijd}}}.',
        whatsappTemplateName: 'klant_reminder_24h_nl'
      },
      reminder_day: {
        emailSubject: 'Onze technieker komt vandaag langs',
        emailHeader: 'We komen vandaag',
        emailIntroNamed: 'Beste {klant}, vandaag voert onze technieker het onderhoud aan uw zonnepanelen uit.',
        emailIntroAnon: 'Vandaag voert onze technieker het onderhoud aan uw zonnepanelen uit.',
        emailTimeLabel: 'Verwachte aankomst',
        emailTechnicianLabel: 'Technieker',
        emailContactCta: 'Vragen? Bel of antwoord op deze mail.',
        smsBody: '{partner}: we komen vandaag langs{tijd, select, leeg{} other{ om {tijd}}}.',
        whatsappTemplateName: 'klant_reminder_day_nl'
      },
      rapport_klaar: {
        emailSubject: 'Uw onderhoudsrapport is klaar',
        emailHeader: 'Rapport beschikbaar',
        emailIntroNamed: 'Beste {klant}, het rapport van uw recent uitgevoerde onderhoudsbeurt is klaar.',
        emailIntroAnon: 'Het rapport van uw recent uitgevoerde onderhoudsbeurt is klaar.',
        emailCtaButton: 'Open rapport',
        emailExpiryNote: 'Deze link blijft 30 dagen geldig.',
        emailFollowupHint: 'Bewaar dit rapport — u kunt het later nog opvragen via uw klantenportaal.'
      },
      common: {
        partnerSignature: 'Met vriendelijke groet,\n{partner}',
        optOutFooter: 'U ontvangt deze mail omdat u akkoord gaf bij ondertekening van uw onderhoudscontract.',
        optOutLink: 'Uitschrijven voor dit kanaal',
        privacyLink: 'Privacyverklaring',
        contactSupport: 'Contact: {email}'
      },
      adminTrigger: {
        sectionTitle: 'Notificaties manueel versturen',
        btnReminder24h: 'Stuur 24u-herinnering',
        btnReminderDay: 'Stuur dag-herinnering',
        btnRapportKlaar: 'Stuur rapport-mail',
        toastSent: 'Notificatie verstuurd via {kanaal}.',
        toastSkipped: 'Niet verstuurd: {reden}.',
        toastFailed: 'Versturen mislukt: {reden}.',
        confirmForce: 'Deze beurt heeft al een notificatie ontvangen via dit kanaal. Toch opnieuw versturen?'
      },
      reasons: {
        no_consent: 'Klant heeft geen actieve toestemming voor dit kanaal',
        already_sent: 'Notificatie was al eerder verstuurd',
        missing_contact: 'Geen geldig contactgegeven beschikbaar',
        daily_cap: 'Dag-limiet voor dit kanaal bereikt',
        not_configured: 'Kanaal nog niet geconfigureerd door beheerder',
        send_failed: 'Provider weigerde de verzending'
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
      },
      // Slot K — Feestdagen + sluitingsperiodes (soft-warning)
      // Strings worden inline gespiegeld in planning.html (geen i18n-runtime in admin).
      feestdagen: {
        markerLabelFd: 'Feestdag',
        markerLabelSp: 'Sluitingsperiode',
        bannerHeading: 'Sluitingsperiodes in deze periode',
        warningTitleFd: 'Je plant op een feestdag',
        warningTitleSp: 'Je plant tijdens een sluitingsperiode',
        warningSubtitle: 'Onze planning detecteerde een conflict. Je kan altijd doorgaan als dit een uitzondering is.',
        warningCancel: 'Annuleer',
        warningProceed: 'Toch plannen'
      },
      // Slot B — Smart picker modal voor cell-clicks (week/dag/maand views).
      // Admin gebruikt geen runtime-i18n; deze keys zijn voorbereid voor toekomstige
      // adoptie en gespiegeld in fr.json.js voor parity. Strings staan vandaag
      // inline in admin/planning.html.
      smartPicker: {
        title: 'Voor {tech} op {date}',
        searchPlaceholder: 'Zoek klant, opdracht, sector\u2026',
        sectionSuggesties: 'Suggesties',
        sectionLopend: 'Lopende opdrachten',
        sectionGepland: 'Gepland / in te plannen',
        emptyNoSuggesties: 'Geen suggesties op dit moment.',
        emptyNoLopend: 'Geen lopende opdrachten.',
        emptyNoGepland: 'Geen geplande opdrachten.',
        actionNew: '+ Nieuwe opdracht',
        actionBeschikbaarheid: '+ Beschikbaarheid',
        toastAddedExisting: 'Toegevoegd als extra technieker',
        toastAddedNew: 'Nieuwe planning-dag aangemaakt',
        toastAlreadyAssigned: 'Deze technieker is al toegekend op deze datum'
      },
      // Slot M — Helper-popover op lopende balk (admin/planning.html)
      // Mini-popover om een extra technieker toe te voegen voor X dagen.
      // Strings staan vandaag inline in admin/planning.html; deze keys zijn
      // gespiegeld in fr.json.js voor parity en toekomstige i18n-runtime adoptie.
      helperPopover: {
        titleExtra: 'Extra technieker erbij',
        primair: 'Primair',
        looptPrefix: 'loopt',
        periodLabel: 'Periode',
        periodToday: 'Vandaag',
        periodDays: 'Aantal dagen',
        periodRemaining: 'Resterende duur',
        urenCheckbox: 'Specifieke uren?',
        urenFrom: 'Van',
        urenTo: 'tot',
        techLabel: 'Kies technieker (vrij op deze datum)',
        showBezet: 'Toon ook bezette techs',
        conflictBadge: '{n} conflict(en)',
        cancel: 'Annuleer',
        save: 'Voeg toe',
        toastSaved: 'Technieker toegevoegd voor {n} dag(en)',
        toastSkipped: 'Technieker was al toegekend',
        toastError: 'Toevoegen mislukt: {error}'
      }
    },
    // Slot K & L — Admin-beheer: feestdagen, verlof / EW
    admin: {
      // Slot L — Verlof / EW samengevoegd onder één pagina (page-verlof-ew)
      verlofEw: {
        title: 'Verlof / EW',
        subtitle: 'Beheer verlof-aanvragen, saldi en economische werkloosheid',
        tabVerlof: 'Verlof',
        tabEw: 'EW',
        subTabKalender: 'Kalender',
        subTabAanvragen: 'Aanvragen',
        subTabSaldo: 'Saldo',
        subTabPersoneel: 'Personeel',
        nieuweAanvraag: 'Nieuwe aanvraag'
      },
      feestdagen: {
        pageTitle: 'Feestdagen & sluitingsperiodes',
        pageSubtitle: 'Wettelijke BE feestdagen en bedrijfs-sluitingen. Worden in de planning-agenda als waarschuwing getoond.',
        btnNew: 'Nieuwe toevoegen',
        btnAutoExtend: 'Genereer voor volgend jaar',
        colDate: 'Datum',
        colDateEnd: 'Einddatum',
        colType: 'Type',
        colLabel: 'Label',
        colRecurring: 'Recurring',
        colActions: 'Acties',
        typeFd: 'Feestdag',
        typeSp: 'Sluitingsperiode',
        recurringJaarlijks: 'Jaarlijks',
        recurringEenmalig: 'Eenmalig',
        empty: 'Geen feestdagen of sluitingsperiodes gevonden voor deze filter.',
        modalNewFd: 'Nieuwe feestdag',
        modalNewSp: 'Nieuwe sluitingsperiode',
        modalEditFd: 'Feestdag bewerken',
        modalEditSp: 'Sluitingsperiode bewerken',
        labelDate: 'Datum',
        labelDateStart: 'Startdatum',
        labelDateEnd: 'Einddatum',
        labelLabel: 'Label',
        placeholderLabel: 'Bv. Bouwverlof zomer 2027',
        helpLabel: 'Wordt in de planning-agenda getoond bij de betreffende dag.',
        helpRecurring: 'Jaarlijkse feestdagen worden automatisch uitgebreid via cron (1 december).',
        toastSaved: 'Opgeslagen.',
        toastDeleted: 'Verwijderd.',
        toastSeedDone: 'Wettelijke feestdagen voor {year} toegevoegd ({count} nieuw, {dup} bestond al).',
        toastSeedFailed: 'Auto-extend mislukt: {reason}',
        errRequired: 'Datum, label en type zijn verplicht.',
        errEindRequired: 'Sluitingsperiode vereist een einddatum.',
        errEindBeforeStart: 'Einddatum moet gelijk of na de startdatum zijn.',
        errLabelShort: 'Label moet minstens 2 tekens bevatten.',
        deleteConfirmFd: 'Weet je zeker dat je de feestdag {label} ({datum}) wil verwijderen?',
        deleteConfirmSp: 'Weet je zeker dat je de sluitingsperiode {label} ({datum}) wil verwijderen?'
      }
    },
    // Slot C — Partner-portal pipeline-tab + acties (bel/email/follow-up)
    partner: {
      pipeline: {
        tabPipeline: 'Pipeline',
        tabAlle: 'Alle contracten',
        tabFollowUp: 'Follow-up',
        statusConcept: 'Concept',
        statusGetekend: 'Getekend',
        statusActief: 'Actief',
        statusVerlopen: 'Verlopen',
        statusGeannuleerd: 'Geannuleerd',
        actionBelKlant: 'Bel klant',
        actionEmailKlant: 'Herinner via email',
        actionFollowUp: 'Markeer als follow-up',
        actionUnFollowUp: 'Verwijder follow-up',
        toastFollowUpAdded: 'Gemarkeerd voor follow-up',
        toastFollowUpRemoved: 'Follow-up verwijderd',
        emptyFollowUp: 'Geen follow-ups op dit moment.',
        emailSubject: 'Herinnering onderhoud {klant}',
        emailBody: 'Beste {klant}, een korte herinnering aan uw onderhoudsbeurt. Met vriendelijke groet,'
      },
      // Slot D — Facturatie-pagina (partner-portal) + PDF-overzicht template
      facturatie: {
        title: 'Facturatie',
        subtitle: {
          week: 'Alle afgewerkte beurten in week {periode}',
          maand: 'Alle afgewerkte beurten over {periode}',
          jaar: 'Alle afgewerkte beurten in {periode}'
        },
        kpi: {
          count: 'Aantal beurten',
          excl: 'Totaal omzet excl. btw',
          incl: 'Totaal omzet incl. btw',
          marge: 'Totaal partner-marge'
        },
        filter: {
          week: 'Week',
          maand: 'Maand',
          jaar: 'Jaar',
          maandKeuze: {
            '1': '1 maand',
            '3': '3 maanden',
            '6': '6 maanden',
            '12': '12 maanden'
          },
          alleenGefactureerd: 'Alleen gefactureerd'
        },
        kolom: {
          datum: 'Datum',
          klant: 'Klant',
          sector: 'Sector',
          panelen: 'Panelen',
          exclBtw: 'Excl. btw',
          inclBtw: 'Incl. btw',
          planningFee: 'Planning fee',
          marge: 'Partner-marge',
          doorFactureren: 'Door te factureren'
        },
        export: {
          csv: 'Exporteer CSV',
          pdf: 'PDF-overzicht'
        },
        geenData: 'Geen afgewerkte beurten in deze periode.',
        loading: 'Beurten laden\u2026',
        error: 'Kon facturatie-gegevens niet laden.',
        pdf: {
          header: 'Facturatie-overzicht',
          footer: 'Intern document \u2014 niet bestemd voor de eindklant',
          gegenereerdOp: 'Gegenereerd op {datum}',
          totaalRij: 'Totaal',
          aantalBeurten: '{n} beurten'
        }
      },
      // Slot I — Rol-gebaseerd partner-team (team-beheer in partner-instellingen)
      team: {
        title: 'Teamleden',
        subtitle: 'Beheer wie toegang heeft tot dit partner-portaal en welke rechten ze krijgen.',
        add: {
          btn: 'Teamlid toevoegen',
          modalTitle: 'Nieuw teamlid uitnodigen',
          email: 'E-mailadres',
          emailPlaceholder: 'naam@bedrijf.be',
          voornaam: 'Voornaam',
          naam: 'Achternaam',
          presetLabel: 'Snel-instelling',
          presetMedewerkerBasis: 'Medewerker basis',
          presetMedewerkerUitgebreid: 'Medewerker uitgebreid',
          presetCoOwner: 'Co-eigenaar',
          submit: 'Uitnodigen',
          cancel: 'Annuleren'
        },
        perm: {
          contracten_aanmaken: {
            label: 'Contracten aanmaken',
            hint: 'Mag nieuwe contracten registreren via de calculator-link.'
          },
          facturatie_inzage: {
            label: 'Facturatie inzage',
            hint: 'Mag de facturatie-pagina openen en exports downloaden.'
          },
          rapporten_inzage: {
            label: 'Rapporten inzage',
            hint: 'Mag uitvoerings- en service-rapporten openen.'
          },
          planning_inzage: {
            label: 'Planning inzage',
            hint: 'Mag de planning-kalender bekijken en eigen taken zien.'
          },
          manage_users: {
            label: 'Teambeheer',
            hint: 'Mag collega\u2019s uitnodigen, rechten aanpassen en verwijderen.'
          }
        },
        role: {
          owner: 'Beheerder',
          medewerker: 'Medewerker'
        },
        actions: {
          edit: 'Rechten aanpassen',
          remove: 'Verwijderen'
        },
        edit: {
          modalTitle: 'Rechten aanpassen voor {naam}',
          submit: 'Opslaan',
          cancel: 'Annuleren'
        },
        remove: {
          confirmTitle: 'Teamlid verwijderen?',
          confirmBody: 'Je staat op het punt om {naam} te verwijderen uit dit partner-portaal. Deze actie kan niet ongedaan gemaakt worden.',
          confirmBtn: 'Definitief verwijderen',
          cancel: 'Annuleren'
        },
        toast: {
          invited: 'Uitnodiging verstuurd naar {email}.',
          removed: 'Teamlid verwijderd.',
          permsUpdated: 'Rechten bijgewerkt.',
          errorPermission: 'Je hebt geen rechten om deze actie uit te voeren.',
          errorExists: 'Deze gebruiker bestaat al in een ander partner-team \u2014 contacteer de beheerder.',
          errorSelf: 'Je kan jezelf niet verwijderen.',
          errorLastOwner: 'Kan laatste beheerder niet verwijderen \u2014 wijs eerst een andere collega aan als beheerder.',
          errorRateLimit: 'Te veel uitnodigingen kort na elkaar \u2014 probeer het later opnieuw.',
          errorGeneric: 'Er ging iets mis. Probeer het opnieuw of contacteer support.'
        },
        empty: {
          title: 'Nog geen teamleden',
          hint: 'Nodig je eerste collega uit om samen contracten en planning te beheren.'
        },
        list: {
          permSummaryNone: 'Geen extra rechten',
          permSummaryCount: '{n} rechten actief'
        }
      }
    }
  });
})();
