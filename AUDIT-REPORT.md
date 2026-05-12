# Flancco Partner Platform — Audit Report

**Datum:** 2026-05-11 22:30 CEST
**Scope:** Read-only crosscheck — security, DB, UX/UI consistency, workflow friction, visual polish, productie-smoketests
**Reviewer:** Claude Code (autonomous parallel-agents audit)
**Status:** Geen wijzigingen aan code, DB of edge functions — alleen vaststelling + suggesties

---

## Executive summary

- **62 bevindingen totaal**: 0 Critical · 12 High · 25 Medium · 25 Low
- **Security-posture is sterk**: geen secrets gelekt, geen SQL-injection, HSTS+CSP+CORS strak, RLS coverage 100%. Twee High: (1) stored XSS via `klant_naam` in admin dashboard table (admin/index.html:8563), (2) 5 publieke edge functions zonder rate-limit (mail-bombing / brute-force vector).
- **Top operationele blockers**: contracten-wizard heeft geen draft-save → browser-crash = data-verlies; onderhoud-pipeline heeft geen bulk-acties → schaal-bottleneck zodra >20 beurten/week; geen automatische admin-mail bij nieuwe lead.
- **DB drift**: CLAUDE.md beschrijft `contracten` / `partners` / `runbook_tooltips` met verkeerde kolomnamen — schema-drift CI faalt waarschijnlijk al.
- **UX/UI consistency**: 4 verschillende class-conventies voor primary CTA; `dv-header` design-template enkel toegepast in admin/index; modal-overlay 4 implementaties.
- **Visual polish**: design-tokens ontbreken — admin/index.html heeft 40 unieke paddings + 25 font-sizes + 24 border-radii. Eén centrale `design-tokens.css` lost VIS-001 t/m VIS-009 in één sweep op.
- **Smoketests OK**: HSTS preload, TLS 1.3, cert geldig tot 2026-07-20, CORS origin-pinned. Eén Medium: dubbele CSP-header op `calculator.flancco-platform.be` blokkeert beoogde embedding.

**Aanbevolen aanpak**: fix High-bevindingen deze week (≤7 dagen). Medium in volgende sprint. Low → backlog. Detail-bevindingen per sectie in `/tmp/audit-{sec,db,ux,wf,vis,smoke}.md` (parallelle agent-outputs, blijven beschikbaar voor cross-reference).

---

## 1. Security (9 bevindingen — 0 Crit, 2 High, 4 Med, 3 Low)

### SEC-01 [High] Stored XSS via `klant_naam` in admin recent-contracts table
- `${c.klant_naam}` direct in `tbody.innerHTML` zonder esc. `klant_naam` wordt door anon-clients (calculator) ingestuurd zonder DB-CHECK op `<>/"`.
- **Impact**: aanvaller met JS-payload in naamveld voert script uit in admin/partner browser → cookie-stealing, role-escalation.
- **Suggestie**: wrap met `esc()` helper (al gedefinieerd op regel 16723).
- **Locatie**: `admin/index.html:8563-8572`

### SEC-02 [High] Geen rate-limit op 5 publieke verify_jwt=false endpoints
- `send-confirmation`, `send-contract-link`, `register-partner`, `upload-partner-contract`, `send-partner-application-confirmation` hebben verify_jwt=false en geen `rateLimit()` helper. Andere publieke endpoints (handle-opt-out, validate-vat, generate-pdf) hebben het wel.
- **Impact**: brute-force op application_id/contract_id, mail-bombing (Resend cost-amplification + reputation damage), upload-spam.
- **Suggestie**: kopieer `rateLimit(ip)` pattern uit `handle-opt-out/index.ts` (in-memory bucket, 10-30 req/min per IP).

### SEC-03 [Medium] XSS via `partner.bedrijfsnaam` in sidebar logo
- `applyBranding` schrijft `${p.bedrijfsnaam || p.naam}` direct in innerHTML. Partner-record is bewerkbaar door admin én partner-zelf.
- **Locatie**: `admin/index.html:6230`; `calculator/index.html:4060,4839` (identiek patroon)
- **Suggestie**: vervang template-literal door `textContent`.

### SEC-04 [Medium] CSS-injection via `kleur_primair` in inline style-attribute
- `style="background:${p.kleur_primair || '#098979'}"` zonder esc op `admin/index.html:8617, 9217`. Andere call-sites (9010, 9011) gebruiken wel esc — inconsistent.
- **Impact**: partner kan `kleur_primair` = `red;background-image:url(//evil.com/x)` zetten → CSS-exfiltration via `background-image`.
- **Suggestie**: DB CHECK `kleur_primair ~ '^#[0-9a-fA-F]{6}$'` + consistent `normalizeHex()` frontend-side.

### SEC-05 [Medium] `email_masked` + kanaal in opt-out zonder esc
- `opt-out/index.html:158,162` plaatst server-response direct in innerHTML. `klant_consents.klant_email` wordt geinsert door anon RLS zonder DB-CHECK op `<>` chars.
- **Suggestie**: wrap `data.email_masked` in `escapeHtml` + DB-CHECK op `klant_consents.klant_email`.

### SEC-06 [Medium] `partner_slug` overrideable in send-confirmation body
- Body-veld `partner_slug` is optionele override in fallback. Niet vandaag exploiteerbaar maar juridisch-zwak (herroepingsformulier moet juiste partner-entiteit benoemen).
- **Locatie**: `supabase/functions/send-confirmation/index.ts:393`
- **Suggestie**: hard-fail bij `contract.partners=null` i.p.v. Flancco-fallback.

### SEC-07, SEC-08, SEC-09 [Low]
- SEC-07: `document.write` met handtekening_base64 (admin-only, theoretisch attribuut-breach) — `admin/index.html:9919`
- SEC-08: `dispatch-klant-notifications` heeft CORS `*` (auth-gate is leading, maar inconsistent)
- SEC-09: In-memory rate-limit overleeft cold-start niet — gedocumenteerde tradeoff, acceptabel voor nu

---

## 2. DB Schema & RLS (10 bevindingen — 3 High, 4 Med, 3 Low)

### DB-001 [High] `user_roles` primary auth-path doet sequential scans
- 158.914 seq_scans / 8 idx_scans. RLS-helpers `is_admin()`, `is_partner_of()`, `is_partner_admin_of()` gebruiken indexen niet (vermoedelijk door non-STABLE marker of `auth.uid()` plan-issue).
- **Impact**: elke geauthenticeerde request scant volle tabel → latency-degradatie bij groei.
- **Suggestie**: wrap RLS-helpers met `(SELECT auth.uid())` of voeg covering partial-index toe `idx_user_roles_user_id_role`.

### DB-002 [High] CLAUDE.md drift: `contracten` kolomnamen incorrect
- Geclaimd: `forfait_per_beurt`, `totaal_excl_btw`, `handtekening`. Werkelijk: `forfait_bedrag`, `totaal_incl_btw`, `handtekening_data`. Ontbreekt in doc: `signing_ip`, `signing_user_agent`, `teken_token`, `pdf_url`, 4 `installation_*_id` FK's, `follow_up_*` triplet.
- **Suggestie**: update CLAUDE.md `Database Tabellen → contracten`.

### DB-003 [High] CLAUDE.md drift: `partners` kolomnamen incorrect
- Geclaimd: `kleur_secundair`, `contact_email`, `contact_telefoon`. Werkelijk: `kleur_donker`, `email`, `telefoon`. Ontbreekt: dubbele adres-set (`street/postal_code/city/country` naast `adres/postcode/gemeente`), `font_heading/body`, `intro_tekst`, `communicatie_email/telefoon`.
- **Suggestie**: documenteer beide adres-sets + kies canonical (tweede set wijst op niet-afgeronde migratie).

### DB-004 [Medium] CLAUDE.md drift: `marge_pct` range
- CHECK enforced 10-15. CLAUDE.md Slot X.2 zegt "10-20".
- **Suggestie**: kies één bron-van-waarheid. Als 10-20 bedoeld is, drop+recreate constraint.

### DB-005 [Medium] `runbook_tooltips` heeft bilingual kolommen (`content_nl`+`content_fr`)
- CLAUDE.md noemt enkel `text`. FR-partners zien lege tooltips.
- **Suggestie**: doc-update + frontend lang-selectie.

### DB-006 [Medium] Anon SELECT-policies zonder filter
- `duur_instellingen`, `sector_config` en `postcodes_geo` hebben `qual='true'` voor anon-rol.
- **Impact**: webcrawlers kunnen volledige interne tarifering oogsten.
- **Suggestie**: filter via `actief=true` of SECURITY DEFINER RPC.

### DB-007 [Medium] Dubbele triggers op `contracten` voor seed-beurten
- `trg_seed_beurten_insert` + `trg_seed_beurten_update` roepen dezelfde functie. Idempotency hangt 100% af van functie-body.
- **Suggestie**: verifieer "bestaat al"-check in `seed_onderhoudsbeurten_on_sign()`; UPDATE-trigger filteren op status-transitie.

### DB-008 [Low] 11 NO ACTION FKs naar `partners`/`contracten`/`clients`
- Kan toekomstige partner-cleanup blokkeren als child-rijen bestaan. Vandaag werkte het omdat tabellen leeg waren.
- **Suggestie**: per FK beslissen `CASCADE` (rapporten/facturatie) vs `SET NULL` (audit-trail) — precedent in `audit_log_user_id_set_null` (vandaag).

### DB-009, DB-010 [Low]
- DB-009: 25+ SECURITY DEFINER functions met EXECUTE op anon — review of `is_super_admin` info-leakage geeft via error-messages
- DB-010: `audit_log.user_agent` geen length-CHECK ondanks CLAUDE.md-claim "max 500"

---

## 3. UX/UI Consistency (9 bevindingen — 4 Med, 5 Low)

### UX-001 [Medium] 4 verschillende class-conventies voor primary CTA
- admin-trio: `btn btn-primary` · calculator: `btn` · onboard/index: `btn-primary` · onboard/sign: `btn primary`
- **Suggestie**: standaardiseer op `btn btn-primary` BEM-paar (admin-conventie).

### UX-002 [Medium] 27 one-off button-classes
- 14 in admin/index.html (`btn-add-cert`, `btn-set-primary`, `btn-action-red`...), 13 in planning.html (`btn-split-*`, `btn-icon-danger`...)
- **Suggestie**: consolideer naar `btn-sm`/`btn-icon`/`btn-ghost` modifiers.

### UX-003 [Medium] `dv-header` template-pattern enkel in admin/index.html
- Andere admin-pagina's hebben eigen header-conventies. Sarah-resilient hand-off premise breekt bij pagina-wissels.
- **Suggestie**: pas `dv-header` toe op planning.html + contracten-wizard step-headers.

### UX-005 [Medium] Modal-overlay: 4 verschillende implementaties
- admin/index, wizard, planning hebben elk eigen z-index (100/100/300), backdrop (`0.5`/`0.5`/`0.4 + blur(4px)`), padding. onboard/sign gebruikt `modal-backdrop` ipv `modal-overlay`.
- **Suggestie**: extracteer naar `admin/shared/modal.css`. Standaardiseer op planning's blur + z-index 300.

### UX-007 [Medium] Tabellen zonder sort/filter/pagination in planning.html
- 33 sort-references maar 0 filter-patterns, 5 pagination-refs op 3 tabellen.
- **Impact**: planner met >50 beurten kan niet filteren — Sarah-resilient hand-off zwaar.
- **Suggestie**: client-side filter-strip (status/partner/datum) + paginator >50 rijen.

### UX-004, UX-006, UX-008, UX-009 [Low]
- UX-004: 3 verschillende input-paddings binnen admin/index.html (`12px 16px` / `6px 10px` / `8px 10px`)
- UX-006: Onboard/sign en wizard hebben geen expliciete "Laden..."-state tijdens token-validatie
- UX-008: 238 inline SVGs in admin/index.html — onderhoudslast bij icoon-updates
- UX-009: `showToast` heeft 5 onafhankelijke implementaties, 2 incompatibele signatures (`type` string vs `isErr` boolean)

---

## 4. Workflow Friction (21 bevindingen — 7 High, 9 Med, 5 Low)

### WF-001 [High] Geen automatische admin-notificatie bij nieuwe lead
- Na `anon_create_partner_application` zit prospect op success-pane; admin heeft enkel realtime-kanban-update als die tab open is.
- **Impact**: leads liggen uren zonder reactie → bounce-risico.
- **Suggestie**: Resend-trigger of DB-trigger op `partner_applications.insert` (mail naar gillian.geernaert@flancco.be).

### WF-002 [High] Onboard heeft 4 marketing-stappen vóór invul-actie
- Prospect moet 5× scroll+klik voordat callback-form in beeld komt.
- **Suggestie**: "Direct naar aanvraag"-CTA op stap 1 voor short-circuit.

### WF-005 [High] CLAUDE.md drift: wizard is 5 stappen, niet 3
- UI toont 5 step-tabs (Type/Klant/Diensten/Frequentie/Afronden); doc zegt 3.
- **Suggestie**: doc updaten OF stappen consolideren.

### WF-006 [High] Geen draft-save in contracten-wizard
- `wizState` leeft in JS-memory; geen localStorage autosave.
- **Impact**: browser-crash/refresh halverwege multi-sector wizard = 5+ min herwerk.
- **Suggestie**: localStorage autosave debounced 500ms (pattern bestaat in `onboard/index.html:1485-1499`, 7d TTL).

### WF-010 [High] Calculator stap 2 heeft 10+ velden zonder field-progress-indicator
- Lange mobile-scroll → hoge afhaak. Calculator wordt veel op tel gebruikt.
- **Suggestie**: voeg "X/12 ingevuld"-counter toe boven scroll.

### WF-011 [High] VIES-validatie kan klant blokkeren bij outage
- VIES timeout/error → geen fallback "ik bevestig zelf BTW correct".
- **Suggestie**: bij `data-state=error` toon "VIES tijdelijk niet bereikbaar — we verifiëren later" + sla op met `btw_nummer_validated=false`.

### WF-015 [High] Geen bulk-acties op onderhoud-pipeline
- 50 ingeplande beurten = 50× klik+modal.
- **Suggestie**: bulk-bar (pattern bestaat al op klanten-pagina). Bulk-acties: markeer-uitgevoerd, snooze, verplaatsen.

### WF-016 [High] 4 kritieke acties gebruiken native `confirm()`
- `annuleer`, `terug_naar_fase_1`, `markeer_afgewerkt`, `markeer_uitgevoerd` — blokkeert UI thread, geen klant/datum-context, niet mobile.
- **Suggestie**: vervang door bestaande `confirmDialog()`.

### WF-019 [Medium]
- `partner_applications` cleanup ontbreekt in delete-cascade-message (al gefixt in PR #44, message niet bijgewerkt).

### Medium (9): WF-003, WF-004, WF-007, WF-008, WF-009, WF-012, WF-013, WF-017, WF-018, WF-020
- WF-003: NDA-modal blokkeert pricing zonder preview-range
- WF-004: 7 error-meldingen verwijzen hardcoded naar "Gillian" — niet schaalbaar
- WF-007: Wizard stap 5 eindigt op "concept", geen integrated sign-flow
- WF-008: Validatie alleen bij stap-transitie, niet inline
- WF-009: BTW 6%-verklaring blokkeert pas op save (stap 5) ipv stap 4
- WF-012: Calculator canvas 180px hoog — krap op mobiel
- WF-013: Geen focus-management bij stap 2b → 2 terug
- WF-017: Snooze >90 dagen pas geweigerd op confirm (geen max-date attr)
- WF-018: "Maak rapport" opent nieuwe tab → pipeline-tab refresht niet (BroadcastChannel)
- WF-020: Blokker-dialog heeft geen click-through naar gerelateerde records

### Low (5): WF-014, WF-021 + 3 sub-findings
- WF-014: Privacy-link is `href="#"` placeholder (GDPR-zwakte)
- WF-021: User-cascade-warning toont count maar geen emails

---

## 5. Visual Polish (11 bevindingen — 6 Med, 5 Low)

### VIS-011 [Low — quick fix] `@media werkt` typo in `calculator/index.html`
- Geen valid CSS — heel block wordt door browsers genegeerd. Dead-code.
- **Suggestie**: lokaliseer + verwijder of vervang door valid breakpoint.

### VIS-008 [Medium] `onboard/index.html` heeft 0× `:focus-visible` — WCAG 2.4.7 fail
- Publieke prospect-flow, meest extern-blootgestelde page. 12 hovers zonder enige focus-indicator.
- **Suggestie**: globale `:focus-visible { outline: 2px solid var(--c-accent); outline-offset: 2px; }`.

### VIS-001 [Medium] Spacing-explosie
- admin/index.html: 40 unieke paddings (1-60px). planning.html: 35.
- **Suggestie**: 8pt-schaal als CSS-vars (`--sp-1: 4px; --sp-2: 8px; ...`).

### VIS-002 [Medium] Border-radius schaal afwezig
- 24 unieke waardes in admin/index.html (2px, 3px, 5px, 7px, 9px, 11px, 13px etc).
- **Suggestie**: `--r-sm:6px; --r-md:10px; --r-lg:16px; --r-pill:999px;`

### VIS-003 [Medium] Font-size schaal te breed
- 25 unieke font-sizes in admin/index.html inclusief fractionele (11.5, 12.5, 13.5).
- **Suggestie**: schaal `--fs-xs:11px; --fs-sm:12px; --fs-md:14px; --fs-base:15px; --fs-lg:18px; --fs-xl:22px;`.

### VIS-005 [Medium] 141 hardcoded hex-waardes in admin/index.html ondanks 1721 var() refs
- Topvoorkomers `#F9FAFB(54×)`, `#92400E(33×)` zijn semantische status-kleuren die als tokens horen.
- **Suggestie**: introduceer `--c-warn-50/100/700`, `--c-danger-*`, `--c-success-*`, `--c-neutral-50..900`.

### VIS-007 [Medium] 11 verschillende breakpoints in admin/index.html
- 540/600/640/700/720/768/800/900/1024/1100/1200.
- **Suggestie**: fixeer 3-4 (`--bp-sm:520; --bp-md:768; --bp-lg:1024; --bp-xl:1280`).

### Low (5): VIS-004, VIS-006, VIS-009, VIS-010, VIS-011
- VIS-004: H1/H2/H3 uppercase-discipline inconsistent (CLAUDE.md zegt UPPERCASE, niet overal toegepast)
- VIS-006: Hex-case mix (#1A1A2E naast #1a1a2e in zelfde file)
- VIS-009: Transition-timing chaos (15+ unieke durations: .12s, .15s, .18s, .2s; onboard gebruikt ms-syntax)
- VIS-010: contracten-wizard.html laagste var-ratio (82%) — strategisch belangrijk maar minst design-token-compatible
- VIS-011: zie hierboven

---

## 6. Productie-smoketests (3 bevindingen — 2 Med, 1 Low)

### Algemene posture: STERK
- HSTS preload (`max-age=63072000`), TLS 1.3, cert geldig t/m 2026-07-20 (70d marge)
- CSP strikt: `frame-ancestors 'none'`, `object-src 'none'`, whitelist op cdn.jsdelivr/unpkg/sentry/plausible/supabase/resend
- CORS origin-pinned (geen reflectie van evil-origin)
- 404-page is nette branded NL-pagina zonder tech-stack-leakage
- Supabase publishable key zichtbaar — bevestigd `role: anon` (correct)

### SMK-001 [Medium] Dubbele CSP-header op `calculator.flancco-platform.be`
- Twee `content-security-policy` response-headers + twee `x-frame-options` (DENY + SAMEORIGIN).
- Browsers gebruiken strikste policy → `frame-ancestors 'none'` blokkeert beoogde embedding in `app.flancco-platform.be`.
- **Suggestie**: Cloudflare Pages `_headers` consolideren — kies één bron-van-waarheid voor calculator-subdomein.

### SMK-002 [Medium] Cloudflare fingerprinting via `server` + `cf-ray` headers
- Laag risico (geen exploit-vector) maar maakt CF-bypass reconnaissance triviaal.
- **Suggestie**: niet kritiek; bewaken via WAF.

### SMK-003 [Low] `unsafe-eval` + `unsafe-inline` in CSP script-src
- `unsafe-inline` is realistisch nodig (single-file HTML met inline `<script>`). `unsafe-eval` is alleen nodig voor oudere jsPDF/html2canvas.
- **Suggestie**: review of `unsafe-eval` echt nodig is; Report-Only CSP heeft het al weggelaten — rollout-pad bestaat.

---

## 7. Prioriteiten-matrix

| ID | Pri | Domein | Bevinding (kort) | File:regel |
|----|-----|--------|------------------|------------|
| SEC-01 | **High** | Security | Stored XSS via `klant_naam` in admin table | `admin/index.html:8563-8572` |
| SEC-02 | **High** | Security | 5 publieke edge functions zonder rate-limit | `supabase/functions/{send-confirmation,send-contract-link,register-partner,upload-partner-contract,send-partner-application-confirmation}` |
| DB-001 | **High** | DB | `user_roles` doet 158K seq_scans — RLS-helpers gebruiken indexen niet | `public.user_roles` |
| DB-002 | **High** | DB | CLAUDE.md drift `contracten` kolomnamen | `CLAUDE.md` Database-sectie |
| DB-003 | **High** | DB | CLAUDE.md drift `partners` kolomnamen | `CLAUDE.md` Database-sectie |
| WF-001 | **High** | Workflow | Geen admin-notificatie bij nieuwe lead | `onboard/index.html:1448-1463` |
| WF-002 | **High** | Workflow | Onboard: 4 marketing-stappen vóór invul-actie | `onboard/index.html:882-1090` |
| WF-005 | **High** | Workflow | CLAUDE.md drift: wizard is 5 stappen, niet 3 | `admin/contracten-wizard.html:643-648` |
| WF-006 | **High** | Workflow | Geen draft-save in contracten-wizard | `admin/contracten-wizard.html:976-999` |
| WF-010 | **High** | Workflow | Calculator stap 2: 10+ velden zonder progress-indicator | `calculator/index.html:768-927` |
| WF-011 | **High** | Workflow | VIES-outage blokkeert klant signing | `calculator/index.html:5485-5586` |
| WF-015 | **High** | Workflow | Geen bulk-acties op onderhoud-pipeline | `admin/index.html:12455` |
| WF-016 | **High** | Workflow | 4 kritieke acties gebruiken native `confirm()` | `admin/index.html:12477,12504,12517,12537` |
| SEC-03 | Medium | Security | XSS via `partner.bedrijfsnaam` in sidebar | `admin/index.html:6230` |
| SEC-04 | Medium | Security | CSS-injection via `kleur_primair` inline-style | `admin/index.html:8617,9217` |
| SEC-05 | Medium | Security | `email_masked` in opt-out zonder esc | `opt-out/index.html:158,162` |
| SEC-06 | Medium | Security | `partner_slug` overrideable in send-confirmation | `supabase/functions/send-confirmation/index.ts:393` |
| DB-004 | Medium | DB | CLAUDE.md drift `marge_pct` range (10-15 vs 10-20) | `partner_applications` constraint |
| DB-005 | Medium | DB | `runbook_tooltips` bilingual kolommen niet gedocumenteerd | `public.runbook_tooltips` |
| DB-006 | Medium | DB | Anon SELECT-policies zonder filter (sector_config, duur_instellingen) | 3 policies |
| DB-007 | Medium | DB | Dubbele triggers op `contracten` seed-beurten | `contracten` triggers |
| UX-001 | Medium | UX/UI | 4 verschillende class-conventies voor primary CTA | 4 files |
| UX-002 | Medium | UX/UI | 27 one-off button-classes | `admin/index.html`, `planning.html` |
| UX-003 | Medium | UX/UI | `dv-header` enkel in admin/index.html | `planning.html`, `wizard.html` |
| UX-005 | Medium | UX/UI | Modal-overlay: 4 implementaties | 4 files |
| UX-007 | Medium | UX/UI | planning.html tabellen zonder filter/paginate | `admin/planning.html` |
| WF-003 | Medium | Workflow | NDA-modal blokkeert pricing zonder preview-range | `onboard/sign/index.html:602-632` |
| WF-004 | Medium | Workflow | 7 error-meldingen hardcoded "Gillian" | `onboard/sign/index.html:768-777` |
| WF-007 | Medium | Workflow | Wizard stap 5: geen integrated sign-flow | `admin/contracten-wizard.html:929-931` |
| WF-008 | Medium | Workflow | Validatie alleen bij stap-transitie, niet inline | `admin/contracten-wizard.html:1393-1442` |
| WF-009 | Medium | Workflow | BTW 6%-verklaring blokkeert pas op save | `admin/contracten-wizard.html:2308-2320` |
| WF-012 | Medium | Workflow | Calculator canvas 180px — krap op mobiel | `calculator/index.html:3816` |
| WF-013 | Medium | Workflow | Geen focus-management bij stap 2b → 2 terug | `calculator/index.html:934` |
| WF-017 | Medium | Workflow | Snooze >90 dagen pas geweigerd op confirm | `admin/index.html:5783-5786` |
| WF-018 | Medium | Workflow | "Maak rapport" tab refresht pipeline niet | `admin/index.html:12528` |
| WF-019 | Medium | Workflow | partner_applications cleanup-message niet bijgewerkt | `admin/index.html:8990-8995` |
| WF-020 | Medium | Workflow | Blokker-dialog zonder click-through naar records | `admin/index.html:8950-8956` |
| VIS-001 | Medium | Visual | 40 unieke paddings in admin/index.html | `admin/index.html` |
| VIS-002 | Medium | Visual | 24 unieke border-radii | `admin/index.html` |
| VIS-003 | Medium | Visual | 25 unieke font-sizes (incl. fractionele) | `admin/index.html` |
| VIS-005 | Medium | Visual | 141 hardcoded hex-waardes | `admin/index.html` |
| VIS-007 | Medium | Visual | 11 verschillende breakpoints in admin/index.html | `admin/index.html` |
| VIS-008 | Medium | Visual | 0× `:focus-visible` in onboard/index.html (WCAG fail) | `onboard/index.html` |
| SMK-001 | Medium | Smoke | Dubbele CSP-header op calculator-subdomein | Cloudflare `_headers` |
| SMK-002 | Medium | Smoke | Cloudflare fingerprinting | response-headers |
| SEC-07..09 | Low | Security | document.write attribute, CORS `*` dispatch, in-memory rate-limit | (zie sectie 1) |
| DB-008..10 | Low | DB | NO ACTION FKs, SECURITY DEFINER review, `user_agent` length-CHECK | (zie sectie 2) |
| UX-004,006,008,009 | Low | UX/UI | Input-padding, loading-states, SVG-sharing, toast-unify | (zie sectie 3) |
| WF-014,021 | Low | Workflow | Privacy-link placeholder, user-cascade emails | (zie sectie 4) |
| VIS-004,006,009,010,011 | Low | Visual | Uppercase H, hex-case, transitions, wizard tokens, `@media werkt` typo | (zie sectie 5) |
| SMK-003 | Low | Smoke | `unsafe-eval` in CSP | response-headers |

---

## 8. Aanbevolen aanpak per priority

### Week 1 (High — 12 items)
1. **SEC-01** (XSS): wrap `klant_naam` met `esc()` — 5 min fix
2. **SEC-02** (rate-limit): kopieer pattern naar 5 endpoints — 1u
3. **WF-006** (draft-save wizard): localStorage autosave — 2u
4. **WF-001** (lead-notificatie): DB-trigger op `partner_applications.insert` — 30 min
5. **WF-016** (native confirm): swap naar `confirmDialog()` — 30 min
6. **DB-002, DB-003, WF-005** (CLAUDE.md drift): doc-update — 1u
7. **WF-002** (onboard short-circuit), **WF-010** (progress-counter), **WF-011** (VIES-fallback), **WF-015** (bulk-acties), **DB-001** (RLS-index): bundle als design-spike — 1 dag totaal

### Sprint 2 (Medium — 25 items)
- Bundle design-tokens.css → lost VIS-001/002/003/005/007/009 in één PR op (~1 dag)
- Modal-extract + toast-unify (UX-005/009) — 1 dag
- Onboard A11y-sweep (VIS-008) + focus-management (WF-013) — 0.5 dag
- DB review SECURITY DEFINER + anon-policies (DB-006/009) — 0.5 dag

### Backlog (Low — 25 items)
- VIS-011 typo (1 min) NU oppakken
- Rest is cosmetisch + niet-blocking, batch-fix bij volgende refactor

---

## 9. Openstaande vragen (manuele beslissing vereist)

1. **Welke marge-range geldt?** CLAUDE.md zegt 10-20%, DB CHECK zegt 10-15. (Zie DB-004)
2. **Welke adres-set is canonical op `partners`?** `adres/postcode/gemeente` (Dutch primary) of `street/postal_code/city/country` (international shadow)? Beide zijn aanwezig — keuze nodig om de andere te deprecaten. (Zie DB-003)
3. **Moeten Cloudflare `_headers` overlap fix op calculator-subdomein** (SMK-001) wachten op andere wijziging, of nu fixen? Blokkeert beoogde calculator-embedding.
4. **Bulk-acties pipeline (WF-015)**: welke acties moeten in bulk? Voorstel: `markeer-uitgevoerd`, `snooze`, `verplaatsen`. Akkoord of meer?
5. **Wizard 5 vs 3 stappen (WF-005)**: doc updaten OF stappen samenvoegen (Type+Klant → 1; Frequentie+Afronden → 1)?
6. **VIES-fallback (WF-011)**: hoe streng moeten we zijn bij outage? Voorstel: tijdelijk doorlaten met `btw_nummer_validated=false` + admin-review-vlag.
7. **Onboard marketing-stappen (WF-002)**: wil je een short-circuit "Direct naar aanvraag", of behoud van marketing-flow voor conversie-funnel?
8. **`unsafe-eval` in CSP (SMK-003)**: heeft jsPDF/html2canvas dit nodig? Een upgrade kan het wegnemen.

---

## Bijlages

Detail-rapporten per agent (volledige logs, blijven beschikbaar tot temp-rotation):
- `/tmp/audit-sec.md` — Security (151 regels)
- `/tmp/audit-db.md` — DB schema (~120 regels)
- `/tmp/audit-ux.md` — UX/UI (81 regels)
- `/tmp/audit-wf.md` — Workflow friction (171 regels)
- `/tmp/audit-vis.md` — Visual polish (91 regels)
- `/tmp/audit-smoke.md` — Smoketests (76 regels)

**Belangrijke discipline-notitie**: dit rapport is read-only audit. Geen wijzigingen zijn aangebracht aan code, database, edge functions, branches of git-history. Alle voorgestelde fixes zijn aanbevelingen — beslissing + implementatie ligt bij Gillian.

---

## SMK-001 follow-up — Cloudflare `_headers` analyse (2026-05-12)

### Bestaand bestand
Repo bevat `_headers` (Cloudflare Pages-format) met:
- Globale regel `/*` met `X-Frame-Options: DENY` + `Content-Security-Policy` met `frame-ancestors 'none'`
- Path-override `/calculator/*` met `X-Frame-Options: SAMEORIGIN` + CSP met `frame-ancestors 'self' https://app.flancco-platform.be https://flancco-platform.be https://*.pages.dev`

### Bevinding
**Geen file-level double-CSP.** Cloudflare Pages stapelt path-overrides niet — het meest specifieke pad wint. De huidige config is correct voor calculator-embedding op admin/preview.

Wel een **subtiele inconsistentie** gedetecteerd:
1. `Content-Security-Policy-Report-Only` (regel 15, globaal) bevat `frame-ancestors 'none'` en wordt NIET overschreven voor `/calculator/*`. Resultaat: op de calculator-paden meldt de browser CSP-report-only violations voor iedere legitieme iframe-embed. False positives die het rapport-kanaal lawaaierig maken.
2. `X-Frame-Options: SAMEORIGIN` op `/calculator/*` is technisch correct voor same-origin (`app.flancco-platform.be` ↔ `calculator.flancco-platform.be` zijn **verschillende origins** want subdomain). Browsers vallen terug op CSP `frame-ancestors` wat hier nieuwer/voorrang heeft — werkt dus, maar XFO is misleidend. `X-Frame-Options` heeft geen waarde voor multi-origin embed; expliciet verwijderen op `/calculator/*` (CSP doet het werk) is netter.

### Voorgestelde correctie (`_headers`)

In het bestaande `/calculator/*` blok (regel 37-40):

```
/calculator/*
  Cache-Control: public, max-age=300, must-revalidate
  # X-Frame-Options weggehaald: heeft geen geldige multi-origin syntax; CSP frame-ancestors regelt embed-policy.
  Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com https://browser.sentry-cdn.com https://*.sentry.io https://plausible.io https://analytics.flancco-platform.be; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https://*.supabase.co https://*.supabase.in https://*.flancco-platform.be; connect-src 'self' https://*.supabase.co wss://*.supabase.co https://*.supabase.in wss://*.supabase.in https://api.resend.com https://*.sentry.io https://*.ingest.de.sentry.io https://*.ingest.us.sentry.io https://plausible.io https://analytics.flancco-platform.be; frame-ancestors 'self' https://app.flancco-platform.be https://flancco-platform.be https://*.pages.dev; base-uri 'self'; form-action 'self'; object-src 'none'; worker-src 'self' blob:; manifest-src 'self'
  Content-Security-Policy-Report-Only: default-src 'self'; script-src 'self' 'unsafe-inline' https://browser.sentry-cdn.com https://cdn.jsdelivr.net https://plausible.io https://analytics.flancco-platform.be; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self' https://*.supabase.co wss://*.supabase.co https://*.ingest.de.sentry.io https://*.ingest.sentry.io https://browser.sentry-cdn.com https://api.resend.com https://plausible.io https://analytics.flancco-platform.be; frame-ancestors 'self' https://app.flancco-platform.be https://flancco-platform.be https://*.pages.dev; base-uri 'self'; form-action 'self'
```

Twee wijzigingen:
- `X-Frame-Options: SAMEORIGIN` regel **verwijderen** uit `/calculator/*` (cosmetisch; geen functionele impact want CSP wint)
- `Content-Security-Policy-Report-Only` toevoegen aan `/calculator/*` met dezelfde `frame-ancestors` whitelist als de actieve CSP → stopt false positives in report-kanaal

### Geen Cloudflare dashboard actie nodig
Alle header-config staat in repo (`_headers`). Geen dashboard-overlay vereist.

---

## Q8 unsafe-eval analyse (2026-05-12)

### Onderzoeksvraag
Is `'unsafe-eval'` in de CSP `script-src` directive (regel 14 + regel 40 in `_headers`) functioneel nodig, of legacy-cruft?

### Methode
1. Grep `eval(`, `new Function(`, `setTimeout('string')`, `setInterval('string')` over alle `*.html` en `*.js` files in repo (excl. `.git`, `.wrangler`, `node_modules`).
2. Inventariseer alle externe libs via `<script src>` met `cdn.jsdelivr.net|unpkg|esm.sh` greps.
3. Per relevante lib (PDF/canvas-rendering): controleer versie + bekende unsafe-eval-afhankelijkheid.

### Bevindingen — interne callsites

| File:line | Match | Verdict |
|-----------|-------|---------|
| `admin/planning.html:13291` | `// 'generate-pdf' Edge Function (...)` | comment, geen call |

**Geen** eigen `eval()` of `new Function()` constructies. Geen string-form `setTimeout`/`setInterval`. Repo is intern eval-vrij.

### Bevindingen — externe libs

Geladen via CDN (geen npm bundling):

| Lib | Versie | Heeft unsafe-eval nodig? | Bron-onderbouwing |
|-----|--------|--------------------------|-------------------|
| `@supabase/supabase-js` | 2.x (latest) / 2.45.4 | Nee | UMD bundle is pre-compiled ES5, geen runtime eval |
| `jspdf` | 2.5.2 | **Conditioneel**: enkel als `addHTML()` / oudere `html()`-API met `addFont` callback via Function-constructor wordt gebruikt. Met 2.5.x is dit ALLEEN nodig als je via `doc.html()` met externe HTML rendert. Repo gebruikt deze flow niet — alle PDFs worden samengesteld via `doc.text() / doc.rect() / addImage()`. | jsPDF changelog 2.4+ verving meeste Function-calls; html()-pad blijft een uitzondering |
| `html2canvas` | 1.4.1 | Nee | 1.4.x heeft geen Function-constructor of eval. Eerdere 0.x versies wel — niet van toepassing. |
| `qrcode-generator` | 1.4.4 | Nee | Pure synchroon JS, geen eval. |

### Test-strategie (aanbevolen voor verifie vóór CSP-tightening)
1. Maak een staging-branch met `'unsafe-eval'` **verwijderd** uit beide CSP-headers (`/*` en `/calculator/*`).
2. Run één klant-flow end-to-end op preview-URL: calculator → contract-signing → PDF-download → admin contract-view.
3. Check browser DevTools Console + Network voor `Refused to evaluate a string as JavaScript` violations.
4. Als geen violations: deploy naar productie. Anders: rollback en log welke lib trippte (waarschijnlijk jsPDF `html()` path als die ooit geactiveerd wordt).

### Aanbeveling

**Verwijder `'unsafe-eval'` uit beide CSP-directives** (`/*` regel 14 + `/calculator/*` regel 40). Repo gebruikt geen eval intern, en de 4 externe libs in huidige versies hebben het niet nodig. Geef het 1 week op staging met Sentry/CSP-report-only monitoring om jsPDF edge-cases te vangen.

**Eventueel aanvullend**: upgrade naar `jspdf@3.x` (september 2025-release) — die schrapt de laatste Function-fallback in `html()` definitief.

### CSP-correctie (te combineren met SMK-001-fix hierboven)

In `script-src` directive (regels 14 + 40), vervang:
```
script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net ...
```
door:
```
script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net ...
```

`'unsafe-inline'` blijft staan (alle pages hebben inline `<script>` blocks voor Supabase-init en handlers — separate task voor toekomstige Slot om die te nonce-en of te externaliseren).

