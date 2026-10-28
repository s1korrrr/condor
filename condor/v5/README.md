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

The stock agent definitions live in the repository-level `agents_v5/`. Runtime notes and optional
local agent overlays live under `$V5_RUNTIME_ROOT/agents/`; local files override
stock files on read. Agent names, tasks, tools, loop timing, and maximum loop
length are fixed in Python. Markdown cannot grant tools, change task IDs, select
a model, or enable execution. The decision reviewer stays blocked until the
native baseline and trace exist.

Only `market_context` and `source_quality` reports can be requested. Calls use
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
