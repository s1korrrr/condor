# V5 paper presentation — Task 2 evidence

Update: [#99 integration wrapping repair](integration-wrap/README.md) records the newer source, 250 integrated tests, TypeScript and nine standalone long-ID captures. The original results and 20 captures below remain historical evidence for `ce0fcc82`.

**Ready for coordinator review.** The focused suite passes 236/236, TypeScript passes, and 20 fixture captures pass. This is repository and fixture evidence. It does not describe a deployed dashboard or grant execution authority.

Source base: Condor #91, `e0005086169bd8b0ea9e1776f616e791d557cb48`. Draft #98 stays based on `feat/andrzej_v5_r2_release_20261102`. The [manifest](manifest.json) binds the captured source files and every PNG by SHA-256. The [validation receipt](validation.json) records counts, exits, versions and raw-log hashes.

## Commands and results

The exact host scripts are retained here as receipts: [batch](verify-final.sh), [browser entry](browser-capture.sh), [Vite session](capture-session.mjs), [Vite configuration](fixture-vite.mts), and [capture checks](capture.mjs). They use the recorded razer worktree and scratch paths. They are test tools, not application services. The worktree stays for review.

Executed on razer:

```bash
TASK=/home/rsi/dev/rsibot/.workspace/scratch/condor-task2-20261105
RUNNER=/home/rsi/dev/rsibot/.workspace/scratch/r3/run-test.sh
export TMPDIR="$TASK/tmp"
test ! -e /home/rsi/dev/rsibot/.workspace/scratch/r3/LIVE_STEP_ACTIVE
"$RUNNER" timeout --signal=TERM --kill-after=10s 900 "$TASK/verify-final.sh"
```

Batch exit: **0**. Each phase checks the live-step flag. Node tests use `--test-concurrency=1`. The v4 runner keeps the job at nice 19 / ionice idle with one BLAS thread.

| Phase inside the held runner slot | Exit | Observed result |
| --- | --- | --- |
| Pinned application source, candidate rendering tests with the explicit regression-name filter in `verify-final.sh` | 1, expected | 10 tests; 10 assertion failures; no setup/import failure. Exact decimal disclosures, qualified summary and raw export are absent on the old source. |
| `node --test --test-concurrency=1 --test-reporter=tap` with the 17 explicit V5/kit/native files in `verify-final.sh` | 0 | 236 tests; 236 pass; 0 fail; 0 skipped. [Full TAP](focused.tap). |
| `./node_modules/.bin/tsc -p tsconfig.app.json --incremental --tsBuildInfoFile "$TASK/tmp/tsconfig.app.tsbuildinfo"` | 0 | No diagnostics. |
| `node "$TASK/capture-session.mjs"`, via `browser-capture.sh` | 0 | 20 captures and 3 interaction groups pass. |
| Hold-union red probe, before the presentation repair | 1, expected | 4 tests; 4 fail. [TAP receipt](hold-union-before.tap). |
| Same hold-union probe after repair | 0 | 4 tests; 4 pass. [TAP receipt](hold-union-after.tap). |
| Single additive fixture with disclosure containment asserted, before layout repair | 1, expected | Seven exact-value disclosures escaped their tile. [Log](tile-layout-before.txt), [before image](before/metric-details-overflow.png). |

The hold-union probe used this command from the task's Condor checkout, behind the shared runner or the parent's temporary slot-2 transition wrapper:

```bash
node --test --test-concurrency=1 --test-reporter=tap \
  --test-name-pattern='held controller|invalid displayed risk' \
  frontend/test/v5-paper-presentation.test.mjs
```

The base archive contains exact `e0005086` application source, its module harness and recorded fixtures, plus the candidate test file. It was created with `git archive`; dependencies resolve through the existing frontend installation. Published text receipts strip trailing whitespace. Original byte hashes and paths remain in `validation.json`. The complete base failure log stays at the path and hash in `validation.json` because it embeds large repeated HTML strings.

## Confirmed causes and repairs

- The old page summary considered the status timestamp alone. The pinned copy already said “snapshot only; not current”; it did not make the native `B01-paper` tile's false Fresh claim. The extracted view now qualifies every displayed section and the accounting snapshot. A direct-render regression exposed a missing accounting binding check in the first implementation: 231/232 passed before the fix; the mismatch case failed. It now passes within the 236-test suite.
- Held-controller rows were keyed by evidence-read index and controller ID. The same controller appeared twice when displayed pause evidence and retained emergency evidence were both needed. The view now groups by controller ID and unions positive flags and distinct native hold explanations. It consumes the newer adapter's optional `entryHold` when present. Native latch evidence remains explicit. It does not mutate input reads or decide supersession. The existing safety store and selectors retain that authority.
- A wrapper around `MetricCard` inherited the kit's full-height card rule and the scoped panel margin. Disclosures escaped the grid cell. The metric wrapper now uses a column layout; its card has automatic height and no outer margin. All 20 final captures assert containment. The scoped note rule also overrides the kit's line clamp so source qualifications remain visible.

A TypeScript inference error in the controller view was fixed with the existing controller type annotation. An interrupted early shell-harness attempt and the mixed-CSS capture set and a later set with escaped disclosures were discarded. They are not counted as passes. All final counts above come from the frozen source whose hashes match `manifest.json`.

## Capture matrix and interactions

The public fixture is `frontend/test/browser/paper-presentation.html`. It mounts the extracted component inside the current `.condor-native` theme scope. It uses recorded native replay at a fixed clock; the additive-hold case changes only labelled synthetic pause/emergency evidence. It mounts no auth, polling or command route.

- Fresh source: 390, 768 and 1440 CSS px, in dark, light and colorblind themes: 9 images.
- Stale and retained-hold: all three widths in dark, plus 1440 light and colorblind: 10 images.
- Additive displayed/retained hold evidence: 1440 dark: 1 image.

The final fixture uses `paperObservationPages` to join the two recorded fill pages without changing their accounting. Fresh captures assert 344 retained rows. The fixture-only alignment occurred after the final application-source test/type pass; the final fixture was compiled and exercised by the browser.

Every capture checks its theme and viewport, no page overflow, no clipped metric text, no escaped disclosures, zero running animations under reduced motion, zero browser errors and zero API requests. The additional interaction groups exercise emulated touch inspection; pointer/keyboard exact disclosure and focus; table search, column filtering, keyboard resize and the actual CSV download. The additive fixture verifies one controller row with both pause and emergency. [CSV receipt](executors-exact.csv).

The T3 browser opened the exact Tailscale HTTPS fixture URL and read its rendered DOM. Its snapshot operation failed twice with `Preview automation snapshot timed out after 15000ms`. Captures then used system Chrome 157.0.8103.38 with Playwright and Node v24.21.0. Exact installed package versions are in `validation.json`. The task fixture server is stopped after capture. No service link is offered as a running preview.

## Comparison with root #652

The baseline uses Condor `cada0c12`; this task is stacked on R2 `e0005086`. These are component comparisons, not pixel equality or current-live comparisons. The fixed clock, fixture banner and retained controllers differ. Both recorded native fill pages are joined through the existing owner pager, as in Task 1; fresh captures assert the 344-row retained window.

| Baseline inspected | Candidate inspected | Result |
| --- | --- | --- |
| `v5-paper-stale-dark-1440.png`, SHA `ca736dfc4351e16f54415a31928139bc4c71d492b263fc4a0656f9b706b84fad` | [stale dark 1440](screenshots/v5-paper-stale-dark-1440.png) | Unpublished stale money, retained holds, stale protection captions, bounded records and collecting charts stay visible. A fresh process heartbeat remains separate. New section and per-metric state labels qualify the whole view. |
| `v5-paper-retained-hold-light-1440.png`, SHA `f3d7479d31851b2d69f728149be50f782bbd9ce168a4146677cb05dd73cc93ae` | [retained hold light 1440](screenshots/v5-paper-retained-hold-light-1440.png) | The light theme, retained emergency/entry evidence and pending snapshot remain visible. Neither fixture publishes wallet totals before completion. This candidate retains the full recorded controller set and an explicit synthetic clock hold. |
| Fresh component structure in the Task 1 matrix | [fresh dark phone](screenshots/v5-paper-fresh-dark-390.png), [fresh light desktop](screenshots/v5-paper-fresh-light-1440.png) | Adaptive kit cards replace the bespoke metric grid. Labels, values, notes and units stay intact. Exact disclosures sit inside their own tiles. Last report keeps secondary typography. |

The author inspected those candidate images and [additive hold dark 1440](screenshots/v5-paper-additive-hold-dark-1440.png), including the phone metric region at native width. The other images have automated checks; no claim of manual inspection of every pixel is made.

## Limits and handoff

Independent review, merges, deployment, image swaps and the R2/root release gates remain coordinator-owned. Full production/public-private builds and live-stack checks were not run for this frontend slice. Native command and polling code, financial/risk selectors and safety/journal retention were left in their owner paths.

Task 1 finding 4's actual `B01-paper` freshness defect is owned by the dashboard worker on main; `fleet-tiles.ts` is untouched here. The extracted `ActiveBotsTab.tsx` region overlaps #91. Rebase if #91 changes, and reconcile #97's safety projection/`entryHold` changes when it lands. The view does not copy that retention repair.

Tasks 3–4 still own native candle transport, C3 qualification/paging and the private chart adapter/export. The collecting chart fallback remains. Rollback is a reviewed revert of this task's commits. No state migration or owner restart is needed.
