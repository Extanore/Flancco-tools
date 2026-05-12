-- ============================================================
-- Klant-aankondiging contract-indexering (14 dagen vooraf)
-- ============================================================
-- Stuurt elke klant 14 dagen vóór zijn contract-verjaardag een mail
-- met preview van de nieuwe prijzen. De preview gebruikt de op dat
-- moment laatste bekende gezondheidsindex; de finale berekening op
-- de verjaardag zelf kan licht afwijken indien er een nieuwere
-- meting binnenkomt. Dat is conform de contractclausule.
--
-- Architectuur:
--   pg_cron (08:00 UTC daily)
--     → public.dispatch_klant_indexering_aankondigingen()
--       → bouwt set contract-ids waarvan verjaardag binnen 14 dagen valt
--         en (contract_id, gepland_voor_datum) nog niet in
--         contract_indexering_announcements zit
--       → per contract: POST naar send-klant-indexering-aankondiging
--         (1 pg_net.http_post per contract, async; antwoorden via net._http_response)
--       → INSERT in contract_indexering_announcements (gateway-claim) zodat
--         dezelfde verjaardag niet 14 dagen lang opnieuw afgevuurd wordt.
--
-- Idempotentie: UNIQUE (contract_id, gepland_voor_datum). De INSERT vóór de
-- http_post (i.p.v. erna) sluit race conditions uit; bij Resend-failure
-- detecteert de edge function dat en kan admin manueel resenden.
--
-- Cron: 08:00 UTC ('0 8 * * *'). Job-naam: dispatch_klant_indexering_aankondiging_daily.
--
-- Vault-secrets (gedeeld met Slot F):
--   slot_f_supabase_url, slot_f_service_role_key
-- ============================================================

-- ----------------------------------------------------------------
-- 1. NIEUWE TABEL — contract_indexering_announcements
-- ----------------------------------------------------------------
-- Audit + idempotency-gateway: 1 rij per (contract_id, gepland_voor_datum).
-- gepland_voor_datum = de contract-verjaardag waarvoor de aankondiging
-- bedoeld is (= CURRENT_DATE + 14 op moment van dispatch).
CREATE TABLE IF NOT EXISTS public.contract_indexering_announcements (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id          uuid NOT NULL REFERENCES public.contracten(id) ON DELETE CASCADE,
  gepland_voor_datum   date NOT NULL,
  verzonden_op         timestamptz,
  recipient            text,
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped')),
  error_detail         text,
  provider_message_id  text,
  created_at           timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT contract_indexering_announcements_uniq
    UNIQUE (contract_id, gepland_voor_datum)
);

COMMENT ON TABLE public.contract_indexering_announcements
  IS 'Audit + idempotency-gateway voor klant-aankondiging contract-indexering. Eén rij per (contract, verjaardag) — voorkomt dubbele mails.';
COMMENT ON COLUMN public.contract_indexering_announcements.gepland_voor_datum
  IS 'De contract-verjaardag waarvoor de aankondiging bestemd is (datum waarop indexering effectief wordt).';

CREATE INDEX IF NOT EXISTS idx_contract_indexering_ann_status_datum
  ON public.contract_indexering_announcements (status, gepland_voor_datum DESC);

-- RLS: admin full, partner SELECT eigen contracten
ALTER TABLE public.contract_indexering_announcements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contract_indexering_ann_admin_all ON public.contract_indexering_announcements;
CREATE POLICY contract_indexering_ann_admin_all
  ON public.contract_indexering_announcements
  FOR ALL
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.user_roles ur
            WHERE ur.user_id = (SELECT auth.uid()) AND ur.role IN ('admin','bediende'))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.user_roles ur
            WHERE ur.user_id = (SELECT auth.uid()) AND ur.role IN ('admin','bediende'))
  );

DROP POLICY IF EXISTS contract_indexering_ann_partner_select ON public.contract_indexering_announcements;
CREATE POLICY contract_indexering_ann_partner_select
  ON public.contract_indexering_announcements
  FOR SELECT
  TO authenticated
  USING (
    contract_id IN (
      SELECT c.id FROM public.contracten c
       WHERE c.partner_id IN (
         SELECT ur.partner_id FROM public.user_roles ur
          WHERE ur.user_id = (SELECT auth.uid())
            AND ur.role = 'partner'
            AND ur.partner_id IS NOT NULL
       )
    )
  );

REVOKE ALL ON public.contract_indexering_announcements FROM anon;
REVOKE ALL ON public.contract_indexering_announcements FROM authenticated;
GRANT SELECT ON public.contract_indexering_announcements TO authenticated;

-- ----------------------------------------------------------------
-- 2. SQL HELPER — dispatch_klant_indexering_aankondigingen
-- ----------------------------------------------------------------
-- Selecteert contracten waarvan de eerstvolgende verjaardag (= dezelfde
-- maand+dag in CURRENT_DATE-jaar, of volgend jaar als al voorbij) precies
-- 14 dagen weg ligt. Voor elk contract claimt de tabel-rij idempotent
-- en POST-t naar de edge function.
CREATE OR REPLACE FUNCTION public.dispatch_klant_indexering_aankondigingen()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_url            text;
  v_key            text;
  v_target_date    date := CURRENT_DATE + 14;
  v_contract       RECORD;
  v_request_id     bigint;
  v_count_dispatched int := 0;
  v_count_skipped    int := 0;
  v_count_failed     int := 0;
BEGIN
  -- Vault-secrets ophalen (gedeeld met Slot F dispatcher).
  SELECT decrypted_secret INTO v_url
    FROM vault.decrypted_secrets WHERE name = 'slot_f_supabase_url' LIMIT 1;
  SELECT decrypted_secret INTO v_key
    FROM vault.decrypted_secrets WHERE name = 'slot_f_service_role_key' LIMIT 1;

  IF v_url IS NULL OR v_key IS NULL THEN
    RAISE WARNING 'dispatch_klant_indexering_aankondigingen: vault-secrets ontbreken — skip cron run.';
    RETURN jsonb_build_object('error', 'vault_secrets_missing');
  END IF;

  -- Loop over eligible contracten: contract-verjaardag = today + 14
  FOR v_contract IN
    SELECT
      c.id, c.partner_id, c.contract_start,
      -- bouw target_anniversary: dezelfde maand+dag in CURRENT_DATE-jaar of volgend jaar
      (MAKE_DATE(
        CASE
          WHEN MAKE_DATE(EXTRACT(YEAR FROM CURRENT_DATE)::int,
                         EXTRACT(MONTH FROM c.contract_start)::int,
                         EXTRACT(DAY FROM c.contract_start)::int) >= CURRENT_DATE
          THEN EXTRACT(YEAR FROM CURRENT_DATE)::int
          ELSE EXTRACT(YEAR FROM CURRENT_DATE)::int + 1
        END,
        EXTRACT(MONTH FROM c.contract_start)::int,
        EXTRACT(DAY   FROM c.contract_start)::int
      )) AS target_anniversary
      FROM public.contracten c
     WHERE c.indexering_type = 'gezondheidsindex_capped'
       AND c.status IN ('actief','getekend')
       AND c.contract_start IS NOT NULL
       AND c.indexering_start_index IS NOT NULL
       AND c.klant_email IS NOT NULL
       AND c.contract_start < CURRENT_DATE  -- contract moet al lopen, niet eerste-jaar
  LOOP
    -- Skip als de verjaardag niet exact today+14 is
    IF v_contract.target_anniversary <> v_target_date THEN
      CONTINUE;
    END IF;

    -- Idempotency-claim. Bij conflict (al verzonden of in flight) → skip.
    BEGIN
      INSERT INTO public.contract_indexering_announcements
        (contract_id, gepland_voor_datum, status)
      VALUES
        (v_contract.id, v_target_date, 'pending');
    EXCEPTION WHEN unique_violation THEN
      v_count_skipped := v_count_skipped + 1;
      CONTINUE;
    END;

    -- Async POST naar edge function. Failure → log + status=failed in edge fn.
    BEGIN
      v_request_id := net.http_post(
        url     := rtrim(v_url, '/') || '/functions/v1/send-klant-indexering-aankondiging',
        body    := jsonb_build_object(
          'contract_id', v_contract.id,
          'gepland_voor_datum', v_target_date,
          'source', 'pg_cron'
        ),
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'Authorization', 'Bearer ' || v_key
        ),
        timeout_milliseconds := 20000
      );
      v_count_dispatched := v_count_dispatched + 1;
    EXCEPTION WHEN OTHERS THEN
      v_count_failed := v_count_failed + 1;
      UPDATE public.contract_indexering_announcements
         SET status = 'failed',
             error_detail = SQLERRM
       WHERE contract_id = v_contract.id
         AND gepland_voor_datum = v_target_date;
      RAISE WARNING 'dispatch_klant_indexering_aankondigingen: contract_id=% http_post failed: % %', v_contract.id, SQLSTATE, SQLERRM;
    END;
  END LOOP;

  RAISE NOTICE 'dispatch_klant_indexering_aankondigingen: target=% dispatched=% skipped=% failed=%',
    v_target_date, v_count_dispatched, v_count_skipped, v_count_failed;

  RETURN jsonb_build_object(
    'target_date', v_target_date,
    'count_dispatched', v_count_dispatched,
    'count_skipped',    v_count_skipped,
    'count_failed',     v_count_failed
  );
END;
$$;

COMMENT ON FUNCTION public.dispatch_klant_indexering_aankondigingen()
  IS 'Cron-entrypoint: triggert klant-aankondiging voor contracten met verjaardag binnen 14 dagen. POST naar send-klant-indexering-aankondiging via pg_net.';

REVOKE ALL ON FUNCTION public.dispatch_klant_indexering_aankondigingen() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dispatch_klant_indexering_aankondigingen() FROM anon;
REVOKE ALL ON FUNCTION public.dispatch_klant_indexering_aankondigingen() FROM authenticated;

-- ----------------------------------------------------------------
-- 3. PG_CRON JOB — 08:00 UTC dagelijks
-- ----------------------------------------------------------------
DO $$
DECLARE
  v_existing_jobid bigint;
BEGIN
  SELECT jobid INTO v_existing_jobid FROM cron.job WHERE jobname = 'dispatch_klant_indexering_aankondiging_daily';
  IF v_existing_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_existing_jobid);
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'dispatch_klant_indexering_aankondiging_daily unschedule fout: %', SQLERRM;
END $$;

SELECT cron.schedule(
  'dispatch_klant_indexering_aankondiging_daily',
  '0 8 * * *',
  $$SELECT public.dispatch_klant_indexering_aankondigingen();$$
);

-- ----------------------------------------------------------------
-- ROLLBACK (handmatig)
-- ----------------------------------------------------------------
-- SELECT cron.unschedule((SELECT jobid FROM cron.job WHERE jobname='dispatch_klant_indexering_aankondiging_daily'));
-- DROP FUNCTION IF EXISTS public.dispatch_klant_indexering_aankondigingen();
-- DROP TABLE IF EXISTS public.contract_indexering_announcements;
