-- ═══════════════════════════════════════════════════════════════════════
-- Pricing foundation — schone rebuild van het volledige schema.
-- ═══════════════════════════════════════════════════════════════════════
--
-- Doel: één reviewbare migration die alle DB-objecten voor de pricing-
-- feature herinricht na zero-state cleanup (PR #68).
--
-- Architectuur:
--   * Snapshot bij contract-signing → bevriest Flancco-portie + marge + planFee
--     zodat latere prijswijzigingen lopend contract niet raken (juridisch
--     verankerd in eindklant-contract art. 3 + partner-contract Prijszetting).
--   * Optie Z hybride pricing: pricing.partner_id NULL = Flancco-basis,
--     niet-NULL = partner override. Calculator/wizard fallback naar basis.
--   * Indexering: gezondheidsindex_capped (default min 1.5% / max 4% per jaar).
--   * Versionering: contract_template_versie auto-stamp bij signing voor
--     juridische reproduceerbaarheid van wat partner/klant ondertekende.
--
-- Idempotent: IF NOT EXISTS overal, ON CONFLICT op seeds.

-- ─────────────────────────────────────────────────────────────────────
-- 1. Kolommen op contracten — snapshot + indexering + versionering
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.contracten
  ADD COLUMN IF NOT EXISTS contract_template_versie  TEXT     NULL,
  ADD COLUMN IF NOT EXISTS flancco_forfait_per_beurt NUMERIC  NULL,
  ADD COLUMN IF NOT EXISTS marge_pct_snapshot        NUMERIC  NULL,
  ADD COLUMN IF NOT EXISTS planning_fee_snapshot     NUMERIC  NULL,
  ADD COLUMN IF NOT EXISTS indexering_type           TEXT     NOT NULL DEFAULT 'gezondheidsindex_capped',
  ADD COLUMN IF NOT EXISTS indexering_min_pct        NUMERIC  NOT NULL DEFAULT 1.5,
  ADD COLUMN IF NOT EXISTS indexering_max_pct        NUMERIC  NOT NULL DEFAULT 4.0,
  ADD COLUMN IF NOT EXISTS indexering_start_index    NUMERIC  NULL,
  ADD COLUMN IF NOT EXISTS indexering_laatste_datum  DATE     NULL;

ALTER TABLE public.contracten
  DROP CONSTRAINT IF EXISTS chk_contracten_indexering_type,
  ADD  CONSTRAINT chk_contracten_indexering_type
    CHECK (indexering_type IN ('gezondheidsindex_capped','vast_pct','geen'));

ALTER TABLE public.contracten
  DROP CONSTRAINT IF EXISTS chk_contracten_indexering_cap_consistent,
  ADD  CONSTRAINT chk_contracten_indexering_cap_consistent
    CHECK (indexering_min_pct <= indexering_max_pct);

COMMENT ON COLUMN public.contracten.contract_template_versie IS
  'Versie-string van eindklant-contract template op signing-moment (bv. v2.0-2026-05). Juridische traceerbaarheid.';
COMMENT ON COLUMN public.contracten.flancco_forfait_per_beurt IS
  'Snapshot van Flancco-forfait per beurt op signing-moment. Wat partner aan Flancco verschuldigd is. Volgt jaarlijkse indexering mee.';
COMMENT ON COLUMN public.contracten.marge_pct_snapshot IS
  'Snapshot van partner.marge_pct op signing-moment. Consistency-check + audit.';
COMMENT ON COLUMN public.contracten.planning_fee_snapshot IS
  'Snapshot van partner.planning_fee per beurt op signing-moment. Volgt jaarlijkse indexering mee.';
COMMENT ON COLUMN public.contracten.indexering_type IS
  'Indexerings-formule. gezondheidsindex_capped = BE gezondheidsindex met min/max cap (default).';
COMMENT ON COLUMN public.contracten.indexering_min_pct IS
  'Minimum jaarlijkse indexering in procent (default 1.5). Bescherming bij lage inflatie.';
COMMENT ON COLUMN public.contracten.indexering_max_pct IS
  'Maximum jaarlijkse indexering in procent (default 4.0). Bescherming klant tegen hoge inflatie.';
COMMENT ON COLUMN public.contracten.indexering_start_index IS
  'Gezondheidsindex-waarde op signing-datum (uit gezondheidsindex_metingen). Auto-gevuld door trigger.';
COMMENT ON COLUMN public.contracten.indexering_laatste_datum IS
  'Datum van laatste toegepaste indexering. NULL = nog nooit geïndexeerd.';

-- ─────────────────────────────────────────────────────────────────────
-- 2. Kolom op partner_applications — versie partner-contract
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.partner_applications
  ADD COLUMN IF NOT EXISTS contract_template_versie TEXT NULL;

COMMENT ON COLUMN public.partner_applications.contract_template_versie IS
  'Versie-string van partner-contract template op signing-moment (bv. v1.1-2026-05). Juridische traceerbaarheid.';

-- ─────────────────────────────────────────────────────────────────────
-- 3. pricing.partner_id nullable — Optie Z hybride (NULL = Flancco-basis)
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.pricing
  ALTER COLUMN partner_id DROP NOT NULL;

COMMENT ON COLUMN public.pricing.partner_id IS
  'NULL = Flancco-basistarief (fallback voor alle partners). Niet-NULL = partner-specifieke override.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_pricing_basis_per_sector_staffel
  ON public.pricing(sector, staffel_min, staffel_max, COALESCE(subtype,''), COALESCE(parameter_key,''))
  WHERE partner_id IS NULL;

-- ─────────────────────────────────────────────────────────────────────
-- 4. Tabel: gezondheidsindex_metingen
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.gezondheidsindex_metingen (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  jaar            INT          NOT NULL,
  maand           INT          NOT NULL CHECK (maand BETWEEN 1 AND 12),
  waarde          NUMERIC      NOT NULL CHECK (waarde > 0),
  bron            TEXT         NOT NULL DEFAULT 'statbel.fgov.be',
  notitie         TEXT         NULL,
  ingevoerd_door  UUID         NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (jaar, maand)
);

CREATE INDEX IF NOT EXISTS idx_gezondheidsindex_jaar_maand
  ON public.gezondheidsindex_metingen(jaar DESC, maand DESC);

COMMENT ON TABLE public.gezondheidsindex_metingen IS
  'Maandelijkse Belgische gezondheidsindex (FOD Economie). Voedt contract-indexering + snapshot bij signing.';

ALTER TABLE public.gezondheidsindex_metingen ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS gezondheidsindex_admin_all ON public.gezondheidsindex_metingen;
CREATE POLICY gezondheidsindex_admin_all
  ON public.gezondheidsindex_metingen FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS gezondheidsindex_authenticated_select ON public.gezondheidsindex_metingen;
CREATE POLICY gezondheidsindex_authenticated_select
  ON public.gezondheidsindex_metingen FOR SELECT
  TO authenticated
  USING (true);

-- ─────────────────────────────────────────────────────────────────────
-- 5. Tabel: pricing_indexering_planned
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.pricing_indexering_planned (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  effective_date   DATE         NOT NULL,
  pct_increase     NUMERIC      NOT NULL,
  scope_sectoren   TEXT[]       NULL,
  reden            TEXT         NULL,
  aangekondigd_op  TIMESTAMPTZ  NULL,
  applied_at       TIMESTAMPTZ  NULL,
  cancelled_at     TIMESTAMPTZ  NULL,
  aangemaakt_door  UUID         NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT chk_indexering_eff_min_30d CHECK (
    -- Bij INSERT moet effective_date minstens 30d in toekomst zijn (juridisch verplichte
    -- aankondigingstermijn). Bij UPDATE/cancel niet meer relevant.
    created_at IS NULL OR effective_date >= (created_at::date + INTERVAL '30 days')
  )
);

CREATE INDEX IF NOT EXISTS idx_pricing_indexering_planned_eff
  ON public.pricing_indexering_planned(effective_date)
  WHERE applied_at IS NULL AND cancelled_at IS NULL;

COMMENT ON TABLE public.pricing_indexering_planned IS
  'Geplande indexeringen van Flancco-basisprijzen. Effective_date moet minstens 30d in toekomst (contractueel verplichte aankondigingstermijn). Scope_sectoren NULL = alle sectoren.';

ALTER TABLE public.pricing_indexering_planned ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pricing_indexering_planned_admin_all ON public.pricing_indexering_planned;
CREATE POLICY pricing_indexering_planned_admin_all
  ON public.pricing_indexering_planned FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- ─────────────────────────────────────────────────────────────────────
-- 6. Tabel: contract_indexering_log (per-contract audit van jaarlijkse indexering)
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.contract_indexering_log (
  id                                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id                       UUID         NOT NULL REFERENCES public.contracten(id) ON DELETE CASCADE,
  toegepast_op                      DATE         NOT NULL,
  oude_forfait                      NUMERIC      NOT NULL,
  nieuwe_forfait                    NUMERIC      NOT NULL,
  oude_flancco_forfait              NUMERIC      NULL,
  nieuwe_flancco_forfait            NUMERIC      NULL,
  pct_toegepast                     NUMERIC      NOT NULL,
  basis_index                       NUMERIC      NULL,
  toegepaste_index                  NUMERIC      NULL,
  klant_aankondiging_verzonden_op   TIMESTAMPTZ  NULL,
  partner_aankondiging_verzonden_op TIMESTAMPTZ  NULL,
  uitgevoerd_door                   TEXT         NOT NULL DEFAULT 'cron',
  created_at                        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contract_indexering_log_contract
  ON public.contract_indexering_log(contract_id, toegepast_op DESC);

COMMENT ON TABLE public.contract_indexering_log IS
  'Append-only audit-trail van elke jaarlijkse indexering per contract. Juridische verdediging + transparantie naar klant en partner.';

ALTER TABLE public.contract_indexering_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contract_indexering_log_admin_all ON public.contract_indexering_log;
CREATE POLICY contract_indexering_log_admin_all
  ON public.contract_indexering_log FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS contract_indexering_log_partner_select ON public.contract_indexering_log;
CREATE POLICY contract_indexering_log_partner_select
  ON public.contract_indexering_log FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.contracten c
      WHERE c.id = contract_indexering_log.contract_id
        AND public.is_partner_of(c.partner_id)
    )
  );

-- ─────────────────────────────────────────────────────────────────────
-- 7. Tabel: contract_indexering_announcements (idempotency klant-aankondiging)
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.contract_indexering_announcements (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id         UUID         NOT NULL REFERENCES public.contracten(id) ON DELETE CASCADE,
  gepland_voor_datum  DATE         NOT NULL,
  verzonden_op        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  recipient_email     TEXT         NULL,
  resend_message_id   TEXT         NULL,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (contract_id, gepland_voor_datum)
);

CREATE INDEX IF NOT EXISTS idx_contract_indexering_announcements_contract
  ON public.contract_indexering_announcements(contract_id, gepland_voor_datum DESC);

COMMENT ON TABLE public.contract_indexering_announcements IS
  'Idempotency-gateway voor klant-aankondiging dispatch. UNIQUE (contract_id, gepland_voor_datum) voorkomt dubbele mails voor zelfde indexerings-cyclus.';

ALTER TABLE public.contract_indexering_announcements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contract_indexering_announcements_admin_all ON public.contract_indexering_announcements;
CREATE POLICY contract_indexering_announcements_admin_all
  ON public.contract_indexering_announcements FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS contract_indexering_announcements_partner_select ON public.contract_indexering_announcements;
CREATE POLICY contract_indexering_announcements_partner_select
  ON public.contract_indexering_announcements FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.contracten c
      WHERE c.id = contract_indexering_announcements.contract_id
        AND public.is_partner_of(c.partner_id)
    )
  );

-- ─────────────────────────────────────────────────────────────────────
-- 8. Views: Partner-afrekening
-- ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.v_partner_afrekening_per_beurt
WITH (security_invoker=on)
AS
SELECT
  b.id                                    AS beurt_id,
  b.contract_id,
  b.sector,
  b.volgnummer,
  b.plan_datum,
  b.eind_datum,
  b.status                                AS beurt_status,
  b.facturatie_status,
  b.gefactureerd_op,
  b.ref_nummer,
  c.partner_id,
  p.bedrijfsnaam                          AS partner_bedrijfsnaam,
  p.naam                                  AS partner_naam,
  p.slug                                  AS partner_slug,
  c.contract_nummer,
  c.klant_naam,
  c.klant_email,
  c.klant_gemeente,
  c.forfait_bedrag                        AS klant_forfait_per_beurt,
  c.flancco_forfait_per_beurt,
  c.planning_fee_snapshot,
  c.marge_pct_snapshot,
  COALESCE(c.flancco_forfait_per_beurt, 0)
    + COALESCE(c.planning_fee_snapshot, 0) AS te_betalen_aan_flancco,
  c.indexering_laatste_datum
FROM public.onderhoudsbeurten b
JOIN public.contracten c ON c.id = b.contract_id
JOIN public.partners   p ON p.id = c.partner_id
WHERE COALESCE(c.is_eenmalig, false) = false
  AND (b.status IN ('uitgevoerd','afgewerkt','ingepland','in_te_plannen'));

COMMENT ON VIEW public.v_partner_afrekening_per_beurt IS
  'Per onderhoudsbeurt de bevroren Flancco-portie + planning fee voor partner→Flancco settlement. RLS via security_invoker — admin ziet alles, partner enkel eigen via contracten RLS.';

CREATE OR REPLACE VIEW public.v_partner_afrekening_per_maand
WITH (security_invoker=on)
AS
SELECT
  partner_id,
  partner_bedrijfsnaam,
  partner_naam,
  partner_slug,
  date_trunc('month', COALESCE(eind_datum, plan_datum))::date AS maand,
  COUNT(*)                                   AS aantal_beurten,
  COUNT(*) FILTER (WHERE beurt_status IN ('uitgevoerd','afgewerkt'))
                                             AS aantal_uitgevoerd,
  SUM(COALESCE(flancco_forfait_per_beurt,0)) AS totaal_flancco_forfait,
  SUM(COALESCE(planning_fee_snapshot,0))     AS totaal_planning_fee,
  SUM(te_betalen_aan_flancco)                AS totaal_te_betalen_aan_flancco,
  COUNT(*) FILTER (WHERE gefactureerd_op IS NOT NULL)
                                             AS aantal_gefactureerd,
  SUM(te_betalen_aan_flancco) FILTER (WHERE gefactureerd_op IS NULL)
                                             AS openstaand_te_factureren
FROM public.v_partner_afrekening_per_beurt
WHERE COALESCE(eind_datum, plan_datum) IS NOT NULL
GROUP BY partner_id, partner_bedrijfsnaam, partner_naam, partner_slug,
         date_trunc('month', COALESCE(eind_datum, plan_datum));

COMMENT ON VIEW public.v_partner_afrekening_per_maand IS
  'Maand-totalen per partner voor Flancco→Partner settlement. Aggregeert v_partner_afrekening_per_beurt. RLS via security_invoker.';

-- ─────────────────────────────────────────────────────────────────────
-- 9. App-settings seed: contract-template versies
-- ─────────────────────────────────────────────────────────────────────

INSERT INTO public.app_settings (key, value)
VALUES
  ('partner_contract_versie',   '"v1.1-2026-05-12"'::jsonb),
  ('eindklant_contract_versie', '"v2.0-2026-05-12"'::jsonb)
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value, updated_at = now();

-- ─────────────────────────────────────────────────────────────────────
-- 10. Trigger function: auto-stamp contract_template_versie bij signing
-- ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_contract_template_versie()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_versie TEXT;
BEGIN
  IF TG_TABLE_NAME = 'partner_applications' THEN
    IF NEW.status = 'contract_signed'
       AND NEW.contract_template_versie IS NULL
       AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'contract_signed') THEN
      SELECT value #>> '{}' INTO v_versie FROM public.app_settings WHERE key = 'partner_contract_versie' LIMIT 1;
      NEW.contract_template_versie := v_versie;
    END IF;
  ELSIF TG_TABLE_NAME = 'contracten' THEN
    IF NEW.status IN ('getekend','actief')
       AND NEW.contract_template_versie IS NULL
       AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
      SELECT value #>> '{}' INTO v_versie FROM public.app_settings WHERE key = 'eindklant_contract_versie' LIMIT 1;
      NEW.contract_template_versie := v_versie;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_contract_template_versie() FROM anon, authenticated, PUBLIC;

DROP TRIGGER IF EXISTS trg_contracten_set_template_versie ON public.contracten;
CREATE TRIGGER trg_contracten_set_template_versie
  BEFORE INSERT OR UPDATE OF status, contract_template_versie
  ON public.contracten
  FOR EACH ROW
  EXECUTE FUNCTION public.set_contract_template_versie();

DROP TRIGGER IF EXISTS trg_partner_applications_set_template_versie ON public.partner_applications;
CREATE TRIGGER trg_partner_applications_set_template_versie
  BEFORE INSERT OR UPDATE OF status, contract_template_versie
  ON public.partner_applications
  FOR EACH ROW
  EXECUTE FUNCTION public.set_contract_template_versie();

-- ─────────────────────────────────────────────────────────────────────
-- 11. Trigger function: auto-fill indexering_start_index bij signing
-- ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_indexering_start_index()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_idx NUMERIC;
BEGIN
  IF NEW.status IN ('actief','getekend')
     AND NEW.indexering_start_index IS NULL
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    SELECT waarde INTO v_idx
      FROM public.gezondheidsindex_metingen
     ORDER BY jaar DESC, maand DESC
     LIMIT 1;
    NEW.indexering_start_index := v_idx;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_indexering_start_index() FROM anon, authenticated, PUBLIC;

DROP TRIGGER IF EXISTS trg_contracten_set_indexering_start_index ON public.contracten;
CREATE TRIGGER trg_contracten_set_indexering_start_index
  BEFORE INSERT OR UPDATE OF status, indexering_start_index
  ON public.contracten
  FOR EACH ROW
  EXECUTE FUNCTION public.set_indexering_start_index();

-- ─────────────────────────────────────────────────────────────────────
-- 12. Trigger function: updated_at touch op gezondheidsindex_metingen
-- ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.touch_gezondheidsindex_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_gezondheidsindex_touch_updated_at ON public.gezondheidsindex_metingen;
CREATE TRIGGER trg_gezondheidsindex_touch_updated_at
  BEFORE UPDATE ON public.gezondheidsindex_metingen
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_gezondheidsindex_updated_at();

-- ─────────────────────────────────────────────────────────────────────
-- 13. Helper function: meest recente gezondheidsindex
-- ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_current_gezondheidsindex()
RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT waarde
    FROM public.gezondheidsindex_metingen
   ORDER BY jaar DESC, maand DESC
   LIMIT 1
$$;

REVOKE EXECUTE ON FUNCTION public.get_current_gezondheidsindex() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_current_gezondheidsindex() TO authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- 14. Auto-dispatch partner-aankondiging bij INSERT in pricing_indexering_planned
-- ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_pricing_indexering_dispatch_partner_mail(p_planned_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_url        text;
  v_key        text;
  v_request_id bigint;
BEGIN
  IF p_planned_id IS NULL THEN
    RETURN -1;
  END IF;

  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'slot_f_supabase_url' LIMIT 1;
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'slot_f_service_role_key' LIMIT 1;

  IF v_url IS NULL OR v_key IS NULL THEN
    RAISE WARNING 'fn_pricing_indexering_dispatch_partner_mail: vault-secrets ontbreken — skip mail voor planned %', p_planned_id;
    RETURN -1;
  END IF;

  BEGIN
    v_request_id := net.http_post(
      url     := rtrim(v_url, '/') || '/functions/v1/send-partner-indexering-aankondiging',
      body    := jsonb_build_object('planned_indexering_id', p_planned_id),
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
      timeout_milliseconds := 30000
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fn_pricing_indexering_dispatch_partner_mail: net.http_post faalde voor % (sqlstate %, msg %)',
      p_planned_id, SQLSTATE, SQLERRM;
    RETURN -1;
  END;
  RETURN v_request_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_pricing_indexering_dispatch_partner_mail(uuid) FROM anon, authenticated, PUBLIC;

CREATE OR REPLACE FUNCTION public.fn_pricing_indexering_planned_after_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.aangekondigd_op IS NOT NULL AND NEW.applied_at IS NULL AND NEW.cancelled_at IS NULL THEN
    PERFORM public.fn_pricing_indexering_dispatch_partner_mail(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_pricing_indexering_planned_after_insert() FROM anon, authenticated, PUBLIC;

DROP TRIGGER IF EXISTS trg_pricing_indexering_planned_dispatch ON public.pricing_indexering_planned;
CREATE TRIGGER trg_pricing_indexering_planned_dispatch
  AFTER INSERT ON public.pricing_indexering_planned
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_pricing_indexering_planned_after_insert();

-- ─────────────────────────────────────────────────────────────────────
-- 15. Cron-functie: apply pending Flancco-basis indexering
-- ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.apply_pending_pricing_indexering()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_planned RECORD;
  v_plans_processed INT := 0;
  v_plans_applied   INT := 0;
  v_rows_affected   INT;
BEGIN
  FOR v_planned IN
    SELECT *
      FROM public.pricing_indexering_planned
     WHERE effective_date <= CURRENT_DATE
       AND applied_at IS NULL
       AND cancelled_at IS NULL
     ORDER BY effective_date ASC
  LOOP
    v_plans_processed := v_plans_processed + 1;
    BEGIN
      UPDATE public.pricing
         SET flancco_forfait = ROUND(flancco_forfait * (1 + v_planned.pct_increase / 100), 2)
       WHERE partner_id IS NULL
         AND (v_planned.scope_sectoren IS NULL OR sector = ANY(v_planned.scope_sectoren));
      GET DIAGNOSTICS v_rows_affected = ROW_COUNT;

      UPDATE public.pricing_indexering_planned
         SET applied_at = now()
       WHERE id = v_planned.id;
      v_plans_applied := v_plans_applied + 1;
      RAISE NOTICE 'Plan % applied: % rijen gewijzigd met %%', v_planned.id, v_rows_affected, v_planned.pct_increase;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'apply_pending_pricing_indexering plan % faalde (sqlstate %, msg %)',
        v_planned.id, SQLSTATE, SQLERRM;
    END;
  END LOOP;
  RETURN jsonb_build_object(
    'plans_processed', v_plans_processed,
    'plans_applied',   v_plans_applied
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.apply_pending_pricing_indexering() FROM anon, authenticated, PUBLIC;

-- ─────────────────────────────────────────────────────────────────────
-- 16. Cron-functie: yearly contract-indexering (gezondheidsindex_capped)
-- ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.apply_yearly_contract_indexering(p_dry_run BOOLEAN DEFAULT FALSE)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_contract       RECORD;
  v_current_idx    NUMERIC;
  v_raw_pct        NUMERIC;
  v_capped_pct     NUMERIC;
  v_new_forfait    NUMERIC;
  v_new_flancco    NUMERIC;
  v_new_plan_fee   NUMERIC;
  v_count_processed INT := 0;
  v_count_applied   INT := 0;
  v_errors          jsonb := '[]'::jsonb;
BEGIN
  -- Huidige gezondheidsindex (maand vóór indexering = vandaag's meest recente)
  SELECT waarde INTO v_current_idx FROM public.gezondheidsindex_metingen ORDER BY jaar DESC, maand DESC LIMIT 1;

  IF v_current_idx IS NULL THEN
    RETURN jsonb_build_object('error', 'no_gezondheidsindex_available');
  END IF;

  FOR v_contract IN
    SELECT id, partner_id, forfait_bedrag, flancco_forfait_per_beurt, planning_fee_snapshot,
           indexering_start_index, indexering_min_pct, indexering_max_pct, contract_start
      FROM public.contracten
     WHERE indexering_type = 'gezondheidsindex_capped'
       AND status IN ('actief','getekend')
       AND contract_start IS NOT NULL
       AND indexering_start_index IS NOT NULL
       AND EXTRACT(MONTH FROM contract_start) = EXTRACT(MONTH FROM CURRENT_DATE)
       AND EXTRACT(DAY   FROM contract_start) = EXTRACT(DAY   FROM CURRENT_DATE)
       AND EXTRACT(YEAR  FROM contract_start) <  EXTRACT(YEAR  FROM CURRENT_DATE)
       AND (indexering_laatste_datum IS NULL OR indexering_laatste_datum <> CURRENT_DATE)
  LOOP
    v_count_processed := v_count_processed + 1;
    BEGIN
      v_raw_pct := ((v_current_idx / v_contract.indexering_start_index) - 1) * 100;
      v_capped_pct := LEAST(GREATEST(v_raw_pct, v_contract.indexering_min_pct), v_contract.indexering_max_pct);

      v_new_forfait  := ROUND(v_contract.forfait_bedrag           * (1 + v_capped_pct / 100), 2);
      v_new_flancco  := ROUND(v_contract.flancco_forfait_per_beurt * (1 + v_capped_pct / 100), 2);
      v_new_plan_fee := ROUND(v_contract.planning_fee_snapshot    * (1 + v_capped_pct / 100), 2);

      IF NOT p_dry_run THEN
        UPDATE public.contracten
           SET forfait_bedrag            = v_new_forfait,
               flancco_forfait_per_beurt = v_new_flancco,
               planning_fee_snapshot     = v_new_plan_fee,
               indexering_laatste_datum  = CURRENT_DATE
         WHERE id = v_contract.id;

        INSERT INTO public.contract_indexering_log
          (contract_id, toegepast_op, oude_forfait, nieuwe_forfait,
           oude_flancco_forfait, nieuwe_flancco_forfait, pct_toegepast,
           basis_index, toegepaste_index, uitgevoerd_door)
        VALUES
          (v_contract.id, CURRENT_DATE,
           v_contract.forfait_bedrag, v_new_forfait,
           v_contract.flancco_forfait_per_beurt, v_new_flancco,
           v_capped_pct,
           v_contract.indexering_start_index, v_current_idx,
           'cron');
      END IF;
      v_count_applied := v_count_applied + 1;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors || jsonb_build_object('contract_id', v_contract.id, 'sqlstate', SQLSTATE, 'msg', SQLERRM);
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'count_processed', v_count_processed,
    'count_applied',   v_count_applied,
    'index_used',      v_current_idx,
    'dry_run',         p_dry_run,
    'errors',          v_errors
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.apply_yearly_contract_indexering(boolean) FROM anon, authenticated, PUBLIC;

-- ─────────────────────────────────────────────────────────────────────
-- 17. Cron-functie: dispatch klant-aankondiging 14d vooraf
-- ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.dispatch_klant_indexering_aankondigingen()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_target_date     DATE := CURRENT_DATE + INTERVAL '14 days';
  v_url             text;
  v_key             text;
  v_contract        RECORD;
  v_count           INT := 0;
BEGIN
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'slot_f_supabase_url' LIMIT 1;
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'slot_f_service_role_key' LIMIT 1;

  IF v_url IS NULL OR v_key IS NULL THEN
    RETURN jsonb_build_object('error', 'vault_secrets_missing', 'target_date', v_target_date);
  END IF;

  FOR v_contract IN
    SELECT c.id
      FROM public.contracten c
     WHERE c.indexering_type = 'gezondheidsindex_capped'
       AND c.status IN ('actief','getekend')
       AND c.contract_start IS NOT NULL
       AND c.contract_start <  CURRENT_DATE
       AND EXTRACT(MONTH FROM c.contract_start) = EXTRACT(MONTH FROM v_target_date)
       AND EXTRACT(DAY   FROM c.contract_start) = EXTRACT(DAY   FROM v_target_date)
       AND NOT EXISTS (
         SELECT 1 FROM public.contract_indexering_announcements a
          WHERE a.contract_id = c.id AND a.gepland_voor_datum = v_target_date
       )
  LOOP
    BEGIN
      PERFORM net.http_post(
        url     := rtrim(v_url,'/') || '/functions/v1/send-klant-indexering-aankondiging',
        body    := jsonb_build_object('contract_id', v_contract.id, 'gepland_voor_datum', v_target_date),
        headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_key),
        timeout_milliseconds := 30000
      );
      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'dispatch_klant_indexering_aankondigingen contract % faalde (%): %', v_contract.id, SQLSTATE, SQLERRM;
    END;
  END LOOP;

  RETURN jsonb_build_object('target_date', v_target_date, 'count_dispatched', v_count);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.dispatch_klant_indexering_aankondigingen() FROM anon, authenticated, PUBLIC;

-- ─────────────────────────────────────────────────────────────────────
-- 18. pg_cron schedules (3 jobs)
-- ─────────────────────────────────────────────────────────────────────

SELECT cron.schedule(
  'apply_pricing_indexering_daily',
  '0 1 * * *',
  $$SELECT public.apply_pending_pricing_indexering();$$
);

SELECT cron.schedule(
  'apply_yearly_contract_indexering_daily',
  '30 1 * * *',
  $$SELECT public.apply_yearly_contract_indexering(FALSE);$$
);

SELECT cron.schedule(
  'dispatch_klant_indexering_aankondiging_daily',
  '0 8 * * *',
  $$SELECT public.dispatch_klant_indexering_aankondigingen();$$
);
