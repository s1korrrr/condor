#!/usr/bin/env bash
set -euo pipefail
scratch=/home/rsi/dev/rsibot/.workspace/scratch/condor-task2-20261105
flag=/home/rsi/dev/rsibot/.workspace/scratch/r3/LIVE_STEP_ACTIVE
export TMPDIR="$scratch/tmp"
[ ! -e "$flag" ] || exit 75
cd "$scratch/base"
set +e
node --test --test-concurrency=1 --test-reporter=tap --test-name-pattern="a recent status cannot summarize|metric exact owner decimal|paper rail maps percent|summary retains|paper record export uses|only all available sections" frontend/test/v5-paper-presentation.test.mjs > "$scratch/before.log" 2>&1
before=$?
set -e
printf 'base_exit=%s\n' "$before" > "$scratch/check-exits.txt"
[ "$before" != 0 ] || { echo 'Expected pinned-base regression did not fail'; exit 1; }
echo "Pinned base exit: $before"
cd "$scratch/condor/frontend"
[ ! -e "$flag" ] || exit 75
set +e
node --test --test-concurrency=1 --test-reporter=tap test/v5-paper-presentation.test.mjs test/v5-paper-bots-contract.test.mjs test/v5-paper-pages.test.mjs test/v5-paged-history.test.mjs test/v5-safety-supersession.test.mjs test/v5-anomaly-retained.test.mjs test/v5-identity-freshness.test.mjs test/v5-journal-condition.test.mjs test/v5-journal-retention.test.mjs test/v5-journal-review-regressions.test.mjs test/v5-refresh-continuity.test.mjs test/bots-roster.test.mjs test/paper-parity.test.mjs test/quant-kit.test.mjs test/quant-kit-datatable-contract.test.mjs test/quant-kit-export-provenance.test.mjs test/quant-decimal-display.test.mjs > "$scratch/focused.log" 2>&1
focused=$?
set -e
printf 'focused_exit=%s\n' "$focused" >> "$scratch/check-exits.txt"
echo "Focused exit: $focused"
[ "$focused" = 0 ] || exit "$focused"
[ ! -e "$flag" ] || exit 75
set +e
./node_modules/.bin/tsc -p tsconfig.app.json --incremental --tsBuildInfoFile "$scratch/tmp/tsconfig.app.tsbuildinfo" > "$scratch/tsc.log" 2>&1
types=$?
set -e
printf 'tsc_exit=%s\n' "$types" >> "$scratch/check-exits.txt"
echo "TypeScript exit: $types"
[ "$types" = 0 ] || exit "$types"
[ ! -e "$flag" ] || exit 75
set +e
"$scratch/browser-capture.sh"
browser=$?
set -e
printf 'capture_exit=%s\n' "$browser" >> "$scratch/check-exits.txt"
echo "Capture exit: $browser"
exit "$browser"
