# Round-8 repair: quarantined clock anomalies

Input heads: Condor f67a70efc90ad5ee90f04b871d384c9ec851a294 and rsibot
cd69ea16bfb41e87a16b0ae75a98f224d44868c5. Local checks pass. New exact-head
independent review remains required. Both PRs remain draft and held for the
live-trial move, integration with #84 and separate requalification.

## Cause and repair

The pinned owner appends suspicious timestamps to clock_anomalies. Clock
maintenance marks them reviewed; it does not delete them. Later risk reads
publish the last 64 entries. The real clock-anomaly-hold fixture contains an
integer timestamp of 1000000000000000000. JavaScript's generic safe-integer
validator rejected that evidence and therefore blocked every later qualified
safety supersession, even after owner acknowledgement.

Pinned control source: ee8ca6adae9327d4b8fb55b710484ce3001f68e7,
scripts/meridian_v5_paper_control.py. SHA256:
46ac6d04fdfe612c4d8d3d99c2a10390d580fb39534a8bba20f7deb069f1d842.
The source excerpts and hash are in round9-owner-quarantine-source.txt.gz.
This round inspected that source; it did not execute or change the owner.

paper-json.ts names a frozen quarantine constant with the path, pinned numeric
fields and reason. Only risk.data.clock_recovery.anomalies[*].timestamp and
.provider_upper_bound accept opaque numeric evidence. The parser validates the
JSON grammar, walks its tokens and retains those original numeric tokens as
strings. It does not reconstruct them from rounded JavaScript numbers. This
works without depending on JSON.parse reviver-context browser support.

Both Bots and shared owner/identity reads use the same parser before schema
validation. Every other numeric field remains subject to the old checks.
Money, position, flag, _ms, count, other-section and nested lookalikes cannot
enter the exemption. Opaque fields reject containers and non-numeric strings.
Their contents do not supply arithmetic, freshness or current controller flags.

Safety ordering, scope coverage, completeness, explicit flags, hold-reason
qualification, progress isolation and the shared clock are unchanged. A
qualified post-acknowledgement read can now supersede old evidence. A NEW
current emergency still renders through the real query path while the reviewed
anomaly remains in the same risk section.

## Fail-before and pass-after

| Check | Original source | Repaired source |
| --- | --- | --- |
| Reported function/render cases | 2 pass, 3 fail | 5 pass, 0 fail |
| Added current-emergency render | covered by failing real-query cases below | 1 pass |
| Expanded real-query cases, Bots and identity | 1 pass, 3 fail | 4 pass, 0 fail |
| Strict/exact JSON boundary guards | added for this repair | 38 pass |

The original function/render schema-invalid precondition is now a schema-valid
assertion. Its previous expectation described the defect, not the required
contract. The old repository unsafe-anomaly negative test is updated likewise.
The three whole-read assertions noted by GPT exist only in the old round-7
review scratch file. They are not repository tests and were not changed.

The real-query before run uses the current tests and actual React/QueryClient
harness with only the three affected source files replaced by their f67a70ef
contents. All three failures are assertions, not dependency/setup errors.
The retained source override is round9-baseline-read.cjs. Reproduce from the
paired workspace layout:

```sh
export TMPDIR=/home/rsi/dev/rsibot/.workspace/scratch/v5-dashboard-polish
export CONDOR=/home/rsi/dev/rsibot/condor/.worktrees/v5-dashboard-polish
export WORKSPACE=/home/rsi/dev/rsibot/.worktrees/v5-workspace-polish
mkdir -p "$TMPDIR/round9-before"
for file in frontend/src/v5/policy.ts frontend/src/v5/usePaperObservation.ts frontend/src/pages/tabs/ActiveBotsTab.tsx; do
  git -C "$CONDOR" show f67a70ef:"$file" > "$TMPDIR/round9-before/$(basename "$file")"
done
REVIEW85_BASELINE_SOURCE="$TMPDIR/round9-before" \
NODE_OPTIONS="--require=$CONDOR/docs/evidence/2026-10-31-v5-dashboard-polish/round9-baseline-read.cjs" \
node --preserve-symlinks --test --test-reporter=tap \
  "$WORKSPACE/dashboard/condor-workspace/test/v5-anomaly-real-query.test.mjs"
```

Install Condor's locked devDependencies first with npm ci. The linked workspace
needs happy-dom and react-test-renderer. Its Condor gitlink still pins be2a3365;
these tests use the newer linked task checkout, not that pin. Merge #85 and bump
the pin before building #625. No gitlink change belongs to this round.

## Final counts and commands

- Python: 4,256 passed, 8 skipped, 18 warnings.
- Condor Node: 1,199 passed, 1 skipped.
- Workspace Node: 573 passed, no skips.
- Focused function/render + strict JSON: 44 passed; real-query: 4 passed.
- Both TypeScript checks pass. New boundary and observation-hook lint passes.
- Existing policy.ts lint errors: the same three before and after. Bots lint
  passes. No unrelated lint repairs are included.
- No getSnapshot-cache, render-depth or render-loop warnings occur in these
  test logs. React-test-renderer's existing deprecation warnings remain.
- Both branch whitespace checks pass. Evidence capture strips trailing blanks.

```sh
# Condor worktree
PYTHONPATH=.:tests:/home/rsi/dev/rsibot/.workspace/scratch/v5-paper-dashboard/pytest-plugin \
  /home/rsi/dev/rsibot/condor/.venv/bin/python -m pytest -q -o addopts= tests
node --test --test-reporter=tap frontend/test/*.test.mjs
(cd frontend && node_modules/.bin/tsc -b)
(cd frontend && node_modules/.bin/eslint src/v5/paper-json.ts src/v5/usePaperObservation.ts)

# Paired workspace dashboard directory
node --preserve-symlinks --test --test-reporter=tap test/*.test.mjs
../../condor/frontend/node_modules/.bin/tsc --noEmit -p .
```

All 13 mutation audits are killed. New no-clock-quarantine restores rejection
and fails one real-query assertion. New rounded-clock-evidence keeps the schema
exception but loses exact text and fails two real-query assertions. The other
11 clock, ordering, partial-qualification, coverage, totals and error-display
audits still kill their mutants. Counts and child assertions are in the full
workspace log in the paired #625 receipt.

## Reproducible bundle

check-v5-reproducibility.mjs rebuild verifies all 35 files across the paired
workspace and a second independent workspace source root. Their workspace
production sources are identical. No reviewed dist artifacts were copied.

- Entry: assets/v5-OBYSWSaP.js
- Entry SHA256: 1511494b786890b341dd283d5215435a3fc511daeae46e98f8ec5481210620ec
- Manifest SHA256: 532224e69ad1a191ef6514a1f26a4659d82ef7f8a8fa2b756379f9c6a7500f0e

```sh
node frontend/tooling/check-v5-reproducibility.mjs rebuild \
  "$TMPDIR/round9-repro" "$WORKSPACE" "$TMPDIR/workspace-independent"
```

No new visual layout, service link or deployment is claimed. No browser service
was started. Earlier screenshots and latency results remain historical. The
gcTime safety-expiry, pre-sleep-frame and upstream emergency-clear follow-ups
remain deferred. Rollback is a revert of this round's feature commits.
