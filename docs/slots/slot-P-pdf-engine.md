# Slot P — Shared PDF-engine

## Intent

One Supabase Edge Function (`generate-pdf`) renders every PDF document the
platform produces — werkplanning today, branded rapport / signed contract /
facturatie-overzicht in later slots. Branding loading, partner-resolution,
auth-checks, rate-limiting, structured logging, storage upload, and signed-URL
generation are centralised so subsequent slots only have to write a layout.

## Architecture choice

**`pdf-lib` via esm.sh on the Deno-based Edge Runtime.**

| Option | Verdict | Why |
|---|---|---|
| `pdf-lib` | **chosen** | Already proven in `_shared/herroeping.ts`. Pure JS, no native deps, no headless browser. Generates A4 documents in ~50–500 ms. Standard fonts (Helvetica family) are sufficient for werkplanning, contract, facturatie. |
| Puppeteer / headless Chromium | rejected | Unreliable on Supabase Edge (Deno). Cold-start cost. Heavy memory. |
| Cloudflare Browser Rendering | deferred | Right tool for the eventual rapport-template (rich typography, web fonts, tables, photos). Plan: stand up a separate Worker, swap only the `renderRapportBranded` body to call it. Out of scope for this slot. |
| Server-side React-PDF | rejected | Adds a build step and tooling; the codebase is intentionally vanilla. |

Practical limits of the chosen stack — documented up-front so later slots plan
around them:

- Standard Helvetica fonts only (WinAnsi). Non-WinAnsi characters are
  silently stripped by `sanitize()` in `templates/_shared.ts`. To embed e.g. a
  custom brand font we'd need to ship a TTF + use `pdf-lib`'s `embedFont` —
  doable but adds binary weight.
- Complex tables (variable row heights, column-spanning) require manual layout
  — fine for werkplanning's row-based design, painful for facturatie spreadsheets.
- Logos > 100 KB are rejected by the loader to keep PDFs under the 5 MB bucket
  cap; partners with heavier logos should optimise first.

## Files touched (created)

| Path | Purpose |
|---|---|
| `supabase/functions/generate-pdf/index.ts` | HTTP handler — CORS, validation, auth, rate-limit, dispatch, upload, signed URL |
| `supabase/functions/generate-pdf/templates/_shared.ts` | pdf-lib utilities: branding type, header/footer drawers, formatters, color helpers, sanitisation |
| `supabase/functions/generate-pdf/templates/werkplanning.ts` | Werkplanning per-dag/per-tech (real implementation) |
| `supabase/functions/generate-pdf/templates/rapport_branded.ts` | Stub — Slot C3 plugs in |
| `supabase/functions/generate-pdf/templates/contract_signed.ts` | Stub — Slot O2 plugs in |
| `supabase/functions/generate-pdf/templates/facturatie_overzicht.ts` | Stub — Slot D plugs in |
| `supabase/functions/generate-pdf/README.md` | Function-level docs (env, registry, examples) |
| `supabase/migrations/20260425000000_create_gen_pdf_bucket.sql` | Storage bucket + RLS |
| `docs/api/generate-pdf.md` | API contract (JSON schemas, errors, payloads) |
| `docs/slots/slot-P-pdf-engine.md` | This document |

No other files were modified.

## Deployment steps

1. **Apply the migration** (from a machine with `supabase` CLI configured):

   ```bash
   supabase db push
   ```

   Verify the bucket exists and is private:

   ```sql
   SELECT id, name, public, file_size_limit
   FROM storage.buckets
   WHERE id = 'gen-pdf';
   ```

2. **Configure `verify_jwt = false` for the function** so `werkplanning` can be
   called by techniciens without a session. Add the following to
   `supabase/config.toml` (file is not under version control yet — create it if
   missing):

   ```toml
   [functions.generate-pdf]
   verify_jwt = false
   ```

   Auth is enforced **inside** the handler for the templates that need it.

3. **Set environment variables** (Supabase dashboard → Edge Functions → secrets):

   | Name | Required | Default |
   |---|---|---|
   | `SUPABASE_URL` | yes | — |
   | `SUPABASE_SERVICE_ROLE_KEY` | yes | — |
   | `SUPABASE_ANON_KEY` | yes (for authed templates) | — |
   | `ALLOWED_ORIGINS` | recommended | productie-domeinen ingebakken |
   | `GEN_PDF_BUCKET` | optional | `gen-pdf` |
   | `GEN_PDF_SIGNED_URL_TTL_SECONDS` | optional | `604800` |
   | `GEN_PDF_RATE_LIMIT_PER_MIN` | optional | `30` |
   | `GEN_PDF_MAX_PAYLOAD_BYTES` | optional | `262144` |
   | `GEN_PDF_LOGO_FETCH_TIMEOUT_MS` | optional | `3000` |
   | `GEN_PDF_LOGO_MAX_BYTES` | optional | `102400` |

4. **Deploy the function**:

   ```bash
   supabase functions deploy generate-pdf --no-verify-jwt
   ```

   The `--no-verify-jwt` mirrors the `config.toml` setting.

5. **Smoke test** with the curl example from
   [`supabase/functions/generate-pdf/README.md`](../../supabase/functions/generate-pdf/README.md#example-invocations)
   pointing at `partner_slug=novectra`. Expected:
   - HTTP 200
   - `url` resolves to a downloadable PDF
   - structured log line `event=pdf_generated`

## Rollback procedure

The function is additive (no existing data touched, no other functions
modified), so rollback is non-destructive:

1. **Disable the function** (preferred over delete, keeps logs):

   ```bash
   supabase functions delete generate-pdf
   ```

   Or temporarily set the function to return `503` by deploying a no-op stub.

2. **Optional: drop the bucket** only if no documents have been generated yet.
   Otherwise leave it — orphaned PDFs cost ~nothing and signed URLs auto-expire:

   ```sql
   -- Only run if you're sure nothing in the bucket is referenced anywhere.
   DELETE FROM storage.objects WHERE bucket_id = 'gen-pdf';
   DELETE FROM storage.buckets WHERE id = 'gen-pdf';
   ```

3. **Revert RLS policies** (the migration is idempotent so re-running
   `supabase db reset` on a non-prod environment is safe; in prod use the
   `DROP POLICY` statements at the top of the migration file).

No client / HTML code calls this endpoint yet, so there is **no app-side
rollback**. Later slots that integrate the endpoint must add their own
fallbacks (e.g. werkplanning UI keeps a "print page" option).

## Known limitations

- **Fonts**: Helvetica family only. Brand custom fonts not supported until we
  ship a TTF + `embedFont` change.
- **Logos**: PNG / JPEG only, ≤ 100 KB. SVG logos must be pre-rendered to PNG.
- **Tables**: simple row layouts only — no column-spanning or auto-fit. The
  facturatie template (Slot D) may need to either go landscape or move to
  Browser Rendering.
- **Cold-start rate-limit**: in-memory per-IP counter resets when the worker
  cold-starts. Acceptable at expected volumes (< 1k PDF/day platform-wide). If
  abuse is observed, swap for a Supabase-table-backed counter or front the
  function with a Cloudflare WAF rule.
- **Signed-URL TTL**: 7 days. Embed `path` in your application state if you
  need to re-sign later — do not assume the URL is permanent.
- **No automatic cleanup**: the bucket grows indefinitely. A future slot must
  add a daily cron that prunes objects older than 30 days (Supabase cron job
  on `storage.objects` filtered by `bucket_id = 'gen-pdf'`).

## Open follow-ups

- Add a Supabase scheduled job to prune `gen-pdf` objects > 30 days old.
- Bench Helvetica vs an embedded TTF for the rapport template once C3 design
  is locked.
- Consider a `webhook_url` field in the request body so the function can POST
  the signed URL to a caller-supplied endpoint instead of returning it
  inline — useful for batch generation (facturatie month-end).
