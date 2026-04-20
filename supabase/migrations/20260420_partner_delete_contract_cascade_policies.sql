-- =============================================
-- Partner DELETE-policies voor contract-kinderen
-- =============================================
-- Vanaf 2026-04-20: partners mogen hun eigen contracten verwijderen (UI-knop in
-- contractenlijst). De parent-delete werkt al via contracten_partner_write, maar
-- de cascade-kinderen hadden enkel admin_all_* policies — daardoor faalde de
-- expliciete pre-delete van facturatie_regels/rapporten/interventies en ook de
-- FK-cascade op contract_regels/onderhoudsbeurten (RLS wordt toegepast op
-- cascade-deletes in de context van de aanroepende user).
--
-- Scope: enkel DELETE, geen INSERT/UPDATE-creep. Admin-policies blijven
-- ongewijzigd. Ownership-check via parent-contract's partner_id.
-- =============================================

CREATE POLICY contract_regels_partner_delete ON contract_regels
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM contracten
    WHERE contracten.id = contract_regels.contract_id
      AND is_partner_of(contracten.partner_id)
  ));

CREATE POLICY facturatie_regels_partner_delete ON facturatie_regels
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM contracten
    WHERE contracten.id = facturatie_regels.contract_id
      AND is_partner_of(contracten.partner_id)
  ));

CREATE POLICY interventies_partner_delete ON interventies
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM contracten
    WHERE contracten.id = interventies.contract_id
      AND is_partner_of(contracten.partner_id)
  ));

CREATE POLICY onderhoudsbeurten_partner_delete ON onderhoudsbeurten
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM contracten
    WHERE contracten.id = onderhoudsbeurten.contract_id
      AND is_partner_of(contracten.partner_id)
  ));

CREATE POLICY rapporten_partner_delete ON rapporten
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM contracten
    WHERE contracten.id = rapporten.contract_id
      AND is_partner_of(contracten.partner_id)
  ));
