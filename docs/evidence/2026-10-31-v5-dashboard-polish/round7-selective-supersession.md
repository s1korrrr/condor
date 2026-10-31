# Round-6 repair: selective safety supersession

The reported owner-flow regression is fixed locally. Independent review of the
new heads remains required. Inputs: Condor `d81f105f` and rsibot `6ad6fa0e`.
Only Condor's safety qualification changes production behavior. The workspace
delta adds tests and evidence, not production behavior or a Condor pin bump.

## Cause and repair

The previous helper required zero safety signals before it would prune older
risk evidence. A scoped resume or named hold reset therefore left the cleared
signal visible whenever any other hold remained. Qualification to supersede is
now independent of the number of holds.

A completed coherent risk section qualifies when it is available, complete,
schema-valid, has no continuation, and every controller explicitly publishes
boolean operator.paused, operator.emergency and native.complete flags. A newer
qualified owner boot/sequence supersedes every older retained risk read for
that bot. Its own remaining signals still render. Missing or invalid flags,
degraded/incomplete sections and unknown ordering preserve older evidence.
Clock, query retention, cancellation, freshness and totals rules are unchanged.

## Fail-before and pass-after

| Evidence | Before | After |
| --- | --- | --- |
| Original Claude owner-flows and partial-supersede probes | 1 pass / 4 fail | 5 pass / 0 fail |
| Added pure boundary/render tests, initial 13-case baseline | 10 pass / 3 fail | Final expanded suite: 14 pass |
| Added real QueryClient completion tests, initial three-case baseline | 0 pass / 3 fail | Final expanded suite: 4 pass |
| Restore obsolete zero-signals requirement in memory | Four assertions fail | Mutation audit passes by rejecting it |

The original review's passing baseline case compares historical `d4f15a67`;
its four failing cases exercise current pure and rendered behavior. Only the
checkout root was adapted for the after-run. Both logs are retained.

The retained regressions cover (A) BNB resumed while BTC stays paused, (B) a
named stop-durability hold reset while emergencies remain, a mixed old-pause
clear/new-pause update, and explicit emergency clear with a remaining pause.
The last fixture proves the consumer rule, not owner operation reachability.
Nine invalid-flag cases and a cursor case prove fail-safe retention.

The real-query tests deliver original risk through progress, finish the read,
start a newer same-boot sequence, and complete it through the actual hook and
QueryClientProvider. They assert the banner across three subsequent renders.
No production hook is stubbed. Isolated source mutation restores the old
all-clear condition; all four scenarios reject it with ERR_ASSERTION, not setup
errors. The other four real-renderer mutation audits also pass. The earlier
high-water/per-mount/always-fresh audits remain green in the full suite.

An intermediate post-fix unit run had three test-count failures: the UI renders
signals in both the hold banner and controller details, not once. Exact counts
now assert both copies (two paused cards; ten emergency observations for five
controllers). The pure-boundary assertions already passed in that run. Its log
is retained as `round7-supersession-after-initial.tap.gz`.

## Commands, setup and counts

Node v24.21.0. All temporary data uses:
`/home/rsi/dev/rsibot/.workspace/scratch/v5-dashboard-polish`.
Run `npm ci` in Condor frontend before workspace tests. They require happy-dom
and react-test-renderer from Condor's locked devDependencies. A stale symlinked
node_modules is insufficient. This round installed its own dependencies with:

```bash
export TMPDIR=/home/rsi/dev/rsibot/.workspace/scratch/v5-dashboard-polish
cd /home/rsi/dev/rsibot/condor/.worktrees/v5-dashboard-polish/frontend
npm ci --ignore-scripts --no-audit --no-fund
```

The workspace's temporary `condor` link points at that repaired checkout, NOT
the unchanged `be2a3365` gitlink. Merge #85 and bump the pin before building
#625. No gitlink update is included here. Remove the temporary link before
root Git publication; do not replace or move a shared Condor checkout.

```bash
# Condor worktree
PYTHONPATH=.:tests:/home/rsi/dev/rsibot/.workspace/scratch/v5-paper-dashboard/pytest-plugin \
  /home/rsi/dev/rsibot/condor/.venv/bin/python -m pytest -q -o addopts= tests
node --test --test-reporter=tap frontend/test/*.test.mjs
(cd frontend && node_modules/.bin/tsc -b)
(cd frontend && node_modules/.bin/eslint src/v5/paper-safety.ts)
node --test --test-reporter=tap frontend/test/v5-safety-supersession.test.mjs \
  frontend/test/v5-risk-evidence.test.mjs frontend/test/v5-build-reproducibility.test.mjs

# Paired workspace worktree, dashboard/condor-workspace
node --preserve-symlinks --test --test-reporter=tap test/*.test.mjs
../../condor/frontend/node_modules/.bin/tsc --noEmit -p .
```

| Check | Result |
| --- | --- |
| Condor Python | 4,256 pass / 8 skip; 18 warnings |
| Condor Node | 1,133 pass / 1 skip |
| Workspace Node | 558 pass |
| Final focused risk/supersession/bundle checks | 27 pass |
| Focused real-query scenarios plus five mutation audits | 9 pass |
| Both typechecks and targeted source lint | PASS |
| Full-branch git diff --check, both repos | PASS |

The final workspace log has no snapshot-cache, render-loop or unwrapped-act
warnings. Expected react-test-renderer deprecation notices remain. Logs are
sanitized with `sed 's/[[:blank:]]*$//'` before deterministic `gzip -n` storage.

## Rebuilt reviewed bundle

Seed build uses V5_WORKSPACE_ROOT pointing at the paired workspace worktree.
The manifest is generated from distHashes in the owning reproducibility tool.
Independent verification command, from Condor:

```bash
node frontend/tooling/check-v5-reproducibility.mjs rebuild \
  "$TMPDIR/round7-repro" \
  /home/rsi/dev/rsibot/.worktrees/v5-workspace-polish \
  "$TMPDIR/workspace-independent"
```

Both roots produce 35 identical files. Entry: `assets/v5-DB8b4_7F.js`.
Entry SHA256: `bdc8e08621fbb6105c391b894b5ea954644de056fd0df0b2d323c157879f8b2a`.
Manifest SHA256: `e7136e1d72b6a5883322824a364ab88e33c258573335a521a46bb75b488ae59e`.
Whichever Condor branch merges second with #84 must regenerate the manifest.

## Limits and rollback

No live services, protected stacks, units, Docker networks, Mac, API #73 or
learning-route changes. No new browser, latency or deployed qualification
claim. Revert the paired repair commits to roll back; no runtime action.
Keep both drafts held for the live-trial move, integration and requalification.

Pre-existing owner behavior, unconfirmed here: the reviewer reports no in-boot
emergency-clear path in the pinned owner because emergency is OR-merged at
`meridian_v5_paper_control.py:1129-1134`. This repair does not change the owner.
Query gcTime safety-evidence expiry and the pre-sleep frame remain deferred,
as do the other follow-ups in the task plan.
