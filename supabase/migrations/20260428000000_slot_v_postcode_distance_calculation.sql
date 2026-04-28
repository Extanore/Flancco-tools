-- Slot V — Server-side afstandsberekening tussen partner en klant
-- ─────────────────────────────────────────────────────────────────────
-- Reden: het `afstand`-veld in de calculator was vrij invulbaar door de
-- eindklant — onbetrouwbaar (manipulatie van transport-supplement) en
-- foutgevoelig. De afstand is een prijs-driver (transport_supplement
-- per km via supplements-config) en moet dus afgeleid worden uit
-- objectieve data: partner-vestigingsadres ↔ klant-postcode.
--
-- Architectuur:
--   1. `postcodes_geo` — coords-cache (postcode + land → lat/lng)
--      Geseed met partner-postcodes + grootste BE-steden voor v1
--      coverage. Onbekende postcodes worden later via een Edge Function
--      (geocode-postcode) on-demand gegeocodeerd via Nominatim/Mapbox.
--   2. `anon_calculate_distance_km(partner_id, klant_postcode, klant_land)`
--      — SECURITY DEFINER RPC, anon-callable, doet haversine × 1.3
--      (routing-correctie hemelsbreed → wegafstand) en rondt af.
--      Returnt NULL als één van beide coords ontbreekt.
--
-- Privacy: postcode-coords zijn publieke geo-data, geen PII. Tabel is
-- public-readable; alleen service_role kan schrijven (geocoding-cache).

-- ─────────────────────────────────────────────────────────────────────
-- 1. postcodes_geo — coords-cache
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.postcodes_geo (
  postcode    text        NOT NULL,
  land        text        NOT NULL CHECK (land IN ('BE','NL')),
  lat         numeric(9,6) NOT NULL,
  lng         numeric(9,6) NOT NULL,
  source      text        NOT NULL DEFAULT 'manual'
                          CHECK (source IN ('manual','nominatim','mapbox','google')),
  geocoded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (postcode, land)
);

COMMENT ON TABLE public.postcodes_geo IS
  'Slot V — Coords-cache (lat/lng) per postcode + land voor afstandsberekening calculator. Manueel geseed of via geocoding Edge Function.';

-- RLS: anon mag SELECT (nodig voor calculator-RPC met security_invoker
-- alternatieven), schrijven alleen via service_role (geocoding cache).
ALTER TABLE public.postcodes_geo ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "postcodes_geo_select_all" ON public.postcodes_geo;
CREATE POLICY "postcodes_geo_select_all" ON public.postcodes_geo
  FOR SELECT
  TO anon, authenticated
  USING (true);

GRANT SELECT ON public.postcodes_geo TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- 2. RPC anon_calculate_distance_km
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.anon_calculate_distance_km(
  p_partner_id     uuid,
  p_klant_postcode text,
  p_klant_land     text DEFAULT 'BE'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_partner_postcode text;
  v_partner_land     text;
  v_p_lat numeric; v_p_lng numeric;
  v_k_lat numeric; v_k_lng numeric;
  v_d_km  numeric;
BEGIN
  -- Defensief: input normaliseren (Nederlandse postcodes kunnen "4536 HL"
  -- zijn — we matchen op de eerste 4 cijfers).
  p_klant_postcode := regexp_replace(coalesce(p_klant_postcode, ''), '\s.*$', '');
  p_klant_land     := upper(coalesce(nullif(p_klant_land, ''), 'BE'));

  IF p_klant_postcode = '' THEN RETURN NULL; END IF;

  -- Partner-postcode + land
  SELECT regexp_replace(coalesce(postcode, ''), '\s.*$', ''),
         upper(coalesce(land, 'BE'))
    INTO v_partner_postcode, v_partner_land
  FROM public.partners
  WHERE id = p_partner_id;

  IF v_partner_postcode IS NULL OR v_partner_postcode = '' THEN
    RETURN NULL;
  END IF;

  -- Coords ophalen
  SELECT lat, lng INTO v_p_lat, v_p_lng
  FROM public.postcodes_geo
  WHERE postcode = v_partner_postcode AND land = v_partner_land;

  IF v_p_lat IS NULL THEN RETURN NULL; END IF;

  SELECT lat, lng INTO v_k_lat, v_k_lng
  FROM public.postcodes_geo
  WHERE postcode = p_klant_postcode AND land = p_klant_land;

  IF v_k_lat IS NULL THEN RETURN NULL; END IF;

  -- Haversine (km) × 1.3 routing-correctie (hemelsbreed → wegafstand,
  -- empirische factor voor BE/NL infrastructuur). Round half-up.
  v_d_km := 6371 * 2 * asin(sqrt(
      sin(radians((v_k_lat - v_p_lat) / 2)) ^ 2
    + cos(radians(v_p_lat)) * cos(radians(v_k_lat)) *
      sin(radians((v_k_lng - v_p_lng) / 2)) ^ 2
  ));

  RETURN GREATEST(0, round(v_d_km * 1.3)::integer);
END;
$$;

COMMENT ON FUNCTION public.anon_calculate_distance_km(uuid, text, text) IS
  'Slot V — Afstand partner↔klant in km (haversine × 1.3 routing-correctie). NULL als één van beide coords onbekend is.';

GRANT EXECUTE ON FUNCTION public.anon_calculate_distance_km(uuid, text, text)
  TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- 3. Seed — partner-vestigingen + grootste BE-postcodes
--    Coords zijn centroid-benadering per postcode (publieke open data).
--    NL-coverage beperkt tot partner Novectra; uitbreiding via geocoding
--    Edge Function in v2.
-- ─────────────────────────────────────────────────────────────────────
INSERT INTO public.postcodes_geo (postcode, land, lat, lng, source) VALUES
  -- Partner-vestigingen
  ('9940', 'BE', 51.108300, 3.688900, 'manual'),  -- Evergem (CW Solar)
  ('9080', 'BE', 51.097800, 3.826600, 'manual'),  -- Lochristi (Flancco / Beervelde)
  ('4536', 'NL', 51.335500, 3.826700, 'manual'),  -- Terneuzen (Novectra)
  -- Brussels Hoofdstedelijk Gewest
  ('1000', 'BE', 50.850300, 4.351700, 'manual'),  -- Brussel
  ('1030', 'BE', 50.867600, 4.378100, 'manual'),  -- Schaarbeek
  ('1050', 'BE', 50.827600, 4.371900, 'manual'),  -- Elsene
  ('1070', 'BE', 50.834300, 4.310200, 'manual'),  -- Anderlecht
  ('1080', 'BE', 50.855600, 4.329400, 'manual'),  -- Sint-Jans-Molenbeek
  ('1180', 'BE', 50.798800, 4.339700, 'manual'),  -- Ukkel
  ('1190', 'BE', 50.812800, 4.330000, 'manual'),  -- Vorst
  ('1200', 'BE', 50.844700, 4.426400, 'manual'),  -- Sint-Lambrechts-Woluwe
  -- Antwerpen
  ('2000', 'BE', 51.219400, 4.402500, 'manual'),  -- Antwerpen centrum
  ('2018', 'BE', 51.207000, 4.418000, 'manual'),  -- Antwerpen Zuid
  ('2020', 'BE', 51.190000, 4.385000, 'manual'),  -- Antwerpen Kiel
  ('2030', 'BE', 51.270000, 4.380000, 'manual'),  -- Antwerpen Luchtbal
  ('2060', 'BE', 51.230000, 4.422000, 'manual'),  -- Antwerpen Noord
  ('2100', 'BE', 51.244400, 4.475000, 'manual'),  -- Deurne
  ('2140', 'BE', 51.218300, 4.435000, 'manual'),  -- Borgerhout
  ('2170', 'BE', 51.270000, 4.483000, 'manual'),  -- Merksem
  ('2200', 'BE', 51.182700, 4.832300, 'manual'),  -- Herentals
  ('2300', 'BE', 51.323900, 4.939200, 'manual'),  -- Turnhout
  ('2500', 'BE', 51.156100, 4.484200, 'manual'),  -- Lier
  ('2600', 'BE', 51.196700, 4.428900, 'manual'),  -- Berchem
  ('2800', 'BE', 51.027800, 4.477200, 'manual'),  -- Mechelen
  ('2900', 'BE', 51.275800, 4.499200, 'manual'),  -- Schoten
  -- Vlaams-Brabant
  ('3000', 'BE', 50.879800, 4.700500, 'manual'),  -- Leuven
  ('3300', 'BE', 50.793100, 4.962200, 'manual'),  -- Tienen
  ('3500', 'BE', 50.930600, 5.338100, 'manual'),  -- Hasselt
  ('3600', 'BE', 50.967200, 5.486700, 'manual'),  -- Genk
  ('3700', 'BE', 50.762200, 5.408300, 'manual'),  -- Tongeren
  ('3800', 'BE', 50.778900, 5.211400, 'manual'),  -- Sint-Truiden
  ('3900', 'BE', 51.236100, 5.475000, 'manual'),  -- Pelt
  -- Luik / Namen / Henegouwen
  ('4000', 'BE', 50.632600, 5.579700, 'manual'),  -- Luik
  ('4500', 'BE', 50.547500, 5.211900, 'manual'),  -- Hoei
  ('4800', 'BE', 50.408000, 6.013000, 'manual'),  -- Verviers
  ('5000', 'BE', 50.467400, 4.871800, 'manual'),  -- Namen
  ('6000', 'BE', 50.410800, 4.444600, 'manual'),  -- Charleroi
  ('6700', 'BE', 49.683300, 5.815300, 'manual'),  -- Aarlen
  ('7000', 'BE', 50.454200, 3.956000, 'manual'),  -- Bergen
  ('7500', 'BE', 50.611100, 3.388900, 'manual'),  -- Doornik
  -- West-Vlaanderen
  ('8000', 'BE', 51.209300, 3.224700, 'manual'),  -- Brugge
  ('8200', 'BE', 51.201700, 3.194700, 'manual'),  -- Sint-Andries (Brugge)
  ('8300', 'BE', 51.330600, 3.275000, 'manual'),  -- Knokke-Heist
  ('8400', 'BE', 51.224700, 2.911100, 'manual'),  -- Oostende
  ('8500', 'BE', 50.828100, 3.264900, 'manual'),  -- Kortrijk
  ('8600', 'BE', 51.043900, 2.880600, 'manual'),  -- Diksmuide
  ('8700', 'BE', 51.000000, 3.116700, 'manual'),  -- Tielt
  ('8800', 'BE', 50.940700, 3.130600, 'manual'),  -- Roeselare
  ('8900', 'BE', 50.850000, 2.883300, 'manual'),  -- Ieper
  -- Oost-Vlaanderen
  ('9000', 'BE', 51.054300, 3.717400, 'manual'),  -- Gent
  ('9030', 'BE', 51.073900, 3.671900, 'manual'),  -- Mariakerke
  ('9040', 'BE', 51.082800, 3.762800, 'manual'),  -- Sint-Amandsberg
  ('9050', 'BE', 51.034400, 3.752800, 'manual'),  -- Gentbrugge / Ledeberg
  ('9100', 'BE', 51.164700, 4.137800, 'manual'),  -- Sint-Niklaas
  ('9200', 'BE', 51.039900, 4.037900, 'manual'),  -- Dendermonde
  ('9300', 'BE', 50.940800, 4.035600, 'manual'),  -- Aalst
  ('9400', 'BE', 50.876900, 3.985300, 'manual'),  -- Ninove
  ('9500', 'BE', 50.770000, 3.900000, 'manual'),  -- Geraardsbergen
  ('9600', 'BE', 50.783300, 3.600000, 'manual'),  -- Ronse
  ('9700', 'BE', 50.854200, 3.609200, 'manual'),  -- Oudenaarde
  ('9800', 'BE', 50.972200, 3.511100, 'manual'),  -- Deinze
  ('9900', 'BE', 51.080900, 3.521100, 'manual'),  -- Eeklo
  ('9970', 'BE', 51.250000, 3.520000, 'manual')   -- Kaprijke
ON CONFLICT (postcode, land) DO NOTHING;

-- PostgREST schema-cache reload
NOTIFY pgrst, 'reload schema';
