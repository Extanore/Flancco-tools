/**
 * Slot X — Partner Onboarding Wizard NL dictionary
 * --------------------------------------------------------------
 * Dezelfde patronen als calculator/i18n/nl.json.js: registreert
 * via window.flanccoI18n.registerDict('nl', {...}). Onboard-namespace
 * leeft naast de bestaande calculator-keys zonder collision.
 *
 * Dot-notation: onboard.step1.title, onboard.contract.artikel1.titel.
 * Placeholders: {bedrijfsnaam}, {marge}, {prijs} — eenvoudige
 * key-substitutie zonder pluralization.
 */
(function () {
  if (!window.flanccoI18n) return;
  window.flanccoI18n.registerDict('nl', {
    onboard: {
      meta: {
        title: 'Word partner — Flancco Platform',
        progressLabel: 'Stap {current} van {total}'
      },
      common: {
        next: 'Volgende stap',
        back: 'Terug',
        submit: 'Onderteken & verstuur',
        loading: 'Bezig…',
        validating: 'Even valideren…',
        retry: 'Opnieuw proberen',
        required: 'verplicht',
        optional: 'optioneel',
        switchToFR: 'Français',
        errorGeneric: 'Er ging iets mis. Probeer het opnieuw of contacteer ons op partners@flancco.be.',
        errorNetwork: 'Geen netwerkverbinding. Controleer uw internet en probeer opnieuw.',
        errorRateLimit: 'Te veel pogingen. Wacht een uur en probeer opnieuw.',
        unsavedHint: 'Uw gegevens worden bewaard in deze browser — sluit het venster niet voor de wizard klaar is.'
      },
      step1: {
        eyebrow: 'Word Flancco-partner',
        heroTitle: 'Bouw recurrente omzet zonder operationele last.',
        heroSubtitle: 'Flancco voert uit, u bewaakt de relatie. Eindklanten bestellen onderhoud onder uw merk via een eigen calculator-pagina, met live-pricing en contracten in maximaal vijf minuten.',
        cta: 'Start aanvraag',
        trustline: 'Geen setup-kosten · transparante marges 10–20% · contract opzegbaar per maand',
        usp1Title: 'Partner-platform voor onderhoud',
        usp1Text: 'White-label calculator met uw logo, kleuren en pricing. Klant tekent digitaal, u krijgt direct de lead.',
        usp2Title: 'Klant-aanvragen onder uw merk',
        usp2Text: 'Volledige klantbeleving in uw branding. Magic-link toegang tot uw eigen partner-portaal met dashboard en contracten.',
        usp3Title: 'Flancco doet de uitvoering',
        usp3Text: 'Wij zijn HVAC-gecertificeerd en regelen techniekers, planning, rapportage en facturatie naar de eindklant.',
        whyTitle: 'Waarom partners voor Flancco kiezen',
        why1: 'Schaalbaar: voeg moeiteloos sectoren of klanten toe zonder eigen techniekers aan te werven.',
        why2: 'Transparant: alle pricing, marges en facturen zichtbaar in real-time — geen verborgen kosten.',
        why3: 'Geen setup-fee: u betaalt enkel een planning-fee per uitgevoerde beurt, zonder vaste kosten vooraf.'
      },
      step2: {
        title: 'Bedrijfsgegevens',
        subtitle: 'Vul uw BTW-nummer in en de meeste gegevens vullen we automatisch aan.',
        sectionCompany: 'Onderneming',
        sectionContact: 'Contactpersoon',
        btwLabel: 'BTW-nummer',
        btwPh: 'BE0123456789',
        btwHelp: 'Voer uw Belgisch ondernemingsnummer in. We valideren via VIES en vullen de rest automatisch aan.',
        btwValidating: 'BTW-nummer valideren…',
        btwValid: 'BTW-nummer is geldig.',
        btwInvalid: 'BTW-nummer niet gevonden in VIES. Controleer of u het correct hebt ingevoerd.',
        btwError: 'Validatie tijdelijk niet beschikbaar. U kunt verder — we controleren handmatig.',
        bedrijfsnaamLabel: 'Bedrijfsnaam',
        bedrijfsnaamPh: 'Voorbeeld BVBA',
        adresLabel: 'Adres',
        adresPh: 'Straat en huisnummer',
        postcodeLabel: 'Postcode',
        postcodePh: '9000',
        gemeenteLabel: 'Gemeente',
        gemeentePh: 'Gent',
        websiteLabel: 'Website',
        websitePh: 'https://uwbedrijf.be',
        voornaamLabel: 'Voornaam',
        voornaamPh: 'Jan',
        naamLabel: 'Achternaam',
        naamPh: 'Janssens',
        emailLabel: 'E-mailadres',
        emailPh: 'jan@uwbedrijf.be',
        emailHelp: 'Op dit adres ontvangt u uw magic-link en alle partner-communicatie.',
        telefoonLabel: 'Telefoon',
        telefoonPh: '+32 470 12 34 56',
        errors: {
          btwRequired: 'BTW-nummer is verplicht.',
          btwFormat: 'Ongeldig formaat. Voorbeeld: BE0123456789.',
          bedrijfsnaamRequired: 'Bedrijfsnaam is verplicht.',
          adresRequired: 'Adres is verplicht.',
          postcodeRequired: 'Postcode is verplicht (4 cijfers).',
          gemeenteRequired: 'Gemeente is verplicht.',
          voornaamRequired: 'Voornaam is verplicht.',
          naamRequired: 'Achternaam is verplicht.',
          emailRequired: 'E-mail is verplicht.',
          emailInvalid: 'Ongeldig e-mailadres.',
          telefoonRequired: 'Telefoon is verplicht.',
          telefoonInvalid: 'Ongeldig telefoonnummer.',
          websiteInvalid: 'Ongeldige URL. Begin met https:// of http://.'
        }
      },
      step3: {
        title: 'Sectoren en marge',
        subtitle: 'Selecteer de diensten die u onder uw merk aanbiedt en stel uw marge in.',
        sectorTitle: 'Welke sectoren biedt u aan?',
        sectorHelp: 'Selecteer minstens één sector. U kunt later sectoren toevoegen of pauzeren in uw partner-portaal.',
        sectorWarmtepompTitle: 'Warmtepomp-onderhoud',
        sectorWarmtepompText: 'Jaarlijkse keuring + reinigingsbeurt voor lucht/water-warmtepompen.',
        sectorZonneTitle: 'Zonnepanelen reiniging',
        sectorZonneText: 'Osmosewater-reiniging + opbrengstcontrole voor zonnepaneel-installaties.',
        sectorVentilatieTitle: 'Ventilatie-onderhoud',
        sectorVentilatieText: 'Onderhoud van systeem C en D met filterwissel en debiet-controle.',
        sectorAhuTitle: 'Industriële AHU',
        sectorAhuText: 'Komt eraan — contacteer ons voor uw specifieke vraag.',
        sectorAhuBadge: 'Komt eraan',
        margeTitle: 'Uw marge',
        margeHelp: 'Eenzelfde marge geldt voor alle sectoren. We berekenen ze bovenop ons Flancco-basisbedrag, vervolgens komt 21% btw bij. U kunt dit later aanpassen.',
        margeLabel: 'Marge',
        margeRange: '10–20%',
        previewTitle: 'Voorbeeldprijzen voor uw eindklant',
        previewSmall: 'Klein',
        previewMedium: 'Middel',
        previewLarge: 'Groot',
        previewBasis: 'Flancco-basis',
        previewMarge: 'Uw marge',
        previewExclBtw: 'Excl. BTW',
        previewInclBtw: 'Incl. BTW',
        btwToggle: 'BTW-tarief preview',
        btw21: '21%',
        btw6: '6% (renovatie)',
        btw6Hint: 'Visualisatie — het tarief wordt per klant bepaald op basis van werken en woning-ouderdom.',
        sampleSizes: {
          warmtepomp: { small: 'Lucht/water 6 kW', medium: 'Lucht/water 12 kW', large: 'Hybride 16 kW + boiler' },
          zonnepanelen: { small: '10 panelen', medium: '20 panelen', large: '40 panelen' },
          ventilatie: { small: 'Systeem C compact', medium: 'Systeem D woning', large: 'Systeem D + multi-unit' }
        },
        errors: {
          sectorRequired: 'Selecteer minstens één sector om verder te gaan.'
        }
      },
      step4: {
        title: 'Partnercontract',
        subtitle: 'Lees het contract zorgvuldig door, vink akkoord aan en plaats uw handtekening om uw aanvraag af te ronden.',
        contractTitle: 'Partnercontract — Flancco BV',
        contractIntro: 'Tussen ondergetekenden is overeengekomen wat volgt:',
        partijTitel: 'Partijen',
        partijFlanccoLabel: 'Flancco BV',
        partijFlanccoLine1: 'Vlamingveld 8 D, 8490 Jabbeke, België',
        partijFlanccoLine2: 'BTW: BE0793.732.611 · RPR Brugge',
        partijPartner: 'Partner',
        artikel1Titel: '1. Voorwerp van de overeenkomst',
        artikel1: 'Flancco BV verbindt zich tot het uitvoeren van technische onderhoudswerken (zoals zonnepaneelreiniging, warmtepomp-onderhoud en/of ventilatie-onderhoud) bij eindklanten die door de Partner worden aangebracht. De Partner treedt op als commercieel kanaal en gebruikt een door Flancco gehoste, op maat-gebrande digitale calculator om eindklanten een transparante prijs en contract aan te bieden. De geactiveerde sectoren voor deze samenwerking zijn: {sectoren}.',
        artikel2Titel: '2. Marge en facturatie',
        artikel2: 'De Partner ontvangt een commerciële marge van {marge}% op het Flancco-basisbedrag per uitgevoerde beurt. Flancco factureert rechtstreeks aan de eindklant en stort de marge maandelijks door, na ontvangst van de klant-betaling. Marges worden afgerekend exclusief btw; btw-verlegging tussen partijen is van toepassing wanneer wettelijk mogelijk.',
        artikel3Titel: '3. Duur en opzegging',
        artikel3: 'Deze overeenkomst wordt aangegaan voor onbepaalde duur en kan op elk moment worden beëindigd door een van de partijen, mits een schriftelijke opzegtermijn van één (1) maand via aangetekend schrijven of e-mail aan partners@flancco.be. Lopende klantcontracten worden uitgevoerd tot hun einddatum, ongeacht beëindiging van de partneroverenkomst.',
        artikel4Titel: '4. Verantwoordelijkheden',
        artikel4: 'De Partner is verantwoordelijk voor de commerciële relatie met de eindklant, het correct doorgeven van klantgegevens en het respecteren van de Flancco-pricing in eigen offertes. Flancco is verantwoordelijk voor de technische uitvoering, planning, kwaliteit van de werken, rapportage en de eventuele garantie op uitgevoerde werkzaamheden. Beide partijen verbinden zich tot een professionele communicatie en respecteren de geldende beroepscodes.',
        artikel5Titel: '5. GDPR en gegevensverwerking',
        artikel5: 'Flancco BV treedt op als verwerkingsverantwoordelijke voor de eindklant-gegevens die via het platform worden verwerkt, conform de Europese Algemene Verordening Gegevensbescherming (AVG/GDPR). De Partner heeft uitsluitend toegang tot de eigen klant-data via het beveiligde partner-portaal en mag deze niet doorverkopen of voor andere commerciële doeleinden gebruiken. Beide partijen werken samen aan correcte uitvoering van betrokkenen-rechten (inzage, correctie, verwijdering).',
        artikel6Titel: '6. Aansprakelijkheid',
        artikel6: 'Flancco BV is aansprakelijk voor de technische uitvoering binnen de wettelijke en contractuele kaders met de eindklant. De Partner is aansprakelijk voor de commerciële communicatie en de juistheid van de aangereikte klantgegevens. De totale aansprakelijkheid van Flancco jegens de Partner uit hoofde van deze overeenkomst is in elk geval beperkt tot het bedrag van de marges uitbetaald in de afgelopen twaalf (12) maanden.',
        artikel7Titel: '7. Toepasselijk recht en geschillen',
        artikel7: 'Op deze overeenkomst is uitsluitend het Belgische recht van toepassing. Eventuele geschillen die niet in der minne kunnen worden geregeld, worden voorgelegd aan de bevoegde rechtbanken van het arrondissement Brugge.',
        contractFooter: 'Door hieronder te tekenen verklaart de ondertekenaar bevoegd te zijn de Partner-onderneming rechtsgeldig te verbinden.',
        accept: 'Ik heb het contract gelezen en ga akkoord met de bovenstaande voorwaarden.',
        sigLabel: 'Plaats hier uw handtekening',
        sigClear: 'Wis handtekening',
        sigDate: 'Datum',
        submitDisabled: 'Vink akkoord aan en plaats uw handtekening om verder te gaan.',
        submitting: 'Bezig met versturen…',
        errorMissingAccept: 'Vink akkoord aan en plaats uw handtekening voor u verstuurt.',
        errorSubmit: 'Verzenden mislukt. Controleer uw verbinding en probeer opnieuw.',
        legalNotice: 'Uw IP-adres en device-info worden meegestuurd als onderdeel van het audit-bewijs. Geen gevoelige data worden opgeslagen buiten de noodzaak van deze contractuele relatie.'
      },
      step5: {
        title: 'Bedankt — contract is geregistreerd',
        subtitle: 'We hebben uw aanvraag ontvangen. Stuur uzelf een magic-link om uw partner-portaal te activeren.',
        emailLabel: 'Magic-link verzenden naar',
        sendBtn: 'Verstuur magic-link',
        sending: 'Magic-link wordt verstuurd…',
        success: 'De magic-link is verstuurd naar {email}. Open uw inbox en klik op de link om in te loggen op uw partner-portaal.',
        successHint: 'Geen mail ontvangen? Controleer uw spam-folder of contacteer ons op partners@flancco.be.',
        errorGeneric: 'Verzenden mislukt. Probeer opnieuw of contacteer partners@flancco.be.',
        nextStepsTitle: 'Wat gebeurt er nu?',
        nextStep1: 'U logt in via de magic-link en kiest een wachtwoord voor uw partner-portaal.',
        nextStep2: 'U vindt direct uw eigen white-label calculator-link — klaar om te delen met klanten.',
        nextStep3: 'Onze account-manager neemt binnen 1 werkdag contact op voor een korte kennismaking en finetuning.'
      }
    }
  });
})();
