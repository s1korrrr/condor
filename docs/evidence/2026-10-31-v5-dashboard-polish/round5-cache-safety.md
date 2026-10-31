# Round-4 review repair: document clock and safety evidence

Both reviewers' blockers are repaired locally. This receipt follows the
round-4 clock receipt; its number is not a new review approval.
Inputs: Condor `07c4e26a5890c98edefa9a8a82291c1d4c0c06d3` and rsibot
`981703987e347377694455318bd6f057fb71a3b2`.

## Owning-boundary repairs

`usePaperClock` now owns one lazy module-level clock for the browser document.
Every paper hook/page uses that store. It has one high-water mark and one
subscription set. It starts one interval for the first subscriber and removes
the interval/listeners after the last subscriber leaves. The high-water mark
does not reset during that gap. A remount, another page or a bot switch cannot
revive a snapshot already observed stale in the same document. There is no
per-component clock state. Skew and freshness rules remain unchanged:
timestamps more than 5,000 ms ahead are invalid; valid age <= 30,000 ms is fresh.
A full new browser document starts a new store. No unobserved elapsed time is
inferred while the browser is closed.

`usePaperSnapshot` keeps positive risk evidence separately from data progress.
Evidence is associated with the exact TanStack Query object in a WeakMap, so
it survives remounts while that query stays cached and cannot cross clients,
query keys or bots. It is released when the query is collected. Positive
signals are compacted by owner hold reason, controller flag or native refusal
reason, keeping the latest source read per signal, not a growing snapshot log.
Only matching status/risk snapshot identity and bot identity are admitted.

Empty progress, an incomplete clear risk read, another section's failure or a
retry cannot clear these signals. A complete newer snapshot can clear older
signals. Completion identity is recorded before admitting new evidence: an
older retained complete snapshot cannot clear a newly received risk signal,
even if that signal has an older owner timestamp. Equal timestamps are not
treated as proof of a newer observation.
The existing attempt-token and AbortSignal checks reject orphaned callbacks.
No additional owner request or polling query is introduced.

`paperCoherentRead` stops dispatching after a failure but still drains admitted
workers. Any validated same-snapshot risk result from a worker already in
flight is published, even if another worker failed first. It no longer erases
received sections on failure. Whole-read retries still reset ordinary progress,
remain bounded at two attempts, and never mix snapshots.

Bots renders safety evidence independently from the selected data snapshot.
It shows received emergency, pause, native entry hold, native refusal, owner
holds and `control_hold` during refresh, after failure and on first-load error.
The emergency badge takes priority. The banner states that safety evidence can
be newer than the displayed data snapshot. Totals still require the complete,
fresh data snapshot. Retained data, errors and progress remain visible.

## Fail-before / pass-after

The original reviewer files were rerun unchanged against the previous review
checkout. Portable copies are retained in the paired workspace test tree.

| Check | Previous source | Repaired source |
| --- | --- | --- |
| Claude blockers + holds, original five cases | 0 pass / 5 fail | 5 pass / 0 fail |
| GPT faithful temporal cases | 9 pass / 4 fail | 13 pass / 0 fail |
| GPT faithful + original assertion-free mutation probe | 9 pass / 5 fail | replaced by faithful cases plus strengthened mutation audit below |
| Real hook/read path, five signal types x first load/refresh/owner-clock rollback | 0 pass / 15 fail | 15 pass / 0 fail |

The fifteen real-hook cases run `V5PaperBots`, `usePaperSnapshot`, `paperCoherentRead`
and the actual read transport against controlled fetch responses. They cover
received signals during refresh, late peer failure, first-load errors, cached
query remount, retry progress reset and a genuinely newer complete clear.
They do not inject `complete:false` directly into `PaperWorkspace`.
For fail-before, the new tests were copied to a fresh scratch archive of
Condor `07c4e26a`; only fixtures and test dependency links were supplied.

Retained reviewer files:

- Workspace `test/v5-document-clock-claude.test.mjs` and
  `test/v5-received-holds-claude.test.mjs`: the original five cases plus two
  extended document-clock cases.
- Workspace `test/v5-document-clock-gpt.test.mjs`: all 13 faithful cases.
- `test/helpers/paper-temporal.mjs`: common portable harness. It uses real
  QueryClient/QueryObserver and the real external clock's subscribe/getSnapshot,
  focus sampling, high-water logic and cleanup. No clock result is fabricated.
  The fake fetch and React hook slots replace browser/context I/O only.
- Condor `frontend/test/v5-refresh-continuity.test.mjs`: fifteen real-hook signal
  cases plus prior retention/abort cases. Its unrelated DataTable child is
  stubbed so table-local state cannot alias the root hook slots.
- Condor `frontend/test/v5-risk-evidence.test.mjs`: publication after peer
  failure, late admitted risk worker, identity isolation and bounded compaction.

Portable adaptations change absolute review paths, provide the actual query
client at the new hook boundary, and locate progress state without the obsolete
clock-state slot. Defect assertions remain. Both previously weak rollback cases
now step back inside the allowed skew/freshness window, rather than depending
on future-skew rejection. The assertion-free Bots test now checks both labels
and every actual `paper-metric` value, including presence of those metrics.

## Mutant-kill evidence

`test/v5-temporal-mutation.test.mjs` runs existing page regressions in isolated
child processes. A test-only source transform changes the executed TS/TSX in
memory; no production file is edited. It requires assertion failures, not
module/setup failures, and checks the exact failure count.

| Injected unsafe change | Assertions that reject it |
| --- | ---: |
| Replace `Math.max(highWater, readNow())` with `readNow()` | 6 |
| Replace shared document clock acquisition with a new clock on each hook call | 2 |
| Force owner read state and snapshot freshness to always fresh | 2 |

The first mutant fails the two original remount cases, both repaired rollback
cases, the remount offsets -5,000/-4,999/0/15,000/25,000/30,000 ms and cross-page
first-mount case. The always-fresh mutant fails the formerly assertion-free
Bots case and the Capital/Bots 30,000/30,001 ms case. All three mutation-audit
tests pass by detecting their unsafe mutant. The unmodified full suite passes.

## Commands and counts

```bash
export TMPDIR=/home/rsi/dev/rsibot/.workspace/scratch/v5-dashboard-polish
# Condor task checkout
PYTHONPATH=.:tests:/home/rsi/dev/rsibot/.workspace/scratch/v5-paper-dashboard/pytest-plugin \
 /home/rsi/dev/rsibot/condor/.venv/bin/python -m pytest -q -o addopts= tests
node --test --test-reporter=tap frontend/test/*.test.mjs
(cd frontend && node_modules/.bin/tsc -b)
(cd frontend && node_modules/.bin/eslint src/v5/usePaperClock.ts \
 src/v5/usePaperSnapshot.ts src/v5/paper-safety.ts src/pages/tabs/ActiveBotsTab.tsx)
# Paired rsibot task checkout, dashboard/condor-workspace
node --preserve-symlinks --test --test-reporter=tap test/*.test.mjs
../../condor/frontend/node_modules/.bin/tsc --noEmit -p .
```

Observed: **4,256 Python pass / 8 skip / 18 warnings; 1,110 Condor Node pass /
1 skip; 529 workspace Node pass; both typechecks PASS**. Targeted presentation
lint passes. Historical `policy.ts` unused-name lint findings remain outside
this repair. Final real-hook/retention cases: 20 pass. Pure clock/risk
boundary tests: 10 pass. Post-manifest build-helper regression: 1 pass.

One full Node rerun during concurrent validation hit the existing 5 s external
watchdog in `quant-kit-axis.test.mjs` (1,109 pass / 1 fail / 1 skip). The later
clean full rerun reports 1,110 pass / 0 fail / 1 skip with no source or timeout
change. That intermediate result remains in `r5-condor-node-reviewed.log`;
the passing full result is `r5-condor-node-clean.log`.

Portable reviewer reruns from the workspace:

```bash
node --preserve-symlinks --test --test-reporter=tap --test-name-pattern='^R4-' \
 test/v5-document-clock-claude.test.mjs test/v5-received-holds-claude.test.mjs
node --preserve-symlinks --test --test-reporter=tap test/v5-document-clock-gpt.test.mjs
node --preserve-symlinks --test --test-reporter=tap test/v5-temporal-mutation.test.mjs
```

Scratch evidence uses `r5-` under TMPDIR: `r5-claude-red.log`, `r5-gpt-red.log`,
`r5-real-hook-rollback-red.log`, `r5-claude-green.log`, `r5-gpt-green.log`,
`r5-hold-final.log`, `r5-boundary.log`, `r5-pytest.log`, `r5-condor-node-clean.log`,
`r5-workspace-node-reviewed.log`, typecheck/lint logs and `r5-repro-reviewed.log`. The full workspace
log records all three mutant kills. Raw logs stay in scratch; committed receipts
have no trailing whitespace.

## Reviewed bundle and integration boundary

```bash
node frontend/tooling/check-v5-reproducibility.mjs rebuild \
 "$TMPDIR/r5-repro-reviewed" /home/rsi/dev/rsibot/.worktrees/v5-workspace-polish \
 "$TMPDIR/workspace-independent"
```

Two real workspace roots produce **35 identical files**. Workspace production
sources are unchanged this round; their independent real copies match the
task checkout. Entry `assets/v5-DuVw6cND.js`; entry SHA256:
`9ea6177027adaadf3e95f704423db076bd457cd6801087766845867d6ff2026c`.
Manifest SHA256:
`1fca3d2fbb771b5f4f3968548b0212acf90768abb4f0796458c0f38518d9fae6`.
Existing chunk-size and mixed static/dynamic import warnings remain.

**#625 still pins Condor `be2a3365`, without the shared helpers. Merge #85 and
bump that pin before building #625. These workspace tests/builds used the newer
linked Condor task checkout, not the pinned checkout. No gitlink bump is included.**
Whichever Condor branch merges second with #84 must regenerate the manifest.

Both PRs stay draft, held for the live-trial move, paired integration and separate
requalification. No API #73 changes, learning-route changes, new services, routes,
units, Docker networks, Mac, live access, merge or deployment. No new browser or
latency claim. Independent exact-head review remains required. Rollback: revert
the paired repair commits; no runtime action is part of this task.
