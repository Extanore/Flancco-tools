# generate-pdf — Slot P (shared PDF-engine)

Single Supabase Edge Function that renders any platform PDF using
[`pdf-lib`](https://pdf-lib.js.org/) (Deno-compatible via `esm.sh`), uploads the
result to a private Storage bucket, and returns a signed URL with a 7-day TTL.

> Why one shared function? Branding loading, partner-resolution, auth-checks,
> rate-limiting, logging, storage-upload and signed-URL generation are identical
> for every PDF. Centralising them avoids the drift visible between
> `send-confirmation` and `send-contract-link` (each re-implements CORS,
> error-shapes, helpers).

## Endpoint

```
POST https://dhuqpxwwavqyxaelxuzl.supabase.co/functions/v1/generate-pdf
```

## Request

```jsonc
{
  "template": "werkplanning",            // required, see registry below
  "partner_slug": "novectra",            // optional; loads branding from `partners`
  "lang": "nl",                          // optional, "nl" | "fr" — defaults to "nl"
  "data": { /* template-specific payload */ }
}
```

Headers:

| Header | Required | Notes |
|---|---|---|
| `Content-Type: application/json` | yes | |
| `Authorization: Bearer <jwt>` | depends on template | required for every template **except** `werkplanning` |
| `Origin` | recommended | must match an entry in the `ALLOWED_ORIGINS` env var |

## Response (200)

```json
{
  "success": true,
  "template": "werkplanning",
  "partner_slug": "novectra",
  "lang": "nl",
  "url": "https://dhuqpxwwavqyxaelxuzl.supabase.co/storage/v1/object/sign/gen-pdf/novectra/2026-04-25/werkplanning-<uuid>.pdf?token=...",
  "path": "novectra/2026-04-25/werkplanning-<uuid>.pdf",
  "expires_at": "2026-05-02T09:14:22.014Z",
  "bytes": 23184
}
```

## Error responses

| HTTP | `error` body | When |
|---|---|---|
| 400 | `"template is required and must be one of: …"` | unknown / missing template |
| 400 | `"data.<field> is required"` | template-specific validation failed |
| 401 | `"Valid Authorization header required"` | template requires auth + JWT missing/invalid |
| 401 | `"Insufficient role for this template"` | role is not admin / partner / bediende |
| 401 | `"Partner cannot generate documents for another partner"` | partner JWT used with another slug |
| 405 | `"method_not_allowed"` | non-`POST` request |
| 413 | `"payload exceeds <N> bytes"` | body exceeds `GEN_PDF_MAX_PAYLOAD_BYTES` (default 256 KB) |
| 429 | `"rate_limited"` | per-IP limit hit (default 30/min) — `Retry-After` header included |
| 500 | `"internal_error"` | server-side render or storage failure (details only in logs) |

Stack traces are never returned to the client; full context is in structured
logs (see below).

## Template registry

| `template` | Auth required | Status | Owner slot | Filename prefix |
|---|---|---|---|---|
| `werkplanning` | no  | implemented (A4 portrait, multi-page) | P (this slot) | `werkplanning-<uuid>.pdf` |
| `rapport_branded`     | yes | stub — partner header only       | C3 | `rapport-<uuid>.pdf` |
| `contract_signed`     | yes | stub — partner header only       | O2 | `contract-<uuid>.pdf` |
| `facturatie_overzicht`| yes | stub — partner header only       | D  | `facturatie-<uuid>.pdf` |

The dispatcher lives in `index.ts` → `renderTemplate()`. Adding a template means:

1. Create `templates/<name>.ts` exporting `render<Name>(data, branding, lang): Promise<Uint8Array>`.
2. Register it in the `TEMPLATES` map in `index.ts`.
3. Add a coercer (typed validator) similar to `coerceWerkplanning` if the data shape is non-trivial.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `SUPABASE_URL` | (required)  | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | (required) | For Storage + DB access |
| `SUPABASE_ANON_KEY` | (required for authed templates) | Used to validate JWTs via `auth.getUser` |
| `ALLOWED_ORIGINS` | `https://app.flancco-platform.be,…` | CSV whitelist; first value is the fallback `Access-Control-Allow-Origin` |
| `GEN_PDF_BUCKET` | `gen-pdf` | Bucket name (must exist; see migration) |
| `GEN_PDF_SIGNED_URL_TTL_SECONDS` | `604800` (7 days) | Signed URL TTL |
| `GEN_PDF_RATE_LIMIT_PER_MIN` | `30` | Per-IP cap |
| `GEN_PDF_MAX_PAYLOAD_BYTES` | `262144` (256 KB) | Reject larger bodies with 413 |
| `GEN_PDF_LOGO_FETCH_TIMEOUT_MS` | `3000` | Abort logo fetch after this |
| `GEN_PDF_LOGO_MAX_BYTES` | `102400` (100 KB) | Reject larger logos silently |

`verify_jwt` must be set to **`false`** in `supabase/config.toml` for this
function (auth is handled per-template inside the handler so `werkplanning`
remains callable from techniciens without a session).

## Logging

All log lines are structured JSON, **without PII**. No `klant_naam`, no email,
no full IP. Example:

```json
{ "event": "pdf_generated", "template": "werkplanning", "partner_slug": "novectra",
  "status": 200, "duration_ms": 412, "ip_hash": "a13f", "ts": "2026-04-25T09:14:22.014Z" }
```

Events emitted:

- `pdf_generated` — success
- `pdf_rejected` — 4xx (validation, auth, payload, rate-limit)
- `pdf_error` — 5xx (storage / render failure)
- `rate_limited` — request blocked before validation

## Example invocations

### Werkplanning (public — no auth)

```bash
curl -X POST https://dhuqpxwwavqyxaelxuzl.supabase.co/functions/v1/generate-pdf \
  -H "Content-Type: application/json" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -d '{
    "template": "werkplanning",
    "partner_slug": "novectra",
    "lang": "nl",
    "data": {
      "datum": "2026-05-12",
      "technieker_naam": "Jens De Vos",
      "technieker_telefoon": "+32 470 12 34 56",
      "beurten": [
        {
          "klant_naam": "Familie Janssens",
          "klant_adres": "Dorpsstraat 12",
          "klant_postcode": "9080",
          "klant_gemeente": "Lochristi",
          "klant_telefoon": "+32 9 123 45 67",
          "tijd_slot": "08:00 – 10:00",
          "sector": "zon",
          "aantal_panelen": 18,
          "geschatte_duur_min": 90,
          "scope_samenvatting": "Reiniging zonnepanelen + kontrole bevestigingen",
          "special_instructions": "Hond aanwezig — even bellen voor aankomst."
        }
      ]
    }
  }'
```

### Rapport (admin / partner — auth required)

```bash
curl -X POST https://dhuqpxwwavqyxaelxuzl.supabase.co/functions/v1/generate-pdf \
  -H "Content-Type: application/json" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $USER_JWT" \
  -d '{
    "template": "rapport_branded",
    "partner_slug": "novectra",
    "data": { "klant_naam": "Familie Janssens", "beurt_id": "..." }
  }'
```

## Local development

```bash
supabase functions serve generate-pdf --env-file .env.local --no-verify-jwt
```

Send the request to `http://localhost:54321/functions/v1/generate-pdf`.

## Future migration: Cloudflare Browser Rendering

For the rapport template (Slot C3) we may need richer typography (web fonts,
tables, embedded photos) than `pdf-lib` ergonomically supports. Plan:

1. Stand up a Cloudflare Worker with [Browser Rendering](https://developers.cloudflare.com/browser-rendering/).
2. Render an HTML template → PDF via headless Chrome.
3. Replace the `renderRapportBranded` body with a `fetch()` to that Worker; the
   rest of this function (auth, branding, storage, signed URL) remains.

That migration is out of scope for Slot P.
