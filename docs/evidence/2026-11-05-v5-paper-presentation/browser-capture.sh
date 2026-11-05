#!/usr/bin/env bash
set -euo pipefail
scratch=/home/rsi/dev/rsibot/.workspace/scratch/condor-task2-20261105
export TMPDIR="$scratch/tmp"
[ ! -e /home/rsi/dev/rsibot/.workspace/scratch/r3/LIVE_STEP_ACTIVE ] || exit 75
cd "$scratch/condor/frontend"
node "$scratch/capture-session.mjs" > "$scratch/capture.log" 2>&1
