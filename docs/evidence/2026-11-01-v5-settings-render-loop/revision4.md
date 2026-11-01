# Microtask-scoped document clock — 2026-11-01

The clock now observes wall time on every new render turn without giving each
consumer a separate time. All consumers and React's synchronous consistency
checks read one cached high-water value. A microtask clears the cache. The next
turn samples again. Timer, subscription, focus and visibility updates still
sample and notify. This is source repair evidence, not deployment qualification.

## Scope and authority

Condor branch: `feat/andrzej_v5_settings_render_loop_20261101`, PR #88.
Previous head: `6f6ff2ddaa75f8092db105a0e78137fbe9a13602`.
Bundle and workspace test baseline: rsibot
`6a408057ca50dbd27de051b094289fafec8ed34f`.

Only usePaperClock.ts changes production behavior in this revision. The manifest
is regenerated with the documented tooling. Test and evidence files retain the
review failures. No owner response, safety retention, capital policy or page
implementation changes. No live service, data store, token, monitor path,
host-export, control, route, deployment, merge or default branch write occurred.
No subagents were used. All temporary output is under the task's scratch root.

The rsibot harness edits are separate. They are not applied to Condor's workspace
dependency or included in the reviewed V5 bundle. The follow-up rsibot branch
starts at fresh origin/main `5f169150b11e4581bf83a02c7aca202b71350d12`.
Its dashboard sources are identical to the required 6a408057 baseline.

## Cause and mechanism

Revision 2 refreshed only in subscription or browser events. React subscribes
after the first commit. A retained query therefore rendered with frozen time
after an idle gap. Rerenders without a timer or focus event also used frozen
time. A dormant-only experiment addressed the first case but not the second.
It was superseded without publication.

`getSnapshot` now samples `Math.max(highWater, readNow())` on its first call in a
synchronous turn. It caches that value until a queued microtask clears the flag.
Later consumers in that turn return the store snapshot itself, not another
sample. The shared clock is initialized lazily. Its high-water survives
navigation, zero-subscriber gaps and clock rollback. There is still one interval
for all subscribers. No age rounding, safety reset or owner-data refresh is used
to conceal expiration.

The clock's `observe` operation performs the native high-water sample inside the
cached getter. This preserves the existing no-render-sample mutation target.
The high-water and lazy-singleton mutation anchors also remain intact. No
rsibot mutation definition or expected failure count changed.

## Harness boundary correction

The synchronous SSR tests previously advanced wall time and rendered another
simulated frame in the same JavaScript turn. A browser cannot pass real wall
time between frames without a turn boundary. The parent authorized only a
lifecycle correction, not new expectations.

`revision4-harness-boundaries.patch` contains the exact complete rsibot diff.
Six existing test files gain helper imports, async callback markers and
`await nextRenderTurn()` before clock steps. The new three-line helper awaits
a microtask. After stripping only those additions and async markers, all six
files are byte-identical to 6a408057. No case, assertion, expectation, minimum,
mutation, fixture or owner state changes. See `revision4-harness-identity.txt`.
The patch SHA256 is
`07251583611e3aa9e727aec0ead86b9a904f1c823f7bb3d6ef7b217c3393286b`.

The earlier incomplete-layout review was not a valid baseline. The reference
layout includes dashboard/, deploy/ and scripts/ from exact rsibot 6a408057,
plus the physical Condor source tree, native fixtures and installed frontend
dependencies. The original unedited suite passed 573/573 in that layout
(`workspace-reference-3dc-full.tap.gz`). The corrected historical matrix uses
the same layout and the same boundary overlay at every Condor revision.

## Fail-before / pass-after

| Check | Before | After |
| --- | --- | --- |
| Temporal matrix at 3dc5ab07 | 67 passed, 0 failed | Baseline preserved |
| Same matrix at rejected 6f6ff2dd | 39 passed, 28 failed | 67 passed, 0 failed |
| Timed frame probe at 74f777c9 | Settings and parent suite fail; available/stale contradiction | Pass |
| Delayed Settings first commit and four idle-gap probes at 6f6ff2dd | All five fail; timed frame probe still passes | All pass; 7/7 including frame subtest |
| Never-clear-cache mutation | Named next-turn freshness assertion fails | Unmutated oracle passes |
| Raw-time/no-cache mutation | Settings reports Maximum update depth exceeded; 6 failures including parent | All 17 routes pass |

The matrix includes the full v5-document-clock-claude suite (including R4-A),
N1/N1b, R5-clock, Q1/Q2 and B1/B2. The rejected head still fails N1 and N1b by
name. Its failures were not hidden by the lifecycle correction.

The permanent Condor regressions include GPT's delayed first-commit case,
Claude's timed Settings/PaperIdentity frame probe, and all four actual-router
idle-gap probes (Settings/Capital, including cached variants). They use real
React DOM, QueryClientProvider, MemoryRouter, shared providers and recorded owner
responses. The route test still mounts all 17 registered routes. It also checks
the stale flip after 30,001 ms and focus, with no `snapshot only` label. Its
obsolete event-only render assertion is replaced by the parent's current-turn
contract; the available/stale contradiction assertion remains.

The mutation helper asserts exactly one source anchor per mutation. The two
permanent mutation tests require the real regression to fail by name, not merely
exit nonzero. The raw-time case must fail Settings with the real React loop.

## Commands and results

Use these exact task roots:

```bash
S=/home/rsi/dev/rsibot/.workspace/scratch/v5-settings-loop-20261101
W=$S/condor
export TMPDIR=$S/tmp
```

Owner checks from `$W`:

```bash
PYTHONPATH="$S/test-plugins:$PWD:$PWD/tests" /home/rsi/dev/rsibot/condor/.venv/bin/python -m pytest -q -o addopts= tests
V5_WORKSPACE_ROOT="$S" node --test --test-reporter=tap frontend/test/*.test.mjs
(cd frontend && node_modules/.bin/tsc -b)
(cd frontend && node_modules/.bin/eslint src/v5/usePaperClock.ts)
```

- Pytest: 4,366 passed, 8 skipped, 18 warnings.
- Node: 1,252 passed, 1 skipped, 0 failures.
- TypeScript and scoped ESLint: exit 0.
- An earlier superseded run had four deadline failures. No test or backend file
  was changed. Their focused rerun passed 4/4, then the full run above passed.
  Both the failed run and successful reruns are retained.

Workspace checks from each archived layout's `dashboard/condor-workspace`:

```bash
node --preserve-symlinks --test --test-reporter=tap test/v5-document-clock*.test.mjs test/v5-clock-skew*.test.mjs test/v5-real-first-frame.test.mjs test/v5-real-boundaries.test.mjs test/v5-received-holds-claude.test.mjs
node --preserve-symlinks --test --test-reporter=tap test/*.test.mjs
"$W/frontend/node_modules/.bin/tsc" --noEmit -p tsconfig.json
```

The final full workspace suite passes 573/573, with no skips or failures,
recorded in `revision4-workspace-final-full.tap.gz`. Workspace TypeScript exits 0.
The production frontend source in that layout is byte-identical to `$W`.

Mutation proofs from `$W`:

```bash
V5_WORKSPACE_ROOT="$S" node --test --test-reporter=tap frontend/test/v5-clock-mutations.test.mjs
V5_WORKSPACE_ROOT="$S" V5_CLOCK_MUTANT=never-clear node --test --test-reporter=tap --test-name-pattern='render reads share' frontend/test/v5-clock-session.test.mjs
V5_WORKSPACE_ROOT="$S" V5_CLOCK_MUTANT=raw-now node --test --test-reporter=tap --test-name-pattern='real V5 routes' frontend/test/v5-route-render-loop.test.mjs
```

The mutation-proof suite passes 2/2. Each direct mutant exits 1. Logs retain
the named assertion and React component stack. No forced process exit is used.

## Reviewed bundle

The two independent workspace directories contain fresh git archives of rsibot
6a408057 dashboard/. Each build runs in a fresh Vite process and a fresh output
directory. No harness edit enters those archives.

```bash
cd "$W/frontend"
V5_WORKSPACE_ROOT="$S/revision4-workspace-1" node node_modules/vite/bin/vite.js build --config vite.v5.config.ts --outDir "$S/revision4-final-seed-dist" --emptyOutDir false
cd "$W"
S="$S" node docs/evidence/2026-11-01-v5-settings-render-loop/revision4-regenerate-manifest.mjs
node frontend/tooling/check-v5-reproducibility.mjs rebuild "$S/revision4-reproducibility" "$S/revision4-workspace-1" "$S/revision4-workspace-2"
```

The generator uses the documented `distHashes` and `verifyDist`. The old
manifest rejects the seed build. The new manifest accepts both independent
builds, matching all 35/35 files.

Before: `assets/v5-Dxi6xJDB.js`, SHA256
`19d1bd94a9c025b5229cb324c6e4f310f028ae0967300fceb1ad7610fc508e0f`.

After: `assets/v5-C5WY8ZMw.js`, SHA256
`c9da29c2eecf93fca07f80c3e41079755cc529d04666f8e391233e7c677d3403`.

Disk checks before heavy steps showed at least 37 GiB free. The 25 GB floor was
not crossed. Existing dependency and build caches were reused.

## Handoff and rollback

The Condor branch remains a draft pending independent review and the parent's
merge. The separate rsibot branch contains only its Condor gitlink plus the
seven harness-boundary files. No component-lock entry is added.
No live rollback is required because no service changed. A repository rollback
is a follow-up commit reverting the clock and matching manifest, or retaining
the current main pin. Never deploy an unreviewed manifest or merge these PRs as
part of this worker's task. Dashboard image qualification remains unverified and
must resume only after both parent-approved merges.
