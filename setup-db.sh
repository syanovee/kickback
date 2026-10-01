#!/bin/bash
# creates the d1 db and adds it to wrangler.toml (run once)
set -e
cd "$(dirname "$0")"
grep -q "d1_databases" wrangler.toml && { echo "db already set up"; exit 0; }
npx -y wrangler@latest d1 create kickback > .d1.txt 2>&1 || true
ID=$(grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' .d1.txt | head -1)
[ -z "$ID" ] && ID=$(npx -y wrangler@latest d1 list 2>/dev/null | grep -w kickback | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
rm -f .d1.txt
[ -z "$ID" ] && { echo "d1 create failed"; exit 1; }
printf '\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "kickback"\ndatabase_id = "%s"\n' "$ID" >> wrangler.toml
echo "db: $ID"
