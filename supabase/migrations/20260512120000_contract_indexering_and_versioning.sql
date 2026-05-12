-- Contract indexering + versionering — fundamentele schema-uitbreiding
-- voor de prijsaanpassings-architectuur (Route 3 + Optie Z hybride).
--
-- Decisions:
--  - Eindklant-contract krijgt jaarlijkse indexering op basis van Belgische
--    gezondheidsindex met hybride cap (min 1.5% / max 4% per jaar)
--  - Flancco-forfait per contract wordt bevroren bij signing en volgt
--    diezelfde indexering automatisch (snapshot kolommen + jaarlijkse update)
--  - Contract-template versionering zodat we juridisch kunnen reproduceren
--    welke tekst een partner/klant getekend heeft
--
-- Geen backfill nodig: vandaag 0 contracten in productie.

-- ─────────────────────────────────────────────────────────────────────
-- 1. Contract-template versionering
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.partner_applications
  ADD COLUMN IF NOT EXISTS contract_template_versie TEXT NULL;

COMMENT ON COLUMN public.partner_applications.contract_template_versie IS
  'Versie-string van het partner-contract template op moment van signing (bv. v1.1-2026-05). Juridische traceerbaarheid.';

ALTER TABLE public.contracten
  ADD COLUMN IF NOT EXISTS contract_template_versie TEXT NULL;

COMMENT ON COLUMN public.contracten.contract_template_versie IS
  'Versie-string van het eindklant-contract template op moment van signing (bv. v2.0-2026-05). Juridische traceerbaarheid.';

-- ─────────────────────────────────────────────────────────────────────
-- 2. Snapshot-kolommen voor Flancco-portie (partner-settlement)
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.contracten
  ADD COLUMN IF NOT EXISTS flancco_forfait_per_beurt NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS marge_pct_snapshot NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS planning_fee_snapshot NUMERIC NULL;

COMMENT ON COLUMN public.contracten.flancco_forfait_per_beurt IS
  'Snapshot van Flancco-forfait per beurt op signing-moment. Wat partner aan Flancco verschuldigd is. Volgt jaarlijkse indexering.';
COMMENT ON COLUMN public.contracten.marge_pct_snapshot IS
  'Snapshot van partner.marge_pct op signing-moment. Consistency-check + audit.';
COMMENT ON COLUMN public.contracten.planning_fee_snapshot IS
  'Snapshot van partner.planning_fee op signing-moment. Volgt jaarlijkse indexering.';

-- ─────────────────────────────────────────────────────────────────────
-- 3. Indexerings-kolommen op eindklant-contract
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.contracten
  ADD COLUMN IF NOT EXISTS indexering_type TEXT NOT NULL DEFAULT 'gezondheidsindex_capped',
  ADD COLUMN IF NOT EXISTS indexering_min_pct NUMERIC NOT NULL DEFAULT 1.5,
  ADD COLUMN IF NOT EXISTS indexering_max_pct NUMERIC NOT NULL DEFAULT 4.0,
  ADD COLUMN IF NOT EXISTS indexering_start_index NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS indexering_laatste_datum DATE NULL;

ALTER TABLE public.contracten
  ADD CONSTRAINT chk_contracten_indexering_type
    CHECK (indexering_type IN ('gezondheidsindex_capped','vast_pct','geen'));

ALTER TABLE public.contracten
  ADD CONSTRAINT chk_contracten_indexering_cap_consistent
    CHECK (indexering_min_pct <= indexering_max_pct);

COMMENT ON COLUMN public.contracten.indexering_type IS
  'Indexerings-formule. gezondheidsindex_capped = BE gezondheidsindex met min/max cap (default).';
COMMENT ON COLUMN public.contracten.indexering_min_pct IS
  'Minimum jaarlijkse indexering in procent (default 1.5). Bescherming bij lage inflatie.';
COMMENT ON COLUMN public.contracten.indexering_max_pct IS
  'Maximum jaarlijkse indexering in procent (default 4.0). Bescherming klant tegen hoge inflatie.';
COMMENT ON COLUMN public.contracten.indexering_start_index IS
  'Gezondheidsindex-waarde op signing-datum (van FOD Economie). Wordt manueel ingevuld of opgehaald via API.';
COMMENT ON COLUMN public.contracten.indexering_laatste_datum IS
  'Datum van laatste toegepaste indexering. NULL = nog nooit geïndexeerd.';

-- ─────────────────────────────────────────────────────────────────────
-- 4. Audit-log tabel voor contract-indexering
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.contract_indexering_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES public.contracten(id) ON DELETE CASCADE,
  toegepast_op DATE NOT NULL,
  oude_forfait NUMERIC NOT NULL,
  nieuwe_forfait NUMERIC NOT NULL,
  oude_flancco_forfait NUMERIC NULL,
  nieuwe_flancco_forfait NUMERIC NULL,
  pct_toegepast NUMERIC NOT NULL,
  basis_index NUMERIC NULL,
  toegepaste_index NUMERIC NULL,
  klant_aankondiging_verzonden_op TIMESTAMPTZ NULL,
  partner_aankondiging_verzonden_op TIMESTAMPTZ NULL,
  uitgevoerd_door TEXT NOT NULL DEFAULT 'cron',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contract_indexering_log_contract
  ON public.contract_indexering_log(contract_id, toegepast_op DESC);

COMMENT ON TABLE public.contract_indexering_log IS
  'Append-only audit-trail van elke jaarlijkse indexering per contract. Juridische verdediging + transparantie naar klant en partner.';

-- RLS policies — admin full, partner SELECT eigen contracten, anon nothing
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
-- 5. Pricing.partner_id nullable maken (Optie Z — Flancco-basis + overrides)
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.pricing
  ALTER COLUMN partner_id DROP NOT NULL;

COMMENT ON COLUMN public.pricing.partner_id IS
  'NULL = Flancco-basistarief (fallback voor alle partners). Niet-NULL = partner-specifieke override.';

-- Partial unique index voor basis-rijen: per sector + staffel mag er maar 1 basis-rij bestaan
CREATE UNIQUE INDEX IF NOT EXISTS uq_pricing_basis_per_sector_staffel
  ON public.pricing(sector, staffel_min, staffel_max, COALESCE(subtype,''), COALESCE(parameter_key,''))
  WHERE partner_id IS NULL;

-- ─────────────────────────────────────────────────────────────────────
-- 6. Geplande indexering tabel (voor Flancco-basisprijs aanpassingen)
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.pricing_indexering_planned (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  effective_date DATE NOT NULL,
  pct_increase NUMERIC NOT NULL,
  scope_sectoren TEXT[] NULL,
  reden TEXT NULL,
  aangekondigd_op TIMESTAMPTZ NULL,
  applied_at TIMESTAMPTZ NULL,
  cancelled_at TIMESTAMPTZ NULL,
  aangemaakt_door UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_indexering_eff_future CHECK (
    -- Bij creatie: effective_date moet minstens 30 dagen in de toekomst zijn
    -- (juridische aankondigingstermijn). Wordt enkel gevalideerd bij INSERT, niet
    -- bij UPDATE (anders kunnen we nooit applied_at zetten).
    created_at IS NULL OR effective_date >= (created_at::date + INTERVAL '30 days')
  )
);

CREATE INDEX IF NOT EXISTS idx_pricing_indexering_planned_eff
  ON public.pricing_indexering_planned(effective_date)
  WHERE applied_at IS NULL AND cancelled_at IS NULL;

COMMENT ON TABLE public.pricing_indexering_planned IS
  'Geplande indexeringen van Flancco-basisprijzen. Effective_date moet minstens 30 dagen in toekomst (contractueel verplichte aankondigingstermijn). Scope_sectoren NULL = alle sectoren.';

-- RLS — admin only
ALTER TABLE public.pricing_indexering_planned ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pricing_indexering_planned_admin_all ON public.pricing_indexering_planned;
CREATE POLICY pricing_indexering_planned_admin_all
  ON public.pricing_indexering_planned FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());
