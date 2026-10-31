# R1: retained snapshot freshness — 2026-10-31

The error and refresh paths now identify retained observations as historical.
Cached data, owner holds, errors and attempt-bound progress remain intact.
No fetch, retry, retention or API behavior changes.

Bases: Condor `a6c009d8b79a043739bdd97c7f007845a7920ef2` and workspace
`2bb8434d9be992487f6fa699cb4e5cdde26d95b2`.
Authority: repository-process-only. No merge, deployment, service, unit, Docker
network, Mac, live read or trade was used in this round.

## Repair

`snapshot-presentation.ts` owns the shared 30,000 ms bound and age label.
Bots, Paper identity and Capital use that policy. Capital receives a clock in
its projection. After the bound, the projection becomes stale and withholds
current equity. The page withholds expired monetary tiles, balances, lifetime
totals and history statistics. Retained source values stay intact; the model
keeps their historical detail and the query object is not replaced or cleared.

During refresh or error, Capital never prints the original wallet state as
current. It prints “Last complete owner snapshot”, age, as-of and “not current”.
Paper identity applies the same label above retained source/config/recipe
SHA256 values and snapshot ID. Read errors remain visible. The shared external
clock subscribes to one-second ticks, focus and visibility changes. Refocus
reads its current snapshot instead of waiting for old component state to tick.
Display resolution is one second. The pure projection accepts a millisecond
clock and tests the exact 30,000/30,001 ms bound. Negative zero displays as `0`;
nonzero tiny negative values stay nonzero.

## Fail before / pass after

| Probe | Before | After |
| --- | --- | --- |
| Capital refresh error | FAIL | PASS; age label, error retained |
| Capital 60-second refresh, GPT QueryObserver repro | FAIL | PASS; stale, totals withheld |
| Capital two-hour refocus | FAIL | PASS; stale age, no current totals |
| Projection at 30,001 ms | FAIL | PASS; exact bound, retained values intact |
| Paper identity after error | FAIL | PASS; retained IDs labelled |
| Paper identity after hours-old refocus | FAIL | PASS; age and not-current label |
| Negative zero | FAIL | PASS; `-0` and `-000.000` display as `0` |

Scratch evidence: `r3-workspace-red.log` has four failures;
`r3-condor-red.log` has two; `r3-gpt-red.log` has one. The original GPT test ran
against the review checkout and failed once. Its portable owning-repo version,
`test/v5-retained-query-observer.test.mjs`, changes only paths and diagnostic
printing. It also proves bot-switch isolation, newer-snapshot replacement and
error recovery. The Claude error-path equivalent is in
`test/v5-retained-freshness.test.mjs`. It asserts the corrected state rather
than keeping the original probe's expectation that old `available` text exists.
Condor retains identity regressions in `frontend/test/v5-identity-freshness.test.mjs`.

## Validation

All commands use `TMPDIR=/home/rsi/dev/rsibot/.workspace/scratch/v5-dashboard-polish`.
From the Condor task worktree:

```sh
PYTHONPATH=.:tests:/home/rsi/dev/rsibot/.workspace/scratch/v5-paper-dashboard/pytest-plugin \
  /home/rsi/dev/rsibot/condor/.venv/bin/python -m pytest -q -o addopts= tests
node --test --test-reporter=tap frontend/test/*.test.mjs
(cd frontend && node_modules/.bin/tsc -b)
```

Observed: **4,256 Python passed, 8 skipped, 18 warnings**;
**1,081 Condor Node passed, 1 skipped**. Condor typecheck passes.
Targeted ESLint passes for the changed presentation/hook files. The two
previously documented baseline unused-name errors in `policy.ts` are not fixed.

From `dashboard/condor-workspace`, with this task's Condor checkout linked in
the workspace `condor` slot:

```sh
node --preserve-symlinks --test --test-reporter=tap test/*.test.mjs
../../condor/frontend/node_modules/.bin/tsc --noEmit -p .
```

Observed: **470 workspace Node passed**, typecheck passes. The exact symlink
flag matters. The temporary link is removed before root Git operations; no
gitlink changes. Final retained-data workspace regression run: **24 passed**,
including the eleven imported fixture-accounting tests.

Repeated error-only renders at one minute, two hours and one day also pass:
errors and cached values stay intact, but expired totals never become current.

## Reviewed bundle

```sh
node frontend/tooling/check-v5-reproducibility.mjs rebuild \
  "$TMPDIR/r3-repro-reviewed" \
  /home/rsi/dev/rsibot/.worktrees/v5-workspace-polish \
  "$TMPDIR/workspace-independent"
```

Both real workspace layouts produce **35 identical files**.
Entry: `assets/v5-BDlbNs5i.js`.
Entry SHA256: `b6732d6fe1c0cc1c5bb95f1acc38c2bf990065fa84fad2c043dfdfabdd10f3bd`.
Manifest SHA256: `0143560d0e157827a5d3e719a5bd8ca25017dc17b35ec840beba0ab144bcff89`.
The later merge with #84 must regenerate the manifest again.

No new browser, screenshot, deployment or latency qualification is claimed.
Previous benchmark receipts remain historical. Fresh independent review and
post-live-trial integration requalification remain required. Rollback: revert
this round's two task commits; no runtime restart is authorized or needed.
