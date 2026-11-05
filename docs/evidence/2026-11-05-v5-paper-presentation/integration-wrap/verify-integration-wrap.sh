#!/usr/bin/env bash
set -euo pipefail
scratch=/home/rsi/dev/rsibot/.workspace/scratch/condor-task2-20261105
flag=/home/rsi/dev/rsibot/.workspace/scratch/r3/LIVE_STEP_ACTIVE
export TMPDIR="$scratch/tmp"
cd "$scratch/integration/frontend"
: > "$scratch/integration-exits.txt"
phase() {
  [ ! -e "$flag" ] || exit 75
  local name=$1 code
  shift
  set +e
  "$@" > "$scratch/$name.tap" 2>&1
  code=$?
  set -e
  echo "$name=$code" | tee -a "$scratch/integration-exits.txt"
  [ "$code" != 75 ] || exit 75
  PHASE_EXIT=$code
}
phase integration-before node --test --test-concurrency=1 --test-reporter=tap test/ui-baseline-findings.test.mjs
[ "$PHASE_EXIT" = 1 ]
phase integration-scope-before node --test --test-concurrency=1 --test-reporter=tap --test-name-pattern='extracted paper container owns wrapping' test/v5-paper-presentation.test.mjs
[ "$PHASE_EXIT" = 1 ]
python3 - "$scratch" <<'PY'
from pathlib import Path
import sys
scratch=Path(sys.argv[1])
for name,count in [('integration-before',1),('integration-scope-before',1)]:
    log=(scratch/(name+'.tap')).read_text()
    assert f'# fail {count}\n' in log and 'ERR_ASSERTION' in log,log
assert 'div.(no class)' in (scratch/'integration-before.tap').read_text()
assert 'anywhere' in (scratch/'integration-scope-before.tap').read_text()
for path in ['frontend/src/v5/components/PaperWorkspace.tsx','frontend/src/v5/components/PaperWorkspace.css','frontend/test/browser/paper-presentation.tsx']:
    (scratch/'integration'/path).write_bytes((scratch/'condor'/path).read_bytes())
PY
phase integration-after node --test --test-concurrency=1 --test-reporter=tap test/ui-baseline-findings.test.mjs test/fleet-paper-freshness.test.mjs test/v5-paper-presentation.test.mjs test/v5-paper-bots-contract.test.mjs test/v5-paper-pages.test.mjs test/v5-paged-history.test.mjs test/v5-safety-supersession.test.mjs test/v5-anomaly-retained.test.mjs test/v5-identity-freshness.test.mjs test/v5-journal-condition.test.mjs test/v5-journal-retention.test.mjs test/v5-journal-review-regressions.test.mjs test/v5-refresh-continuity.test.mjs test/bots-roster.test.mjs test/paper-parity.test.mjs test/quant-kit.test.mjs test/quant-kit-datatable-contract.test.mjs test/quant-kit-export-provenance.test.mjs test/quant-decimal-display.test.mjs
[ "$PHASE_EXIT" = 0 ]
phase integration-tsc ./node_modules/.bin/tsc -p tsconfig.app.json --incremental --tsBuildInfoFile "$scratch/tmp/integration-wrap.tsbuildinfo"
[ "$PHASE_EXIT" = 0 ]
cd "$scratch/condor/frontend"
phase stacked-wrap-after node --test --test-concurrency=1 --test-reporter=tap test/v5-paper-presentation.test.mjs
[ "$PHASE_EXIT" = 0 ]
phase integration-browser node "$scratch/integration-wrap-browser.mjs"
[ "$PHASE_EXIT" = 0 ]
