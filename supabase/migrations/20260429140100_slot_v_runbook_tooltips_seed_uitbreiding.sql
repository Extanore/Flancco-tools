-- Slot V Toolkit-5: uitbreiding pre-seed runbook_tooltips
-- Dekt edge-cases voor invaller-scenario zoals klant-onbereikbaar, tech-ziek,
-- klacht-handling, multi-day beurten, etc. Sarah-resilient continuity.
--
-- Stijl-conventie: 90-160 chars per tooltip, directe NL-instructie,
-- verwijzingen naar concrete UI-elementen (modal-namen, knop-labels), géén emoji's.
-- Idempotent: ON CONFLICT update zodat re-run de defaults refresht.

INSERT INTO runbook_tooltips (fase, action_key, content_nl) VALUES

  -- ===== Fase 1: in_te_plannen — extra context bij planning =====
  ('in_te_plannen', 'klant_onbereikbaar',
    'Na 3 belpogingen op verschillende dagdelen (ochtend/middag/avond): stuur korte mail met 2 datum-voorstellen + terugbel-nummer. Snooze 7 dagen met reden "wacht op klant-respons". Beide pogingen documenteren in activity-log.'),

  ('in_te_plannen', 'klant_wil_andere_datum',
    'Klant geeft datum-voorkeur door vóór planning afgerond is? Noteer in klant-notitie (clients.planner_notitie) zodat toekomstige beurten dit overerven. Plan vervolgens in voor de gewenste datum via QuickAdd.'),

  ('in_te_plannen', 'geen_tech_beschikbaar',
    'Geen technieker vrij in target-week? Eerst Pattern A picker checken voor reisafstand-match in aangrenzende dagen. Lukt het niet binnen SLA-fase-1: snooze 1 week met reden "capaciteit", escaleer naar Gillian via Slack.'),

  -- ===== Fase 2: ingepland — beheer van gepland werk =====
  ('ingepland', 'klant_cancelled',
    'Definitief geannuleerd door klant: terug_naar_fase_1 + reden in activity-log. Bij herhaling (3+ keer dezelfde klant): zet vlag in klant-notitie zodat planner extra bevestiging vraagt vóór tech rijdt.'),

  ('ingepland', 'tech_ziek',
    'Open beurt → Verplaats. Pattern A picker stelt automatisch vervangende technieker voor o.b.v. reisafstand. Klant krijgt nieuwe bevestigings-mail/SMS. Bij geen vervanger: terug_naar_fase_1 + bel klant zelf voor herplanning.'),

  ('ingepland', 'weer_obstakel',
    'Zonnepanelen-reiniging bij regen/storm: Verplaats naar volgende beschikbare droge dag (check buienradar 48u vooruit). Documenteer reden in activity-log zodat partner ziet waarom datum wijzigde.'),

  -- ===== Fase 3: uitgevoerd — controle voor rapport =====
  ('uitgevoerd', 'multi_day_beurt',
    'Multi-day werk (bv. 2-daagse HVAC-installatie): markeer pas als "uitgevoerd" na de laatste werkdag. Tussentijds blijft status "ingepland" zodat uren-registratie doorloopt over alle dagen.'),

  ('uitgevoerd', 'geen_uren_geregistreerd',
    'Geen uren ingegeven door technieker? Stop. Bel tech voor bevestiging effectieve uren vóór status-wissel. Zonder uren faalt fase-4 controle en wordt facturatie incorrect.'),

  ('uitgevoerd', 'klacht_klant',
    'Klant klacht over uitvoering? Eerst klacht-flow: noteer in activity-log met type "klacht", informeer Gillian via Slack, hou rapport-fase tegen tot klacht is opgelost. Pas daarna maak_rapport of credit.'),

  -- ===== Fase 4: rapportage — rapport-creatie =====
  ('rapportage', 'rapport_pending_klant_review',
    'Bij grotere installaties: stuur rapport-draft naar klant voor review vóór definitief verstuurd. Wacht max 5 werkdagen op respons, dan automatisch doorzetten naar facturatie met activity-log-vermelding.'),

  ('rapportage', 'rapport_template_keuze',
    'Partner-onderhoud (Novectra/CW Solar): altijd partner-branded template (logo + kleuren). Flancco-direct of ad-hoc: Flancco default-template. Template wordt automatisch gekozen o.b.v. contract.partner_id.'),

  -- ===== Fase 5: uitgestuurd_facturatie — facturatie =====
  ('uitgestuurd_facturatie', 'factuur_credit_nodig',
    'Klant betwist factuur na verzending? Maak géén nieuwe beurt. Open boekhouding (extern) voor credit-nota, log reden in activity-log. Beurt blijft op "uitgestuurd_facturatie" tot creditering geboekt is.'),

  ('uitgestuurd_facturatie', 'partner_marge_check',
    'Vóór markeer_afgewerkt: check Winstgevendheid-pagina voor deze partner. Negatieve marge op deze beurt? Eerst Gillian inlichten — kan duiden op onderschatting uren of verkeerde forfait.'),

  -- ===== Cross-cutting (fase=general) — invaller-onboarding =====
  ('general', 'gebruik_handoff_modus',
    'Activeer hand-off modus in Instellingen wanneer een invaller het overneemt. Tooltips, activity-log en klant-notitie staan dan default uitgeklapt op pipeline-pages — minimaliseert klikken voor wie het systeem nog niet kent.'),

  ('general', 'klant_notitie_best_practices',
    'In clients.planner_notitie: enkel praktische voorkeuren ("steeds voor 14u", "achteringang", "honden in tuin"). Géén medische details, géén GDPR-gevoelige info, géén meningen. Audit-trail leest mee.'),

  ('general', 'runbook_aanpassen',
    'Tooltips zijn admin-bewerkbaar: hover icoon → potlood-knop → tekst aanpassen → save. Wijziging is direct zichtbaar voor alle planners. Houd het kort (max 200 chars) en concreet — geen lange uitleg.'),

  ('general', 'escaleer_naar_admin',
    'Stuur door naar Gillian bij: klacht met juridische impact, betwisting > €1000, technieker-conflict, partner-relatie issue, security-incident. Voor alle andere edge-cases: probeer eerst zelf met activity-log + runbook.')

ON CONFLICT (fase, action_key) DO UPDATE
  SET content_nl = EXCLUDED.content_nl,
      updated_at = now();

COMMENT ON TABLE runbook_tooltips IS
  'Slot V Toolkit-5: admin-bewerkbare tooltips per fase + action_key. Self-documenting platform (Sarah-resilient). Pre-seed dekt 27+ scenarios incl. cross-cutting fase=general.';
