# Frame-consistent shared paper clock — 2026-11-01

The hook now returns exactly the snapshot that React checks. It does not sample
wall time during render. The accepted GPT probe fails at `74f777c9` and passes
with this repair. All 17 real route cases remain in the permanent regression.
This is local source and build evidence. It is not deployment qualification.

## Scope and cause

Owner: Condor. Existing branch:
`feat/andrzej_v5_settings_render_loop_20261101`, PR #88.
Pre-fix head: `74f777c96af585f59914a2bede5a571e0e68aa44`.
Bundle workspace: rsibot `6a408057ca50dbd27de051b094289fafec8ed34f`.
Authority: repository-process-only and disposable paper fixtures.
No live service, token, API, host-export, monitor path, paper control, data store,
Tailscale route, image swap, merge or workspace pin was touched.

The rejected hook subscribed React to `published`, then returned `observe()`.
Settings and PaperIdentity could therefore render different freshness states in
one commit. React's consistency check could not see the second clock value.
The new store has one monotonic value, `published`. Module initialization creates
one document store before render. Subscribe/mount, the one-second timer, focus
and visibility events advance that value with `Math.max`. Snapshot reads only
return it. The hook directly returns `useSyncExternalStore`'s checked value.
The store survives navigation and a zero-subscriber gap. Unsubscribe removes
the timer and event listeners when the last subscriber leaves, not its history.

The original loop's introducing commit and bisect evidence remain in README.md.
This revision fixes the separate same-frame contradiction introduced by the
first repair. No owner query, snapshot retention, safety or capital code changes.

## Permanent boundary and lifecycle tests

`frontend/test/v5-route-render-loop.test.mjs` incorporates the review probe from
`review-88-gpt/review-evidence/workspace-1/condor/frontend/test/review-settings-frame.test.mjs`.
It still mounts the real V5App, QueryClientProvider, MemoryRouter, Auth/Server
providers, real page queries, snapshot hooks and shared clock over recorded
owner fixture sections. The status wrapper is set to available, with no reason,
to exercise the available-to-stale boundary. Owner payloads remain fixture data.

The test publishes exactly 30,000 ms by focus. Both Settings and PaperIdentity
must be fresh, with `paper owner reads: available` and `snapshot only` present.
It then advances the wall clock by 1 ms at the real PaperIdentity entry during
a Settings query-cache update. The source-transform anchor must occur exactly
once. No clock hook, query or freshness predicate is replaced. Without another
publication, the frame must stay fresh in both consumers. The permanent failure
message is:

```text
Settings must not call owner reads available while identity marks the same snapshot stale
```

Focus then publishes 30,001 ms. Settings must show `stale; not current`, without
`snapshot only` or `paper owner reads: available`. All route cases still check
for render loops, React warnings, a mounted page and mapped owner reads.
The fixture transport permits only GET. It is not a live Operations or candle
data qualification. Every registered non-wildcard route must have a test case.

`frontend/test/v5-clock-session.test.mjs` now models mount/subscribe outside
render. Its 45 s -> 25 s -> 61 s high-water scenario still passes. It retains
the 5 s future-skew boundaries, exact 30,000/30,001 ms freshness boundary,
focus/visibility publication, one timer and zero-subscriber-gap checks.
The rejected requirement that render sample a separate time is replaced with
the store contract: snapshot reads do not sample time, the next timer tick
publishes stale at 30,001 ms, and a clock rollback plus focus cannot make it
fresh again. No route case or safety outcome was removed.

## Fail-before / pass-after

The final two regression files were copied onto a `git archive` of exact
`74f777c9` (frontend, tests/fixtures and condor/v5). Dependencies came from the
task worktree by symlink. The archive did not contain the repaired clock.

```bash
export S=/home/rsi/dev/rsibot/.workspace/scratch/v5-settings-loop-20261101
export W="$S/condor"
export TMPDIR="$S/tmp"
git archive 74f777c96af585f59914a2bede5a571e0e68aa44 \
  frontend tests/fixtures condor/v5 | tar -x -C "$S/revision2-before-src"
cp frontend/test/v5-clock-session.test.mjs \
  frontend/test/v5-route-render-loop.test.mjs \
  "$S/revision2-before-src/frontend/test/"
ln -s "$W/frontend/node_modules" "$S/revision2-before-src/frontend/node_modules"
(cd "$S/revision2-before-src" && V5_WORKSPACE_ROOT="$S" node --test \
  frontend/test/v5-clock-session.test.mjs \
  frontend/test/v5-route-render-loop.test.mjs)
V5_WORKSPACE_ROOT="$S" node --test frontend/test/v5-clock-session.test.mjs \
  frontend/test/v5-route-render-loop.test.mjs
```

The before run exits 1: 24 passed, 2 failed. Settings fails with the exact
contradiction message; its parent suite reports the failed child. All 16 sibling
routes and all 8 clock tests pass. The after run exits 0: 26 passed, 0 failed,
0 skipped. Logs: `revision2-final-tests-before.tap.gz` and
`revision2-render-clock-after.tap.gz`. No forced process exit was needed.

## Reproducible reviewed bundle

The only frontend production source change is usePaperClock.ts. Regeneration
uses `distHashes` and `verifyDist` from the documented
`frontend/tooling/check-v5-reproducibility.mjs` tooling. The prior manifest
rejects the new build with `V5 dist differs from the reviewed manifest`.
The new manifest accepts it. Its entry is:

```text
before: assets/v5-CRFJ14k7.js
SHA256: c04279325fe9c1ceb5135becc91689c1ece946ac32fffe11675be6eeb6fdd488
after:  assets/v5-Dxi6xJDB.js
SHA256: 19d1bd94a9c025b5229cb324c6e4f310f028ae0967300fceb1ad7610fc508e0f
```

Each workspace below was freshly archived from exact rsibot 6a408057. Each
contains a Condor symlink to the task worktree. Both fresh output builds match
the complete reviewed manifest: 35/35 files, including entry hash. The existing
large-chunk warning remains a warning, not a build failure.

```bash
for index in 1 2; do
  mkdir "$S/revision2-workspace-$index"
  git -C /home/rsi/dev/rsibot archive \
    6a408057ca50dbd27de051b094289fafec8ed34f dashboard | \
    tar -x -C "$S/revision2-workspace-$index"
  ln -s "$W" "$S/revision2-workspace-$index/condor"
done
(cd frontend && V5_WORKSPACE_ROOT="$S/revision2-workspace-1" \
  node_modules/.bin/vite build --config vite.v5.config.ts \
  --outDir "$S/revision2-seed-dist")
node docs/evidence/2026-11-01-v5-settings-render-loop/revision2-regenerate-manifest.mjs
node frontend/tooling/check-v5-reproducibility.mjs rebuild \
  "$S/revision2-reproducibility" "$S/revision2-workspace-1" \
  "$S/revision2-workspace-2"
node frontend/tooling/check-v5-reproducibility.mjs verify \
  "$S/revision2-reproducibility/build-1"
node frontend/tooling/check-v5-reproducibility.mjs verify \
  "$S/revision2-reproducibility/build-2"
```

The generated manifest and build logs are retained with this evidence. The
before manifest is `revision2-reviewed-build-before.json`. The exact generator
is retained as `revision2-regenerate-manifest.mjs`, for execution from the
Condor repository root after the seed build.

## Owner validation and rollback

All checks below ran locally on the revised source and reviewed bundle.
TMPDIR stays below .workspace/scratch. The isolated pytest-asyncio 1.2.0 plugin
is the same task-local plugin used for the first revision. The shared Python
environment is not modified. Full Node tests use the required dashboard/condor
sibling layout under S. No new skip or lowered minimum is introduced.

| Check | Observed result | Retained log |
| --- | --- | --- |
| Full Condor pytest | 4,366 passed; 8 skipped; 18 warnings | revision2-pytest-full.log.gz |
| Full Condor Node | 1,242 passed; 1 skipped; 0 failed | revision2-node-full.tap.gz |
| Route + clock after repair | 26 passed; 0 failed; 0 skipped | revision2-render-clock-after.tap.gz |
| Same final tests on 74f777c9 | Expected failure: 24 passed; 2 failed | revision2-final-tests-before.tap.gz |
| TypeScript build | PASS, exit 0 | revision2-tsc.log.gz |
| Clock ESLint | PASS, exit 0 | revision2-eslint-clock.log.gz |
| Independent fresh builds | 35/35 files each; same entry hash | revision2-reproducibility.log.gz |
| Old manifest rejection/new acceptance | PASS | revision2-manifest-regenerate.log.gz |
| Bundle guard helper tests | 2 passed | revision2-bundle-tests.tap.gz |
| Final shadow diff | git diff --check PASS | Local check |

Exact owner-suite commands, from the task's Condor worktree:

```bash
export S=/home/rsi/dev/rsibot/.workspace/scratch/v5-settings-loop-20261101
export TMPDIR="$S/tmp"
PYTHONPATH="$S/test-plugins:$PWD:$PWD/tests" \
  /home/rsi/dev/rsibot/condor/.venv/bin/python -m pytest -q -o addopts= tests
V5_WORKSPACE_ROOT="$S" node --test frontend/test/*.test.mjs
(cd frontend && node_modules/.bin/tsc -b)
(cd frontend && node_modules/.bin/eslint src/v5/usePaperClock.ts)
node --test frontend/test/v5-build-reproducibility.test.mjs \
  frontend/test/v5-bundle-proof.test.mjs
git diff --check
```

The first local after-run initialized fixture time after loading workspace
modules. Module-level clock creation therefore correctly retained the real
wall-time high-water, making that fixture stale. The corrected harness sets
fixture time before loading any application modules. This is test setup only;
no clock reset or production fallback was added. The final before/after proof
uses the same corrected regression files. The full suites pass on that source.

Disk checks before dependency installation, the full suites and fresh builds
showed 43-44 GiB available. The final check shows 43 GiB, above the 25 GiB floor.
Unrelated root and nested checkout changes remain untouched. Root synchronization
was dry-run only, recorded in revision2-root-sync-dry-run.log.gz.

Rollback is a normal reviewed revert of this revision and its manifest.
That would restore the rejected frame-consistency defect; it is not a release
recommendation. No operational rollback is needed because nothing was deployed.
After parent merge, the separately authorized pin-only rsibot PR and disposable
image qualification remain required. Browser/live qualification is unverified.

Blocked on parent: review and merge the revised Condor #88 before any pin step.
Changed: shared clock, permanent boundary/lifecycle tests, reviewed bundle and evidence.
Found: separate render samples allowed contradictory freshness in one committed frame.
