-- Audit-fix 2026-05-13: BEFORE UPDATE auto-stamp van updated_at op 12 tabellen
-- die de kolom wel hadden maar geen trigger. Hygiëne-fix om audit-trail
-- betrouwbaar te houden onafhankelijk van client-discipline.
-- Helper-function set_updated_at() bestaat al sinds Wave 4a.

DROP TRIGGER IF EXISTS trg_app_settings_set_updated_at ON public.app_settings;
CREATE TRIGGER trg_app_settings_set_updated_at
  BEFORE UPDATE ON public.app_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_beurt_uren_registraties_set_updated_at ON public.beurt_uren_registraties;
CREATE TRIGGER trg_beurt_uren_registraties_set_updated_at
  BEFORE UPDATE ON public.beurt_uren_registraties
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_checklist_templates_set_updated_at ON public.checklist_templates;
CREATE TRIGGER trg_checklist_templates_set_updated_at
  BEFORE UPDATE ON public.checklist_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_clients_set_updated_at ON public.clients;
CREATE TRIGGER trg_clients_set_updated_at
  BEFORE UPDATE ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_facturatie_records_set_updated_at ON public.facturatie_records;
CREATE TRIGGER trg_facturatie_records_set_updated_at
  BEFORE UPDATE ON public.facturatie_records
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_interventies_set_updated_at ON public.interventies;
CREATE TRIGGER trg_interventies_set_updated_at
  BEFORE UPDATE ON public.interventies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_klant_installaties_set_updated_at ON public.klant_installaties;
CREATE TRIGGER trg_klant_installaties_set_updated_at
  BEFORE UPDATE ON public.klant_installaties
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_onderhoudsbeurten_set_updated_at ON public.onderhoudsbeurten;
CREATE TRIGGER trg_onderhoudsbeurten_set_updated_at
  BEFORE UPDATE ON public.onderhoudsbeurten
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_opmaat_projects_set_updated_at ON public.opmaat_projects;
CREATE TRIGGER trg_opmaat_projects_set_updated_at
  BEFORE UPDATE ON public.opmaat_projects
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_partner_permissions_set_updated_at ON public.partner_permissions;
CREATE TRIGGER trg_partner_permissions_set_updated_at
  BEFORE UPDATE ON public.partner_permissions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_runbook_tooltips_set_updated_at ON public.runbook_tooltips;
CREATE TRIGGER trg_runbook_tooltips_set_updated_at
  BEFORE UPDATE ON public.runbook_tooltips
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_voertuigen_set_updated_at ON public.voertuigen;
CREATE TRIGGER trg_voertuigen_set_updated_at
  BEFORE UPDATE ON public.voertuigen
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
