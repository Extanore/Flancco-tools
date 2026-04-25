/**
 * Flancco Calculator — FR dictionary (Slot S baseline)
 * --------------------------------------------------------------
 * Vertaling onder review — gemarkeerd als 'BASELINE'. Voor go-live
 * laten valideren door native FR-speaker (Belgisch FR, geen FR-FR-
 * jargon). Open punten gemarkeerd met "REVIEW:" comment in de keys.
 *
 * Gebruik strikt formele 'vous'-vorm — past bij B2B-communicatie.
 */
(function () {
  if (!window.flanccoI18n) return;
  window.flanccoI18n.registerDict('fr', {
    common: {
      yes: 'Oui',
      no: 'Non',
      back: '\u2190 Retour',
      next: 'Continuer \u2192',
      cancel: 'Annuler',
      save: 'Enregistrer',
      required: 'obligatoire',
      optional: 'optionnel',
      loading: 'Patientez\u2026',
      retry: 'R\u00e9essayer'
    },
    header: {
      tagline: 'L\'entretien comme il se doit'
    },
    step0: {
      title: 'Quels services souhaitez-vous ?',
      subtitle: 'S\u00e9lectionnez les services pour lesquels vous souhaitez un devis. Vous pouvez combiner plusieurs services dans un seul contrat.',
      cta: 'Continuer \u2192',
      ctaHint: 'S\u00e9lectionnez au moins un service pour continuer'
    },
    step1: {
      title: 'Configurez vos services',
      subtitle: 'Compl\u00e9tez les donn\u00e9es de votre installation et d\u00e9couvrez imm\u00e9diatement votre prix personnalis\u00e9.',
      ctaNext: 'Continuer vers le contrat \u2192',
      ctaHint: 'Compl\u00e9tez vos coordonn\u00e9es et consultez imm\u00e9diatement votre contrat personnalis\u00e9',
      postcode: {
        title: 'Code postal du chantier',
        subtitle: 'Indiquez le code postal de l\'adresse o\u00f9 les travaux seront ex\u00e9cut\u00e9s. Sur cette base, nous d\u00e9terminons vos frais de d\u00e9placement et le taux de TVA applicable.',
        label: 'Code postal',
        placeholder: 'Ex. 4000',
        helperBE: 'Code postal belge \u2014 tous les taux de TVA disponibles.',
        helperFallback: 'Code postal \u00e9tranger ou invalide \u2014 TVA standard de 21\u202f% appliqu\u00e9e.',
        gemeenteLabel: 'Commune',
        gemeenteAuto: 'Compl\u00e9t\u00e9 automatiquement sur base du code postal.',
        gemeenteChoose: 'S\u00e9lectionnez la commune correcte\u00a0:'
      },
      cards: {
        afstand: 'Distance',
        afstandLabel: 'Distance jusqu\'\u00e0 votre habitation',
        afstandUnit: '(en km)',
        btw: 'Taux de TVA',
        btw21: 'TVA 21\u202f%',
        btw21sub: 'Taux standard',
        btw6: 'TVA 6\u202f%',
        btw6sub: 'R\u00e9novation \u2014 habitation de plus de 10 ans (Belgique uniquement)',
        btw6disabled: 'Disponible uniquement pour les codes postaux belges',
        freq: 'Fr\u00e9quence',
        freqJaarlijks: 'Annuel',
        freqJaarlijksSub: '1 entretien par an',
        freqHalfjaar: 'Semestriel',
        freqHalfjaarSub: '2 entretiens par an',
        duur: 'Dur\u00e9e du contrat',
        duurEenmalig: 'Intervention unique',
        duurEenmaligSub: 'Tarif standard, sans contrat r\u00e9current',
        duur3: '3 ans',
        duur5: '5 ans',
        duurKortingSub: '5\u202f% de remise sur tous les tarifs'
      },
      result: {
        title: 'Estimation de prix par entretien',
        perBeurt: 'Par entretien',
        perJaar: 'Par an (2 entretiens)',
        btwNote21: 'Tous les montants TVA 21\u202f% incluse',
        btwNote6: 'Tous les montants TVA 6\u202f% incluse'
      },
      btw6: {
        title: 'D\u00e9claration sur l\'honneur \u2014 taux de TVA r\u00e9duit de 6\u202f%',
        intro: 'Conform\u00e9ment \u00e0 l\'arr\u00eat\u00e9 royal n\u00b0\u202f20 (rubriques XXXVIII et XXXI du tableau A), le taux de TVA r\u00e9duit de 6\u202f% ne peut \u00eatre appliqu\u00e9 que si l\'habitation r\u00e9pond aux deux conditions ci-dessous. Cochez les deux d\u00e9clarations pour confirmer le taux de 6\u202f%.',
        cond1: 'L\'habitation a plus de 10 ans (premi\u00e8re occupation depuis plus de 10 ans)',
        cond2: 'L\'habitation est utilis\u00e9e principalement comme logement priv\u00e9',
        cond3: 'Les travaux sont factur\u00e9s directement \u00e0 l\'utilisateur final',
        checkPrive: 'Je d\u00e9clare sur l\'honneur que le b\u00e2timent o\u00f9 les travaux sont ex\u00e9cut\u00e9s est utilis\u00e9 exclusivement ou principalement comme logement priv\u00e9, et que je suis l\'utilisateur final \u00e0 qui ces travaux sont factur\u00e9s directement.',
        checkOuderdom: 'Je d\u00e9clare sur l\'honneur que la premi\u00e8re occupation du b\u00e2timent date d\'au moins dix ans avant le premier moment auquel cette TVA devient exigible.',
        disclaimer: 'En cas de d\u00e9claration inexacte, la diff\u00e9rence de TVA (15\u202f%), ainsi que les \u00e9ventuels int\u00e9r\u00eats de retard et amendes, peuvent \u00eatre int\u00e9gralement r\u00e9clam\u00e9s \u00e0 l\'utilisateur final (AR n\u00b0\u202f20 \u2014 art.\u202f1quater).'
      }
    },
    step2: {
      title: 'Vos coordonn\u00e9es',
      subtitle: 'Compl\u00e9tez vos coordonn\u00e9es ci-dessous afin d\'\u00e9tablir votre contrat personnalis\u00e9.',
      personal: 'Donn\u00e9es personnelles',
      contact: 'Coordonn\u00e9es de contact',
      naam: 'Nom',
      naamPh: 'Ex. Jean Dupont',
      straat: 'Rue',
      straatPh: 'Nom de rue',
      huisnr: 'N\u00b0',
      huisnrPh: '12A',
      postcode: 'Code postal',
      postcodePh: '4000',
      gemeente: 'Commune',
      gemeentePh: 'Li\u00e8ge',
      btwNr: 'Num\u00e9ro de TVA',
      contactPersoon: 'Personne de contact',
      contactPersoonPh: 'Nom de la personne de contact',
      tel: 'T\u00e9l\u00e9phone',
      telPh: '+32 4...',
      email: 'E-mail',
      emailPh: 'jean@exemple.be',
      privacy: 'J\'ai lu la {link} et j\'accepte le traitement de mes donn\u00e9es.',
      privacyLink: 'd\u00e9claration de confidentialit\u00e9',
      ctaNext: 'Voir le r\u00e9capitulatif \u2192',
      ctaBack: '\u2190 Retour'
    },
    klantType: {
      title: 'Vous \u00eates\u2026',
      subtitle: 'S\u00e9lectionnez le type de client afin que nous demandions les bonnes informations.',
      particulier: 'Particulier',
      particulierSub: 'Personne priv\u00e9e sans num\u00e9ro de TVA',
      bedrijf: 'Entreprise',
      bedrijfSub: 'Avec num\u00e9ro de TVA (B2B)',
      bedrijfsnaam: 'Raison sociale',
      bedrijfsnaamPh: 'Ex. Dupont SRL',
      btwNummer: 'Num\u00e9ro de TVA',
      btwNummerPh: 'BE0123456789',
      btwHelper: 'V\u00e9rification automatique via VIES (registre TVA UE).',
      contactpersoon: 'Personne de contact',
      contactpersoonPh: 'Nom de la personne de contact dans l\'entreprise',
      viesValidating: 'V\u00e9rification du num\u00e9ro de TVA\u2026',
      viesValid: 'V\u00e9rifi\u00e9 via VIES \u2014 donn\u00e9es remplies automatiquement',
      viesInvalid: 'Num\u00e9ro de TVA invalide (format ou inconnu dans le registre VIES)',
      viesError: 'V\u00e9rification temporairement indisponible \u2014 vous pouvez continuer, nous validerons plus tard'
    },
    step2b: {
      title: 'R\u00e9capitulatif de votre offre',
      subtitle: 'V\u00e9rifiez les donn\u00e9es ci-dessous avant de poursuivre vers le contrat.',
      ctaBack: '\u2190 Modifier',
      ctaNext: 'D\'accord, aller au contrat \u2192'
    },
    step3: {
      title: 'Votre contrat',
      subtitle: 'V\u00e9rifiez le contrat ci-dessous et signez num\u00e9riquement.',
      ctaBack: '\u2190 Retour',
      ctaSubmit: 'Signer & envoyer',
      submitHint: 'Apposez votre signature et cochez la d\u00e9claration d\'accord pour envoyer'
    },
    success: {
      title: 'Votre contrat a \u00e9t\u00e9 sign\u00e9 avec succ\u00e8s',
      subtitle: 'Votre PDF est t\u00e9l\u00e9charg\u00e9 automatiquement. Conservez-le comme confirmation.',
      subtitleSigning: 'Merci de votre confiance. Vous recevrez une confirmation par e-mail.',
      headerOvereenkomst: 'Votre contrat',
      labelNr: 'Num\u00e9ro de contrat',
      labelDatum: 'Date',
      labelDiensten: 'Services',
      labelFreq: 'Fr\u00e9quence',
      labelDuur: 'Dur\u00e9e du contrat',
      labelBedrag: 'Total par entretien',
      headerNext: 'Que se passe-t-il maintenant ?',
      stepDownloaded: 'Votre PDF de contrat a \u00e9t\u00e9 t\u00e9l\u00e9charg\u00e9 automatiquement \u2014 conservez ce document',
      stepProcessed: 'Votre contrat sign\u00e9 est trait\u00e9 par votre partenaire',
      stepPlanFirst: 'Nous planifions votre premier entretien',
      stepCalled: 'Vous serez contact\u00e9 par t\u00e9l\u00e9phone pour fixer une date pr\u00e9cise',
      dlAgain: '\u2193 T\u00e9l\u00e9charger le PDF \u00e0 nouveau',
      dlContract: '\u2193 T\u00e9l\u00e9charger votre contrat en PDF',
      contactQuestion: 'Des questions ? Contactez',
      freqJaarlijks: 'Annuel (1\u00D7)',
      freqHalfjaarlijks: 'Semestriel (2\u00D7)',
      freqEenmalig: 'Unique',
      duurEenmalig: 'Intervention unique',
      duurJaarSingular: '{n} an',
      duurJaarPlural: '{n} ans',
      seizoenPrefix: 'Nous planifions votre premier entretien durant la p\u00e9riode {seizoenen}',
      nvt: 's.o.'
    },
    languagePrompt: {
      title: 'Quelle langue pr\u00e9f\u00e9rez-vous ?',
      subtitle: 'Nous avons constat\u00e9 que votre code postal se situe \u00e0 Bruxelles. Choisissez votre langue de pr\u00e9f\u00e9rence pour ce devis.',
      nl: 'Nederlands',
      fr: 'Fran\u00e7ais',
      remember: 'Retenir mon choix'
    },
    consent: {
      title: 'Pr\u00e9f\u00e9rences de communication',
      subtitle: 'Vous pouvez modifier ces pr\u00e9f\u00e9rences \u00e0 tout moment via le lien de d\u00e9sinscription pr\u00e9sent dans chaque communication.',
      email_service: {
        label: 'E-mails de service (n\u00e9cessaires \u00e0 l\'ex\u00e9cution du contrat)',
        help: 'Confirmation de vos rendez-vous, facture, rapport apr\u00e8s entretien et messages de service.'
      },
      email_marketing: {
        label: 'E-mails marketing (facultatif)',
        help: 'Conseils, newsletter et offres promotionnelles. Au maximum une fois par mois.'
      },
      sms: {
        label: 'Rappels SMS (facultatif)',
        help: 'Bref rappel 24 h avant votre entretien et le jour m\u00eame avec l\'heure d\'arriv\u00e9e du technicien.'
      },
      whatsapp: {
        label: 'Messages WhatsApp (facultatif)',
        help: 'Messages interactifs avec photos du rapport et possibilit\u00e9 de poser des questions directement.'
      }
    },
    // Slot F \u2014 Notifications client multi-canal (e-mail/SMS/WhatsApp)
    // Ces cl\u00e9s sont rendues dans send-klant-notification-email/-sms/-whatsapp
    // et dans les boutons de d\u00e9clenchement c\u00f4t\u00e9 admin. Toujours en parit\u00e9 avec nl.json.js.
    notification: {
      reminder_24h: {
        emailSubject: 'Rappel : entretien de vos panneaux solaires demain',
        emailHeader: 'A demain',
        emailIntroNamed: 'Bonjour {klant}, voici un bref rappel concernant votre intervention d\'entretien planifi\u00e9e.',
        emailIntroAnon: 'Bref rappel concernant votre intervention d\'entretien planifi\u00e9e.',
        emailDateLabel: 'Date',
        emailTimeLabel: 'Arriv\u00e9e',
        emailTimeFullDay: 'Toute la journ\u00e9e',
        emailNote: 'Veillez \u00e0 rendre les panneaux accessibles et \u00e0 pr\u00e9parer les codes ou cl\u00e9s d\'acc\u00e8s \u00e9ventuels.',
        emailContactCta: 'Une modification \u00e0 apporter ? R\u00e9pondez \u00e0 ce courriel.',
        smsBody: '{partner} : rappel \u2014 entretien panneaux solaires demain {datum}{tijd, select, leeg{} other{ \u00e0 {tijd}}}.',
        whatsappTemplateName: 'klant_reminder_24h_fr'
      },
      reminder_day: {
        emailSubject: 'Notre technicien arrive aujourd\'hui',
        emailHeader: 'Nous arrivons aujourd\'hui',
        emailIntroNamed: 'Bonjour {klant}, notre technicien intervient aujourd\'hui pour l\'entretien de vos panneaux solaires.',
        emailIntroAnon: 'Notre technicien intervient aujourd\'hui pour l\'entretien de vos panneaux solaires.',
        emailTimeLabel: 'Heure d\'arriv\u00e9e pr\u00e9vue',
        emailTechnicianLabel: 'Technicien',
        emailContactCta: 'Des questions ? Appelez-nous ou r\u00e9pondez \u00e0 ce courriel.',
        smsBody: '{partner} : nous arrivons aujourd\'hui{tijd, select, leeg{} other{ \u00e0 {tijd}}}.',
        whatsappTemplateName: 'klant_reminder_day_fr'
      },
      rapport_klaar: {
        emailSubject: 'Votre rapport d\'entretien est pr\u00eat',
        emailHeader: 'Rapport disponible',
        emailIntroNamed: 'Bonjour {klant}, le rapport de votre intervention d\'entretien r\u00e9cente est pr\u00eat.',
        emailIntroAnon: 'Le rapport de votre intervention d\'entretien r\u00e9cente est pr\u00eat.',
        emailCtaButton: 'Ouvrir le rapport',
        emailExpiryNote: 'Ce lien reste valide pendant 30 jours.',
        emailFollowupHint: 'Conservez ce rapport \u2014 vous pourrez le consulter ult\u00e9rieurement via votre espace client.'
      },
      common: {
        partnerSignature: 'Cordialement,\n{partner}',
        optOutFooter: 'Vous recevez ce message car vous avez donn\u00e9 votre accord lors de la signature de votre contrat d\'entretien.',
        optOutLink: 'Se d\u00e9sinscrire de ce canal',
        privacyLink: 'D\u00e9claration de confidentialit\u00e9',
        contactSupport: 'Contact : {email}'
      },
      adminTrigger: {
        sectionTitle: 'Envoyer manuellement les notifications',
        btnReminder24h: 'Envoyer rappel 24 h',
        btnReminderDay: 'Envoyer rappel du jour',
        btnRapportKlaar: 'Envoyer le rapport',
        toastSent: 'Notification envoy\u00e9e via {kanaal}.',
        toastSkipped: 'Non envoy\u00e9 : {reden}.',
        toastFailed: 'Envoi \u00e9chou\u00e9 : {reden}.',
        confirmForce: 'Cette intervention a d\u00e9j\u00e0 re\u00e7u une notification via ce canal. R\u00e9envoyer quand m\u00eame ?'
      },
      reasons: {
        no_consent: 'Le client n\'a pas donn\u00e9 d\'accord actif pour ce canal',
        already_sent: 'La notification a d\u00e9j\u00e0 \u00e9t\u00e9 envoy\u00e9e pr\u00e9c\u00e9demment',
        missing_contact: 'Aucune coordonn\u00e9e valide disponible',
        daily_cap: 'Limite quotidienne pour ce canal atteinte',
        not_configured: 'Canal pas encore configur\u00e9 par l\'administrateur',
        send_failed: 'Le fournisseur a refus\u00e9 l\'envoi'
      }
    },
    optOut: {
      title: 'D\u00e9sinscription confirm\u00e9e',
      subtitleSuccess: 'Vous ne recevrez plus de messages via ce canal. Les e-mails de service (confirmations de rendez-vous, factures) continueront de vous parvenir tant que votre contrat est en cours.',
      subtitleFail: 'Nous n\'avons pas pu traiter votre d\u00e9sinscription. Le lien est peut-\u00eatre expir\u00e9 ou d\u00e9j\u00e0 utilis\u00e9.',
      contactHint: 'Des questions ? \u00c9crivez-nous \u00e0 {email}.',
      backHome: 'Retour vers le site',
      processing: 'Traitement en cours\u2026'
    },
    errors: {
      generic: 'Une erreur s\'est produite. R\u00e9essayez ou contactez-nous.',
      requiredField: 'Ce champ est obligatoire',
      invalidEmail: 'Adresse e-mail invalide',
      invalidPostcode: 'Code postal invalide',
      invalidPhone: 'Num\u00e9ro de t\u00e9l\u00e9phone invalide',
      tooManySubmits: 'Trop d\'envois. R\u00e9essayez dans une heure.'
    },
    validation: {
      required: 'Ce champ est obligatoire.',
      invalidEmail: 'Indiquez une adresse e-mail valide (ex.\u00a0nom@exemple.be).',
      invalidPhone: 'Indiquez un num\u00e9ro de t\u00e9l\u00e9phone belge valide (ex.\u00a0+32 4XX XX XX XX).',
      invalidPostcode: 'Indiquez un code postal valide (4 chiffres, ex.\u00a04000).',
      invalidName: 'Indiquez au moins votre pr\u00e9nom et nom de famille.',
      postcodeNotFound: 'Code postal introuvable dans notre r\u00e9f\u00e9rentiel \u2014 v\u00e9rifiez la saisie.',
      remainingFieldsOne: 'Encore 1 champ obligatoire \u00e0 compl\u00e9ter avant de continuer.',
      remainingFieldsMany: 'Encore {count} champs obligatoires \u00e0 compl\u00e9ter avant de continuer.',
      okReady: 'Toutes les donn\u00e9es sont correctement remplies.',
      btw6NeedsBoth: 'Cochez les deux d\u00e9clarations ou choisissez la TVA \u00e0 21\u202f%.',
      btw6Reverted: 'TVA automatiquement repass\u00e9e \u00e0 21\u202f% car les conditions ne sont pas remplies.'
    },
    /* BASELINE — formele 'vous'-vorm (BE-FR), gemarkeerd voor native-FR review vóór go-live */
    rapport: {
      contract: {
        tabLabel: 'Contrat',
        tabSubtitle: 'P\u00e9rim\u00e8tre, coordonn\u00e9es client et accords compl\u00e9mentaires pour cette mission.',
        scope: {
          title: 'P\u00e9rim\u00e8tre de la mission',
          aantalPanelen: 'Nombre de panneaux',
          frequentie: 'Fr\u00e9quence',
          contractduur: 'Dur\u00e9e du contrat',
          btwTarief: 'Taux de TVA',
          totaalInclBtw: 'Total TVAC',
          totaalExclBtw: 'Total HTVA',
          eenheidsprijsBeurt: 'Prix unitaire par passage',
          notSet: 'Non renseign\u00e9',
          btw6Verklaring: 'D\u00e9claration TVA 6\u202f% enregistr\u00e9e le {datum}',
          btw6VerklaringMissing: 'D\u00e9claration TVA 6\u202f% manquante',
          frequentieJaarlijks: 'Annuelle',
          frequentieHalfjaarlijks: 'Semestrielle',
          frequentieEenmalig: 'Unique',
          duurEenmalig: 'Unique',
          duurJaren: '{n} ans'
        },
        klantContact: {
          title: 'Coordonn\u00e9es du client',
          naam: 'Nom',
          adres: 'Adresse',
          postcode: 'Code postal',
          gemeente: 'Commune',
          email: 'E-mail',
          telefoon: 'T\u00e9l\u00e9phone',
          klantType: 'Type de client',
          particulier: 'Particulier',
          bedrijf: 'Entreprise',
          bedrijfsnaam: 'D\u00e9nomination sociale',
          btwNummer: 'Num\u00e9ro de TVA',
          contactpersoon: 'Personne de contact',
          btwGevalideerd: 'TVA v\u00e9rifi\u00e9e via VIES le {datum}'
        },
        instructies: {
          title: 'Instructions sp\u00e9ciales pour le technicien',
          subtitle: 'Sp\u00e9cificit\u00e9s que le technicien doit conna\u00eetre sur place (acc\u00e8s, code, chien, parking, personne de contact sur site, ...).',
          placeholder: 'Ex.\u202fcl\u00e9 sous le pot de fleurs, chien pr\u00e9sent, parking dans l\'all\u00e9e \u2014 appelez le client 10 min avant l\'arriv\u00e9e.',
          charCounter: '{n}/{max} caract\u00e8res',
          save: 'Enregistrer les instructions',
          saving: 'Enregistrement\u2026',
          saved: 'Enregistr\u00e9',
          saveSuccess: 'Instructions enregistr\u00e9es.',
          saveError: '\u00c9chec de l\'enregistrement. R\u00e9essayez.',
          tooLong: 'Maximum {max} caract\u00e8res atteint.'
        },
        handtekening: {
          title: 'Accord du client sur le p\u00e9rim\u00e8tre',
          subtitle: 'Optionnel \u2014 le client peut donner son accord sur place pour le p\u00e9rim\u00e8tre planifi\u00e9 avant le d\u00e9but des travaux.',
          cta: 'Le client signe sur place',
          modalTitle: 'Le client signe pour accord du p\u00e9rim\u00e8tre',
          modalHint: 'Faites signer le client ci-dessous. En signant, le client confirme que les travaux planifi\u00e9s correspondent \u00e0 l\'accord.',
          clear: 'Effacer',
          confirm: 'Confirmer l\'accord',
          cancel: 'Annuler',
          signedAt: 'Accord sign\u00e9 le {datum}',
          confirmClear: 'Effacer la signature d\'accord existante\u202f? Cette action est irr\u00e9versible.',
          clearAction: 'Effacer & recommencer',
          saveSuccess: 'Accord du p\u00e9rim\u00e8tre enregistr\u00e9.',
          saveError: '\u00c9chec de l\'enregistrement de la signature. R\u00e9essayez.',
          empty: 'Veuillez d\'abord signer avant de confirmer.'
        },
        emptyState: 'S\u00e9lectionnez d\'abord une intervention pour voir les donn\u00e9es du contrat.'
      }
    },
    // Slot A4 — Export du planning de travail par jour (admin/planning.html)
    // Strings refl\u00e9t\u00e9es dans la fallback wpeT() inline pour fonctionner
    // sans runtime i18n charg\u00e9 dans l'admin.
    planning: {
      werkplanningExport: {
        title: 'Exporter le planning de travail',
        subtitle: '{tech} \u2014 {datum}',
        metaCount: '{count} mission aujourd\u2019hui',
        metaCountPlural: '{count} missions aujourd\u2019hui',
        btnPdf: 'T\u00e9l\u00e9charger le PDF',
        btnPdfSub: 'Document A4 avec toutes les missions du jour',
        btnPdfLoading: 'G\u00e9n\u00e9ration du PDF\u2026',
        btnWhatsapp: 'Envoyer via WhatsApp',
        btnWhatsappSub: 'Ouvre WhatsApp avec un message pr\u00e9-rempli + lien PDF',
        btnRetry: 'R\u00e9essayer',
        close: 'Fermer',
        successToast: 'Planning g\u00e9n\u00e9r\u00e9',
        openInTab: 'Ouvrir le PDF dans un nouvel onglet',
        errorTitle: 'Impossible de g\u00e9n\u00e9rer le planning',
        errorTimeout: 'La g\u00e9n\u00e9ration du PDF a pris trop de temps. R\u00e9essayez ou contactez le support si le probl\u00e8me persiste.',
        errorNetwork: 'Pas de connexion au service PDF. V\u00e9rifiez votre connexion et r\u00e9essayez.',
        errorAuth: 'Session expir\u00e9e. Reconnectez-vous pour exporter le planning.',
        errorRate: 'Trop d\u2019exports cons\u00e9cutifs. Patientez un instant.',
        errorGeneric: 'Une erreur est survenue lors de la g\u00e9n\u00e9ration du PDF.',
        errorMissingSession: 'Aucune session admin active \u2014 rechargez la page.',
        errorNoBeurten: 'Aucune mission trouv\u00e9e pour ce technicien ce jour-l\u00e0.',
        waMessageNl: 'Bonjour {voornaam}, voici votre planning de travail pour {datum}: {url}',
        expiresHint: 'Lien valable 7 jours.'
      },
      // Slot K — Jours f\u00e9ri\u00e9s + p\u00e9riodes de fermeture (soft-warning)
      feestdagen: {
        markerLabelFd: 'Jour f\u00e9ri\u00e9',
        markerLabelSp: 'P\u00e9riode de fermeture',
        bannerHeading: 'P\u00e9riodes de fermeture sur cette p\u00e9riode',
        warningTitleFd: 'Vous planifiez un jour f\u00e9ri\u00e9',
        warningTitleSp: 'Vous planifiez pendant une p\u00e9riode de fermeture',
        warningSubtitle: 'Le planning a d\u00e9tect\u00e9 un conflit. Vous pouvez toujours continuer si c\u2019est exceptionnel.',
        warningCancel: 'Annuler',
        warningProceed: 'Planifier quand m\u00eame'
      },
      // Slot B — Smart picker modal pour les clics sur cellule vide (semaine/jour/mois).
      // L'admin n'utilise pas de runtime i18n ; cl\u00e9s pr\u00eates pour adoption future.
      // Strings actuellement inline dans admin/planning.html.
      smartPicker: {
        title: 'Pour {tech} le {date}',
        searchPlaceholder: 'Rechercher client, mission, secteur\u2026',
        sectionSuggesties: 'Suggestions',
        sectionLopend: 'Missions en cours',
        sectionGepland: 'Planifi\u00e9es / \u00e0 planifier',
        emptyNoSuggesties: 'Aucune suggestion pour le moment.',
        emptyNoLopend: 'Aucune mission en cours.',
        emptyNoGepland: 'Aucune mission planifi\u00e9e.',
        actionNew: '+ Nouvelle mission',
        actionBeschikbaarheid: '+ Disponibilit\u00e9',
        toastAddedExisting: 'Ajout\u00e9 comme technicien suppl\u00e9mentaire',
        toastAddedNew: 'Nouvelle journ\u00e9e de planification cr\u00e9\u00e9e',
        toastAlreadyAssigned: 'Ce technicien est d\u00e9j\u00e0 assign\u00e9 \u00e0 cette date'
      },
      // Slot M — Popover d'aide sur la barre en cours (admin/planning.html)
      // Mini-popover pour ajouter un technicien suppl\u00e9mentaire pour X jours.
      // Strings actuellement inline dans admin/planning.html ; cl\u00e9s pr\u00eates
      // pour adoption future via runtime i18n. Parit\u00e9 avec nl.json.js.
      helperPopover: {
        titleExtra: 'Technicien suppl\u00e9mentaire',
        primair: 'Principal',
        looptPrefix: 'du',
        periodLabel: 'P\u00e9riode',
        periodToday: 'Aujourd\u2019hui',
        periodDays: 'Nombre de jours',
        periodRemaining: 'Dur\u00e9e restante',
        urenCheckbox: 'Heures sp\u00e9cifiques ?',
        urenFrom: 'De',
        urenTo: '\u00e0',
        techLabel: 'Choisir un technicien (libre ce jour)',
        showBezet: 'Afficher aussi les techs occup\u00e9s',
        conflictBadge: '{n} conflit(s)',
        cancel: 'Annuler',
        save: 'Ajouter',
        toastSaved: 'Technicien ajout\u00e9 pour {n} jour(s)',
        toastSkipped: 'Technicien d\u00e9j\u00e0 assign\u00e9',
        toastError: '\u00c9chec de l\u2019ajout : {error}'
      }
    },
    // Slot K & L — Gestion admin: jours f\u00e9ri\u00e9s, cong\u00e9s / CT
    admin: {
      // Slot L — Cong\u00e9s & ch\u00f4mage temporaire fusionn\u00e9s sous une seule page
      verlofEw: {
        title: 'Cong\u00e9s / CT',
        subtitle: 'G\u00e9rez les demandes de cong\u00e9s, les soldes et le ch\u00f4mage \u00e9conomique',
        tabVerlof: 'Cong\u00e9s',
        tabEw: 'CT',
        subTabKalender: 'Calendrier',
        subTabAanvragen: 'Demandes',
        subTabSaldo: 'Soldes',
        subTabPersoneel: 'Personnel',
        nieuweAanvraag: 'Nouvelle demande'
      },
      feestdagen: {
        pageTitle: 'Jours f\u00e9ri\u00e9s & p\u00e9riodes de fermeture',
        pageSubtitle: 'Jours f\u00e9ri\u00e9s belges et fermetures de l\u2019entreprise. Affich\u00e9s comme avertissement dans le planning.',
        btnNew: 'Nouveau',
        btnAutoExtend: 'G\u00e9n\u00e9rer pour l\u2019ann\u00e9e prochaine',
        colDate: 'Date',
        colDateEnd: 'Date de fin',
        colType: 'Type',
        colLabel: 'Libell\u00e9',
        colRecurring: 'R\u00e9currence',
        colActions: 'Actions',
        typeFd: 'Jour f\u00e9ri\u00e9',
        typeSp: 'P\u00e9riode de fermeture',
        recurringJaarlijks: 'Annuel',
        recurringEenmalig: 'Ponctuel',
        empty: 'Aucun jour f\u00e9ri\u00e9 ou p\u00e9riode de fermeture trouv\u00e9 pour ce filtre.',
        modalNewFd: 'Nouveau jour f\u00e9ri\u00e9',
        modalNewSp: 'Nouvelle p\u00e9riode de fermeture',
        modalEditFd: 'Modifier le jour f\u00e9ri\u00e9',
        modalEditSp: 'Modifier la p\u00e9riode de fermeture',
        labelDate: 'Date',
        labelDateStart: 'Date de d\u00e9but',
        labelDateEnd: 'Date de fin',
        labelLabel: 'Libell\u00e9',
        placeholderLabel: 'P. ex. Cong\u00e9 du b\u00e2timent \u00e9t\u00e9 2027',
        helpLabel: 'Affich\u00e9 dans le planning sur le jour concern\u00e9.',
        helpRecurring: 'Les jours f\u00e9ri\u00e9s annuels sont \u00e9tendus automatiquement via cron (1er d\u00e9cembre).',
        toastSaved: 'Enregistr\u00e9.',
        toastDeleted: 'Supprim\u00e9.',
        toastSeedDone: 'Jours f\u00e9ri\u00e9s pour {year} ajout\u00e9s ({count} nouveaux, {dup} d\u00e9j\u00e0 pr\u00e9sents).',
        toastSeedFailed: 'L\u2019extension automatique a \u00e9chou\u00e9 : {reason}',
        errRequired: 'La date, le libell\u00e9 et le type sont obligatoires.',
        errEindRequired: 'Une p\u00e9riode de fermeture requiert une date de fin.',
        errEindBeforeStart: 'La date de fin doit \u00eatre \u00e9gale ou post\u00e9rieure \u00e0 la date de d\u00e9but.',
        errLabelShort: 'Le libell\u00e9 doit contenir au moins 2 caract\u00e8res.',
        deleteConfirmFd: 'Voulez-vous vraiment supprimer le jour f\u00e9ri\u00e9 {label} ({datum}) ?',
        deleteConfirmSp: 'Voulez-vous vraiment supprimer la p\u00e9riode de fermeture {label} ({datum}) ?'
      }
    },
    // Slot C — Portail partenaire : onglet Pipeline + actions (appel/e-mail/suivi)
    partner: {
      pipeline: {
        tabPipeline: 'Pipeline',
        tabAlle: 'Tous les contrats',
        tabFollowUp: 'Suivi',
        statusConcept: 'Brouillon',
        statusGetekend: 'Sign\u00e9',
        statusActief: 'Actif',
        statusVerlopen: 'Expir\u00e9',
        statusGeannuleerd: 'Annul\u00e9',
        actionBelKlant: 'Appeler le client',
        actionEmailKlant: 'Rappel par e-mail',
        actionFollowUp: 'Marquer pour suivi',
        actionUnFollowUp: 'Retirer du suivi',
        toastFollowUpAdded: 'Marqu\u00e9 pour suivi',
        toastFollowUpRemoved: 'Suivi retir\u00e9',
        emptyFollowUp: 'Aucun suivi pour le moment.',
        emailSubject: 'Rappel d\'entretien {klant}',
        emailBody: 'Bonjour {klant}, un bref rappel concernant votre entretien. Cordialement,'
      },
      // Slot D — Page Facturation (portail partenaire) + mod\u00e8le PDF d'aper\u00e7u
      facturatie: {
        title: 'Facturation',
        subtitle: {
          week: 'Toutes les interventions cl\u00f4tur\u00e9es en semaine {periode}',
          maand: 'Toutes les interventions cl\u00f4tur\u00e9es sur {periode}',
          jaar: 'Toutes les interventions cl\u00f4tur\u00e9es en {periode}'
        },
        kpi: {
          count: 'Nombre d\'interventions',
          excl: 'Chiffre d\'affaires HTVA',
          incl: 'Chiffre d\'affaires TTC',
          marge: 'Marge partenaire totale'
        },
        filter: {
          week: 'Semaine',
          maand: 'Mois',
          jaar: 'Ann\u00e9e',
          maandKeuze: {
            '1': '1 mois',
            '3': '3 mois',
            '6': '6 mois',
            '12': '12 mois'
          },
          alleenGefactureerd: 'Uniquement factur\u00e9es'
        },
        kolom: {
          datum: 'Date',
          klant: 'Client',
          sector: 'Secteur',
          panelen: 'Panneaux',
          exclBtw: 'HTVA',
          inclBtw: 'TTC',
          planningFee: 'Frais de planning',
          marge: 'Marge partenaire',
          doorFactureren: '\u00c0 refacturer'
        },
        export: {
          csv: 'Exporter CSV',
          pdf: 'Aper\u00e7u PDF'
        },
        geenData: 'Aucune intervention cl\u00f4tur\u00e9e sur cette p\u00e9riode.',
        loading: 'Chargement des interventions\u2026',
        error: 'Impossible de charger les donn\u00e9es de facturation.',
        pdf: {
          header: 'Aper\u00e7u de facturation',
          footer: 'Document interne \u2014 non destin\u00e9 au client final',
          gegenereerdOp: 'G\u00e9n\u00e9r\u00e9 le {datum}',
          totaalRij: 'Total',
          aantalBeurten: '{n} interventions'
        }
      },
      // Slot I — \u00c9quipe partenaire bas\u00e9e sur les r\u00f4les (gestion d\u2019\u00e9quipe dans param\u00e8tres partenaire)
      team: {
        title: 'Membres de l\u2019\u00e9quipe',
        subtitle: 'G\u00e9rez qui peut acc\u00e9der \u00e0 ce portail partenaire et quels droits ils re\u00e7oivent.',
        add: {
          btn: 'Ajouter un membre',
          modalTitle: 'Inviter un nouveau membre',
          email: 'Adresse e-mail',
          emailPlaceholder: 'nom@entreprise.be',
          voornaam: 'Pr\u00e9nom',
          naam: 'Nom',
          presetLabel: 'R\u00e9glage rapide',
          presetMedewerkerBasis: 'Collaborateur \u2014 base',
          presetMedewerkerUitgebreid: 'Collaborateur \u2014 \u00e9tendu',
          presetCoOwner: 'Co-propri\u00e9taire',
          submit: 'Inviter',
          cancel: 'Annuler'
        },
        perm: {
          contracten_aanmaken: {
            label: 'Cr\u00e9er des contrats',
            hint: 'Peut enregistrer de nouveaux contrats via le lien calculateur.'
          },
          facturatie_inzage: {
            label: 'Acc\u00e8s facturation',
            hint: 'Peut ouvrir la page facturation et t\u00e9l\u00e9charger les exports.'
          },
          rapporten_inzage: {
            label: 'Acc\u00e8s rapports',
            hint: 'Peut ouvrir les rapports d\u2019ex\u00e9cution et de service.'
          },
          planning_inzage: {
            label: 'Acc\u00e8s planning',
            hint: 'Peut consulter le calendrier de planning et voir ses propres t\u00e2ches.'
          },
          manage_users: {
            label: 'Gestion d\u2019\u00e9quipe',
            hint: 'Peut inviter des coll\u00e8gues, modifier leurs droits et les retirer.'
          }
        },
        role: {
          owner: 'Administrateur',
          medewerker: 'Collaborateur'
        },
        actions: {
          edit: 'Modifier les droits',
          remove: 'Retirer'
        },
        edit: {
          modalTitle: 'Modifier les droits de {naam}',
          submit: 'Enregistrer',
          cancel: 'Annuler'
        },
        remove: {
          confirmTitle: 'Retirer ce membre\u00a0?',
          confirmBody: 'Vous \u00eates sur le point de retirer {naam} de ce portail partenaire. Cette action est irr\u00e9versible.',
          confirmBtn: 'Retirer d\u00e9finitivement',
          cancel: 'Annuler'
        },
        toast: {
          invited: 'Invitation envoy\u00e9e \u00e0 {email}.',
          removed: 'Membre retir\u00e9.',
          permsUpdated: 'Droits mis \u00e0 jour.',
          errorPermission: 'Vous n\u2019avez pas les droits pour effectuer cette action.',
          errorExists: 'Cet utilisateur existe d\u00e9j\u00e0 dans une autre \u00e9quipe partenaire \u2014 contactez l\u2019administrateur.',
          errorSelf: 'Vous ne pouvez pas vous retirer vous-m\u00eame.',
          errorLastOwner: 'Impossible de retirer le dernier administrateur \u2014 d\u00e9signez d\u2019abord un autre coll\u00e8gue comme administrateur.',
          errorRateLimit: 'Trop d\u2019invitations en peu de temps \u2014 r\u00e9essayez plus tard.',
          errorGeneric: 'Une erreur est survenue. R\u00e9essayez ou contactez le support.'
        },
        empty: {
          title: 'Aucun membre pour le moment',
          hint: 'Invitez votre premier coll\u00e8gue pour g\u00e9rer ensemble contrats et planning.'
        },
        list: {
          permSummaryNone: 'Aucun droit suppl\u00e9mentaire',
          permSummaryCount: '{n} droits actifs'
        }
      }
    }
  });
})();
