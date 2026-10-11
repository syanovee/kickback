#!/bin/bash
# Runs the bag calculator job from this Mac against the test site, with the keys from secrets.json.
#   bash tools/yield-local.sh          everything
#   bash tools/yield-local.sh seeds    only the non-StonkFun coins people scanned
cd "$(dirname "$0")/.."
k(){ python3 -c "import json;print(json.load(open('secrets.json')).get('$1',''))"; }
export SITE=${SITE:-https://kickback-test.pages.dev} YIELD_KEY=$(k YIELD_KEY) HELIUS_KEY=$(k HELIUS_KEY) ALCHEMY_KEY=$(k ALCHEMY_KEY) MAX_MIN=${MAX_MIN:-25}
[ "$1" = "seeds" ] && export SEEDS_ONLY=1
node tools/yield-job.mjs 2>&1 | tee "Claude outputs/yield_job_log.txt"
