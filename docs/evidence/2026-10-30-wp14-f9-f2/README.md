# WP-14 F9 and F2 fixture qualification — 2026-10-30

The consumer-side F2 defect is fixed. The F9 routes render coherent paper states in a disposable fixture dashboard. This is not a live-stack qualification or a production-readiness pass. The upstream companion-read race (F3) is outside this change.

## Scope and authority

- Authority: paper, read-only dashboard projection and repository work.
- Condor PR82 branch: `feat/andrzej_v5_operations_export_20261029`, before head `a9422fd32a4a17de9a68b06d25bc30768b91c282`.
- Root PR594 branch: `feat/andrzej_v5_paper_workspace_ui_20261029`, before head `042776129437efad297dc6ed97a2cc8ac3d50b52`.
- Canonical risk extension: hummingbot #220 at `1e131c74ec7b3633780b22442d0ded08954ac3cc`. `risk.data.controllers` is a keyed object. `decisions.data.controllers` remains a list. No producer contract was invented.
- The vendored `tests/fixtures/paper-c1-1e131c74/native-entry-holds.json` is the exact owner fixture. The browser combines owner partial-close and native-hold data with synthetic service, market and candle data. Its clocks are shifted for freshness tests.
- No exchange call, live write, paid report, protected service change, deployment or secret read. The unrelated root `condor` gitlink is not part of this repair.
- The optional workspace-module stub only gains matching prop signatures. The real workspace adapter remains in PR594.

## Before and after

Before root: `/home/rsi/dev/rsibot/.workspace/scratch/v5-wp14/prefinal-20261030a/shots-full/`.
After sheets: `docs/evidence/2026-10-30-wp14-f9-f2/sheets/` in this Condor worktree. Each sheet contains light, dark and colour-blind captures, in that order. Both widths have a sheet for every row. All 38 sheets were opened and visually inspected. `screenshot-index.json` gives the absolute path and SHA256 of each of the 114 selected full PNGs. `before-screenshot-index.json` preserves the parent's 78 before paths and hashes.

| Item | Before PNG, relative to before root | Repair and observed result | After sheets, 1440 and 390 |
| --- | --- | --- | --- |
| F2 / Bots risk | `bots-1440-light.png` | Strict keyed risk map renders native controller controls and entry holds. Lists and malformed map records fail closed. The authenticated browser risk request returned 200 with an object, not a list. Partial risk remains Incomplete. | `bots-1440.png`, `bots-390.png` |
| Market status and overflow | `market-390-light.png` | Publisher health and data age have separate labels. Shared status chips and cohort headings wrap within the narrow shell. Same synthetic feed is stable across themes. | `market-1440.png`, `market-390.png` |
| Candle store settling | `market-candles-390-light.png` | Existing candle-store route settles on valid synthetic owner coverage and chart data in all six captures. No candle-store contract or code changed. This does not prove the production store settles. | `candles-1440.png`, `candles-390.png` |
| Market evidence | `market-evidence-1440-light.png` | Paper route shows an intentional not-connected state with owner and next step. No legacy dark frame or raw HTTP-503 banner. Non-paper behavior stays unchanged. | `market-evidence-1440.png`, `market-evidence-390.png` |
| Capital | `capital-1440-light.png` | Mounts the existing paper wallet/history/accounting projection, not the legacy live fleet route. Light theme applies. Marked inventory, cash and equity reconcile. Unqualified history says Collecting, not an enum. | `capital-1440.png`, `capital-390.png` |
| Operations | `operations-390-light.png` | Mounts the paper host export. Five synthetic service tiles render. Shared tables retain scroll and resize behavior; state labels use human words. | `operations-1440.png`, `operations-390.png` |
| Tradepad | `tradepad-1440-light.png` | Deliberate paper not-connected state explains the missing owner and next step without UNBOUND wording. No fabricated publication. | `tradepad-1440.png`, `tradepad-390.png` |
| Agents / detail overflow | `agent-detail-390-colorblind.png` | Shared safety footer wraps. Report heading puts its status on a new row when needed. EXPIRED no longer splits. Paid reports remain blocked. | `agents-1440.png`, `agents-390.png`, `agent-detail-1440.png`, `agent-detail-390.png` |
| Settings consistency | `settings-1440-light.png` | Snapshot-validated paper read health is separate from process liveness. Partial risk reports Incomplete. Owner failure reports Unavailable, not Fresh. Provider-key path is absent. | `settings-1440.png`, `settings-390.png`, `settings-unavailable-1440.png`, `settings-unavailable-390.png` |
| Readiness consistency | `readiness-1440-light.png` | Coherent paper read summary replaces heartbeat-as-data-health. Four P0 gates stay NOT_RUN; NOT_READY remains. | `readiness-1440.png`, `readiness-390.png`, `readiness-unavailable-1440.png`, `readiness-unavailable-390.png` |
| Research / Sessions | `research-1440-light.png`, `sessions-1440-light.png` | Prior deliberate not-connected / empty-journal states remain readable in all themes. No invented research binding or session history. | `research-1440.png`, `research-390.png`, `sessions-1440.png`, `sessions-390.png` |
| Retained/error Bots states | Compare initial Bots failure above | Stale reports retain local as-of warnings and cannot claim current protection. Malformed sections remain section failures. Known holds retain clearing actions. Unavailable owner reads show a human diagnostic, not an HTTP banner or zero wallet. | `bots-stale-{1440,390}.png`, `bots-malformed-{1440,390}.png`, `bots-hold-{1440,390}.png`, `bots-unavailable-{1440,390}.png` |

The browser checks found zero page exceptions, zero document-width overflows, and zero clipped main scrollers across the selected 114 captures. Wide shared tables intentionally scroll within their own containers.

## Fail before / pass after

Logs are retained under `/home/rsi/dev/rsibot/.workspace/scratch/v5-paper-dashboard/`.

| Command / gate | Result | Log |
| --- | --- | --- |
| F2 Python regression against old parser | FAIL as expected: keyed map rejected; list wrongly accepted (2 failed, 4 passed) | `f2-red.log` |
| F2 frontend regression against old guard | FAIL as expected: list accepted | `f2-frontend-red.log` |
| Workspace route and coherent-health regressions before implementation | FAIL as expected: missing projections | `wp14-condor-red.log` |
| Shared human owner-label regressions before implementation | FAIL as expected: missing helpers | `wp14-root-red.log`, `wp14-label-red.log` |
| Condor full Python suite | PASS: 4077 passed, 8 skipped, 18 warnings | `wp14-python-verified.log` |
| Condor `node --test frontend/test/*.test.mjs` | PASS: 993 passed, 1 skipped, 0 failed (994 total) | `wp14-frontend-reverified.log` |
| Root `node --test dashboard/condor-workspace/test/*.test.mjs` | PASS: 421 passed, 0 failed | `wp14-root-verified.log` |
| `frontend/node_modules/.bin/tsc -b frontend/tsconfig.json` | PASS | `wp14-tsc-reverified.log` |
| Combined V5 Vite build | PASS | `wp14-build-verified.log` |

Python command, from the Condor worktree:

```bash
export TMPDIR=/home/rsi/dev/rsibot/.workspace/scratch/v5-paper-dashboard/tmp
PYTHONPATH=.:tests:/home/rsi/dev/rsibot/.workspace/scratch/v5-paper-dashboard/pytest-plugin \
  /home/rsi/dev/rsibot/condor/.venv/bin/python -m pytest -q tests \
  --basetemp="$TMPDIR/wp14-suite-<unique-timestamp>" -p no:cacheprovider
```

Build command, from the Condor worktree:

```bash
V5_WORKSPACE_ROOT=/home/rsi/.t3/worktrees/rsibot/t3-d0925a05 \
  frontend/node_modules/.bin/vite build \
  --config frontend/vite.v5.config.ts --emptyOutDir false
```

The local async pytest plugin must be on PYTHONPATH. An earlier attempt lacked that plugin and failed async tests. Another attempt registered it twice and stopped during setup. Those are retained environment failures, not hidden passing results. An earlier timing test also failed under concurrent build/browser load; the complete isolated run above passed.

## Disposable browser and withdrawal

- Project: `v5-wp14-condor-fixture-20261030`. Compose: `/home/rsi/dev/rsibot/.workspace/scratch/v5-paper-dashboard/compose-wp14.yaml`.
- New Serve route was HTTPS port 25443. The exact Tailscale HTTPS `/bots` route was opened and checked in Chrome. Preview snapshots twice failed with `Preview automation snapshot timed out after 15000ms.`; installed Chrome/Playwright then captured the evidence.
- Reused image `rsibot-v5-dashboard:main-024dcf5a-aa306357`, ID `sha256:804b2cc47e27b23db3032d3989341f51bd142c05c1a4a39ff15c20d0cd5f2be4`. No image was built. Changed sources and the combined Vite output were mounted into the disposable container. This is source qualification, not immutable-image proof.
- The disposable container is stopped, not removed. Its own Serve port 25443 is withdrawn. The before/after Serve JSON objects are identical. All pre-existing routes remain. The owned browser tab is closed. No files, images, networks, containers or worktrees were deleted.
- Evidence uses full-height captures: viewport width is 1440 or 390, height grows to include the inner scrolling main content. This avoids pretending a viewport-only image proves the lower page.

## Remaining limits and rollback

- F3 mutable companion-read chain race needs owner/API proof on the real integration. Fixture success does not clear it.
- Bots pair charts remain explicitly Collecting. Root PR594 exports `StrategyCharts`, but the optional native `PaperStrategyCharts` mount is not yet bound. No invented candle route or UI-derived prices were added. Candle-store charts are a separate route and use synthetic candle-owner data here.
- The fixture risk section is partial. Current numeric rails, readiness and completeness are not promoted by a fresh process heartbeat.
- Research and Tradepad stay deliberately not connected. Production expiry, deployment, lifecycle, and trading were not exercised by this round.
- Rollback is a normal revert of the two task commits. Do not reset published history. New heads require independent review; prior approvals do not transfer automatically.
- Worktrees and scratch evidence remain because the task forbids deletion and the full PNGs live there. Preserve them for review.
