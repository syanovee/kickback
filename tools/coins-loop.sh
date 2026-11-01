#!/bin/bash
# Keeps the coin job running on this Mac: one run after another until Ctrl+C. The Mac won't sleep while it runs (caffeinate).
#   bash tools/coins-loop.sh
cd "$(dirname "$0")/.."
caffeinate -i bash -c 'while true; do MAX_MIN=${MAX_MIN:-60} BF_MIN=${BF_MIN:-50} bash tools/coins-local.sh; echo "next run in 1 min (Ctrl+C to stop)"; sleep 60; done'
