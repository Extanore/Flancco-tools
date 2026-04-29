-- Slot V Toolkit-5a: SLA-targets per partner per fase
ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS sla_fase_1_uren INT NULL,
  ADD COLUMN IF NOT EXISTS sla_fase_2_uren INT NULL,
  ADD COLUMN IF NOT EXISTS sla_fase_4_uren INT NULL,
  ADD COLUMN IF NOT EXISTS sla_fase_5_uren INT NULL;

COMMENT ON COLUMN partners.sla_fase_1_uren IS 'Slot V Toolkit-5: SLA-uren voor fase 1 (in te plannen). NULL=geen SLA.';
COMMENT ON COLUMN partners.sla_fase_2_uren IS 'Slot V Toolkit-5: SLA-uren voor fase 2 (ingepland).';
COMMENT ON COLUMN partners.sla_fase_4_uren IS 'Slot V Toolkit-5: SLA-uren voor fase 4 (rapportage).';
COMMENT ON COLUMN partners.sla_fase_5_uren IS 'Slot V Toolkit-5: SLA-uren voor fase 5 (uitgestuurd ter facturatie).';

-- Slot V Toolkit-5b: runbook_tooltips voor admin-bewerkbare per-fase uitleg
CREATE TABLE IF NOT EXISTS runbook_tooltips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fase TEXT NOT NULL,
  action_key TEXT NOT NULL,
  content_nl TEXT NOT NULL,
  content_fr TEXT NULL,
  updated_by UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (fase, action_key)
);

COMMENT ON TABLE runbook_tooltips IS
  'Slot V Toolkit-5: admin-bewerkbare tooltips per fase + action_key. Self-documenting platform (Sarah-resilient).';

ALTER TABLE runbook_tooltips ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "All authenticated SELECT runbook_tooltips" ON runbook_tooltips;
CREATE POLICY "All authenticated SELECT runbook_tooltips"
  ON runbook_tooltips FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Admin INSERT runbook_tooltips" ON runbook_tooltips;
CREATE POLICY "Admin INSERT runbook_tooltips"
  ON runbook_tooltips FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM user_roles WHERE user_id=auth.uid() AND role='admin'));

DROP POLICY IF EXISTS "Admin UPDATE runbook_tooltips" ON runbook_tooltips;
CREATE POLICY "Admin UPDATE runbook_tooltips"
  ON runbook_tooltips FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM user_roles WHERE user_id=auth.uid() AND role='admin'));

DROP POLICY IF EXISTS "Admin DELETE runbook_tooltips" ON runbook_tooltips;
CREATE POLICY "Admin DELETE runbook_tooltips"
  ON runbook_tooltips FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM user_roles WHERE user_id=auth.uid() AND role='admin'));

-- Pre-seed defaults NL voor alle Slot V (Onderhoud) fase + action combinaties
INSERT INTO runbook_tooltips (fase, action_key, content_nl) VALUES
  ('in_te_plannen', 'plan_in', 'Open de QuickAdd-modal en kies datum + technieker. De afspraak is daarna vastgelegd. Klant ontvangt automatisch een bevestiging.'),
  ('in_te_plannen', 'snooze', 'Tijdelijk verbergen tot een latere datum. Geef altijd een reden mee zodat collega''s context hebben — dat staat permanent op het record.'),
  ('in_te_plannen', 'annuleer', 'Soft-delete het record. Klant heeft niet langer interesse of contract is opgezegd. Audit-trail blijft bewaard.'),
  ('ingepland', 'verplaats', 'Wijzig datum of technieker. Klant ontvangt automatisch een nieuwe bevestiging via email/SMS.'),
  ('ingepland', 'terug_naar_fase_1', 'Klant heeft afgezegd. Record gaat terug naar In te plannen voor herplanning. Schrijf reden in activity-log.'),
  ('ingepland', 'bel_klant', 'Snel-actie: native dialer opent met klant-telefoon. Documenteer het gesprek via "+ Notitie" zodat collega''s weten wat besproken is.'),
  ('uitgevoerd', 'maak_rapport', 'Voor partner-onderhoud (Novectra/CW Solar) altijd. Verplicht voor klant. Gebruikt admin/rapport.html in nieuwe tab.'),
  ('uitgevoerd', 'direct_naar_facturatie', 'Alleen voor losse opdrachten zonder rapport-vraag (bv. droger-uitgave, ad-hoc reiniging). Skip rapport-fase.'),
  ('rapportage', 'controleer_verstuur', 'Open uren-controle-modal, pas tarieven aan indien nodig, save → genereert facturatie-regel onder open of nieuw partner-factuur.'),
  ('uitgestuurd_facturatie', 'markeer_afgewerkt', 'Pas wanneer factuur effectief verstuurd is. Beurt verdwijnt uit Onderhoud, blijft als historiek in Rapporten + Facturatie.')
ON CONFLICT (fase, action_key) DO NOTHING;
