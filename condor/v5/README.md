# RSI V5 workspace backend

This is a separate FastAPI application factory. Run it with
`uvicorn --factory condor.v5.app:create_app`; do not include `condor.web.app` or its routers in
the V5 process. It does not import Condor's `AgentStore`, `TickEngine`, generic
agent routes, MCP tools, Hummingbot client, or deployment controls.

## V5 dashboard environment

Machine-local Compose overlays supply deployment values and bind mounts. They
are private by design and are tracked in neither Condor nor rsibot. This table
describes the inputs, not the contents of those overlays.

| Setting | Where it comes from and what it does | When unset |
| --- | --- | --- |
| `V5_RUNTIME_ROOT` | Deployment's dedicated writable V5 state mount for the database and local notes. Must not overlap ordinary Condor state. | Startup fails. |
| `V5_DASHBOARD_TOKEN_FILE` | Deployment secret mount for the V5 login token and HttpOnly session cookie. | Startup fails. |
| `V5_DASHBOARD_ORIGIN` | Deployment's browser-facing origin, without a path; checked on writes. | Startup fails. |
| `V5_OBSERVATION_BASE_URL` | Deployment's fixed observation API base URL for evidence and task reads. | Startup fails. |
| `V5_OBSERVATION_TOKEN_FILE` | Secret mount provisioned for read access to the observation API. | Startup fails. |
| `V5_ADVISOR_CONTROL_BASE_URL` | Deployment's fixed advisor service URL for bounded assessments. | Startup fails. |
| `V5_ADVISORY_REQUEST_TOKEN_FILE` | Advisor request secret mount, distinct from the observation read token. | Startup fails. |
| `V5_STOCK_AGENTS_ROOT` | Optional deployment override for read-only stock agent definitions. | Uses the repository `agents_v5/`. |
| `V5_FRONTEND_DIST` | Deployment path to the separate V5 frontend build. | Uses `frontend/dist-v5/`. |
| `V5_COOKIE_SECURE` | Operator override; use `false` only for an isolated local development browser. | `true`; cookies require HTTPS. |
| `V5_PAPER_STATUS_FILE` | Absolute `<bot>_paper.status.json` path from the native paper runtime, mounted read-only. | Paper projections remain unbound. |
| `V5_CANDLE_STORE_SOCKET` | Absolute `.sock` path mounted from the candle-store owner. | Candle-store views are not configured and their API returns 404. |
| `V5_HOST_OPERATIONS_FILE` | Read-only bind of the host monitor's sanitized operations export. | Uses the observation API for a bound paper bot's operations read. |
| `V5_HELM_STATUS_FILE` | Absolute `<bot>_paper.status.json` path, a read-only bind of the Helm trial's `runtime_status` export. | The Helm endpoint reports `UNBOUND`. |
| `V5_MONEY_SAMPLER` | Deployment opt-in: `1` records money samples every five minutes in the V5 runtime root. | No new samples; retained rows remain readable. |
| `V5_TRADEPAD_URL` | Fixed HTTP(S) base URL from the read-only Tradepad owner. Not wired in the current deployment. | Tradepad reports not connected. |
| `V5_TRADEPAD_CAMPAIGN_ID` | Exact tested-window ID from the Tradepad owner publication, e.g. `w1772323200-1790812800`. Not wired in the current deployment. | No campaign is selected or admitted. |
| `V5_RESEARCH_URL` | Fixed HTTP(S) base URL from the Research OS owner, used only for the overview and network. Displayed generation time and age describe the projection, not its source tree. | Research reports not connected. |

All five Learning settings are intentionally **unset** until the pilot packet is
approved. D07 and D12 stay off. With all five unset, the Learning / Factory /
Lineage owner projection is disabled: `/api/v5/learning/{manifest,lessons,records,jobs}`
return `503 PUBLICATION_UNAVAILABLE`, never fixture data. Missing any setting
when another is supplied, or supplying an invalid value, fails startup.

| Setting | Where it comes from and what it does | When unset |
| --- | --- | --- |
| `V5_LEARNING_SOURCE` | The pilot packet selects exactly `research_os_v1`, the read-only projection protocol frozen in `schemas/learning_projection/`. | Disabled with the other four unset. |
| `V5_LEARNING_OWNER_URL` | The pilot packet's fixed HTTP(S) Research OS projection-proxy origin, with no path other than `/`, query, fragment or credentials. Reads use identity encoding and no credentials, with a 256,000-byte cap, four-second deadline and no retries. | No owner proxy bound. |
| `V5_LEARNING_SCOPE_ID` | Identifier from the approved scope artifact. Authenticated browsers get it from `/api/v5/auth` and send it on each projection request. Condor rejects a missing or mismatched scope with `400 INVALID_QUERY` and forwards valid query bytes unchanged. | No scope selected. |
| `V5_LEARNING_SCOPE_SHA256` | Canonical SHA-256 of the approved scope artifact pinned in `schemas/learning_scopes/PIN.md`; used to validate envelope and row membership. | No scope digest pinned. |
| `V5_LEARNING_PROJECTION_REVISION` | Frozen 64-character lowercase hexadecimal revision from the approved pilot contract; must match the stage of the scope pin. Other owner revisions are rejected. | No projection revision pinned. |

Tradepad's owner publishes numeric PnL as a float; numeric values are shown as published, not as exact accounting. Decimal strings, when supplied, retain their text. Browsers without lossless JSON primitive source access fail closed rather than display a rounded number. The campaign owner may publish no generation time or freshness deadline; neither a successful refresh nor the Research tree selection establishes freshness. Bridge limits in `config.py` reject oversized collections without truncating them: 10,000 strategies or sources, 20,000 network nodes, 100,000 network edges, and 10,000 statistics, facet or limitation rows. Per-endpoint byte limits are 4–64 MiB and the deadline is 20 seconds. Collection caps are checked after decode; the byte cap bounds the work. The pages label display subsets.

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
journal. Only one dashboard process may use that root. To stay within 200
sessions, admission prunes the oldest terminal sessions and their ticks in the
same transaction. Running sessions are never pruned, and only one report loop
can run at a time. Admission still refuses work if running sessions and the
new work cannot fit, or if the 20,000-tick or 32 MiB limit would be exceeded.
A report reserves outcome space before the API request starts. To make a
consistent SQLite backup, stop the V5 service and run:

```python
from pathlib import Path
from condor.v5.state import WorkspaceState

WorkspaceState.backup_database(
    Path("/var/lib/condor-v5/workspace.sqlite3"),
    Path("/var/backups/condor-v5-2026-10-28.sqlite3"),
)
```

The application serves the V5 frontend from `$V5_FRONTEND_DIST/v5.html` and its
`assets/` directory. Put the matching reviewed build manifest at
`$V5_FRONTEND_DIST/../v5-reviewed-build.json` (for example,
`frontend/dist-v5/` alongside `frontend/v5-reviewed-build.json`). New root-level
statics and the favicon alias require manifest membership and a matching SHA256;
an absent or invalid manifest withholds them with a warning. The legacy
`/condor_old.jpeg` GET route remains independent of the manifest and serves the
logo file as before. The ordinary Condor app, routes, auth, runtime root, and
ports are not changed by this package.
