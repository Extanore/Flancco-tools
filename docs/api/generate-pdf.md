# API contract — `generate-pdf`

Single edge function that renders branded PDF documents and returns a signed URL.

- **Method**: `POST`
- **URL**: `https://dhuqpxwwavqyxaelxuzl.supabase.co/functions/v1/generate-pdf`
- **Content-Type**: `application/json`

## Request schema

```jsonc
{
  "template":     "werkplanning | rapport_branded | contract_signed | facturatie_overzicht",  // required
  "data":         { /* template-specific object */ },                                          // required
  "partner_slug": "novectra",                                                                  // optional, default = Flancco
  "lang":         "nl | fr"                                                                    // optional, default = "nl"
}
```

JSON-Schema (informal):

```json
{
  "type": "object",
  "required": ["template", "data"],
  "properties": {
    "template": {
      "type": "string",
      "enum": ["werkplanning", "rapport_branded", "contract_signed", "facturatie_overzicht"]
    },
    "data": { "type": "object" },
    "partner_slug": { "type": "string", "pattern": "^[a-z0-9-]{1,64}$" },
    "lang": { "type": "string", "enum": ["nl", "fr"] }
  },
  "additionalProperties": false
}
```

Body size is capped at **256 KB** by default (`GEN_PDF_MAX_PAYLOAD_BYTES`).
Larger requests are rejected with `413`.

## Authentication

| Template | JWT required | Acceptable roles |
|---|---|---|
| `werkplanning` | no | n/a — endpoint is public so techniciens can pull their own daily PDF |
| `rapport_branded` | yes | `admin`, `partner`, `bediende` |
| `contract_signed` | yes | `admin`, `partner`, `bediende` |
| `facturatie_overzicht` | yes | `admin`, `partner`, `bediende` |

Partners can only generate documents for **their own** `partner_slug`. Admin
overrides this.

> Even though `werkplanning` is public, requests still need the Supabase
> anonymous `apikey` header (this is a Supabase Edge Functions requirement).

## Response 200

```jsonc
{
  "success":      true,
  "template":     "werkplanning",
  "partner_slug": "novectra",
  "lang":         "nl",
  "url":          "https://…/storage/v1/object/sign/gen-pdf/novectra/2026-04-25/werkplanning-<uuid>.pdf?token=...",
  "path":         "novectra/2026-04-25/werkplanning-<uuid>.pdf",
  "expires_at":   "2026-05-02T09:14:22.014Z",
  "bytes":        23184
}
```

### Field semantics

| Field | Meaning |
|---|---|
| `url` | Signed URL with TTL = `GEN_PDF_SIGNED_URL_TTL_SECONDS` (default 7 days). Single fetch is fine; sharing is intentional. |
| `path` | Bucket path for re-signing later (`partner_slug/YYYY-MM-DD/…`). |
| `expires_at` | ISO timestamp at which the signed URL stops working. |
| `bytes` | Size of the generated PDF in bytes. |

## Error codes

| HTTP | `error` | Cause | Resolution |
|---|---|---|---|
| 400 | `Body must be valid JSON` | malformed body | fix the JSON |
| 400 | `Body must be a JSON object` | array / primitive sent | wrap in `{}` |
| 400 | `template is required and must be one of: …` | unknown / missing template | use a registered template |
| 400 | `data is required and must be an object` | data missing or not an object | provide `data` |
| 400 | `data.<field> is required` | template-specific validator failed | check template docs |
| 400 | `partner_slug must match [a-z0-9-]{1,64}` | invalid slug format | sanitize input |
| 401 | `Valid Authorization header required` | template requires JWT but header missing | add `Authorization: Bearer <jwt>` |
| 401 | `Insufficient role for this template` | role outside admin/partner/bediende | escalate role or use a different account |
| 401 | `Partner cannot generate documents for another partner` | partner JWT used with foreign slug | use admin or correct slug |
| 405 | `method_not_allowed` | non-POST request | use POST |
| 413 | `payload exceeds <N> bytes` | body too large | shrink payload or raise `GEN_PDF_MAX_PAYLOAD_BYTES` |
| 429 | `rate_limited` | per-IP cap (default 30/min) | back off (`Retry-After` header included) |
| 500 | `internal_error` | render or storage failure | check edge logs by `event=pdf_error` |

## Template payloads

### `werkplanning`

```jsonc
{
  "datum": "2026-05-12",                         // required, YYYY-MM-DD
  "technieker_naam": "Jens De Vos",              // required
  "technieker_telefoon": "+32 470 12 34 56",     // optional
  "algemene_opmerking": "Materiaal is op…",      // optional
  "beurten": [                                   // ordered server-side by start time
    {
      "id": "uuid",                              // optional reference
      "klant_naam": "Familie Janssens",          // required
      "klant_adres": "Dorpsstraat 12",           // optional
      "klant_postcode": "9080",                  // optional
      "klant_gemeente": "Lochristi",             // optional
      "klant_telefoon": "+32 9 …",               // optional
      "tijd_slot": "08:00 – 10:00",              // optional, free-form
      "start_tijd": "08:00",                     // optional
      "eind_tijd": "10:00",                      // optional
      "scope_samenvatting": "Reiniging panelen", // optional
      "special_instructions": "Hond aanwezig",   // optional, rendered in accent color
      "aantal_panelen": 18,                      // optional
      "sector": "zon",                           // optional, slug — labels: zon|warmtepomp|ventilatie|verwarming|airco
      "geschatte_duur_min": 90                   // optional
    }
  ]
}
```

### `rapport_branded` (stub — Slot C3)

```jsonc
{ "beurt_id": "uuid", "klant_naam": "Familie Janssens", "datum": "2026-05-12" }
```

Returns a 1-page placeholder with the partner header. C3 will define the full
schema.

### `contract_signed` (stub — Slot O2)

```jsonc
{ "contract_id": "uuid", "contract_nummer": "FLA-2026-0042", "klant_naam": "…" }
```

### `facturatie_overzicht` (stub — Slot D)

```jsonc
{ "periode_van": "2026-04-01", "periode_tot": "2026-04-30", "partner_id": "uuid" }
```

## Logging contract

Structured JSON, no PII (no `klant_naam`, no email, no full IP). Fields:

| Field | Always present | Notes |
|---|---|---|
| `event` | yes | `pdf_generated` \| `pdf_rejected` \| `pdf_error` \| `rate_limited` |
| `template` | when known | template id |
| `partner_slug` | when known | sanitized |
| `status` | yes | HTTP status code |
| `duration_ms` | yes | end-to-end render + upload latency |
| `error` | on 4xx/5xx | sanitized, ≤ 200 chars |
| `ip_hash` | yes | first 4 bytes of SHA-256 of IP — for rate-limit debugging without storing the full IP |
| `ts` | yes | ISO timestamp |

## Versioning

The endpoint is v1. Breaking changes (new required fields, removed templates,
changed response keys) require a v2 endpoint deployed alongside the existing
one. Adding new templates or new optional `data` fields is not breaking.
