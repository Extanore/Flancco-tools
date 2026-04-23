# Flancco Platform — Openstaande Backlog

**Laatst bijgewerkt**: 2026-04-23
**Status**: multi-sector architectuur + operationele features grotendeels geïmplementeerd. Dit document beschrijft enkel nog wat écht openstaat. Voor de volledige historiek zie git log en `CLAUDE.md`.

**Scope-beslissing**: op 2026-04-23 per item afgestemd met Gillian. Geschrapt: weekcapaciteit-enforcement, contract-sharing tussen partners, verdienste-overzicht portal. Behouden: 6 items in 2 sprints.

---

## 1. Wat is al gebouwd (niet meer opnieuw plannen)

Volledig geaudit op 2026-04-23. De volgende capaciteiten zijn productieklaar aanwezig:

### Multi-sector calculator
- Universele template `/calculator/?partner={slug}` (3.827 regels) vervangt legacy `/novectra/`, `/cwsolar/`, `/flancco/` — die zijn nu 4-regel redirects
- Vier kernsectoren operationeel: zonnepanelen, warmtepomp (3 subtypes: lucht-lucht, lucht-water, geothermie-water), ventilatie, verwarming — plus IC, klussen, airco
- Stap 0 sector-selector, combinatiecontracten met per-sector breakdown + grand total
- Dynamische pricing uit Supabase per partner+sector (geen hardcoded TIERS meer)
- Handtekening upload naar Storage-bucket `handtekeningen` (geen base64 in DB)
- Doorlopende contractnummering (`contract_nummer`)
- Herroepingsclausule + privacy-checkbox + 6% BTW verklaring op eer
- Seizoenslogica: `seizoenMaanden` per sector + `eersteSeizoensDatum()` correct toegepast vóór RPC-insert

### Database
- `contracten` bevat `sector`, `sector_details` (JSONB), `contract_nummer`, `signing_user_agent`, `signing_timestamp`, `signing_methode`, `handtekening_url`, `privacy_akkoord`, `herroeping_verstreken`
- `pricing` + `supplementen` met `sector`-kolom
- `contract_regels`, `onderhoudsbeurten`, `partner_sectors`, `rapporten`, `interventies`, `interventie_berichten`
- `techniekers`, `technieker_sectoren`, `technieker_afwezigheden`
- `voertuigen`, `voertuig_kosten`, `voertuig_km_log`
- `klant_delingen` (klant-sharing met permission levels)
- `audit_log` (beperkt, zie openstaand item hieronder)

### Admin dashboard
- Partners, contracten, pricing per sector, klanten, forecast, facturatie, personeel, wagenpark, interventies, rapporten, notificaties, verlof, uren, gebruikers, admin-instellingen
- Rol-systeem via body-class (`role-admin`, `role-partner`, `role-technieker`) + permission gates (`admin-only`, `not-technieker`, `.perm-*`)
- Partner branding (logo, kleuren) met boot-cache voor zero-flash bij recurring logins
- CSV-import voor klanten (12 kolommen, dedup op BTW+email)
- GDPR cascade-delete klant (contracten + beurten + rapporten + foto's + interventies + installaties + locaties)

### Planning + Rapport
- `/admin/planning.html` (8.229 regels) — weekview met technieker-lanes, drag-drop inplannen, per-dag per-technieker capaciteitsvalidatie, duo-beurten
- `/admin/rapport.html` (2.563 regels) — checklist per sector, foto-upload per categorie, PDF-generatie client-side
- Onderhoudsbeurten status-flow: toekomstig → in_te_plannen → ingepland → uitgevoerd
- Interventie-registratie in rapport-wizard met email-notificatie partner
- Interventie-chat (`interventie_berichten`) tussen admin en partner met bestand-uploads

### Verloopwaarschuwingen + notificaties
- Voertuig-keuring + voertuig-verzekering verval-notificaties (`checkVoertuigVervalNotificaties`)
- In-app notificatie-systeem met badges en auto-expand op bestemming

---

## 2. Openstaande backlog — 6 items

### Sprint 1 — Juridische hardening (1-2 dagen totaal)

#### 1.1 `signing_ip` opslaan op contract-signing
**Probleem**: bij contractondertekening worden `signing_user_agent`, `signing_timestamp` en `signing_methode` opgeslagen, maar het IP-adres niet. Juridisch zwakker bij betwisting van de elektronische handtekening.

**Scope**:
- Externe IP detecteren via `https://api.ipify.org?format=json` (of Supabase Edge Function met `x-forwarded-for` uitlezen)
- Toevoegen aan contract-insert payload in `calculator/index.html`
- Kolom `signing_ip text` bestaat mogelijk al in schema; verifiëren, anders `ALTER TABLE contracten ADD COLUMN signing_ip text`

**Raakt**: `calculator/index.html` (contract-insert rond regel 3465), DB-migratie indien kolom ontbreekt.

**Risico**: laag. Fout-modes: derde-partij IP-detect faalt → val terug op `null` + waarschuwing in console.

---

#### 1.2 Bevestigingsmail uitbreiden met PDF + herroepingsformulier
**Probleem**: Edge Function `send-contract-link` stuurt HTML-only mail. Wettelijk vereist bij contracten op afstand: klant moet het contract als PDF-bijlage ontvangen én een standaard herroepingsformulier. Zonder deze bijlagen start de 14-daagse herroepingstermijn juridisch niet.

**Scope**:
- PDF client-side genereren op moment van ondertekening (bestaande jsPDF-flow in calculator/admin)
- PDF uploaden naar Storage-bucket `contracten-pdf` (moet mogelijk aangemaakt worden)
- Herroepingsformulier-template (PDF) in `contracten-pdf/templates/herroepingsformulier.pdf` plaatsen
- Edge Function `send-contract-link` uitbreiden: download beide files van Storage en attach via Resend `attachments`-array
- Link naar PDF ook tonen in bevestigingsscherm na ondertekening

**Raakt**: `supabase/functions/send-contract-link/index.ts`, `calculator/index.html`, Storage-bucket setup.

**Risico**: medium. Resend attachment-size-limiet (25MB) — onze contract-PDFs zijn <1MB, dus geen probleem. Wel testen met reële klantdata.

---

#### 1.3 Audit-log systeem-breed toepassen
**Probleem**: `audit_log` tabel bestaat, maar wordt slechts gebruikt voor 6 actietypes (GDPR-delete, 2× interventie, 2× partner-approval, 1× generiek). NIET gelogd: contract status changes, beurt-planning, pricing-updates, user-creatie/deletie, partner-mutaties. Voor compliance én bij klachten/betwistingen is een volledig audit-spoor noodzakelijk.

**Scope**:
- Centrale helper `logAudit(actie, entity_type, entity_id, oude_waarde, nieuwe_waarde)` in admin + calculator
- Toepassen op minstens:
  - Contract status-wijzigingen (concept → getekend → gefactureerd → geannuleerd)
  - Beurt status-wijzigingen (toekomstig → in_te_plannen → ingepland → uitgevoerd → geannuleerd)
  - Pricing-updates (welke admin wijzigde welk forfait wanneer)
  - User-creatie/deletie/role-wijziging
  - Partner-mutaties (marge, planning-fee, contract_getekend)
- Admin-pagina `Audit-log` (enkel admin-rol) met filter op entity-type + datumbereik + uitvoerder

**Raakt**: `admin/index.html` (helper + meerdere callsites), eventueel `calculator/index.html` voor contract-submit.

**Risico**: laag. Additief, breekt niks. Performance-impact verwaarloosbaar (1 insert per actie).

---

### Sprint 2 — Operationele optimalisatie (2-3 dagen totaal)

#### 2.1 Verloopwaarschuwingen voor technieker-certificaten
**Probleem**: `technieker_sectoren` tabel heeft certificaat-verloopdata, maar er is geen equivalent van `checkVoertuigVervalNotificaties()` voor techniekers. Als een sector-certificaat verloopt mag die technieker geen beurten van dat type meer uitvoeren — veiligheids- én juridisch risico.

**Scope**:
- Functie `checkTechniekerCertVervalNotificaties()` (clone van voertuig-flow)
- Drempels: 60 dagen oranje, 30 dagen rood, verlopen = kritiek
- Notificatie met `related_type='technieker_cert'` + auto-expand in personeel-pagina
- Bij drag-drop in planning: waarschuwing als technieker geen geldig certificaat heeft voor beurt-sector
- Dashboard-tegel: aantal binnenkort verlopende certificaten

**Raakt**: `admin/index.html`, `admin/planning.html`.

**Risico**: laag. Patroon bestaat al voor voertuigen.

---

#### 2.2 `duur_instellingen` tabel + admin-UI
**Probleem**: duur-regels per sector+installatiegrootte zitten hardcoded in `calculator/index.html`. Aanpassen vereist code-deploy. Admin moet dit zelf kunnen beheren.

**Scope**:
- Nieuwe tabel `duur_instellingen (sector, grootte_min, grootte_max, duur_minuten, partner_id)` waar `partner_id` nullable is (NULL = default, waarde = per-partner override)
- Seed-migratie met huidige hardcoded waarden
- Admin-pagina onder Instellingen → Duur-regels (tabel per sector, inline-edit)
- Calculator + planning laden duur-regels uit DB i.p.v. hardcoded
- Fallback naar 60 min bij lege tabel
- Duurregel-resolver: eerst zoek partner-specifieke regel, val terug op default

**Raakt**: nieuwe migratie, `admin/index.html` (nieuwe subpagina), `calculator/index.html`, `admin/planning.html`.

**Risico**: medium. Raakt duur-berekening op meerdere plaatsen — goed regressietesten.

---

#### 2.3 Postcode-clustering / route-suggestie in planning
**Probleem**: techniekers rijden nu willekeurige volgordes — postcode-data wordt enkel gebruikt voor provincie-filter, niet voor route-optimalisatie. Resultaat: verloren uren aan onnodige verplaatsingen.

**Scope** (v1):
- "Route-suggestie"-knop per dag per technieker
- Sortering op postcode-nabijheid via lokale heuristiek: sorteren op eerste 2 cijfers postcode, dan op straat-alfabet
- Handmatige drag-drop blijft mogelijk binnen een dag (suggestie kan overschreven worden)
- Tonen geschatte totale rij-afstand per technieker per dag (ruwe schatting via postcode-centroid)

**Scope** (v2, optioneel later):
- Echte afstandsberekening via externe service (Google Maps Distance Matrix API of open-source alternatief zoals OSRM)
- Automatische route-optimalisatie bij elke nieuwe drop
- Integratie met navigatie-app (technieker tikt op beurt → opent Google Maps)

**Raakt**: `admin/planning.html`.

**Risico**: laag voor v1 (heuristiek, geen externe calls). Medium voor v2 (API-kosten + rate limits).

---

## 3. Geschrapt uit backlog (expliciet niet doen)

Volgende items stonden in eerdere versies van dit plan en zijn op 2026-04-23 bewust uit scope genomen:

- **Weekcapaciteit echt afdwingen**: huidige per-dag per-technieker validatie is voldoende. Week-totaal blijft enkel visueel indicator.
- **Contract-sharing tussen partners**: klanten met diensten van meerdere partners blijven 2 aparte contracten. Geen nieuwe `contract_partners` tabel, geen RLS-wijzigingen op contracten.
- **Verdienste-overzicht portal**: partners zien hun contractenlijst zonder financiële samenvatting. Geen kwartaal-breakdown, geen omzet/marge dashboard.

---

## 4. Niet meer relevant (al geïmplementeerd)

Deze items stonden in het originele PLAN.md of memory en zijn afgewerkt — mag genegeerd worden in toekomstige sessies:

- Multi-sector architectuur (fases 1-4 origineel plan)
- Universal calculator met template
- Database-schema uitbreiding (sector kolommen, contract_regels, partner_sectors, onderhoudsbeurten, rapporten, interventies, techniekers, voertuigen)
- Planning-dashboard met weekview + drag-drop
- Rapport-wizard
- Wagenpark-module
- Interventie-flow + chat tussen partner en admin (oorspronkelijk 11-fasen plan, fase 7)
- Partner-sharing voor klanten via `klant_delingen` (oorspronkelijk 11-fasen plan, fase 9)
- CSV import voor klanten (oorspronkelijk 11-fasen plan, fase 10)
- GDPR cascade-delete
- Seizoenslogica onderhoudsbeurten
- Partner branding met zero-flash boot-cache
- Permission-systeem (role + perm-gates)
- Notificatie-systeem met badges en auto-expand
- Legacy URL redirects (novectra/cwsolar/flancco)

---

## 5. Prioriteitsvolgorde aanbevolen

1. **Sprint 1 eerst** (3 items, juridische hardening) — hoge impact, laag risico, klein volume werk. Zonder dit is er bij een klachtenprocedure of audit geen verdediging.
2. **Sprint 2 daarna** (3 items, operationele verbeteringen) — voorkomt fouten in dagelijkse werking (verlopen certificaten, hardcoded config, inefficiënte routes).

**Totale werklast geschat**: 3-5 werkdagen voor alle 6 items samen, mits geen onvoorziene regressies.

**Niet in scope hier**: infrastructuur (Cloudflare WAF, rate-limiting, RLS security-audit) — zie `wild-honking-planet.md` als die nog actief is. Ook niet: mobiele app, externe API voor partners, publieke marketing-site.
