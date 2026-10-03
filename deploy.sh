#!/bin/bash
set -e
cd "$(dirname "$0")"
npx -y wrangler@latest whoami >/dev/null 2>&1 || npx -y wrangler@latest login
npx -y wrangler@latest pages project create kickback-rewards --production-branch main </dev/null >/dev/null 2>&1 || true
[ -f secrets.json ] && npx -y wrangler@latest pages secret bulk secrets.json --project-name kickback-rewards </dev/null || true
mkdir -p public/knots && cp public/index.html public/knots/index.html
npx -y wrangler@latest pages deploy public --project-name kickback-rewards --branch main --commit-dirty=true
