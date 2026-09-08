# Research OS workspace

Condor's `/research` page reads an existing Research OS knowledge catalog. It shows
ideas, papers, experiments, attempts, directed evidence connections, source results,
and admissible baseline comparisons. Research OS remains the owner of records and
workflow state; this integration has no execution, synchronization, or trading API.

## Configuration and startup

Run the updated Research OS reader on the same host as Condor, bound to loopback
port 8873. It must support `projection=summary` on its knowledge `nodes`, `node`,
and `graph` endpoints. Start it from an existing rsibot checkout with an already
built catalog and its owner Python environment:

```sh
PYTHONPATH=research_os/src research_os/.venv/bin/python -m research_os.research_knowledge.cli serve \
  --source-root "$PWD" --output "$PWD/research_os/output/research_knowledge" --port 8873
```

Set `CONDOR_RESEARCH_SERVER` on the Condor web process to the name of exactly one
existing configured server. The authenticated user must have access to that server.
Select that server in the dashboard and open Research. Restart the reader first,
then the Condor web process after upgrading. Build the frontend using `npm ci` and
`npm run build` in `frontend/`. No exchange credentials are needed to browse the
research catalog; its route is exempt from the connect-keys overlay and trading
prefetch, including `/research/`.

The upstream origin is fixed at `http://127.0.0.1:8873/api/knowledge`; browser input
cannot select a URL or local file. `CONDOR_RESEARCH_SERVER` binds access to this one
local source, not to arbitrary remote Research OS servers. Multi-host research
routing is outside this contract. An unset binding returns 503; a wrong or denied
server returns 404. Missing or invalid authentication is rejected by Condor's
existing authentication dependency.

## Read contract and interpretation

- Only overview, nodes, node, graph, comparisons, and clusters are exposed.
  Unknown/repeated parameters, invalid pagination, unlisted endpoints and mutations
  are rejected. Nodes/graph queries are limited to 50 records; catalog offset is limited to 10000.
- List and graph responses request owner summary projection, keeping metadata,
  identity and edges while omitting full evidence data. Detail retains the selected
  record's evidence; related records use summaries.
- Response bodies are capped at 1 MiB, or 4 MiB for node/graph, with a 15-second
  total upstream deadline. Oversized, malformed, mismatched, or unavailable source
  observations return a sanitized 502. Projection does not bypass the transport bounds.
- Credentials and executable/file-locator fields are omitted. Recognizable local
  path tokens in prose are withheld. Path-keyed maps retain values under stable
  SHA-256 locator labels; projected-key collisions are rejected instead of losing
  source hashes. This is a structured projection, not a general-purpose secret
  detector for arbitrary free text. Do not put secrets in research records.
- Fetch timestamps describe transport observation, separately from owner index
  freshness. Each panel expires independently 60 seconds after its client-side query receipt
  (`dataUpdatedAt`), so a fixed browser/host clock offset does not hide valid reads. It shows failed or
  stale reads without retaining old results as current. Polling is every 30 seconds;
  Refresh and panel retries include baseline comparisons.
- A completed process and a held research outcome are different recorded states.
  Source PnL is not live account PnL. Comparison groups retain capital model,
  contract, conditions, assessment identities and evidence; different groups are
  never pooled. Missing values remain unavailable.

The owner reader checks one admitted graph snapshot for the entire request before
sending a successful response. A concurrent commit can therefore cause an explicit
503 upstream, followed by recovery on a stable retry. The reader never advances a
research workflow. Search still scans the existing catalog payloads; compact
transport does not replace its indexing architecture.

## Validation and troubleshooting

```sh
python -m pytest tests/test_research_read.py tests/test_web_auth.py tests/test_web_spa_fallback.py tests/test_web_report_serving.py -q
cd frontend
node --test test/research*.test.mjs
npm run build
npx eslint src/pages/Research.tsx src/features/research src/App.tsx src/components/layout/AppShell.tsx src/hooks/usePrefetchData.ts
```

If the page reports unavailable research, first verify the reader's loopback
`/api/knowledge/overview`, then its `nodes?projection=summary&limit=1` contract,
then the server binding and user access. Inspect service startup logs. Do not solve
this by widening file access, disabling authentication, or silently treating failed
reads as empty results. Clearing `CONDOR_RESEARCH_SERVER` disables read access; a
rollback reverts only this integration and restores the previous web build.

## Primary references used in the audit

- [React effect lifecycle](https://react.dev/reference/react/useEffect): timer cleanup and dependencies.
- [TanStack Query cancellation](https://tanstack.com/query/latest/docs/framework/react/guides/query-cancellation): the query signal reaches fetch.
- [HTTPX streaming](https://www.python-httpx.org/async/) and [timeouts](https://www.python-httpx.org/advanced/timeouts/): response lifetime and inactivity versus whole-request limits.
- [FastAPI security](https://fastapi.tiangolo.com/reference/security/): authenticated route dependencies.
- [SQLite JSON projection](https://sqlite.org/json1.html#the_json_remove_function) and [URI semantics](https://sqlite.org/uri.html): compact reads and immutable-reader assumptions.

The client receipt clock follows [TanStack Query result state](https://tanstack.com/query/latest/docs/framework/react/reference/interfaces/QueryObserverBaseResult). Server `fetched_at` remains source metadata and does not set client expiry.
