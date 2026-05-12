-- Security audit follow-up — 2026-05-13
-- Adresseert audit-issue M5: anon kon contracten ondertekenen met 1-byte
-- handtekening. CHECK-constraint enforced minimum-lengte op signing-velden.
--
-- Drempel: 500 bytes ≈ minimum geloofwaardige PNG (50x50px met enkele lijnen).
-- Echte handtekeningen zijn typisch 2000-15000 bytes. 500 bytes is een veilige
-- ondergrens die fake "lege" submissions blokkeert zonder echte signatures te
-- raken.

-- ─────────────────────────────────────────────────────────────────────
-- contracten.handtekening_data — lengte-check bij status='actief'/'getekend'
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.contracten
  DROP CONSTRAINT IF EXISTS chk_contracten_handtekening_min_length;

ALTER TABLE public.contracten
  ADD CONSTRAINT chk_contracten_handtekening_min_length
  CHECK (
    status NOT IN ('actief','getekend')
    OR handtekening_url IS NOT NULL
    OR (handtekening_data IS NOT NULL AND length(handtekening_data) >= 500)
  );

COMMENT ON CONSTRAINT chk_contracten_handtekening_min_length ON public.contracten IS
  'Audit-fix 2026-05-13: blokkeert fake "getekend" contracten met 1-byte handtekening. Bij status=actief/getekend moet er ofwel handtekening_url zijn (uploaded PNG) ofwel handtekening_data van min. 500 bytes (canvas-base64).';

-- ─────────────────────────────────────────────────────────────────────
-- partner_applications.contract_handtekening_base64 — RPC heeft al >= 100,
-- ophogen naar >= 500 voor consistency
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.partner_applications
  DROP CONSTRAINT IF EXISTS chk_partner_app_handtekening_min_length;

ALTER TABLE public.partner_applications
  ADD CONSTRAINT chk_partner_app_handtekening_min_length
  CHECK (
    status NOT IN ('contract_signed','account_created','live')
    OR contract_handtekening_base64 IS NOT NULL AND length(contract_handtekening_base64) >= 500
  );

COMMENT ON CONSTRAINT chk_partner_app_handtekening_min_length ON public.partner_applications IS
  'Audit-fix 2026-05-13: minimum-lengte 500 bytes voor handtekening bij signed-status. Consistent met contracten-tabel; voorheen enforced de RPC >= 100 wat te laag was.';
