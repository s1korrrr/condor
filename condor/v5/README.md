# RSI V5 workspace backend

This is a separate FastAPI application factory. Run it with
`uvicorn --factory condor.v5.app:create_app`; do not include `condor.web.app` or its routers in
the V5 process. It does not import Condor's `AgentStore`, `TickEngine`, generic
agent routes, MCP tools, Hummingbot client, or deployment controls.

The app requires these process settings:

| Setting | Use |
| --- | --- |
| `V5_RUNTIME_ROOT` | V5-only database and local notes. Must not point into `.condor`. |
| `V5_DASHBOARD_TOKEN_FILE` | Login token for the V5-only HttpOnly cookie. |
| `V5_DASHBOARD_ORIGIN` | Exact browser origin checked on every write request. |
| `V5_OBSERVATION_BASE_URL` | Fixed observation API base URL. |
| `V5_OBSERVATION_TOKEN_FILE` | Read token for evidence and task-profile reads. |
| `V5_ADVISOR_CONTROL_BASE_URL` | Fixed advisor service URL. |
| `V5_ADVISORY_REQUEST_TOKEN_FILE` | Separate request token for bounded assessment POSTs. |
| `V5_STOCK_AGENTS_ROOT` | Read-only V5 stock agent folders; defaults to the repository `agents_v5/`. |
| `V5_FRONTEND_DIST` | Separate frontend build root; defaults to `frontend/dist-v5/`. |
| `V5_COOKIE_SECURE` | Defaults to `true`; use `false` only for an isolated local development browser. |
| `V5_PAPER_STATUS_FILE` | Optional. Absolute `<bot>.status.json` of the native paper runtime, mounted read-only. Unset keeps every projection unbound and unchanged. |

The stock agent definitions live in the repository-level `agents_v5/`. Runtime notes and optional
local agent overlays live under `$V5_RUNTIME_ROOT/agents/`; local files override
stock files on read. Agent names, tasks, tools, loop timing, and maximum loop
length are fixed in Python. Markdown cannot grant tools, change task IDs, select
a model, or enable execution. Without `V5_PAPER_STATUS_FILE` the decision
reviewer is exactly the unbound release's role: no task, no tools, no notes or
loop, and blocked until the native baseline and trace exist (pinned by
`tests/fixtures/v5_unbound_base_8284ffe7.json`).

## Read-only paper bot binding

With `V5_PAPER_STATUS_FILE` set, `condor/v5/paper.py` reads that one file per
request: a canonical path opened one directory at a time with `O_NOFOLLOW`
relative to the opened parent (so a directory swapped for a symlink after the
path check cannot redirect it), a regular non-symlink file (FIFOs refused), at most
2 MiB, strict JSON, and the `PaperRuntime.status()` contract of hummingbot
`scripts/component_paper_runtime.py` (`schema_version` 1,
`native_component_paper_runtime_v1`, `execution_mode` paper, the bot name from
the file name). A status older than 30 seconds is `STALE`; a missing, oversized,
malformed or future-dated one is `UNAVAILABLE` with a reason code. Nothing is
cached or invented.

Only a `FRESH` status sets `native_owner` to `PAPER_BOUND` in the profile and
server status. `/servers/rsibot-v5/bots` then lists the paper bot (mode PAPER,
simulated wallet only) with one controller row per native controller: native
PnL and volume only when that controller's native report is current, the
bounded `custom_info` (decision status, candle, bag) and readiness reasons.
Non-finite numbers (for example `"1e999"`, or totals beyond float range)
withhold the metrics. `/trading-visuals/sources` and
`/trading-visuals/bootstrap?bot=<bot>` feed the existing Bots roster card
(positions and active executors from native reports). Bot-wide
`positions_held` and `active_executors` are `null`, never a partial or empty
list, unless every controller has a current native report with both lists; a
controller without one is `observation_status: unavailable` with `report_state`
`unavailable`, or `retained` plus the retained `report_observed_at` when the
runtime kept a quiet book's report (dated, never counted as current).
A stale status shows the bot as stale without controllers or metrics. Account,
portfolio, holdings, executors and every control stay unbound: the paper wallet
balances are not published by the status file. Capabilities are unchanged
(read-only; no start, stop, manual trading or executor management).

With the status file configured, the decision reviewer uses the API task
`decision_review` and its paper prose in `agents_v5/decision_reviewer_paper/`.
It is ready only when the API reports that task enabled and the paper status is
`FRESH`; otherwise it shows the exact blocker (`paper_owner_stale`,
`paper_owner_unavailable:<reason>` and/or the task's reason) and exposes no
tools. The dashboard never reads the decision journal or
sends decision text; the API reads its own read-only mount.

Only `market_context`, `source_quality` and (when bound and enabled) `decision_review` reports can be requested. Calls use
fixed task and snapshot identifiers; browser input cannot provide a prompt,
provider, model, URL, source, or token. The API owns Claude enablement, pricing,
budget reservation, request persistence, and spend limits. Observation reads
have a five-second transport limit; report POSTs have a twelve-second limit to
allow the API's bounded ten-second provider request to finish. This dashboard never
receives the provider key. A dashboard loop waits at least fifteen minutes per
tick, allows at most 96 ticks, and stops without replay after process restart.

The V5 process takes an exclusive lock on its runtime root before opening the
journal. Only one dashboard process may use that root. Session and tick history
is append-only and is not pruned automatically. The journal stops accepting new
work at 200 sessions, 20,000 ticks, or 32 MiB; a report reserves outcome space
before the API request starts. To make a consistent SQLite backup, stop the V5
service and run:

```python
from pathlib import Path
from condor.v5.state import WorkspaceState

WorkspaceState.backup_database(
    Path("/var/lib/condor-v5/workspace.sqlite3"),
    Path("/var/backups/condor-v5-2026-10-28.sqlite3"),
)
```

The application serves the V5 frontend from `$V5_FRONTEND_DIST/v5.html` and its
`assets/` directory. The ordinary Condor app, routes, auth, runtime root, and
ports are not changed by this package.
