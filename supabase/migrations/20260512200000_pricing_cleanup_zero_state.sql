-- Pricing-feature cleanup: drop ALLE objecten uit PR #62 + PR #64.
-- Doel: zero-state om opnieuw te beginnen vanaf schoon vertrekpunt.
--
-- Volgorde matters: cron-jobs → triggers → functions → views → tables →
-- kolommen → constraints → indexes → restore defaults. Alle IF EXISTS-clauses
-- zodat herhaald uitvoeren idempotent is.
--
-- Wat blijft staan: alles wat NIET met de pricing-feature samenhangt
-- (kalenderen, klanten, contracten basics, partner_applications kern-data, etc.)

-- ─────────────────────────────────────────────────────────────────────
-- 1. Unschedule pg_cron jobs (geen impact als ze al weg zijn)
-- ─────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  PERFORM cron.unschedule('apply_pricing_indexering_daily');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'cron job apply_pricing_indexering_daily niet aanwezig: %', SQLERRM;
END $$;

DO $$
BEGIN
  PERFORM cron.unschedule('apply_yearly_contract_indexering_daily');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'cron job apply_yearly_contract_indexering_daily niet aanwezig: %', SQLERRM;
END $$;

DO $$
BEGIN
  PERFORM cron.unschedule('dispatch_klant_indexering_aankondiging_daily');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'cron job dispatch_klant_indexering_aankondiging_daily niet aanwezig: %', SQLERRM;
END $$;

-- ─────────────────────────────────────────────────────────────────────
-- 2. Drop triggers
-- ─────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_pricing_indexering_planned_dispatch ON public.pricing_indexering_planned;
DROP TRIGGER IF EXISTS trg_contracten_set_indexering_start_index ON public.contracten;
DROP TRIGGER IF EXISTS trg_contracten_set_template_versie ON public.contracten;
DROP TRIGGER IF EXISTS trg_partner_applications_set_template_versie ON public.partner_applications;
DROP TRIGGER IF EXISTS trg_gezondheidsindex_touch_updated_at ON public.gezondheidsindex_metingen;

-- ─────────────────────────────────────────────────────────────────────
-- 3. Drop functions
-- ─────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.apply_pending_pricing_indexering();
DROP FUNCTION IF EXISTS public.apply_yearly_contract_indexering(boolean);
DROP FUNCTION IF EXISTS public.dispatch_klant_indexering_aankondigingen();
DROP FUNCTION IF EXISTS public.dispatch_klant_indexering_aankondiging_via_http();
DROP FUNCTION IF EXISTS public.fn_pricing_indexering_dispatch_partner_mail(uuid);
DROP FUNCTION IF EXISTS public.fn_pricing_indexering_planned_after_insert();
DROP FUNCTION IF EXISTS public.set_indexering_start_index();
DROP FUNCTION IF EXISTS public.set_contract_template_versie();
DROP FUNCTION IF EXISTS public.touch_gezondheidsindex_updated_at();
DROP FUNCTION IF EXISTS public.get_current_gezondheidsindex();

-- ─────────────────────────────────────────────────────────────────────
-- 4. Drop views
-- ─────────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.v_partner_afrekening_per_maand;
DROP VIEW IF EXISTS public.v_partner_afrekening_per_beurt;

-- ─────────────────────────────────────────────────────────────────────
-- 5. Drop tables (volgorde: child eerst om FK-issues te vermijden)
-- ─────────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS public.contract_indexering_announcements;
DROP TABLE IF EXISTS public.contract_indexering_log;
DROP TABLE IF EXISTS public.pricing_indexering_planned;
DROP TABLE IF EXISTS public.gezondheidsindex_metingen;

-- ─────────────────────────────────────────────────────────────────────
-- 6. Drop kolommen op contracten (PR #62 snapshot + indexering)
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.contracten
  DROP CONSTRAINT IF EXISTS chk_contracten_indexering_cap_consistent,
  DROP CONSTRAINT IF EXISTS chk_contracten_indexering_type;

ALTER TABLE public.contracten
  DROP COLUMN IF EXISTS contract_template_versie,
  DROP COLUMN IF EXISTS flancco_forfait_per_beurt,
  DROP COLUMN IF EXISTS marge_pct_snapshot,
  DROP COLUMN IF EXISTS planning_fee_snapshot,
  DROP COLUMN IF EXISTS indexering_type,
  DROP COLUMN IF EXISTS indexering_min_pct,
  DROP COLUMN IF EXISTS indexering_max_pct,
  DROP COLUMN IF EXISTS indexering_start_index,
  DROP COLUMN IF EXISTS indexering_laatste_datum;

-- ─────────────────────────────────────────────────────────────────────
-- 7. Drop kolom op partner_applications (PR #62 template-versie)
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.partner_applications
  DROP COLUMN IF EXISTS contract_template_versie;

-- ─────────────────────────────────────────────────────────────────────
-- 8. Restore pricing.partner_id NOT NULL + drop unique index
-- ─────────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS public.uq_pricing_basis_per_sector_staffel;

-- Restore NOT NULL constraint. Veilig: er zijn nu nul rijen met NULL partner_id
-- (Optie Z was nooit gebruikt productie-wise — geen Flancco-basis-rijen ingevoerd).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.pricing WHERE partner_id IS NULL LIMIT 1) THEN
    RAISE WARNING 'pricing-tabel bevat % NULL partner_id rijen — NOT NULL constraint niet hersteld. Manueel opruimen.',
      (SELECT COUNT(*) FROM public.pricing WHERE partner_id IS NULL);
  ELSE
    ALTER TABLE public.pricing ALTER COLUMN partner_id SET NOT NULL;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────
-- 9. Drop app_settings entries
-- ─────────────────────────────────────────────────────────────────────
DELETE FROM public.app_settings WHERE key IN ('partner_contract_versie', 'eindklant_contract_versie');

-- ─────────────────────────────────────────────────────────────────────
-- 10. Verificatie + samenvatting
-- ─────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_remaining_objects INT;
BEGIN
  SELECT COUNT(*) INTO v_remaining_objects
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN ('pricing_indexering_planned','contract_indexering_log','contract_indexering_announcements','gezondheidsindex_metingen');

  RAISE NOTICE 'Pricing-cleanup compleet. Resterende tabellen die zouden moeten weg zijn: %', v_remaining_objects;
END $$;
