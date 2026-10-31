# V5 dashboard review fix round — 2026-10-31

B1/B2 and the requested small fixes are implemented. Local checks pass.
This is not independent review approval, a merge, deployment or requalification.
The live-trial move, Condor #84 and new qualification remain integration gates.

## Scope and mechanism

Starting heads: Condor `43695d26fbe0103321074235bf1fff077460fb4a` and rsibot
`b39c05484e9604700830d79673cde12a3a7a0499`. Continue the existing task branches.
No rebase, merge, API changes, protected stack, units, Docker network, Mac or
live service actions. The learning routes and learning owner are unchanged.

The shared `usePaperSnapshot` hook owns progress and query lifecycle. Cached
complete results remain selected while a background read runs and after a
failed refresh. The views retain their native as-of time. Progress has a separate
`Refreshing: n/9 sections` label on Bots and `n/4` on Capital. A complete newer
query result replaces the retained result; in-flight sections never replace it.

The first load has no cached result. Bots renders received/pending section
states, not missing controls or numeric rails. Capital can show received wallet
balances but withholds aggregate metrics and pending accounting/history claims.
It never calls a pending history section zero samples or not connected.

Each query invocation has a token. Only its current, non-aborted invocation can
publish progress. Requests consume the query AbortSignal with the existing
14-second timeout. Late responses from an aborted manual refresh cannot reset
the new invocation's progress. The three-worker, pinned snapshot read and its
two-attempt 409/503 policy are unchanged.

Leading zeros are removed only from the displayed integer before grouping.
For example `00012` displays `12`; its exact tooltip stays `00012 USDC`.
Recursive TS financial validation now applies before every section branch.

## Fail-before and pass-after

The baseline Condor source was exported with `git archive 43695d26` into
`$TMPDIR/round2-baseline-condor`. The same final regression files run against
that source and the task source. No reviewer worktree was modified.

| Item | Before | After |
| --- | --- | --- |
| B1 retained Bots hold/as-of | Refresh loses the held snapshot/banner | Retained banner, risk caption and native time remain; failed refresh retains them; newer complete snapshot can clear the hold |
| First load and numeric rails | No pending state; partial reads can project absent controls | Pending/checking state, no absent controls or numeric-rail claim |
| B2 Capital selection | Cached full wallet/history/accounting replaced by partial result | Complete result remains selected during refresh and error |
| Orphaned progress | Late old invocation overwrites current progress | Both callers reject progress from an aborted invocation, including a fetch stub that ignores cancellation |
| Capital pending exports | Missing-accounting note, disconnected history and zero sample claims | Pending labels; sample counts and export-absence text wait for completion |
| Leading zeros | `00012` becomes `00,012` | `12`, exact original tooltip retained |
| Recursive validator parity | TS accepts `fee_quote={}` or `[]` in all seven object sections | TS and Python reject the same 14 cases; Python returns `502 paper_read_schema_invalid` |
| Evidence whitespace | Full Condor branch diff reports 32 whitespace/EOF findings | Full branch and worktree `git diff --check` pass |

Object sections tested: status, wallet, risk, decisions, history, accounting,
operations. Valid original fixtures pass first. Python already rejected the
mutations before this round; its production validator is unchanged. Blank
capability strings remain accepted.

Condor baseline: 45 focused tests, 26 passes and 19 expected failures. Final
focused regression/bundle set: 47 passes. Workspace baseline: 19 passes and
three expected failures; after: all 22 focused checks pass. The logs retain the
actual assertions. Whitespace normalization changes only evidence line endings
and trailing blanks, not test output facts or source behavior.

## Final checks

```bash
export TMPDIR=/home/rsi/dev/rsibot/.workspace/scratch/v5-dashboard-polish
export PYTHONPATH=.:tests:/home/rsi/dev/rsibot/.workspace/scratch/v5-paper-dashboard/pytest-plugin
/home/rsi/dev/rsibot/condor/.venv/bin/python -m pytest -q -o addopts= tests
node --test frontend/test/*.test.mjs
(cd frontend && node_modules/.bin/tsc -b)
```

Observed: **4,256 Python passes, 8 skips, 18 warnings**; **1,079 Condor Node
passes, 1 skip**; Condor typecheck passes. After strengthening the parity error
code assertion, all 23 Python parity checks pass. The final changed-test/bundle
set has 47 passes after manifest regeneration.

Workspace commands, from its `dashboard/condor-workspace` directory:

```bash
node --preserve-symlinks --test test/*.test.mjs
../../condor/frontend/node_modules/.bin/tsc --noEmit -p .
```

Observed: **446 workspace Node passes**, typecheck passes. The temporary Condor
link is the expected workspace layout. The `--preserve-symlinks` flag is explicit
because GPT's reviewed layout needed it. No Condor gitlink change is committed.

Changed-source ESLint has only the two previously reproduced baseline errors,
`_risk` and `_owner` in policy.ts. No new lint error remains. Original raw logs
stay in task scratch. Committed logs have trailing blanks and extra EOF blank
lines removed before `git diff --check`.

## Injected-delay benchmark

The unmodified API73 app at `5a24d9c2` runs in-process with the same 404,074-byte
primary, 344 fills and 45 executors. Delay is 300 ms **for every request**, including
status and each page. Pagination remains serial within a section. Both loaders
have 20 timed samples per page plus one warmup; 160 timed page reads total.
Every returned envelope is compared in full, and passes the new TS validator.

| Page | Serial p95, seconds | Pool 3 p95, seconds |
| --- | ---: | ---: |
| Bots | 3.114860 | 1.285031 |
| Settings | 1.554710 | 0.942002 |
| Readiness | 1.556270 | 0.947868 |
| Capital | 1.234376 | 0.628113 |

Reproduce from the Condor task checkout, using the API export and serial baseline
preparation documented in README.md:

```bash
node frontend/tooling/benchmark-v5-paper.mjs \
  /home/rsi/dev/rsibot/condor/.venv/bin/python "$TMPDIR/api73" \
  "$PWD/tests/fixtures/paper-api-final3/native-replay" "$TMPDIR" \
  "$TMPDIR/baseline/policy.ts" 20 300
```

This tests a fixed-delay model, not the deployed transport or host. It does not
reproduce FINAL6's 21-second p95 or establish requalification. The fixture app
emitted `report validity sample unavailable: FileNotFoundError`; no advisory
validity is claimed. Owner-envelope parity and all timed reads still pass.
The original no-delay results remain historical evidence in README.md.

## Reviewed bundle

Entry: `assets/v5-Bdm5jABw.js`.
Entry SHA256: `a4c8a33df4134044233e662d3709cf7697438cfed95e39d8b62b818af3b8c554`.
Manifest SHA256: `c7867d9a35a62b6d5283af6408b5f98238cc3f4005ebd1b765bba683afd5d161`.

```bash
node frontend/tooling/check-v5-reproducibility.mjs rebuild \
  "$TMPDIR/round2-repro" \
  /home/rsi/dev/rsibot/.worktrees/v5-workspace-polish \
  "$TMPDIR/workspace-independent"
```

Both real workspace layouts produce **35 identical files**. The manifest binds
the paired workspace fixes. Whichever Condor branch merges second with #84 must
regenerate it. API source hashes still match the original receipt.

## Remaining boundary

No new browser screenshot or deployed test is claimed in this round. Actual
React render tests and query-function lifecycle regressions provide local proof.
The prior screenshots belong to the original head, not this fix.

Deferred items are in docs/v5-dashboard-polish-plan.md: health Checking can hide
prior Stale/Unavailable briefly; Settings' extra five-section polling; significant
digits below 1e-6; pair-chart remounts. The delay benchmark is now complete.

Bootstrap reported two unrelated local HQ commits not pushed; they were left
untouched. Rollback: revert this round's paired commits. No runtime restart is
needed. Independent rereview, post-move integration and requalification remain
with the parent. Task worktrees are removed after clean/pushed reachability
checks; no service or Serve route was created in this round.
