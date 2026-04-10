#!/bin/bash
# ============================================
# Flancco-tools → GitHub Pages deploy
# Open Terminal, navigeer naar deze map en voer uit:
#   chmod +x DEPLOY.sh && ./DEPLOY.sh
# ============================================

REPO_NAME="Flancco-tools"

echo "=== Flancco-tools GitHub deploy ==="

# Check of git beschikbaar is
if ! command -v git &> /dev/null; then
    echo "Git is niet geinstalleerd. Installeer via: brew install git"
    exit 1
fi

# Check of gh CLI beschikbaar is
if command -v gh &> /dev/null; then
    echo "GitHub CLI gevonden — repo wordt automatisch aangemaakt..."
    gh repo create "$REPO_NAME" --public --source=. --remote=origin --push
    echo ""
    echo "=== GitHub Pages activeren ==="
    gh api -X POST "repos/$(gh api user --jq .login)/$REPO_NAME/pages" \
        -f "source[branch]=main" -f "source[path]=/" 2>/dev/null || \
    gh api -X PUT "repos/$(gh api user --jq .login)/$REPO_NAME/pages" \
        -f "source[branch]=main" -f "source[path]=/" 2>/dev/null

    USERNAME=$(gh api user --jq .login)
    echo ""
    echo "=== KLAAR! ==="
    echo "Admin:    https://$USERNAME.github.io/$REPO_NAME/admin/"
    echo "Novectra: https://$USERNAME.github.io/$REPO_NAME/novectra/"
    echo "CW Solar: https://$USERNAME.github.io/$REPO_NAME/cwsolar/"
else
    echo "GitHub CLI (gh) niet gevonden — handmatig pushen..."
    echo ""
    read -p "Wat is je GitHub username? " USERNAME

    git init
    git add .
    git commit -m "Initial commit: calculators + admin dashboard met Supabase"
    git branch -M main
    git remote add origin "https://github.com/$USERNAME/$REPO_NAME.git"

    echo ""
    echo "Maak eerst de repo '$REPO_NAME' aan op https://github.com/new"
    echo "Druk Enter als de repo aangemaakt is..."
    read

    git push -u origin main

    echo ""
    echo "=== Activeer GitHub Pages ==="
    echo "Ga naar: https://github.com/$USERNAME/$REPO_NAME/settings/pages"
    echo "Zet Source op: Deploy from branch → main → / (root) → Save"
    echo ""
    echo "Daarna zijn de URLs:"
    echo "Admin:    https://$USERNAME.github.io/$REPO_NAME/admin/"
    echo "Novectra: https://$USERNAME.github.io/$REPO_NAME/novectra/"
    echo "CW Solar: https://$USERNAME.github.io/$REPO_NAME/cwsolar/"
fi
