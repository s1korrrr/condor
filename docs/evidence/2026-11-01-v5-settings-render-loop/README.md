# Settings render-loop repair — 2026-11-01

## Current revision: one cached time per microtask turn

Revision 2 closed frame tearing but froze the clock before a delayed first
commit and during event-free rerenders. The parent accepted both blockers at
`6f6ff2dd` and authorized a microtask-scoped snapshot cache. The dormant-only
experiment was not published. See [revision4.md](revision4.md) for the repair,
unchanged-assertion harness diff, historical matrix and current evidence.
All earlier reports and logs are historical, not current approval evidence.

## Historical second revision: frame-consistent publication

The original repair below stopped the render loop but returned a separate
wall-clock sample to each consumer. The parent accepted GPT's frame-consistency
blocker at `74f777c9`. That design is superseded. See
[revision2.md](revision2.md) for the repair, permanent boundary probe, exact
commands, new bundle hashes and current validation. The earlier logs remain
historical evidence, not approval of the rejected per-consumer sampling design.

## Historical first revision

The Settings loop is repaired at the shared paper clock boundary. The dev DOM
renderer reproduces the original error before the repair and renders Settings
after it. All 17 registered V5 route patterns now mount and settle with the real
providers. This is repair evidence, not dashboard deployment qualification.

## Scope and authority

Base: Condor `3dc5ab0798c0c21d9ad1e00f402b7d207a22f309`.
Branch: `feat/andrzej_v5_settings_render_loop_20261101`.
Bundle workspace: git-archived rsibot
`6a408057ca50dbd27de051b094289fafec8ed34f`.

Only the clock implementation, render tests, test module resolver, reviewed
manifest and this evidence change. No execution, capital, owner-query, safety
retention, learning, or Operations behavior is changed. No live token, live
observation API, host-export, monitor input, service, unit, or route was used.
No dashboard swap, paper activation, model call, merge, or default-branch write
occurred. S2/S3 remain inputs to the next authorized qualification.

## Cause and introducing commit

`git bisect` over `be2a3365..3dc5ab07` identifies:

`d81f105f8e1e571a2b1966f96894e84b74e4e021`
— `fix(v5): sample render clock and qualify risk clearance`.

Its immediate parent `d4f15a672d728ba715e4d7022231fd80858dffd5` passes
the same reproducer. The bad commit entered main through #85 at
`22f520f2222c0f87fff8886a50a0259d7f183f85`. #84 did not introduce the loop.

The dev React stack names SettingsPage. Its usePaperObservation call and its
PaperIdentity child's usePaperObservation call share the document clock:

```text
SettingsPage -> usePaperObservation -> usePaperClock -> observe()
PaperIdentity -> usePaperObservation -> usePaperClock -> observe()
  later render sample changes the high-water value returned by getSnapshot
React updateStoreInstance -> forceStoreRerender
  earlier consumer's rendered snapshot no longer equals the current store
another render -> another time sample -> another store mismatch -> repeat
```

The development error is `Maximum update depth exceeded`, through
forceStoreRerender/updateStoreInstance. Production reported React #185.
No query or snapshot hook is stubbed in the permanent regression.

The repair separates the **published store snapshot** from the **monotonic
sampled time**. Subscription, interval, focus and visibility events publish
the store value and notify subscribers. During render, useSyncExternalStore
reads that stable published value. The hook still returns a precise time sample
from the same document high-water clock. Sampling cannot change the value
React checks for external-store consistency.

This preserves millisecond freshness checks, rollback resistance, one shared
interval, and high-water retention across a zero-subscriber gap. It does not
round time, freeze time, suppress errors, remove either Settings consumer,
bypass owner validation, or reset safety state.

## Permanent regression

`frontend/test/v5-route-render-loop.test.mjs` mounts the real V5App with its
QueryClientProvider, Auth/Server providers, app shell, real page components,
MemoryRouter, usePaperSnapshot, usePaperObservation and shared paper clock.
Date.now advances by one millisecond per read. Settings has two real clock
consumers; no error requires a timing race to reproduce.

The read transport serves recorded paper API native-replay fixtures unchanged.
Identity/settings and disabled projection scaffolding supply the surrounding
read-only app contracts. The test refetches active real queries, checks the
returned health sections against all five owner fixtures, publishes focus,
and asserts no caught error, no React warning, a mounted main, and page text.
It checks the route inventory, so adding a route requires a new render case.
Only GET is permitted. An unmapped app read fails the test.

The test covers Settings, Bots, Capital, Operations, Readiness, Tradepad,
Market, Market evidence, Candles, Agents, Decision Reviewer, Research,
Learning, Factory, Lineage, Sessions, and a session detail. Dynamic agent and
session route patterns use one concrete case each. Wildcard redirect is not
a page and is excluded from the inventory.

Operations' fixture remains the known native fallback envelope. This test
checks render stability, not successful host-monitor Operations integration.
The candle store is unconfigured in this fixture profile. The actual page still
mounts; this is not a candle-data browser qualification claim.

The existing module harness now resolves extensionless .js/.mjs owner modules.
Research imports lab-network-engine.js. This loads the actual module rather
than skipping Research or substituting a component. The native singleton
candleStore.dispose method runs during teardown; no force-exit is required.

`frontend/test/v5-clock-session.test.mjs` adds the invariant that a render
sample crosses the exact 30,001 ms stale boundary without changing getSnapshot.
It then checks rollback resistance and focus publication. Existing precision,
freshness/skew, interval, visibility, unsubscribe, and remount cases remain.

## Fail-before/pass-after

The final two test files and resolver ran against an archived unmodified
`3dc5ab07` source tree, with its frontend, paper validator and recorded fixtures.
They report **23 pass / 3 fail / 0 skipped**. The failures are the new clock
snapshot invariant, `/settings` with maximum update depth, and its parent test.
Every sibling route passes before the repair.

The identical tests with the repaired source report **26 pass / 0 fail /
0 skipped**. The original dev reproducer also reports `PASS Settings rendered`.
Neither final proof uses --test-force-exit, reduced assertions, route skips,
hook overrides, retries, or a changed owner fixture.

Commands from the Condor checkout:

```bash
export S=/home/rsi/dev/rsibot/.workspace/scratch/v5-settings-loop-20261101
export TMPDIR="$S/tmp"
node --test frontend/test/v5-route-render-loop.test.mjs \
  frontend/test/v5-clock-session.test.mjs
```

The baseline command is identical, with cwd `$S/baseline-condor`.
Its node_modules symlink uses the same pinned npm-ci dependency installation.
Proof logs: `final-harness-before-layout.tap.gz`, `render-and-clock-after.tap.gz`.
Dev reproducer and bisect output: `dev-reproduction-before.log.gz`,
`dev-reproduction-after.log.gz`, `bisect.log.gz`, `bisect-decisions.txt`.

Bisect commands in the own worktree, before implementation:

```bash
git bisect start 3dc5ab0798c0c21d9ad1e00f402b7d207a22f309 be2a3365
git bisect run node "$S/reproduce.mjs" "$S/condor"
git bisect log
git bisect reset
```

## Reviewed bundle

The manifest was generated only with the documented distHashes/verifyDist
functions in frontend/tooling/check-v5-reproducibility.mjs. The old manifest
rejects the repaired seed build with `V5 dist differs from the reviewed manifest`.
The regenerated manifest accepts it. Two further fresh Vite builds from
independent git-archived workspace roots each verify all **35/35 files**.

Old entry: `assets/v5-DSygPxRb.js`.
Old SHA256: `15badf3586f56907cf368d06877b8b6d62896c2bfaf46e15478a3def86f73611`.
New entry: `assets/v5-CRFJ14k7.js`.
New SHA256: `c04279325fe9c1ceb5135becc91689c1ece946ac32fffe11675be6eeb6fdd488`.

```bash
(cd frontend && npm ci --no-audit --no-fund)
(cd frontend && node_modules/.bin/tsc -b)
(cd frontend && V5_WORKSPACE_ROOT="$S/workspace-1" \
  node_modules/.bin/vite build --config vite.v5.config.ts \
  --outDir "$S/seed-dist-layout")
node frontend/tooling/check-v5-reproducibility.mjs rebuild \
  "$S/reproducibility" "$S/workspace-1" "$S/workspace-2"
node frontend/tooling/check-v5-reproducibility.mjs verify \
  "$S/reproducibility/build-1"
node frontend/tooling/check-v5-reproducibility.mjs verify \
  "$S/reproducibility/build-2"
```

Each workspace root contains its own archived dashboard tree plus a Condor
symlink to the owner worktree. An initial build/test invocation used the earlier
Docker-only archive without its workspace/condor sibling and failed resolution.
Restoring the documented sibling layout fixed this environment error. No source
fallback or relaxed build guard was added. Logs retain that failed invocation.
The build emits the existing large-chunk warning; both builds succeed.

## Owner validation

All commands ran locally. TMPDIR stayed under the task's .workspace/scratch
directory. No suite, assertion, minimum, or stage was removed or weakened.

| Check | Result | Evidence |
| --- | --- | --- |
| Full Condor pytest | 4,366 passed; 8 skipped; 18 warnings | pytest-full-plugin.log.gz |
| Full Condor Node tests | 1,242 passed; 1 skipped; 0 failed | node-full-layout.tap.gz |
| Final route + clock regression | 26 passed; 0 skipped | render-and-clock-after.tap.gz |
| Bundle helper/proof tests | 2 passed | bundle-tests.tap.gz |
| TypeScript build | PASS, exit 0 | tsc-final.log.gz |
| Clock source lint | PASS, exit 0 | eslint-clock.log.gz |
| Independent reviewed builds | 35/35 each | reproducibility.log.gz |
| Old manifest rejection/new acceptance | PASS | manifest-regenerate.log.gz |
| git diff --check | PASS | Local shadow-diff check |

Exact full-suite commands, from the Condor task worktree:

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

The shared Python environment lacks the declared pytest-asyncio development
plugin. The initial command without it reports 70 async-test failures,
4,296 passes and 8 skips. It did not execute those async tests. The corrected
full command uses pytest-asyncio 1.2.0 copied into the task's own test-plugins
directory from the earlier task-owned Phase 3b1 plugin directory. The shared
environment was not modified. All 70 tests then execute and pass. The initial
failed run is retained in pytest-full.log.gz, not represented as source failure
or as a pass. pytest-full-plugin.log.gz is the complete corrected run.

The Node suite requires ../dashboard and ../condor siblings. S/dashboard points
to the already archived rsibot 6a408057 dashboard tree; S/condor is this owner
worktree. The first full invocation selected the earlier Docker-only archive
as workspace root. Its missing workspace/condor source caused a setup error
in the new render test (1 failed, 1,224 passed, 1 skipped). The corrected full
run exercises all 17 route cases and passes 1,242 tests. Both logs remain.

No real-browser or deployed-image PASS is claimed for S1. The dev React DOM
renderer identifies and locks down the loop. The parent-authorized post-merge
Phase 3 remains necessary. Final disk check before publication: 45 GiB free,
above the 25 GiB floor.

## Rollback and remaining boundary

Revert this repair through the normal reviewed repository process to restore
the previous source and manifest. That also restores the known Settings loop;
it is not a recommended deployment. No runtime rollback is needed: nothing
was deployed. The prior unqualified image remains unqualified.

After parent merge: a separate pin-only rsibot PR, parent merge, then a fresh
image build and full disposable qualification. The next qualification must use
the newly authorized read-only host export and observation binding for S2/S3.
This repair does not claim fresh Capital/BUY coverage or live Operations PASS.

Blocked on parent: review and merge this Condor repair; authorize the next pin step.
Changed: shared clock publication, route/clock regression coverage, reviewed bundle and evidence.
Found: #85 d81f105f introduced a render-time external-store mutation; no deployment performed.
