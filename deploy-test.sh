#!/bin/bash
# deploys to kickback-test.pages.dev
set -e
cd "$(dirname "$0")"
npx -y wrangler@latest pages project create kickback-test --production-branch main </dev/null >/dev/null 2>&1 || true
[ -f secrets.json ] && npx -y wrangler@latest pages secret bulk secrets.json --project-name kickback-test </dev/null || true
npx -y wrangler@latest pages deploy public --project-name kickback-test --branch main --commit-dirty=true
