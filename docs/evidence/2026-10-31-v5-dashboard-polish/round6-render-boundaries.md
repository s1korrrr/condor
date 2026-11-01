# Round-5 review repair: render-time clock and risk clearance

The reported failures are repaired locally. New-head independent review is
pending. Inputs: Condor `d4f15a672d728ba715e4d7022231fd80858dffd5` and rsibot
`585e993fc5bdf9f2112ad1a657cfe28c1a79e618`. This receipt supersedes the previous
receipt's timestamp-based clearance and synthetic-focus harness descriptions.

## Cause and repair

The document clock stopped sampling after its last subscriber left. Its cached
value could survive into the first committed remount frame. A mounted rerender
also reused the cache when no interval callback ran. `usePaperClock` now calls
`observe()` before `useSyncExternalStore` on every render. `getSnapshot` still
returns the cached numeric high-water value. The document singleton, interval,
focus/visibility listeners, <= 30,000 ms freshness and 5,000 ms skew bound stay
unchanged. Backward clock steps cannot reduce the high-water mark.

The old completion helper selected status. That envelope could erase safety
evidence even when risk was unavailable. It now selects only coherent risk from
the completed aggregate. Clearance also requires available, complete,
schema-valid risk, no continuation, no positive safety signals and complete
native controllers with explicit false emergency/pause observations. A status
envelope, empty risk object, degraded risk or incomplete risk cannot clear it.

Safety ordering now uses owner `source.boot_id` and `source.sequence`. A later
qualified replacement boot supersedes an older boot. A higher sequence orders
observations within one boot. Wall time is not an ordering fallback. Missing
or invalid owner ordering keeps the hold fail-safe. A retained null generated
time is irrelevant when sequence/boot ordering is known. Receipt order here is
the existing serialized coherent-query completion path; it is not a lexical
comparison of boot IDs. Attempt cancellation, bot/query isolation and retained
data semantics remain unchanged. No API source changes are included.

On first-load failure, Bots now shows `Owner snapshot unavailable`, the error
diagnostic and any received safety banner. It no longer shows the pending panel.

## Fail-before and pass-after

The original reviewer files ran unchanged against the supplied archived heads:

| Reviewer regression | Before | After, portable real-renderer copy |
| --- | --- | --- |
| Claude ten probes, including N1 Bots and N1b Capital first commit | 8 pass / 2 fail | 10 pass / 0 fail |
| GPT eight boundary probes, including stopped-interval rerenders, unavailable risk and boot replacement | 3 pass / 5 fail | 8 pass / 0 fail |

The workspace retains these in `test/v5-real-first-frame.test.mjs` and
`test/v5-real-boundaries.test.mjs`. Two further real-renderer regressions cover
the first-load error panel and same-boot higher sequence at equal wall time.
There are 20 real-renderer probes in total. Condor's twelve direct risk tests
also cover null retained times, sequence ties/regression, unknown ordering and
six non-affirmative clearance candidates. The original fifteen real-hook
first-load/refresh/rollback signal cases all pass in the current full suite.

`test/helpers/paper-temporal.mjs` no longer dispatches focus during render.
Its snapshot read precedes subscription. The first-frame suite uses real
React 19.2.4, `react-dom/client`, happy-dom 20.14.6 and a real QueryClientProvider.
A layout effect records the committed DOM before passive subscriptions. Its
diagnostic collector requires no React errors. The GPT suite keeps the real
React test renderer 19.2.4 and QueryClientProvider. Its expected renderer
deprecation notice is not a snapshot-cache warning. Both dependencies are
exact, test-only Condor dev dependencies. No production hook is stubbed in
either real-renderer suite. Unrelated charts and browser I/O are fixture-only.

The final full workspace log contains no `getSnapshot should be cached`,
`Maximum update depth exceeded`, `Too many re-renders`, or unwrapped-act warning.

## Mutation evidence

Four isolated source mutants are rejected by real-renderer assertions:

| Mutant | Assertion failures |
| --- | ---: |
| Remove render-time sampling | 2: N1 and N1b |
| Restore pending panel after first-load failure | 1 |
| Allow unqualified risk to clear safety | 1 |
| Order safety clearance only by timestamp | 2: replacement boot / tied timestamp |

These audit tests require assertion failures, exact failure counts and no
snapshot-cache/render-loop diagnostics. Setup failures do not count. The prior
high-water, per-mount clock and always-fresh audits still kill their mutants
with 6, 2 and 2 assertion failures. No source file is edited by a mutation run.

## Commands and counts

Use Node v24.21.0 and the paired workspace layout, with workspace `condor`
temporarily linked to the repaired Condor checkout. The unchanged #625 gitlink
still pins `be2a3365`: merge #85 and bump that pin before building #625. Every
workspace result here used the newer linked Condor, not the pinned checkout.

```bash
export TMPDIR=/home/rsi/dev/rsibot/.workspace/scratch/v5-dashboard-polish
# Condor worktree
PYTHONPATH=.:tests:/home/rsi/dev/rsibot/.workspace/scratch/v5-paper-dashboard/pytest-plugin \
 /home/rsi/dev/rsibot/condor/.venv/bin/python -m pytest -q -o addopts= tests
node --test --test-reporter=tap frontend/test/*.test.mjs
(cd frontend && node_modules/.bin/tsc -b)
(cd frontend && node_modules/.bin/eslint src/v5/usePaperClock.ts \
 src/v5/usePaperSnapshot.ts src/v5/paper-safety.ts src/pages/tabs/ActiveBotsTab.tsx)
node --test frontend/test/v5-build-reproducibility.test.mjs
# rsibot worktree/dashboard/condor-workspace
node --preserve-symlinks --test --test-reporter=tap test/*.test.mjs
../../condor/frontend/node_modules/.bin/tsc --noEmit -p .
node --preserve-symlinks --test --test-concurrency=1 \
 test/v5-real-first-frame.test.mjs test/v5-real-boundaries.test.mjs \
 test/v5-real-boundary-mutations.test.mjs
```

- Python: 4,256 passed, 8 skipped, 18 existing warnings.
- Condor Node: 1,119 passed, 1 skipped.
- Workspace Node: 553 passed, including four new mutation audits.
- Both typechecks and targeted lint: PASS. Post-manifest build-helper: 1 pass.
- Both full-branch whitespace checks: PASS.

`round6-logs/` stores sanitized, gzip-compressed baseline, full-suite and bundle
logs. Capture strips trailing blanks before `gzip -n`; inspect with
`gzip -dc round6-logs/condor-node.tap.gz`. The paired workspace receipt stores
its complete 553-test log. Intermediate local debugging logs remain in task
scratch; they are not approval evidence.

## Rebuilt reviewed bundle

Built a fresh seed, regenerated the manifest, then ran:

```bash
node frontend/tooling/check-v5-reproducibility.mjs rebuild \
 "$TMPDIR/round6-repro" /home/rsi/dev/rsibot/.worktrees/v5-workspace-polish \
 "$TMPDIR/workspace-independent"
```

Both independent workspace roots produced the same 35 files.

- Entry: `assets/v5-Dlv4NEzO.js`.
- Entry SHA256: `9e2eb9db66b19e6a262cb611a60bb11b387e68f4c23f2f23f2f80f66db857b4d`.
- Manifest SHA256: `3b5bd4aaaae33534e150022d094127e9b16808fea41e9a27765cc5951fdc5770`.

Existing large-chunk and mixed-import build warnings remain. No Docker network,
service, unit, deployment, browser-service publication or live surface was used.
These are renderer tests, not a new screenshot or deployed-latency claim.

## Remaining gates and rollback

Both PRs remain draft and held for the live-trial move, paired merge order,
Condor #84 integration and separate requalification. Whichever Condor change
merges second must regenerate the manifest. Revert this round's commits to
roll back; no runtime state was changed. The plan retains the Query-gc safety
expiry and pre-sleep frame follow-ups, plus the previously deferred presentation
and deployed-latency work. No new-head independent approval is claimed.
