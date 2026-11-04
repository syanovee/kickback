#!/bin/bash
# Runs the coin pages job from this Mac against the test site, with the keys from secrets.json.
#   bash tools/coins-local.sh            everything, 25 minutes
#   MAX_MIN=60 bash tools/coins-local.sh a longer first run, to count old coins faster
cd "$(dirname "$0")/.."
k(){ python3 -c "import json;print(json.load(open('secrets.json')).get('$1',''))"; }
export SITE=${SITE:-https://kickback-test.pages.dev} YIELD_KEY=$(k YIELD_KEY) HELIUS_KEY=$(k HELIUS_KEY) BLOCKSCOUT_KEY=$(k BLOCKSCOUT_KEY) MAX_MIN=${MAX_MIN:-25}
NODE_OPTIONS="--dns-result-order=ipv4first" node tools/coins-job.mjs 2>&1 | tee "Claude outputs/coins_job_log.txt"
