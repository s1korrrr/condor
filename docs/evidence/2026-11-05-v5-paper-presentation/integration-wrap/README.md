# #99 integration: paper-container wrapping

**The integrated wrapping regression now passes.** The same unchanged #99 test failed before the extraction repair. The integrated focused suite passes 250/250, TypeScript passes, and nine browser cases pass. This is local integration and recorded-fixture evidence, not a deployed-dashboard claim.

The integration starts at Condor main `d564695fb2a564b59e884743c1c7c28e056c68dd` (#99). It merges #91 `e0005086169bd8b0ea9e1776f616e791d557cb48`, then #98 `ce0fcc821603759653cc9046c66ccc0f15303fb5`. Both merges complete without textual conflicts. Local merge commit: `3f10b7306fbf7ac712e3cb0ca91f94cf61dca1f6`; tree: `56cc883b9b4fdce00a92cec1092da126dc7bfc0e`. These local merge commits are not on the PR branch. [Setup and original source hashes](integration-setup.json).

## Cause and repair

#99 gives `.paper-fleet` and `.paper-section` an `overflow-wrap: anywhere` contract. Extraction introduced an outer `<div data-paper-workspace>` without either class or its own wrapping rule. The unchanged #99 test therefore reports `div.(no class)`. The added standalone CSS regression also observes an empty computed `overflow-wrap` on this root.

The extracted root now uses the shared `paper-section` class. Its scoped stylesheet owns `overflow-wrap: anywhere`, so it also works without page styles or the `.v5-paper-bots` wrapper. Scoped zero block margin and padding prevent the shared class from adding an extra outer section gap. No selector, safety-store, command or polling logic changes in this repair. #99's `fleet-strip.css`, `paper-safety.ts` and `usePaperSnapshot.ts` are unchanged.

## Commands and results

All runtime checks use the shared runner, scratch TMPDIR, one Node test-file worker and a 900-second ceiling. The batch and browser script check `LIVE_STEP_ACTIVE` before each phase. Exit 75 means NOT RUN; none of the claimed results is an exit 75.

```bash
TASK=/home/rsi/dev/rsibot/.workspace/scratch/condor-task2-20261105
RUNNER=/home/rsi/dev/rsibot/.workspace/scratch/r3/run-test.sh
test ! -e /home/rsi/dev/rsibot/.workspace/scratch/r3/LIVE_STEP_ACTIVE
"$RUNNER" timeout --signal=TERM --kill-after=10s 900 "$TASK/verify-integration-wrap.sh"
```

The [batch receipt](verify-integration-wrap.sh) records all 19 integrated test files and the exact commands. Its starting tree has the added standalone test overlaid, while application source and #99's baseline test are unchanged from the local merge. The batch proves both reds, copies the repair into the integrated tree, and runs the green checks. To replay the red phases, first reconstruct that original integration tree in a separate task scratch checkout.

| Check | Exit | Result |
| --- | --- | --- |
| Unchanged #99 `ui-baseline-findings.test.mjs`, before | 1, expected | 4 tests: 3 pass, 1 wrapping assertion fails with `div.(no class)` |
| Added standalone CSS-boundary regression, before | 1, expected | 1 test fails: `'' !== 'anywhere'` |
| Integrated focused suite, after | 0 | 250/250 pass; 0 skipped; includes both wrapping regressions, the hold-union tests and #99's real-hook safety tests |
| Integrated `tsc -p tsconfig.app.json --incremental --tsBuildInfoFile "$TASK/tmp/integration-wrap.tsbuildinfo"` | 0 | No diagnostics |
| #98's existing stacked base, full `v5-paper-presentation.test.mjs` | 0 | 23/23 pass; 0 skipped |
| Final integrated browser phase | 0 | Nine captures pass: 390/768/1440 in dark/light/colorblind |
| Task and integrated `git diff --check` | 0 | PASS |

The first batch attempt found a missing `happy-dom` installation and is excluded from the red results. Only task-owned dependency symlinks changed; package files did not change. The complete installed set uses happy-dom 20.14.6, TypeScript 5.9.3, Vite 8.2.2 and React 19.2.4.

The main batch completed the passing test/type phases, then its first browser probe failed because the synthetic IDs exceeded the owner's 128-character limit. The policy correctly rejected the malformed read. The final fixture uses exactly 128 characters. Only the browser phase needed a rerun; application source is unchanged from the passing test/type phases:

```bash
test ! -e /home/rsi/dev/rsibot/.workspace/scratch/r3/LIVE_STEP_ACTIVE
"$RUNNER" timeout --signal=TERM --kill-after=10s 900 \
  env TMPDIR="$TASK/tmp" node "$TASK/integration-wrap-browser.mjs"
```

## Browser evidence and limits

The [browser script](integration-wrap-browser.mjs) mounts the actual extracted component from the integrated tree. It uses the recorded replay, replaces controller identifiers with labelled synthetic 128-character IDs and removes the `.v5-paper-bots` page class. It opens owner-section details. Every case asserts five visible held-controller headings, wrapping inherited from the extracted root, no text outside the hold container, no page overflow, zero outer block spacing, zero running reduced-motion animations, zero schema-error panels, zero browser errors and zero API requests.

[Manifest and source/PNG hashes](manifest.json), [validation receipt](validation.json), [phone dark](screenshots/integration-long-ids-dark-390.png), [desktop light](screenshots/integration-long-ids-light-1440.png). The author inspected the phone dark and desktop light images. Other cases have automated checks. The temporary fixture server and browser are stopped. No service route was added.

The original 20 Task 1 comparison captures remain historical evidence for `ce0fcc82`; this integration package binds the repaired source. #98 stays stacked on #91. Rebase it after R2 rebases #91 onto main, then repeat the affected integration checks. Coordinator review and merge remain pending. No full production build or live-stack check was run. Rollback is a reviewed revert of this repair commit. Both task-owned worktrees remain for review.
