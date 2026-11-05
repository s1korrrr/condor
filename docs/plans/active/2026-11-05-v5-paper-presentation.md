# V5 paper presentation — Task 2

Objective: extract the existing paper view and adopt matching Condor kit primitives. Preserve owner values, exact detail/export, holds, journal evidence, read-only controls and independent clocks.

Owner/scope: Condor frontend presentation and focused tests. Authority: repository-process-only. Normal risk: no financial selector, reader, polling, command, backend or configuration changes. No live stack, credentials, builds/images, deploys, units, merges or other branches.

Base: condor #91, `e0005086169bd8b0ea9e1776f616e791d557cb48`, branch `feat/andrzej_v5_r2_release_20261102`. Own branch: `feat/andrzej_condor_v5_paper_presentation_20261105`. Worktree: `/home/rsi/dev/rsibot/.workspace/scratch/condor-task2-20261105/condor`. Root and owner dirty work preserved. No nested AGENTS.md exists at this base.

Evidence: root #648 plan from origin/main; Task 1 captures from root #652 (`0b7a65d7`); existing real native replay fixtures. Root sync divergence is coordinator-owned. HQ bootstrap reported one unpushed commit; untouched.

Checks: before every check, require absence of r3/LIVE_STEP_ACTIVE. All tests/typechecks through r3/run-test.sh, TMPDIR inside task scratch. Exit 75 means NOT RUN. Focused V5/kit/native tests, focused tsc, fixture comparison only. No full suite or production build before QUIET END.

Rollback: revert this task's commits after review. No state migration, restart or operational step needed. Coordinator owns review/merge/rebase and deployment.

- [x] Add rendering tests before extraction. Fail-before execution is NOT RUN during strict quiet. Exact pinned base copy is retained in task scratch.
- [x] Extract PaperWorkspace and view helpers, retain old-site export and polling.
- [x] Adopt MetricCard/TileGrid/PanelFrame/StatStrip/DataTable where compatible.
- [x] Verify exact decimal detail and CSV; ratio scaling, null/zero and invalid percent.
- [x] Scope styles, compare Task 1 captures and check reduced motion.
- [x] Run focused checks; self-audit; one stacked draft PR and handoff.

## Issue register

| Area | Cause/evidence | Repair/verification |
| --- | --- | --- |
| Task 1 finding 4, B01-paper | fleet-tiles.ts:175 hardcodes fresh while cards derive source state | Parent assigned to Claude dashboard worker on main; trace sent; NOT IN THIS DIFF |
| V5 summary state | Parent label uses only status timestamp; no child qualification | Add explicit section qualification inside extracted module; keep snapshot age and heartbeat distinct |
| Exact detail/export | Record column values currently use rounded unit strings | Keep formatted cells, expose raw owner strings for export and exact details; do not recompute accounting |
| Journal/risk retention | Existing hooks retain received safety/journal evidence outside display | Preserve hook ownership and prove existing retention checks plus rendered holds |

Tasks 3–4 remain deferred: native candle bridge, C3 validation/paging, private chart adapter/export and integrated chart proof. Collecting fallback remains visible.

## Strict quiet handoff — 2026-11-05

Parent ordered strict quiet for about 75 minutes at 14:50 UTC. No node, vitest, tsc, pytest, browser fixture server or build runs until the flag is removed and QUIET END arrives. A rendering test queued before the flag appeared was cancelled while waiting on the shared lock. It ran no tests. `before.log` is empty and is not evidence of a pass or a reproduced failure.

Implementation level: **IMPLEMENTED BUT UNVERIFIED**. `git diff --check` passes. All runtime checks and independent review are **NOT RUN**. Parent owns review, merge, image changes and root divergence. Worktree/branch must stay for continuation; nothing was deleted.

The pinned #91 status-age text already says `snapshot only; not current`; it does not make B01-paper's unconditional Fresh claim. This extraction adds an explicit section-state summary and per-section inspection. The added stale-child regression asserts this qualification independently of the current status timestamp and fresh heartbeat. Do not describe it as the original B01-paper repair.

Post-quiet commands: `/home/rsi/dev/rsibot/.workspace/scratch/condor-task2-20261105/verify-after-quiet.sh`. It runs the new regression against an archived exact `e0005086` source first, then the candidate's focused V5/kit/native tests, then TypeScript. Inspect base failures for assertion failures rather than import/setup failures. Exit 75 is NOT RUN. The compatibility-export test only applies to the candidate; exclude it from the baseline regression run.

Browser fixture: `frontend/test/browser/paper-presentation.html` (recorded native replay, fixed source clock, no backend/token/commands). After QUIET END, run focused Vite through the shared runner, then inspect fresh/stale/retained-hold at 390/768/1440 and dark/light/colorblind, reduced motion, exact metric disclosure, table search/filter/export and contained scrolling. Stop the task-owned fixture server afterward. Any service link sent to Rafal must be browser-verified Tailscale Serve HTTPS; no localhost/LAN/Funnel links.

### Task 1 capture comparison

Viewed existing root #652 images: `v5-paper-stale-dark-1440.png` and `v5-paper-retained-hold-light-1440.png`. Their baseline shows separately labelled Fresh heartbeat beside stale unavailable monetary values, retained emergency/entry holds, stale position protection captions, bounded records and collecting charts. These semantics remain in source. New candidate captures are **NOT RUN** because of strict quiet; no visual parity or overflow PASS is claimed.

Expected visual changes: kit PanelFrame and adaptive TileGrid replace the bespoke fleet metric frame; exact decimal disclosures and per-metric state are visible; section inspection explains stale/partial reads; rail use displays the existing native percent value through StatStrip. Existing recipe-specific pair, protection and hold markup remains. CSS is scoped to `[data-paper-workspace]` and uses current theme variables. No global quant skin or V1/V2/V3 retheme. No financial animation or inferred activity is introduced; reduced motion disables descendant animation/transitions.

### Overlap and remaining work

`ActiveBotsTab.tsx` extraction overlaps #91's PaperWorkspace region. Draft base is #91's task branch, never main. Rebase this diff if #91 changes; after #91 merges, retarget/rebase under coordinator control. No backend or #91 worker branch writes. Claude worker owns findings 1–4 on main, including fleet-tiles.ts and long-ID CSS. Reconcile its result when stacking/retargeting; this task deliberately makes no fleet-tiles fix.

Tasks 3–4 still own native candle routing, C3 schema/page/source qualification, bounded history, private chart adapter and export. Pair charts retain the collecting fallback. Full public/private builds and cross-contract gates remain required before merge under parent authority; none ran in strict quiet.

## Post-quiet completion — 2026-11-05

Final evidence: `docs/evidence/2026-11-05-v5-paper-presentation/README.md`, `validation.json` and `manifest.json`. The prior strict-quiet section is historical; runtime validation is now complete for this slice.

- Exact pinned-base rendering regression: exit 1, expected; 10 tests/10 assertion failures after tightening exact-zero disclosure checks. No import/setup error.
- Candidate: exit 0; 236/236 focused tests, zero skipped. TypeScript: exit 0, no diagnostics.
- Captures: exit 0; 20 images and 3 interaction groups. Zero overflow, clipped metric text, escaped disclosures, running reduced-motion animations, browser errors or API requests. Source and PNG hashes match.
- Controller duplication handed off by the dashboard worker: four fail-before/four pass-after cases. Group one row per controller and preserve the union of received positive hold signals. Retention/supersession stay in existing selectors/hooks. Optional future adapter `entryHold` is consumed in the presentation union.
- Manual inspection found exact disclosure overflow. A browser check reproduced seven escaped disclosures before the scoped flex/height/margin fix; all 20 final captures pass containment.
- Existing risk and journal retention checks pass. Capture uses recorded/synthetic fixtures, not live state. No commands, providers, tokens, Docker, units, deployment or production build was used.

Draft #98 stays stacked on #91's `e0005086` branch. #91 was rechecked and is unchanged. Coordinator owns independent review/merge and any rebase after #91/#97 changes. The task worktree remains for that review. Rollback remains a reviewed revert; no state operation is required.
