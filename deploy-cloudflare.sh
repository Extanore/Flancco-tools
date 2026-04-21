#!/usr/bin/env bash
# ============================================================================
# Flancco-tools — Cloudflare Pages one-shot deployer
# ----------------------------------------------------------------------------
# Gebruik:
#   ./deploy-cloudflare.sh                # interactief (prompt voor token)
#   CLOUDFLARE_API_TOKEN=xxx ./deploy-cloudflare.sh
#
# Deze script is bedoeld voor handmatige deploys zolang Cloudflare Pages
# nog niet aan GitHub gekoppeld is. Eens git-integratie actief is, wordt
# dit script overbodig (elke push naar main triggert dan automatisch een
# build). Zie RUNBOOK_CUTOVER.md > Optie B voor die setup.
#
# Wat doet dit script:
#   1. Controleert prerequisites (node, git, curl)
#   2. Vraagt CLOUDFLARE_API_TOKEN op als die niet in env staat
#   3. Laat je de branch + commit bevestigen voor we iets wijzigen
#   4. Voert `wrangler pages deploy` uit met de juiste project-parameters
#   5. Polt de branch-alias URL tot HTTP 200 (edge-cache warming)
#   6. Draait de volledige smoke-test en blokkeert op failures
#
# Security:
#   - CLOUDFLARE_API_TOKEN wordt NOOIT naar disk geschreven
#   - Script draait zonder sudo en raakt geen system-state aan
#   - Account ID is hardcoded want dat is geen secret
#
# Exit-codes:
#   0  — deploy + smoke-test groen
#   1  — prerequisites ontbreken
#   2  — user cancelled of token ontbreekt
#   3  — wrangler deploy gefaald
#   4  — edge nooit live geworden (timeout)
#   5  — smoke-test heeft failures
# ============================================================================

set -euo pipefail

# ---- Config (veilig om hardcoded te zijn; geen secrets) ---------------------
CF_ACCOUNT_ID="89139283d98d1286c006c912b23e6cd9"
CF_PROJECT="flancco-tools"
BRANCH_ALIAS_URL="https://deploy-flancco-platform-be.flancco-tools.pages.dev"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---- Kleuren (alleen als stdout een TTY is) ---------------------------------
if [ -t 1 ]; then
  C_RED=$'\033[0;31m'; C_GRN=$'\033[0;32m'; C_YEL=$'\033[0;33m'
  C_BLU=$'\033[0;34m'; C_GRY=$'\033[0;90m'; C_BLD=$'\033[1m'; C_RST=$'\033[0m'
else
  C_RED=""; C_GRN=""; C_YEL=""; C_BLU=""; C_GRY=""; C_BLD=""; C_RST=""
fi

say()  { printf "%s%s%s\n" "$C_BLU" "==> $*" "$C_RST"; }
ok()   { printf "%s%s%s\n" "$C_GRN" " \xe2\x9c\x93 $*" "$C_RST"; }
warn() { printf "%s%s%s\n" "$C_YEL" " ! $*" "$C_RST"; }
fail() { printf "%s%s%s\n" "$C_RED" " \xe2\x9c\x97 $*" "$C_RST"; }
info() { printf "%s%s%s\n" "$C_GRY" "   $*" "$C_RST"; }

banner() {
  echo
  printf "%s============================================================%s\n" "$C_BLD" "$C_RST"
  printf "%s  Flancco-tools \xe2\x86\x92 Cloudflare Pages deploy%s\n" "$C_BLD" "$C_RST"
  printf "%s============================================================%s\n" "$C_BLD" "$C_RST"
  echo
}

# ---- Stap 0: banner ---------------------------------------------------------
banner

# ---- Stap 1: prerequisites --------------------------------------------------
say "Controleer prerequisites"
MISSING=0
for cmd in node npx git curl; do
  if command -v "$cmd" >/dev/null 2>&1; then
    info "$cmd \xe2\x86\x92 $(command -v "$cmd")"
  else
    fail "$cmd niet gevonden in PATH"
    MISSING=1
  fi
done
[ "$MISSING" = "1" ] && exit 1
ok "Alle tools aanwezig"

# ---- Stap 2: git state ------------------------------------------------------
say "Git state"
cd "$REPO_DIR"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
CURRENT_COMMIT="$(git rev-parse --short HEAD)"
COMMIT_MSG="$(git log -1 --format=%s)"
DIRTY="$(git status --porcelain)"

info "Branch  : $CURRENT_BRANCH"
info "Commit  : $CURRENT_COMMIT \xe2\x80\x94 $COMMIT_MSG"
if [ -n "$DIRTY" ]; then
  warn "Working tree is NIET clean \xe2\x80\x94 ongecommitte wijzigingen worden NIET gedeployd"
  echo "$DIRTY" | sed "s/^/     /"
fi

# Waarschuw als we op main staan \xe2\x80\x94 main is voor productie-cutover, niet voor preview
if [ "$CURRENT_BRANCH" = "main" ]; then
  warn "Je staat op 'main'. Deze script deployt naar de preview-branch alias,"
  warn "NIET naar de productie-custom-domain. Weet je het zeker?"
  read -r -p "    Doorgaan op main? [y/N] " ans
  [[ "${ans:-N}" =~ ^[Yy]$ ]] || { warn "Afgebroken."; exit 2; }
fi

# ---- Stap 3: token ---------------------------------------------------------
say "Cloudflare API-token"
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo
  info "CLOUDFLARE_API_TOKEN is niet gezet in je shell."
  info "Maak er een aan via:"
  info "  https://dash.cloudflare.com/profile/api-tokens"
  info "  \xe2\x86\x92 'Create Token' \xe2\x86\x92 Template 'Edit Cloudflare Workers'"
  info "  \xe2\x86\x92 Account Resources: Include \xe2\x86\x92 (jouw account)"
  info "  \xe2\x86\x92 Zone Resources: All zones"
  info "  \xe2\x86\x92 Scopes: Account.Cloudflare Pages \xe2\x86\x92 Edit"
  echo
  read -r -s -p "    Plak je token (input is verborgen): " CLOUDFLARE_API_TOKEN
  echo
  if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
    fail "Geen token opgegeven \xe2\x80\x94 afgebroken"
    exit 2
  fi
  ok "Token ontvangen (lengte: ${#CLOUDFLARE_API_TOKEN} chars, wordt NIET opgeslagen)"
else
  ok "Token uit env (lengte: ${#CLOUDFLARE_API_TOKEN} chars)"
fi
export CLOUDFLARE_API_TOKEN
export CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID"

# ---- Stap 4: deploy --------------------------------------------------------
say "Deploy naar Cloudflare Pages"
info "Project : $CF_PROJECT"
info "Account : $CF_ACCOUNT_ID"
info "Branch  : $CURRENT_BRANCH"
echo

# `wrangler pages deploy` uploadt ALLE files in de repo-dir. Het respecteert
# .gitignore niet volledig \xe2\x80\x94 .wrangler/, .git/, node_modules worden auto-skipped.
# --commit-hash + --commit-message = metadata op de deploy-kaart in CF dashboard.
set +e
npx --yes wrangler@latest pages deploy . \
  --project-name="$CF_PROJECT" \
  --branch="$CURRENT_BRANCH" \
  --commit-hash="$(git rev-parse HEAD)" \
  --commit-message="$COMMIT_MSG"
DEPLOY_RC=$?
set -e

if [ $DEPLOY_RC -ne 0 ]; then
  fail "Wrangler deploy gefaald (exit $DEPLOY_RC)"
  exit 3
fi
ok "Wrangler deploy voltooid"

# ---- Stap 5: edge warming --------------------------------------------------
say "Wacht tot edge live is op $BRANCH_ALIAS_URL"
MAX_WAIT=90
ELAPSED=0
SLEEP=5
LIVE=0
while [ $ELAPSED -lt $MAX_WAIT ]; do
  code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 8 -I "$BRANCH_ALIAS_URL/" 2>/dev/null || echo "000")
  if [ "$code" = "200" ] || [ "$code" = "301" ] || [ "$code" = "302" ]; then
    ok "Edge live (HTTP $code na ${ELAPSED}s)"
    LIVE=1
    break
  fi
  info "   nog niet live (HTTP $code), retry in ${SLEEP}s... (${ELAPSED}s/${MAX_WAIT}s)"
  sleep $SLEEP
  ELAPSED=$((ELAPSED + SLEEP))
done

if [ "$LIVE" != "1" ]; then
  fail "Edge kwam niet up binnen ${MAX_WAIT}s \xe2\x80\x94 controleer Cloudflare dashboard"
  info "   https://dash.cloudflare.com/$CF_ACCOUNT_ID/pages/view/$CF_PROJECT"
  exit 4
fi

# ---- Stap 6: smoke-test ----------------------------------------------------
say "Smoke-test"
SMOKE_SCRIPT=""
if [ -x "/tmp/flancco-smoke.sh" ]; then
  SMOKE_SCRIPT="/tmp/flancco-smoke.sh"
elif [ -x "$REPO_DIR/scripts/flancco-smoke.sh" ]; then
  SMOKE_SCRIPT="$REPO_DIR/scripts/flancco-smoke.sh"
fi

if [ -n "$SMOKE_SCRIPT" ]; then
  info "Draai $SMOKE_SCRIPT"
  echo
  if bash "$SMOKE_SCRIPT" "$BRANCH_ALIAS_URL"; then
    echo
    ok "Smoke-test groen"
  else
    echo
    fail "Smoke-test heeft failures \xe2\x80\x94 fix eerst vooraleer DNS-cutover"
    exit 5
  fi
else
  warn "Geen smoke-test gevonden. Run handmatig:"
  info "  curl -I $BRANCH_ALIAS_URL/admin/"
  info "  curl -I $BRANCH_ALIAS_URL/PLAN.md    # moet 404"
fi

# ---- Stap 7: wrap-up -------------------------------------------------------
echo
printf "%s============================================================%s\n" "$C_BLD" "$C_RST"
ok "Deploy voltooid \xe2\x80\x94 commit $CURRENT_COMMIT staat nu op de edge."
info "Branch-alias : $BRANCH_ALIAS_URL"
info "Dashboard    : https://dash.cloudflare.com/$CF_ACCOUNT_ID/pages/view/$CF_PROJECT"
echo
info "Volgende stap: RUNBOOK_CUTOVER.md Deel 2 (DNS-cutover)."
echo
