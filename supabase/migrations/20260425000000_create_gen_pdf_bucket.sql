-- =====================================================================
-- Migratie: gen-pdf storage bucket + RLS policies
-- Datum   : 2026-04-25
-- Scope   : Slot P (shared PDF-engine) — bucket waarin de generate-pdf
--           Edge Function gegenereerde documenten plaatst en signed URLs
--           voor genereert.
-- Beslissing:
--   - Privé bucket (public = false). Toegang loopt uitsluitend via signed URLs
--     gegenereerd door de Edge Function (service-role).
--   - File-size limit 5 MB; PDF is enige toegelaten MIME-type.
--   - RLS:
--       * service_role mag schrijven/lezen (zoals altijd).
--       * authenticated users mogen alleen hun eigen bestanden lezen (path
--         start met `<partner_slug>/...`); de slug-match wordt gevalideerd
--         tegen de partner_id van de user via user_roles.
--   - Geen DELETE-policy; cleanup gebeurt via een aparte cron-job die
--     bestanden ouder dan 30 dagen verwijdert (toekomstige slot).
-- =====================================================================

-- ---------------------------------------------------------------------
-- A. Bucket
-- ---------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'gen-pdf',
  'gen-pdf',
  false,
  5242880,                              -- 5 MB
  ARRAY['application/pdf']::text[]
)
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ---------------------------------------------------------------------
-- B. RLS-policies op storage.objects (scoped to bucket gen-pdf)
-- ---------------------------------------------------------------------

-- Drop bestaande policies (idempotent re-run)
DROP POLICY IF EXISTS gen_pdf_service_role_all  ON storage.objects;
DROP POLICY IF EXISTS gen_pdf_admin_select      ON storage.objects;
DROP POLICY IF EXISTS gen_pdf_partner_select    ON storage.objects;

-- B1. Service role: volledige toegang (Edge Functions schrijven via deze rol)
CREATE POLICY gen_pdf_service_role_all ON storage.objects
  FOR ALL TO service_role
  USING (bucket_id = 'gen-pdf')
  WITH CHECK (bucket_id = 'gen-pdf');

-- B2. Admins kunnen alle bestanden in de bucket lezen
CREATE POLICY gen_pdf_admin_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'gen-pdf'
    AND EXISTS (
      SELECT 1 FROM user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role = 'admin'
    )
  );

-- B3. Partners kunnen alleen bestanden lezen onder hun eigen slug-prefix
--     (path-vorm: '<partner_slug>/<YYYY-MM-DD>/<filename>.pdf')
CREATE POLICY gen_pdf_partner_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'gen-pdf'
    AND EXISTS (
      SELECT 1
      FROM user_roles ur
      JOIN partners p ON p.id = ur.partner_id
      WHERE ur.user_id = auth.uid()
        AND ur.role IN ('partner', 'bediende')
        AND split_part(name, '/', 1) = p.slug
    )
  );

-- ---------------------------------------------------------------------
-- C. Documentatie
-- ---------------------------------------------------------------------
COMMENT ON POLICY gen_pdf_service_role_all  ON storage.objects IS
  'gen-pdf bucket: service role (Edge Function) volledige toegang.';
COMMENT ON POLICY gen_pdf_admin_select      ON storage.objects IS
  'gen-pdf bucket: admins lezen alle bestanden.';
COMMENT ON POLICY gen_pdf_partner_select    ON storage.objects IS
  'gen-pdf bucket: partners + bedienden lezen alleen hun eigen partner-slug-prefix.';
