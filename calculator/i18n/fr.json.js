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
      cards: {
        afstand: 'Distance',
        afstandLabel: 'Distance jusqu\'\u00e0 votre habitation',
        afstandUnit: '(en km)',
        btw: 'Taux de TVA',
        btw21: 'TVA 21\u202f%',
        btw21sub: 'Taux standard',
        btw6: 'TVA 6\u202f%',
        btw6sub: 'R\u00e9novation \u2014 habitation de plus de 10 ans (Belgique uniquement)',
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
        title: 'D\u00e9claration sur l\'honneur \u2014 taux de TVA r\u00e9duit (6\u202f%)',
        intro: 'Pour b\u00e9n\u00e9ficier du taux de TVA r\u00e9duit de 6\u202f%, l\'habitation o\u00f9 les travaux sont r\u00e9alis\u00e9s doit r\u00e9pondre aux conditions suivantes :',
        cond1: 'L\'habitation a plus de 10 ans (premi\u00e8re occupation depuis plus de 10 ans)',
        cond2: 'L\'habitation est utilis\u00e9e principalement comme logement priv\u00e9',
        cond3: 'Les travaux sont factur\u00e9s directement \u00e0 l\'utilisateur final',
        check: 'Je d\u00e9clare sur l\'honneur que le b\u00e2timent o\u00f9 les travaux sont r\u00e9alis\u00e9s est utilis\u00e9 depuis plus de 10 ans comme logement priv\u00e9 et que je suis l\'utilisateur final. Je prends acte qu\'en cas de d\u00e9claration inexacte, la diff\u00e9rence de TVA (15\u202f%) pourra \u00eatre r\u00e9clam\u00e9e.'
      }
    },
    step2: {
      title: 'Vos coordonn\u00e9es',
      subtitle: 'Compl\u00e9tez vos coordonn\u00e9es ci-dessous afin d\'\u00e9tablir votre contrat personnalis\u00e9.',
      personal: 'Donn\u00e9es personnelles',
      contact: 'Coordonn\u00e9es de contact',
      naam: 'Nom / Raison sociale',
      naamPh: 'Ex. Jean Dupont ou Dupont SRL',
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
      headerOvereenkomst: 'Votre contrat',
      labelNr: 'Num\u00e9ro de contrat',
      labelDatum: 'Date',
      labelDiensten: 'Services',
      labelFreq: 'Fr\u00e9quence',
      labelDuur: 'Dur\u00e9e du contrat',
      labelBedrag: 'Total par entretien',
      headerNext: 'Que se passe-t-il maintenant ?'
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
    }
  });
})();
