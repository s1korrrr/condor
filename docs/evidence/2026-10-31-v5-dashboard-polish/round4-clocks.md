# Round 4: shared clock and received entry holds

The round-3 review blockers are repaired locally. This is fixture evidence,
not a merge, deployment, live-trial result or separate requalification.
Inputs: Condor `e5f8368ffc968365efd8e31e70a4dfea459023f3` and rsibot
`cb7db9b5831a0613e4f58d2f4d219dcdc6a8aef8`.

## Mechanism and boundaries

- `snapshot-presentation.ts` owns the 5,000 ms future-skew rule. Both
  `paperReadState` and `paperTime` use its timestamp validator. More than
  5,000 ms ahead is not fresh, says `owner clock ahead; not current`, and
  withholds Capital totals. Exactly 5,000 ms ahead remains within tolerance.
- Fresh means valid time and age <= 30,000 ms. Age 30,001 ms is stale.
  `usePaperClock` supplies millisecond precision to Bots, Capital, identity,
  Readiness and Operations. No page floors its freshness clock to seconds.
- Each mounted page session owns a clock high-water mark. Tick, focus and
  visibility observations cannot lower it. A 45 s -> 25 s wall-clock step
  cannot revive a stale snapshot. Unmount cleans up its timer and listeners;
  a new page session starts a new clock. This does not claim persistence
  across browser restarts or infer elapsed time never observed by the page.
- Labels consistently say `Last complete owner snapshot`, with compact ages
  such as `2d 1h`. A fresh refresh does not change that wording. Original
  owner state is explicitly a snapshot observation, never current authority.
- Operations uses the same clock and label, including retained error results.
  Existing data, errors, progress, coherent retention and query isolation remain.
- Bots renders every received positive controller emergency, pause, native
  entry hold or native refusal in the banner even before all other sections
  arrive. Pending sections do not suppress a received safety signal. Partial
  totals remain withheld. Clearing only global hold cannot hide an emergency.
- No owner/API behavior, learning routes, live service or runtime control changes.

## Fail-before / pass-after

| Regression | Baseline | Repaired |
| --- | --- | --- |
| Claude portable temporal suite | 15 pass, 4 fail | 19 pass |
| GPT temporal suite | 4 pass, 4 fail | 8 pass |
| Initial shared-clock probes | 0 pass, 4 fail | 6 pass, expanded boundaries/lifecycle |
| Operations clock/retention suite | 5 pass, 4 fail | 9 pass |
| First-load received emergency/pause/native hold/refusal | 0 pass, 4 fail | 4 pass |

Reviewer reproductions are retained next to each other in the owning workspace:
`test/v5-clock-skew.test.mjs` and `test/v5-clock-skew-gpt.test.mjs`.
They preserve future-clock, rollback, 30,001 ms boundary, refocus, recovery,
identity and early-emergency assertions. Portable adaptations remove absolute
review-checkout paths and diagnostic prints. Wording assertions use the requested
compact, stable labels. The GPT harness keeps separate page/component hook slots
and reads the external-clock snapshot instead of writing the removed raw-clock
state slot. Existing retention harnesses now clear every controller signal when
asserting a genuinely cleared hold; a separate assertion preserves emergency
visibility when only the global hold clears.

## Exact commands and counts

Set `TMPDIR=/home/rsi/dev/rsibot/.workspace/scratch/v5-dashboard-polish`.
From the Condor task checkout:

```bash
PYTHONPATH=.:tests:/home/rsi/dev/rsibot/.workspace/scratch/v5-paper-dashboard/pytest-plugin \
 /home/rsi/dev/rsibot/condor/.venv/bin/python -m pytest -q -o addopts= tests
node --test --test-reporter=tap frontend/test/*.test.mjs
(cd frontend && node_modules/.bin/tsc -b)
```

Observed: **4,256 Python pass / 8 skip / 18 warnings; 1,091 Condor Node pass /
1 skip / 0 fail; Condor typecheck PASS**. Targeted changed presentation/hook/Bots
lint passes. The two historical unused-name lint errors in `policy.ts` remain
outside this repair. Focused Condor regressions: **17 pass**.

From the paired rsibot task checkout's `dashboard/condor-workspace`:

```bash
node --preserve-symlinks --test --test-reporter=tap test/*.test.mjs
../../condor/frontend/node_modules/.bin/tsc --noEmit -p .
```

Observed: **506 workspace Node pass / 0 fail; typecheck PASS**. Focused paired
regressions, including previous retained-error/refresh cases: **60 pass**.
The temporary `condor` link points to the repaired task checkout. These counts
are NOT against rsibot's pinned `be2a3365`. That pin lacks the shared helpers:
**#625 builds only after #85 merges and the Condor pin is bumped**.
The temporary link is removed before publication; no gitlink bump is committed.

Scratch logs: `r4-pytest.log`, `r4-condor-node.log`, `r4-workspace-node.log`,
`r4-condor-tsc.log`, `r4-workspace-tsc-reviewed.log`, `r4-condor-focused-reviewed.log`,
`r4-workspace-focused.log`, plus `r4-*-red.log`. Logs remain in task scratch;
these whitespace-clean receipts are the committed summary.

## Reproducible bundle

```bash
node frontend/tooling/check-v5-reproducibility.mjs rebuild \
 "$TMPDIR/r4-repro" \
 /home/rsi/dev/rsibot/.worktrees/v5-workspace-polish \
 "$TMPDIR/workspace-independent"
```

Two real workspace source roots produce **35 identical files**. The independent
root contains real dashboard copies and the expected Condor owner link. Entry:
`assets/v5-CWV39HsG.js`; entry SHA256:
`dd32f9fb21c7715e0ca057a9513ee4715ac2be5319d72246afcd617cd5e90e1b`.
Reviewed manifest SHA256:
`563e5e91cd2245b35dcf9958f76ff65784feb63a2c17d7095e57fcb616b78433`.
Existing chunk-size and mixed static/dynamic import warnings remain. Whichever
merges second with #84 must regenerate the manifest against the merged sources.

## Limits and rollback

No new browser, deployed latency or requalification claim is made. No service,
Tailscale route, Docker network or unit was created. Historical screenshot and
benchmark evidence remains in the earlier receipts. Independent exact-head
rereview is still required. Revert the paired repair commits to roll back;
no runtime restart or deployment is part of this task.
