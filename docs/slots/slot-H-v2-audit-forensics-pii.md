# Slot H v2 — Audit-log forensische trail + GDPR-PII-redactie

**Datum**: 2026-04-25
**Status**: Live
**Migratie**: `supabase/migrations/20260425180000_slot_h_v2_audit_pii_forensics.sql`
**Plan-ref**: `valiant-petting-pretzel.md` Cluster 2 → Slot H

---

## Intent

Sluit de spec-gap tussen de oorspronkelijke `audit_log`-implementatie (commit `f8d1474`, pre-plan, Apr 23) en de plan-spec uit `valiant-petting-pretzel.md` Slot H:

1. **Forensische trail**: voeg `ip` + `user_agent` toe — vereist voor incidentonderzoek, klacht-verdediging en compliance-audits.
2. **GDPR-PII-redactie**: filter klant-PII uit `oude_waarde`/`nieuwe_waarde` zodat deze velden enkel veldnamen + types/lengtes bevatten, geen klant-data zelf. Audit-log valt onder de **7-jarige boekhoudkundige bewaarplicht** en kan dus niet selectief gepurged worden — daarom moeten we PII bij de bron tegenhouden.

## Files-touched

| File | Wijziging |
|---|---|
| `supabase/migrations/20260425180000_slot_h_v2_audit_pii_forensics.sql` | NEW — kolommen + index + trigger + COMMENT-statements |
| `admin/index.html` | NEW helpers `AUDIT_PII_KEYS`, `_auditMaskValue`, `_auditRedactPii`, `_auditSerializeSnapshot`, `_auditUserAgentShort`. `auditLog()` gewrapt. Audit-tabel + CSV-export uitgebreid met Bron-kolom (IP/UA). |
| `CLAUDE.md` | NEW `audit_log` entry onder **Database Tabellen** met v2 schema-doc. |
| `docs/slots/slot-H-v2-audit-forensics-pii.md` | NEW — dit runbook. |

## DB-changes

```sql
ALTER TABLE public.audit_log
  ADD COLUMN IF NOT EXISTS ip         INET,
  ADD COLUMN IF NOT EXISTS user_agent TEXT;

CREATE INDEX IF NOT EXISTS audit_log_ip_idx
  ON public.audit_log (ip)
  WHERE ip IS NOT NULL;
```

Plus `audit_log_stamp_request_meta()` trigger-functie (geen `SECURITY DEFINER` — leest enkel session-GUC en muteert `NEW`) + `BEFORE INSERT` trigger `trg_audit_log_stamp_request_meta`.

## Trigger-architectuur — waarom server-side stempelen

| Optie | Voor- | Nadelen |
|---|---|---|
| **Client-side** (JS doet `fetch('/ip')`) | Eenvoudig zichtbaar | Brittle: blokkeerbaar door extensies, IP kan worden gespoofd in payload, vereist extra round-trip |
| **Edge function tussenschakel** | Volledig auditeerbaar | Extra latency + extra failure-mode op iedere audit-call |
| **DB-trigger** (gekozen) | Onomzeilbaar voor PostgREST-clients, zero round-trip, geen client-spoofing-vector | NULL voor service-role/pg_cron (geen `request.headers` GUC) — bewust gekozen als correcte system-vs-end-user-onderscheiding |

Header-volgorde in trigger: **cf-connecting-ip → x-forwarded-for first hop → x-real-ip**. Eerste match wint. Malformed IP → fail-safe NULL i.p.v. trigger-reject.

## PII-redactie — design

**Filosofie**: whitelist van bekende PII-veldnamen (`AUDIT_PII_KEYS` Set). Bij twijfel maskeren.

**Type-behoud**:
- `boolean` → onveranderd (consent-flag, actief-flag — geen PII)
- `number` → `[REDACTED:num]`
- `string` → `[REDACTED:str:<lengte>]` (lengte-hint voor zinvolle diff)
- `array` → `[REDACTED:arr:<count>]`
- `object` → `[REDACTED:obj]`

**Whitelist-categorieën** (lowercased compare):
- Identiteit: `email`, `naam`, `voornaam`, `klant_naam`, `contactpersoon`, `bedrijfsnaam`, `btw_nummer`, `rijksregisternummer`
- Telefoon: `telefoon`, `gsm`, `mobiel`, `phone`, `phone_number`, `recipient_phone`
- Adres: `adres`, `straat`, `huisnummer`, `bus`, `postcode`, `gemeente`, `stad`
- Vertrouwelijk: `handtekening`, `signature`, `notitie`, `opmerking`, `bericht`, `instructies`
- Auth-secrets (mogen NOOIT in audit): `token`, `opt_out_token`, `access_token`, `refresh_token`, `jwt`, `password`, `wachtwoord`

**Niet gemaskeerd** (business-relevante diff blijft werken):
`status`, `marge_pct`, `planning_fee`, `contractduur`, `aantal_panelen`, `frequentie`, `actief`, `kleur_*`, etc.

**Scalar string passthrough**: `auditLog(..., 'ingepland', 'uitgevoerd')` → status-strings worden niet geparsed als JSON, blijven raw. Geen PII per definitie.

## Verificatie (post-deploy smoketest)

```sql
-- 1. Schema verificatie
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema='public' AND table_name='audit_log' AND column_name IN ('ip','user_agent');
-- Verwacht: ip=inet, user_agent=text

-- 2. Trigger verificatie
SELECT tgname FROM pg_trigger WHERE tgrelid='public.audit_log'::regclass AND NOT tgisinternal;
-- Verwacht: trg_audit_log_stamp_request_meta

-- 3. Index verificatie
SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='audit_log' AND indexname='audit_log_ip_idx';
-- Verwacht: audit_log_ip_idx

-- 4. Trigger fail-safe smoketest (SQL-sessie zonder PostgREST headers)
INSERT INTO public.audit_log (tabel, record_id, actie, oude_waarde, nieuwe_waarde, user_id)
VALUES ('_smoke', gen_random_uuid(), 'test', NULL, '{"smoke":true}', NULL)
RETURNING ip, user_agent;
-- Verwacht: ip=NULL, user_agent=NULL (geen request.headers in psql-context)
DELETE FROM public.audit_log WHERE tabel='_smoke';
```

**End-to-end verificatie (live admin)**:
1. Login als admin → ga naar Audit-log
2. Bewerk een partner of contract
3. Refresh audit-log → nieuwe rij moet IP + UA tonen in Bron-kolom
4. Open Volledige JSON → controleer dat geen email/naam/adres letterlijk verschijnt (alle PII is `[REDACTED:str:<len>]`)
5. CSV-export → controleer kolommen `ip` + `user_agent` aanwezig

## Backward-compatibility

- **Bestaande audit-rows**: `ip` + `user_agent` blijven NULL — gerendered als `systeem` (correcte interpretatie: pre-v2 hadden we geen forensische capture).
- **Bestaande audit-call-sites**: alle `auditLog()`-callers blijven werken zonder code-wijziging. De nieuwe redactie wordt automatisch toegepast door `_auditSerializeSnapshot`.
- **CSV-importeurs/parsers**: header krijgt 2 nieuwe kolommen (`ip`, `user_agent`) tussen `record_id` en `oude_waarde`. Downstream-tooling die op kolomvolgorde leest, moet aangepast — momenteel geen externe consumers.

## Rollback-procedure

```sql
-- Kolommen behouden voor data-bewaring; trigger droppen om stempel te stoppen.
DROP TRIGGER IF EXISTS trg_audit_log_stamp_request_meta ON public.audit_log;
DROP FUNCTION IF EXISTS public.audit_log_stamp_request_meta();
DROP INDEX IF EXISTS public.audit_log_ip_idx;
-- Kolommen ip/user_agent NIET droppen — historische data behouden voor compliance.
```

Frontend-rollback: `git revert <commit-sha>` en deploy. Pre-existing audit-rows blijven `ip`/`user_agent`-data behouden, gewoon niet meer gerenderd.

## Open bekommernissen / TODO-v3

- **IPv6-handling in `_auditUserAgentShort`**: lengte-test op `ua.slice(0,32)` is byte-based; kan multibyte-emoji breken. Niet-blocking — UA's bevatten zelden multibyte chars.
- **Geo-IP enrichment**: zou nuttig zijn voor "uitvoerder vanuit Brussel/Antwerpen/buitenland" patroon-detectie. Vereist external GeoIP-service — buiten scope v2.
- **Retention-policy automatisering**: 7-jarige bewaarplicht is wettelijk — geen automatische purge. Manuele review na 7 jaar voor selectieve archive.
- **`audit_log` RLS-check**: bestaat policy? Niet onderzocht in v2 — pre-bestaande in commit `f8d1474`. Volgende slot-review: `get_advisors security` op deze tabel.
