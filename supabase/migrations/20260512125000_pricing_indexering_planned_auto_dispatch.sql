-- Auto-dispatch partner-aankondiging bij INSERT in pricing_indexering_planned.
-- Volgt zelfde pattern als slot_f_klant_dispatch: SECURITY DEFINER helper +
-- pg_net.http_post via Vault-secrets. Trigger fires alleen bij INSERT met
-- aangekondigd_op IS NOT NULL (= definitief gepland, niet draft).

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

  SELECT decrypted_secret INTO v_url
    FROM vault.decrypted_secrets WHERE name = 'slot_f_supabase_url' LIMIT 1;
  SELECT decrypted_secret INTO v_key
    FROM vault.decrypted_secrets WHERE name = 'slot_f_service_role_key' LIMIT 1;

  IF v_url IS NULL OR v_key IS NULL THEN
    RAISE WARNING 'fn_pricing_indexering_dispatch_partner_mail: vault-secrets ontbreken — skip mail voor planned %', p_planned_id;
    RETURN -1;
  END IF;

  BEGIN
    v_request_id := net.http_post(
      url     := rtrim(v_url, '/') || '/functions/v1/send-partner-indexering-aankondiging',
      body    := jsonb_build_object('planned_indexering_id', p_planned_id),
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || v_key
      ),
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

COMMENT ON FUNCTION public.fn_pricing_indexering_dispatch_partner_mail(uuid) IS
  'Roept send-partner-indexering-aankondiging edge function aan via pg_net + Vault-secrets. Vuur enkel via AFTER INSERT trigger op pricing_indexering_planned.';

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

COMMENT ON TRIGGER trg_pricing_indexering_planned_dispatch ON public.pricing_indexering_planned IS
  'Stuurt automatisch partner-aankondigingsmail bij INSERT met aangekondigd_op gezet. Defensief: fout in mail-pad rolt INSERT niet terug (EXCEPTION block in helper).';
