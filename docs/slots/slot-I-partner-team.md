# Slot I — Rol-gebaseerd partner-team

## Intent

Geef partner-eigenaars (`role='partner'` met `permissions.manage_users=true`)
een eigen, in-product team-beheer in **Instellingen → Teamleden**: collega
uitnodigen, rechten aanpassen en weghalen, zonder ooit een Flancco-admin nodig
te hebben. Tegelijkertijd hardenen we het permissie-model server-side zodat
een partner-medewerker zichzelf nooit kan promoten tot beheerder, en een laatste
beheerder niet per ongeluk verwijderd wordt waardoor de tenant lockt.

Het scherm vervangt de tot dusver door admin uitgevoerde "kan jij even
deze collega toevoegen?"-mailtjes door één strakke flow met server-side
gecontroleerde rechten en een gebrand uitnodigings-mail (NL/FR).

## Scope

| In scope | Out of scope |
|---|---|
| Edge function `invite-partner-member` (whitelist + rate-limit + brand-mail) | Magic-link invites — we behouden temp-password flow analoog aan `invite-partner` |
| Edge function `remove-partner-member` (anti-self-delete + anti-last-owner + cleanup) | Bulk-import van teamleden vanuit CSV |
| RLS-migratie die `user_roles_partner_update` vervangt door self-promote-blok | UI om `manage_pricing` of `manage_partners` toe te kennen — die blijven uitsluitend Flancco-admin |
| Card `set-team-card` (rebuild) + 3 modals (invite / edit / remove) in `admin/index.html` | Bedienden-pagina (`page-personeel` Bedienden-tab) — flow blijft via `create-bediende` voor admin-context |
| Permission presets: medewerker basis, medewerker uitgebreid, co-eigenaar | Custom permission-templates die admin kan beheren |
| i18n keys onder `partner.team.*` (NL=FR symmetrisch, 48 leaf-keys) | Admin-zijde van team-beheer (blijft Nederlands-only via `renderGebruikers`) |
| Slot 0 events: `Partner Team Member Invited / Removed`, `Partner Team Permissions Updated` | Per-actie audit-mail naar de uitgenodigde collega — alleen welkomst-mail |

## Files touched

| Path | Type | Verantwoordelijkheid |
|---|---|---|
| `supabase/migrations/20260425160000_slot_i_restrict_partner_self_promote.sql` | create | Helpers `user_role_has_manage_users(uuid)` + `is_partner_admin_of(uuid)`, vervangt policy `user_roles_partner_update` met WITH CHECK die self-promote blokkeert en `manage_partners`/`manage_pricing` hard cap't op `false` |
| `supabase/functions/invite-partner-member/{index.ts,deno.json}` | create | POST-endpoint, JWT-auth, partner-owner-check, rate-limit (10/uur per partner_id), permissie-whitelist, anti-hijack (existing-user check), `auth.users` create + `user_roles` upsert + `techniekers` insert, gebrande NL/FR welkomst-mail via Resend |
| `supabase/functions/remove-partner-member/{index.ts,deno.json}` | create | POST-endpoint, anti-self-delete, tenant-scope-check, anti-last-owner (count `manage_users=true` rijen in tenant), tenant-gescoped DELETE op `techniekers` + `user_roles`, conditionele `auth.admin.deleteUser` indien geen andere tenant-rijen meer |
| `admin/index.html` (partner-tak Instellingen) | edit | Card `set-team-card` rebuild (header + button + lijst), 3 nieuwe modals (`modal-team-invite`, `modal-team-edit`, `modal-team-remove`), CSS voor `.ti-perm-grid`, `.pt-row` + badges, JS-functies `renderPartnerTeamList / loadPartnerTeamRoles / openTeamInviteModal / submitTeamInvite / openTeamEditModal / submitTeamPermsUpdate / openTeamRemoveModal / submitTeamRemove` |
| `calculator/i18n/nl.json.js` | edit | 48 nieuwe leaf-keys onder `partner.team.*` |
| `calculator/i18n/fr.json.js` | edit | Identieke set FR-vertalingen, NL=FR=440 keys totaal |

Niet aangeraakt (file-fence): `planning.html`, `calculator/index.html`, andere edge functions, `cwsolar/`, `novectra/`, andere PDF-templates.

## Architectuur

### Data flow — invite

```
[admin/index.html partner-instellingen]
  └─ openTeamInviteModal()
       └─ vul form (voornaam, naam, email, preset → checkbox-state)
  └─ submitTeamInvite()
       └─ fetch POST /functions/v1/invite-partner-member
            body { email, voornaam, naam, partner_id, permissions, lang:'nl' }
            headers { Authorization: Bearer <user-JWT>, apikey }

[invite-partner-member edge function]
  ├─ JWT-validatie (admin.auth.getUser)
  ├─ Rate-limit (in-memory Map per partner_id, 10/uur)
  ├─ Caller-rol check: admin OR partner+matching partner_id+manage_users=true
  ├─ Permissie-whitelist: alleen 5 toegelaten keys, manage_partners/pricing geforceerd false
  ├─ Anti-hijack: auth.admin.listUsers → existing-user → 409 als al in tenant of in andere tenant
  ├─ auth.admin.createUser (temp-password "Flancco_<uuid-10>")
  ├─ user_roles upsert (role='partner', partner_id, permissions)
  ├─ techniekers insert (type_personeel='bediende', tenant-scoped)
  └─ Resend mail (NL/FR template, credentials-box, permission-list, brand-color)

[admin client]
  └─ allTechniekers = await sb.from('techniekers').select('*')
  └─ renderPartnerTeamList()
  └─ window.flanccoTrack('Partner Team Member Invited', { partner_slug, preset, is_owner })
```

### Data flow — remove

```
[admin/index.html]
  └─ openTeamRemoveModal(teamRowId)  → confirm-modal met naam
  └─ submitTeamRemove()
       └─ fetch POST /functions/v1/remove-partner-member
            body { user_id_to_remove, partner_id }

[remove-partner-member edge function]
  ├─ JWT-validatie
  ├─ Anti-self-delete (caller.id !== userIdToRemove)
  ├─ Caller-rol check (admin OR partner-owner van tenant)
  ├─ Doel-rij ophalen (user_roles) — 404 als weg
  ├─ Tenant-scope-check (target.partner_id === partner_id voor non-admin)
  ├─ Anti-last-owner: tel partner-owners (manage_users=true) in tenant; weiger als doel laatste is
  ├─ DELETE techniekers WHERE user_id=? AND partner_id=? (tenant-gescoped)
  ├─ DELETE user_roles WHERE user_id=?
  └─ Conditioneel: auth.admin.deleteUser ALS geen andere techniekers-rij meer (cross-tenant safe)

[admin client]
  └─ Refresh allTechniekers + renderPartnerTeamList
  └─ window.flanccoTrack('Partner Team Member Removed', { partner_slug })
```

### Data flow — permissie-edit (geen edge function)

```
[admin/index.html]
  └─ openTeamEditModal(teamRowId) → checkbox-state uit partnerTeamRolesByUser[user_id].permissions
  └─ submitTeamPermsUpdate()
       └─ sb.from('user_roles').update({ permissions: merged }).eq('id', role.id)

[Postgres / RLS]
  └─ Policy user_roles_partner_update WITH CHECK:
       ├─ partner_id matched (is_partner_of)
       ├─ role <> 'admin'
       ├─ manage_partners forced false
       ├─ manage_pricing forced false
       └─ manage_users wijziging mag alleen als:
            - waarde gelijk aan huidige (= geen verandering), OF
            - caller is partner-admin van tenant EN editeert NIET zijn eigen rij
```

## Permissie-model

Whitelist (server-side hard cap in `invite-partner-member`):

| Key | Default | Co-owner | Effect |
|---|---|---|---|
| `planning_inzage` | true | true | Mag de planning-kalender bekijken en eigen taken zien |
| `rapporten_inzage` | false | true | Mag uitvoerings- en service-rapporten openen |
| `facturatie_inzage` | false | true | Mag de facturatie-pagina openen en exports downloaden |
| `contracten_aanmaken` | false | true | Mag nieuwe contracten registreren via de calculator-link |
| `manage_users` | false | true | Mag collega's uitnodigen, rechten aanpassen en verwijderen |

Geblokkeerd voor partner-tak (server-side forced false, RLS WITH CHECK + edge function whitelist):
- `manage_partners`
- `manage_pricing`

Presets in invite-modal:
- **Medewerker basis** — alleen `planning_inzage`
- **Medewerker uitgebreid** — `planning_inzage` + `rapporten_inzage` + `facturatie_inzage` + `contracten_aanmaken`
- **Co-eigenaar** — alle 5 inclusief `manage_users`
- **Eigen selectie** — auto-modus die activeert zodra een vinkje handmatig wordt aangepast

## Auth + RLS

### Edge function auth

Beide functies gebruiken `verify_jwt: false` met custom JWT-validatie in de
handler (zelfde patroon als bestaande `delete-user` en `invite-partner v5`).
Dit geeft nettere foutmeldingen en laat de functie zelf bepalen of de caller
admin of partner-owner is.

### Caller-validatie

```
isAdmin       = role === 'admin'
isPartnerOwner = role === 'partner'
                 AND partner_id === request.partner_id
                 AND permissions.manage_users === true
allow         = isAdmin OR isPartnerOwner
```

Faalt → HTTP 403 + `step:'forbidden'`.

### RLS-policy `user_roles_partner_update` (rebuild)

Vóór Slot I liet deze policy elke permissions-mutatie toe zolang
`manage_partners=false` bleef. Een partner-medewerker kon dus zichzelf
promoten tot beheerder via een directe PATCH op `user_roles`.

De nieuwe policy gebruikt twee security-definer helpers:

- `user_role_has_manage_users(uuid)` — geeft de huidige `manage_users`-flag terug van een gegeven user_id-rij
- `is_partner_admin_of(uuid)` — TRUE iff caller zelf een partner-admin is van een gegeven `partner_id`

en blokkeert in WITH CHECK:
1. `manage_partners=true` of `manage_pricing=true` → altijd geweigerd
2. Verandering van `manage_users` op eigen rij → altijd geweigerd
3. Verandering van `manage_users` op andermans rij → alleen toegelaten voor bestaande partner-admin van dezelfde tenant

Dit is **defense-in-depth** naast de edge function whitelist: ook als iemand
de Supabase JS-client direct hijack't, blijft de server consistent.

## UI-flow

### Card `set-team-card` (Instellingen)

- Header `Teamleden` + subtitle + button `+ Teamlid uitnodigen` (alleen zichtbaar voor `permissions.manage_users=true` via class `perm-users` + `partner-only`)
- Lijst gerenderd door `renderPartnerTeamList()`:
  - Avatar (initialen)
  - Naam + role-badge (`Beheerder` / `Medewerker`) + optionele `Jij`-badge
  - E-mail
  - Permission-summary (door komma's gescheiden labels of "Geen extra rechten")
  - Acties: Edit (rechten aanpassen) + Verwijderen (rode trash) — verwijder-knop verborgen voor eigen rij
- Sortering: beheerders eerst, dan alfabetisch
- Empty-state: card met titel + uitleg

### Modals

- `modal-team-invite` — voornaam, naam, e-mail, preset-dropdown, 5 checkbox-rijen met label+hint, hint-box, submit/cancel
- `modal-team-edit` — naam in subtitle, 5 checkbox-rijen pre-filled, hint-box, submit/cancel
- `modal-team-remove` — naam in body-zin, expliciete uitleg over wat verwijderd wordt, danger-button + cancel

Alle 3 modals respecteren de bestaande `.modal-overlay` / `.modal-header` /
`.modal-body` / `.modal-footer` patterns.

## i18n

48 leaf-keys onder `partner.team.*` in beide files, NL=FR=440 totaal-keys
(was 392 vóór Slot I). Categorieën:

- `team.title`, `team.subtitle`
- `team.add.*` — modal-titel + form-labels + presets + submit/cancel (12 keys)
- `team.perm.<key>.{label,hint}` — 5 permission-keys × 2 = 10 keys
- `team.role.{owner,medewerker}` — 2 keys
- `team.actions.{edit,remove}` — 2 keys
- `team.edit.{modalTitle,submit,cancel}` — 3 keys
- `team.remove.{confirmTitle,confirmBody,confirmBtn,cancel}` — 4 keys
- `team.toast.*` — 9 keys (success + 6 error-cases)
- `team.empty.{title,hint}` — 2 keys
- `team.list.{permSummaryNone,permSummaryCount}` — 2 keys

De `admin/index.html`-zijde gebruikt deze keys nog niet (admin is Dutch-only);
de keys staan klaar voor toekomstige partner-portal-rendering en voor
calculator-zijde messaging waar nodig.

## Slot 0 events

| Event | Props | Trigger |
|---|---|---|
| `Partner Team Member Invited` | `partner_slug`, `preset`, `is_owner` | Na succesvolle response van `invite-partner-member` |
| `Partner Team Member Removed` | `partner_slug` | Na succesvolle response van `remove-partner-member` |
| `Partner Team Permissions Updated` | `partner_slug`, `is_owner_after` | Na succesvolle direct-`UPDATE` op `user_roles` |

Alle events gaan door dezelfde `window.flanccoTrack()` shim die elders in de
app gebruikt wordt (degradeert silent als ad-blocker actief).

## Verificatie

### JS-syntax (admin/index.html)

```
node -e "<state-machine extractor> + new Function(code)"
→ JS-SYNTAX OK across all 6 blocks
```

### i18n parity

```
NL count: 440
FR count: 440
Only NL: 0
Only FR: 0
partner.team.* NL: 48
partner.team.* FR: 48
PARITY: OK
```

### Fence-counts (must remain unchanged)

```
feestdag                     : 66
switchVerlofEwTab            :  4
c-pipeline-                  : 48
card-partner-facturatie      :  1
pipeline_emailKlant          :  2
```

### Edge function curl-tests (5 scenarios per functie)

`invite-partner-member`:
1. Geen JWT → 401 `no_token`
2. Admin JWT + valid body → 200 `success:true`
3. Partner-owner JWT + matching partner_id + valid body → 200 `success:true`
4. Partner-medewerker JWT (manage_users=false) + matching partner_id → 403 `forbidden`
5. Partner-owner JWT + andere partner_id → 403 `forbidden`

`remove-partner-member`:
1. Geen JWT → 401 `no_token`
2. Caller probeert zichzelf te verwijderen → 400 `self_delete`
3. Admin JWT + valid body → 200 `success:true`
4. Partner-owner JWT + last-owner doel → 400 `last_owner`
5. Partner-owner JWT + andere tenant doel → 403 `tenant_mismatch`

### Advisor-baseline

Pre-Slot I: 5 advisors. Migratie introduceert geen nieuwe RLS-warnings of
unindexed FK's; helpers zijn `SECURITY DEFINER` met `SET search_path=public`.

## Rollback

1. **UI rollback** — revert commit op `admin/index.html` (set-team-card +
   modals + JS-block) + `calculator/i18n/nl.json.js` + `calculator/i18n/fr.json.js`.
2. **Edge functions** — `supabase functions delete invite-partner-member` en
   `remove-partner-member`; geen DB-state om op te ruimen.
3. **RLS-migratie rollback** — onderstaande inverse-migratie herstelt de
   originele policy:

```sql
DROP POLICY IF EXISTS user_roles_partner_update ON public.user_roles;
CREATE POLICY user_roles_partner_update ON public.user_roles
  FOR UPDATE TO authenticated
  USING (partner_id IS NOT NULL AND is_partner_of(partner_id) AND role <> 'admin')
  WITH CHECK (
    is_partner_of(partner_id) AND role <> 'admin'
    AND COALESCE((permissions->>'manage_partners')::boolean, false) = false
  );
DROP FUNCTION IF EXISTS public.is_partner_admin_of(uuid);
DROP FUNCTION IF EXISTS public.user_role_has_manage_users(uuid);
```

Belangrijk: rollback van de RLS-migratie zónder rollback van de edge
functions is veilig (de functions blijven werken). Andersom (functions weg,
RLS hard) blokkeert UI-flow voor team-beheer; partners kunnen dan niets
meer beheren tot rollback compleet is.

## Open follow-ups

1. **Magic-link variant** — vervang temp-password mail door `inviteUserByEmail`
   wanneer Supabase de redirect-URL whitelisting consistent ondersteunt voor
   custom domains. Vereist update van mail-template (link i.p.v. credentials).
2. **Audit-trail per permissie-toggle** — momenteel logt `auditLog` de
   oude/nieuwe JSON; een visuele diff in een toekomstige `Activiteit`-tab
   zou per partner-tenant kunnen tonen wie wat wanneer wijzigde.
3. **Re-invite-flow** — als invite-mail niet aankwam, is er nu geen knop om
   de welkomst-mail opnieuw te versturen. Toevoegen via een `?resend=true`
   query-param naar `invite-partner-member` die de auth-create-stap overslaat
   en alleen mail+temp-password regenereert.
4. **Bulk-import** — CSV-upload voor partners met grote teams (>10 collega's
   tegelijk). Niet urgent zolang individuele invite-flow snel is.
5. **Permission-templates per partner** — admin zou per partner een eigen
   "default preset" kunnen instellen die in plaats van de hardcoded presets
   in de invite-modal verschijnt.
6. **Live `remove-partner-member` v1 redeploy retry** — lokale code in
   `supabase/functions/remove-partner-member/index.ts` is hardened met
   auth-first ordering (JWT-validatie regel 75 vóór body-parsing regel 82).
   Live v1 op productie heeft body-parsing vóór auth (info-disclosure: 400
   op format-error vóór 401 op missing-auth). Niet exploiteerbaar voor
   data-leak — alle write-paden zitten achter auth-check. Redeploys
   geblokkeerd door Supabase platform `InternalServerErrorException`
   (3 pogingen). Retry bij volgende deploy-window.
7. **Helper search_path consistency** — `user_role_has_manage_users(uuid)`
   en `is_partner_admin_of(uuid)` hebben `SET search_path = public`. De
   project-conventie elders is `public, extensions, pg_temp`. Niet
   functioneel kritiek (geen extension-functies in body) maar eenvormig
   maken bij volgende migration touch.
