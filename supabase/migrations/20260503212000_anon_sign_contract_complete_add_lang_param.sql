-- Bug-fix: anon_sign_contract_complete had 2 overloads in DB (5-arg en 6-arg met
-- p_signing_ip), maar frontend stuurt sinds Slot S ook p_lang mee. Geen overload
-- accepteert p_lang → PostgREST kan geen matching function vinden → contract-signing
-- faalt met "Ondertekenen mislukt" voor élke remote-signing flow.
--
-- Fix: drop beide overloads, create unified V3 met alle 7 params incl. p_lang.
-- p_lang wordt gepersisteerd op contracten.lang (whitelisted nl|fr, fallback nl)
-- als ground-truth voor outbound communicatie (PDF, mail, etc).

DROP FUNCTION IF EXISTS public.anon_sign_contract_complete(uuid, text, text, text, jsonb);
DROP FUNCTION IF EXISTS public.anon_sign_contract_complete(uuid, text, text, text, jsonb, text);

CREATE OR REPLACE FUNCTION public.anon_sign_contract_complete(
  p_token uuid,
  p_handtekening_url text DEFAULT NULL,
  p_handtekening_data text DEFAULT NULL,
  p_signing_user_agent text DEFAULT NULL,
  p_signing_ip text DEFAULT NULL,
  p_client_payload jsonb DEFAULT NULL,
  p_lang text DEFAULT 'nl'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_contract_id uuid;
  v_partner_id  uuid;
  v_client_id   uuid;
  v_email       text;
  v_lang        text;
BEGIN
  IF p_token IS NULL THEN
    RAISE EXCEPTION 'token_required';
  END IF;

  -- Whitelist lang: enkel nl/fr toegelaten, anders fallback nl
  v_lang := CASE WHEN lower(coalesce(p_lang, 'nl')) IN ('nl','fr') THEN lower(p_lang) ELSE 'nl' END;

  -- Vind contract via token. Sluit reeds-getekende, verlopen en niet-bestaande tokens uit.
  SELECT id, partner_id
    INTO v_contract_id, v_partner_id
  FROM contracten
  WHERE teken_token = p_token
    AND status = 'concept'
    AND (verlopen_op IS NULL OR verlopen_op >= CURRENT_DATE)
  LIMIT 1;

  IF v_contract_id IS NULL THEN
    RAISE EXCEPTION 'contract_not_signable';
  END IF;

  -- Optioneel: maak/hergebruik klant-record
  IF p_client_payload IS NOT NULL
     AND (p_client_payload ? 'contact_person')
     AND length(coalesce(p_client_payload->>'contact_person','')) > 0 THEN

    v_email := nullif(p_client_payload->>'email','');

    -- Eerst kijken of er al een client bestaat voor deze partner+email.
    -- idx_clients_partner_lower_email is een UNIQUE partial index op
    -- (partner_id, lower(email)) WHERE email IS NOT NULL AND email <> ''.
    IF v_email IS NOT NULL THEN
      SELECT id
        INTO v_client_id
      FROM clients
      WHERE partner_id = v_partner_id
        AND lower(email) = lower(v_email)
      LIMIT 1;
    END IF;

    -- Geen bestaande match → insert nieuwe klant
    IF v_client_id IS NULL THEN
      INSERT INTO clients (
        partner_id,
        contact_person,
        email,
        phone,
        street,
        postal_code,
        city,
        notes
      )
      VALUES (
        v_partner_id,
        nullif(p_client_payload->>'contact_person',''),
        v_email,
        nullif(p_client_payload->>'phone',''),
        nullif(p_client_payload->>'street',''),
        nullif(p_client_payload->>'postal_code',''),
        nullif(p_client_payload->>'city',''),
        coalesce(nullif(p_client_payload->>'notes',''), 'Aangemaakt bij contractondertekening')
      )
      RETURNING id INTO v_client_id;
    END IF;
  END IF;

  -- Atomic update: enkel whitelisted signing-kolommen + lang.
  UPDATE contracten
     SET status              = 'actief',
         handtekening_url    = p_handtekening_url,
         handtekening_data   = CASE WHEN p_handtekening_url IS NULL THEN p_handtekening_data ELSE NULL END,
         datum_ondertekening = CURRENT_DATE,
         signing_user_agent  = p_signing_user_agent,
         signing_timestamp   = now(),
         signing_methode     = 'op_afstand',
         signing_ip          = p_signing_ip,
         akkoord_voorwaarden = TRUE,
         privacy_akkoord     = TRUE,
         client_id           = COALESCE(v_client_id, client_id),
         lang                = v_lang
   WHERE id = v_contract_id;

  RETURN jsonb_build_object(
    'contract_id', v_contract_id,
    'client_id',   v_client_id,
    'signed_at',   now(),
    'lang',        v_lang
  );
END;
$$;

COMMENT ON FUNCTION public.anon_sign_contract_complete(uuid, text, text, text, text, jsonb, text) IS
  'Slot S unified V3: signing-RPC met p_lang param voor taal-persistentie. Whitelist nl|fr. Vorige overloads (5 + 6 arg) gedropt om PostgREST overload-confusion te elimineren.';
