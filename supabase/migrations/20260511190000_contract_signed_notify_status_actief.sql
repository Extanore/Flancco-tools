-- ─── Fix: contract-signed notify-trigger checkt nu 'actief' én 'getekend' ─────
-- Calculator schrijft bij signing status='actief' (zie calculator/index.html
-- regel 4517 ~). De triggers vergeleken enkel met 'getekend', een legacy-waarde
-- die in productie nooit wordt geschreven. Resultaat: partner kreeg geen
-- bell-notification bij elke klant-signing.
--
-- Fix: beide notify-functies accepteren nu de set {'actief', 'getekend'} als
-- "signed". UPDATE-pad blijft idempotent via OLD/NEW DISTINCT-check.

CREATE OR REPLACE FUNCTION public.notify_partner_on_contract_inserted_signed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  klant_label text;
  link_path   text;
BEGIN
  -- "Signed" = status 'actief' (huidige schrijfpad) OR 'getekend' (legacy).
  -- Bij INSERT wordt enkel genotificeerd als de rij al direct als signed komt
  -- (niet als concept, dat is een werk-in-uitvoering).
  IF NEW.status IN ('actief', 'getekend') THEN
    klant_label := COALESCE(NEW.klant_naam, 'Onbekende klant');
    link_path   := '?page=contracten&preview=' || NEW.id::text;

    INSERT INTO notifications (
      partner_id, type, title, body, link_url, related_type, related_id, created_at, is_read
    ) VALUES (
      NEW.partner_id,
      'contract_getekend',
      'Nieuw getekend contract',
      klant_label || ' heeft het contract ondertekend via de calculator-link.',
      link_path,
      'contract',
      NEW.id,
      now(),
      false
    );
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.notify_partner_on_contract_signed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  klant_label text;
  link_path   text;
  v_was_signed boolean;
  v_is_signed  boolean;
BEGIN
  v_was_signed := (OLD.status IN ('actief', 'getekend'));
  v_is_signed  := (NEW.status IN ('actief', 'getekend'));

  -- Enkel notificeren bij echte transitie van non-signed → signed.
  -- Voorkomt ruis bij andere updates op een al-getekend contract (bv. status
  -- 'actief' → 'uitgevoerd' of bewerking van klant-data).
  IF v_is_signed AND NOT v_was_signed THEN
    klant_label := COALESCE(NEW.klant_naam, 'Onbekende klant');
    link_path   := '?page=contracten&preview=' || NEW.id::text;

    INSERT INTO notifications (
      partner_id, type, title, body, link_url, related_type, related_id, created_at, is_read
    ) VALUES (
      NEW.partner_id,
      'contract_getekend',
      'Nieuw getekend contract',
      klant_label || ' heeft het contract ondertekend via de calculator-link.',
      link_path,
      'contract',
      NEW.id,
      now(),
      false
    );
  END IF;
  RETURN NEW;
END;
$function$;

-- Backfill: idempotent insert voor alle bestaande signed contracten zonder
-- bijhorende notification. WHERE NOT EXISTS check via (related_id, type)
-- omdat contracten geen dedup_key gebruiken zoals partner_applications.
INSERT INTO notifications (
  partner_id, type, title, body, link_url, related_type, related_id, created_at, is_read
)
SELECT
  c.partner_id,
  'contract_getekend',
  'Nieuw getekend contract',
  COALESCE(c.klant_naam, 'Onbekende klant') || ' heeft het contract ondertekend via de calculator-link.',
  '?page=contracten&preview=' || c.id::text,
  'contract',
  c.id,
  COALESCE(c.datum_ondertekening::timestamptz, c.created_at, now()),
  false
FROM contracten c
WHERE c.status IN ('actief', 'getekend')
  AND c.partner_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM notifications n
    WHERE n.related_type = 'contract'
      AND n.related_id = c.id
      AND n.type = 'contract_getekend'
  );
