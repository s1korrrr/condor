# V5 paper dashboard polish — local evidence

Latest repair: [round4-clocks.md](round4-clocks.md) records clock-skew and
rollback protection, early emergency banners, both reviewer regressions,
reviewed bundle hashes and current checks. Earlier receipts are historical.

Latest fix-round results are in [round2.md](round2.md). The bundle hashes,
counts and browser evidence below describe the original `43695d26` round,
not the fixed head. Independent rereview remains pending.

Requested test suites and typechecks pass. Two baseline ESLint errors remain.
This is a draft integration candidate, not requalification,
deployment, a merge decision or paper/live authority. Merge only after the
live-trial move, with Condor #84 and the separate rsibot workspace branch.

## Sources and boundary

- Condor base: `be2a3365801d9d1ec3e12d79a365c07ef1c4fefd` (`origin/main`).
- Condor branch: `feat/andrzej_v5_dashboard_polish_20261031`.
- Workspace base: `d1b160abc67fecf929f08c06a5b9d3cce72af967` (`origin/main`).
- Workspace branch: `feat/andrzej_v5_workspace_polish_20261031`.
- API source: `5a24d9c25158f9740b846bdbdc4ad79a53e2af55`, exported to task scratch.
- No API changes, protected stacks, units, Docker networks, Mac, provider calls,
  deployment, orders or lifecycle controls. Fixture owner trust is scratch-only.
- `frontend/src/v5/V5App.tsx` and `condor/v5/learning.py` are unchanged.

## Mechanism

Status establishes the snapshot. Three workers fetch pinned sections; each
worker pages its own section serially. A failure stops further section dispatch,
clears progress and drains existing workers before any second whole-read attempt.
409 restarts once. 503 waits 200 ms and retries once. Other errors fail closed.
Pagination retains the existing five-page bound. No results from different
snapshots are joined.

Partial sections render at one snapshot. Fleet totals, accounting, rail totals
and charts stay withheld until the complete read arrives. Capital can render
balances before history/accounting; aggregate tiles remain withheld. Readiness
and Settings report the observed read state, not process liveness.

The host monitor uses a separate file contract, not API73's Pydantic model.
Its Condor adapter supplies the actual adapter read time, nullable owner times,
no declared capabilities and an explicit `host_monitor_export` source owner.
It does not invent a hash, health state, observed timestamp or capability.
Missing API73 fields are still rejected at the API-consumer boundary.

## Latency

Seconds, full section completion p95. Thirty timed samples per cell; one warmup
per page/loader. Each returned envelope is compared in full against the baseline.
All envelopes also pass the current TS validator. No delay is injected.

| Page | Before, serial | After, pool 3 |
| --- | ---: | ---: |
| Bots | 0.144023 | 0.124160 |
| Settings | 0.062074 | 0.059006 |
| Readiness | 0.067760 | 0.057222 |
| Capital | 0.044040 | 0.037652 |

The fixture uses API73's real ASGI app in-process through TestClient and a stdio
bridge. It has a 404,074-byte primary, 344 fills, 45 executors and the copied
owner history companion. The read limit is 200, so fills traverse two pages.
Peak concurrency is one before and three after. There are 240 timed reads and
eight warmups across four pages and two implementations.

The measured Bots target is below six seconds. The serial baseline is also below
six seconds with this API73 app. These measurements do not reproduce FINAL6's
21.1-second Bots p95 or establish deployed-stack latency. Transport, host load,
cold publication verification and larger archives require the new qualification.
The exact pre-change shared loader is used for the baseline. Its successful Bots
section schedule matches the old serial page loop; UI error paths are tested
separately. Settings/Readiness measure their owner-read work, not unrelated assets.

Reproduce from the Condor task checkout, with an isolated API export:

```bash
export TMPDIR=/home/rsi/dev/rsibot/.workspace/scratch/v5-dashboard-polish
mkdir -p "$TMPDIR/api73"
git -C /home/rsi/dev/rsibot/hummingbot-api archive 5a24d9c2 \
  services/strategies/v5_advisory test/fixtures/paper_observation_v2/real-trial/emitted \
  | tar -x -C "$TMPDIR/api73"
mkdir -p "$TMPDIR/baseline"
git show be2a3365:frontend/src/v5/policy.ts > "$TMPDIR/baseline/policy.ts"
node frontend/tooling/benchmark-v5-paper.mjs \
  /home/rsi/dev/rsibot/condor/.venv/bin/python "$TMPDIR/api73" \
  "$PWD/tests/fixtures/paper-api-final3/native-replay" "$TMPDIR" \
  "$TMPDIR/baseline/policy.ts" 30
```

The bridge creates a fresh scratch directory on each invocation. It copies the
export before enrollment; it does not read a running owner or live trust store.

## Fail-before and pass-after

- Pool/progress: baseline peak is one, not three; it emits no partial progress.
  The new test also proves that workers drain before a 409 restart and that no
  late old-attempt result appears after progress resets.
- Missing fields: an explicit import of baseline `paper.py` accepts all six
  removed API-required fields. It also accepts `{}` and `[]` for `fee_quote`.
  The current validator rejects all eight cases; blank capability strings pass.
  `python-baseline-probe.log` records the baseline source path and eight defects.
- TS baseline: 15 failures and five passes in the initial 20-case regression.
  Existing price/quantity checks already reject containers; newly covered
  fee/amount/balance/PnL cases fail before the change.
- Capital formatting, partial totals and Operations labels: three workspace
  render regressions fail before the change and pass after it.
- Settings: all five subtitle-state cases fail before and pass after.
- Bots risk caption: doubled punctuation fails before and passes after.
- API73 real replay records, pagination, retry caps, schema failures, stale data,
  ownership and existing read-only boundaries remain covered by the full suites.

## Commands and counts

All commands use `TMPDIR` above. Condor commands run in its task checkout.

```bash
PYTHONPATH=.:tests:/home/rsi/dev/rsibot/.workspace/scratch/v5-paper-dashboard/pytest-plugin \
  /home/rsi/dev/rsibot/condor/.venv/bin/python -m pytest -q -o addopts= tests
node --test frontend/test/*.test.mjs
(cd frontend && node_modules/.bin/tsc -b)
(cd /home/rsi/dev/rsibot/.worktrees/v5-workspace-polish/dashboard/condor-workspace \
  && node --test test/*.test.mjs)
/home/rsi/dev/rsibot/condor/.worktrees/v5-dashboard-polish/frontend/node_modules/.bin/tsc \
  --noEmit -p /home/rsi/dev/rsibot/.worktrees/v5-workspace-polish/dashboard/condor-workspace
```

| Check | Result |
| --- | --- |
| Condor Python | 4,242 passed, 8 skipped, 18 warnings |
| Condor frontend Node | 1,060 passed, 1 skipped |
| Workspace Node | 443 passed |
| Condor `tsc -b` | PASS |
| Workspace typecheck | PASS |
| Cross-root reproducible build | PASS, 35 identical files |
| Browser matrix | 16 views inspected; one extra Settings fault view |
| Changed-file whitespace | PASS |
| Touched frontend ESLint | Two pre-existing errors, no new ones |

ESLint reports unused `_risk` and `_owner` in `policy.ts`. The baseline reports
the same errors at lines 200 and 404; current lines are 224 and 428. They are not
changed by this task. Two fleet-summary wall-clock timeout tests failed in the
first concurrent full run. The unchanged tests pass in the narrow rerun and in
the final full run; no fleet-summary code or tests changed.

## Bundle identity

- Entry: `assets/v5-BV7P1xdK.js`.
- Entry SHA256: `20c374914e5b6a97e3a514a551943fe3c5b4c0a82bbb42478bf9860487a1d5e4`.
- Manifest SHA256: `818286c8ff07efbea25254ae28832fd67fae6c4af5445cfb12bac70c8282782b`.
- API `app.py` SHA256: `6dc4b90d81b62b5c3fe9974d287c349f57c647c1eb73b5a2298c74d640b94fa0`.
- API `paper_observation.py` SHA256: `d069c633f312f0f4931c74b3fbab5712ade7b0cd7a2f8a53e1ca50d34340bfa7`.

```bash
node frontend/tooling/check-v5-reproducibility.mjs rebuild \
  "$TMPDIR/independent-repro" \
  /home/rsi/dev/rsibot/.worktrees/v5-workspace-polish \
  "$TMPDIR/workspace-independent"
```

The second root contains real copies of `dashboard/condor-workspace` and
`dashboard/hummingbot-reporting-next`, plus the expected Condor owner link.
Both roots must expose `condor/frontend/tsconfig.app.json` through the expected
owner link while the build runs. Removing the temporary link is cleanup, not a
supported build layout.
A symlink-only dashboard replica did not preserve module resolution and failed
the hash check. It is not a valid independent workspace layout. The real-copy
cross-root check passes. Build warnings about chunk size and an existing mixed
static/dynamic import remain; no build errors occur.

Both #84 and this branch change the manifest. Whichever merges second must
regenerate it against the merged workspace sources. Do not resolve that conflict
by retaining either old manifest. The manifest here binds the separate workspace
polish sources, not a claimed build of an unchanged rsibot main.

## Browser evidence and cleanup

The fixture entry is `docs/v5-dashboard-polish-fixture.py`. It uses only copied
native replay data and a synthetic upstream. The 120 ms fixture response delay
is for visible progress checks only; it is not used by the latency benchmark.

All four pages were opened at the exact private Tailscale HTTPS endpoint on port
30443 in the real shared browser. Light/dark and CSS widths 1440/390 were saved
under `screenshots/` and inspected through four contact sheets. The browser tool
downscales 1440-wide captures to 1280×889 PNGs; 390-wide PNGs are 390×1000.
Names identify the tested CSS viewport, not native PNG dimensions.

Observed runtime checks:

- Bots refresh reached `2/9 sections` with all eight aggregate values `Not
  published`; strategy charts were not mounted. The final result later rendered.
- Capital displayed `198,162.290652… USDC`, with exact hover text
  `198162.29065200662240123456789123456789 USDC`. No float conversion occurred.
- Operations showed human labels and secondary exact IDs for all seven retained
  monitor findings, including `risk.entry_paused` and `disk.low:/home`.
- Bots risk text and Capital history text had no doubled periods.
- Injected 503 faults made the Settings subtitle and identity read state
  `Unavailable`, while process heartbeat remained separately labeled liveness.
- The fixture's intentionally degraded wallet stays degraded; formatting does
  not manufacture reconciled equity. Narrow service cards and exact IDs still
  wrap on mobile; this task does not redesign the existing page hierarchy.

The task's browser tabs, fixture process and Serve port 30443 were closed.
All original Serve TCP/Web mappings were checked and preserved. Raw screenshots
also remain at `/home/rsi/dev/rsibot/.workspace/scratch/v5-dashboard-polish/screenshots/`.
No temporary service remains for review. Start a new bounded fixture for replay;
do not use an expired endpoint.

## Rollback and remaining gate

Revert the Condor and workspace polish commits. No runtime restart is needed.
The parent owns independent review, merge order after the live-trial move,
regeneration after #84 and the separate requalification. No deployment or
requalification is claimed here.
