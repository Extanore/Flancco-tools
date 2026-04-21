#!/bin/bash
# ============================================================================
# LEGACY — GitHub Pages deploy script
# ----------------------------------------------------------------------------
# NIET MEER IN GEBRUIK sinds migratie naar Cloudflare Pages (april 2026).
#
# Productie-hosting draait sindsdien op:
#   - app.flancco-platform.be           (admin + portal)
#   - calculator.flancco-platform.be    (publieke calculator)
#
# Deployment gebeurt automatisch bij elke push naar `main` via Cloudflare
# Pages git-integratie — er hoeft geen script meer manueel gedraaid te worden.
# Feature-branches krijgen automatisch een preview-URL op *.pages.dev.
#
# Voor rollback- of cutover-procedures: zie RUNBOOK_CUTOVER.md in deze repo.
#
# Dit bestand blijft bewaard als historisch referentiepunt en om te voorkomen
# dat een bestaande shortcut per ongeluk iets overschrijft. Het eindigt direct.
# ============================================================================

echo "DEPLOY.sh is gedeprecieerd."
echo "Flancco-tools draait sinds april 2026 op Cloudflare Pages."
echo "Elke git-push naar main triggert automatisch een nieuwe deploy."
echo "Zie RUNBOOK_CUTOVER.md voor rollback- en beheer-procedures."
exit 0
