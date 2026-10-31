# F19: bounded, coherent paper reads

Condor restarts the entire read once after HTTP 409 or 503. It never joins
sections from different snapshots. A second failure leaves the existing honest
unavailable presentation. This is a read-only consumer repair, not a deployment
or a qualification pass for the API owner's retention/verification repair.

## Scope and bounds

- Approved starting point: `15719dba9e73c3089ba8224d5a9dac1e342c3de5`.
- Authority: paper, read-only projection. No contract field changes.
- HTTP 409: discard all attempt-local results and obtain current status again.
- HTTP 503: discard all attempt-local results, wait 200 ms, obtain status again.
- At most two attempts per query invocation. Existing periodic refreshes remain.
- Owner concurrency is one within each read. No abandoned `Promise.all` siblings
  continue to compete with a retry.
- Every transport request has a 14-second timeout. List/history paging retains
  the approved 200-row limit, five-page bound, snapshot pin and truncation marker.
- Auth, same-origin rules, route allowlists, strict schemas and live denials do
  not change. Auth and schema errors do not trigger transport retries.
- Bots retains section-level schema degradation. Accounting joins the same
  attempt. A non-transient accounting failure is explicitly unavailable, not zero.
- A failed periodic refresh cannot show old query data beside the error as if it
  were a successful current read.
- Capital and Operations receive the root dashboard's existing `paperRead`
  input. No root-dashboard worker source was changed.
- When no paper owner is configured, the new workspace queries stay disabled.

| Reader | Maximum requests per attempt | Maximum per invocation | Result |
|---|---:|---:|---|
| Bots, including accounting | 25 | 50 | One snapshot; section schema errors remain explicit |
| Settings and Readiness, shared health reader | 13 | 26 | One snapshot; no heartbeat substitute |
| Capital: status, wallet, history, accounting | 8 | 16 | Coherent supplied wallet/history/accounting |
| Operations: independent host export | 1 | 2 | Independent owner envelope; no financial join |

Counts include the worst case of five pages for every paginated section.
Ordinary reads need fewer requests. The existing 15-second query refresh is not
an extra attempt inside the retry loop. Some longer visual captures include a
later successful periodic refresh; their receipts retain that fact.

## Fail before, pass after

The current actual-query regression tests were run against an immutable
`git archive 15719dba frontend/src` under scratch, with the approved fixtures
and the same dependencies. All **16 actual-query cases failed** there. They
cover health, Capital, Operations and Bots, each with 409/503 recovery and
409/503 exhaustion. The separate new helper regressions first failed in four
cases. Their complete outputs are retained here.

After the repair:

| Check | Result |
|---|---|
| Focused paper page/Bots tests | 91 passed |
| Full frontend | 1,033 passed, 1 skipped |
| Full Python, plugin environment | 4,161 passed, 8 skipped |
| TypeScript build | PASS |
| V5 bundle | PASS |

The first Python run hit the unrelated 100 ms scheduling deadline in
`test_stalled_status_read_is_bounded_and_waiting_summary_recovers`. That test
passed alone. The entire suite then passed unchanged. Both runs and the isolated
test receipt are retained; no timeout or test assertion was weakened.

Commands run from the Condor owner worktree:

```bash
export TMPDIR=/home/rsi/dev/rsibot/.workspace/scratch/v5-paper-dashboard/tmp
PYTHONPATH=.:tests:/home/rsi/dev/rsibot/.workspace/scratch/v5-paper-dashboard/pytest-plugin \
 /home/rsi/dev/rsibot/condor/.venv/bin/python -m pytest -q -o addopts= tests \
 --basetemp="$TMPDIR/f19-full-20261031b" -p no:cacheprovider
node --test frontend/test/v5-paper-pages.test.mjs frontend/test/v5-paper-bots-contract.test.mjs
node --test frontend/test/*.test.mjs
frontend/node_modules/.bin/tsc -b frontend/tsconfig.json
V5_WORKSPACE_ROOT=/home/rsi/dev/rsibot/.workspace/scratch/v5-wp14/final3-20261030/src/workspace-f3dcee938f3c \
 frontend/node_modules/.bin/vite build --config frontend/vite.v5.config.ts --emptyOutDir false
git diff --check
```

The pinned workspace source is `f3dcee938f3c74528e44a677b053555008f7e973`, the
same combined source used in FINAL4. A first build using FINAL4's extracted
workspace failed because its `condor/frontend/tsconfig.app.json` was absent.
The prior extraction of that same pinned source contains the required build
configuration and built successfully. No owner source was patched for the build.

## Bundle and browser proof

- Entry: `/assets/v5-PXRF8ydq.js`.
- SHA256: `fe4ad689dc593f9820101e527966f7c00a0f1a65053d4c96ddf108d8c62df9a4`.
- Disposable project: `v5-f19-fixture-20261031`.
- Existing fixture image: `rsibot-v5-dashboard:main-024dcf5a-aa306357`.
- Image ID: `sha256:804b2cc47e27b23db3032d3989341f51bd142c05c1a4a39ff15c20d0cd5f2be4`.
- No new Docker image. Current source and frozen built assets are read-only mounts.
- Real native API records: `tests/fixtures/paper-api-final3/native-replay/`, with
  the approved provenance and hashes. The fixture rebases timestamps, snapshot
  sequence and cursor identity together; economic values remain unchanged.
- The fixture injects one 409 or 503, or repeated 503s. A retry obtains a different
  snapshot. Market-only data is explicitly synthetic, with four seconds of owner
  delay per request. It is not a claimed production market source.
- The exact task-scoped Tailscale HTTPS origin was opened in the shared browser
  and authenticated. Two resize calls stayed at 1280×800 rather than the requested
  1440/390. The real-Chrome harness then used exact widths over the same HTTPS
  origin. No loopback, LAN, Funnel or protected service was used for browser proof.
- `screenshots/screenshot-index.json` binds every capture to the built HTML and
  entry SHA256 and verifies every loaded JS/CSS asset against `dist-v5`.
- All captures are full-height. The harness checks overflow, clipped main content,
  unexpected schema panels, successful reads and coherent per-attempt receipts.
- Expected transient HTTP failures remain in the index. Some error responses have
  no retained browser body because the application rejects them by status without
  consuming their body. HTTP status is retained; all successful response bodies
  are required for snapshot validation.

Each scenario has light, dark and colour-blind captures at 1440 and 390:

| Scenario | Desktop contact sheet | Narrow contact sheet |
|---|---|---|
| Bots 409 → success | `sheets/bots-409-1440.png` | `sheets/bots-409-390.png` |
| Bots 503 → success | `sheets/bots-503-1440.png` | `sheets/bots-503-390.png` |
| Bots exhausted → unavailable | `sheets/bots-exhausted-1440.png` | `sheets/bots-exhausted-390.png` |
| Capital 503 → success | `sheets/capital-1440.png` | `sheets/capital-390.png` |
| Operations 503 → success | `sheets/operations-1440.png` | `sheets/operations-390.png` |
| Settings 409 → success | `sheets/settings-1440.png` | `sheets/settings-390.png` |
| Readiness 503 → success | `sheets/readiness-1440.png` | `sheets/readiness-390.png` |
| Delayed Market chart → rendered | `sheets/candles-1440.png` | `sheets/candles-390.png` |

The index supplies all 48 individual absolute PNG paths, theme/width, hashes,
visible text and API receipts. The contact sheets preserve the entire capture,
not selected crops.

All 48 captures were visually inspected through the 16 full-height theme contact
sheets. Recovery views retain owner data; the exhausted view shows unavailable,
not an empty wallet. Settings keeps heartbeat fields separate. Readiness stays
NOT_READY. The delayed candle chart is rendered in both widths and all themes.
Capital retains exact native decimals, which wrap at narrow widths. Operations
retains the approved owner's monitor IDs and recorded degraded checks; this
transport repair does not relabel or clear those checks.

## Market diagnosis: qualification capture timing, not F19

FINAL4's `qualification/shots.mjs` waits 3,500 ms, then 800 ms plus any scroll
steps. It does not wait for the dependent candle request or a rendered chart.
The retained real candle reader log gives a precise example:

| Event | UTC |
|---|---|
| Symbols request starts | 2026-10-31 01:08:42 |
| Symbols completes HTTP 200 | 2026-10-31 01:08:46.162 |
| Overview completes HTTP 200 | 2026-10-31 01:08:46.217 |
| FINAL4 desktop light screenshot | 2026-10-31 01:08:47.547 |
| Dependent candles completes HTTP 200 | 2026-10-31 01:08:49.978 |

The screenshot preceded the candle result by about 2.4 seconds. The candle
request is to the independent Unix-socket candle owner, not API73's paper-reader
lock. Thus its absence from completed browser response receipts did not prove a
missing binding. The Condor UI starts the candle read after symbols select an
instrument, has a 14-second request timeout and already renders an explicit error
on failure. The delayed fixture proves that it leaves loading and mounts the chart.

Owner of the remaining qualification action: the parent WP-14 harness. Wait for
the selected candle response and rendered chart, with an explicit deadline, rather
than sleeping a fixed 4.3 seconds. Do not increase arbitrary sleeps or manufacture
fresh prices. No Market source change is justified by this evidence. The stopped
FINAL4 reader was not restarted. A new real-trial chart qualification remains with
the parent, alongside API verification/retention integration.

## Safety and rollback

The task route is withdrawn and only the disposable project is stopped after
capture. Before/after Serve receipts show preservation of existing routes.
Protected compose projects, units, stores, credentials and the Mac were unchanged.
No files, containers, images or worktrees were removed. The existing owner
worktree remains for PR review; its unrelated `.workspace/` directory is preserved.
Rollback is a normal revert of this repair commit, never a state reset or force push.
