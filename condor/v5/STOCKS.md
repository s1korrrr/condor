# Stocks public market observations

`/market/stocks` adds an always-visible Stocks tab under Market. It defaults
to EEA and provides an explicit Global selector. The product filter keeps
`SPOT`, `SWAP` and `FUTURES` separate. A `FUTURES` instrument with
`ruleType: "xperp"` is labelled X-Perps; ordinary futures do not show funding
as an applicable metric. The page selects only exact catalog identities,
without inferring stock classification or trading eligibility from a symbol.

Condor is a read-only projection of the Hummingbot candle-store owner. It
does not collect exchange data, open the owner's database, start feeds,
alter retention, or submit orders. No observation grants trading authority.
The existing crypto candle query and payload schemas are unchanged.

## Transport and queries

The existing V5 authenticated session and `V5_CANDLE_STORE_SOCKET` transport
serve these additional GET views:

| Browser route | Required query | Optional query |
| --- | --- | --- |
| `/api/v5/candle-store/stocks` | `region` | None |
| `/api/v5/candle-store/stock-market` | `region`, `instId`, `instType` | None |
| `/api/v5/candle-store/stock-candles` | `region`, `instId`, `instType` | `range`, default `24h` |

`region` is exactly `eea` or `global`; `instType` is exactly `SPOT`, `SWAP`,
or `FUTURES`. `instId` is the unmodified wire identifier, 2–80 characters
matching `[A-Z0-9][A-Z0-9._-]{1,79}`, containing at least one hyphen and no
`..`. Extra hyphens, a dot or an underscore are allowed; slashes, URL input,
path input, duplicate parameters and unknown parameters are rejected.
Allowed candle ranges are `1h`, `6h`, `24h`, `7d`; there is no `res` parameter.

The fixed private-socket routes are `/api/stocks`, `/api/stock-market`, and
`/api/stock-candles`. The consumer forwards only the validated query, never
cookies, authorization headers or browser-controlled host information.
Existing bounds still apply: 2 MB response, two concurrent reads,
ten-second upstream timeout and twelve-second total deadline. The browser
has a fourteen-second deadline. Responses use `Cache-Control: no-store`.

The browser receives the existing transport envelope:
`{state: "AVAILABLE", reason: null, data: <validated payload>}`. A failed
read returns HTTP 503 with `{state: "UNAVAILABLE", reason, data: null}`.
HTTP 401 requires sign-in, 404 means the owner is unconfigured or the view
is unknown, and 422 rejects an invalid query before any socket request.
There are no mutation endpoints.

With no configured socket, the tab explains that the data source is not
configured and enables no owner queries. When the socket exists but stock
collection is disabled, the owner's `disabled` state is shown separately.

## Strict public-data schemas

`condor/v5/stocks.py` validates stocks independently of the crypto schema.
All payload trees reject non-finite or unsafe numbers, oversized strings,
excessive nesting or node counts. The shared decoder also rejects duplicate
JSON keys. Optional raw metadata is preserved as bounded JSON, including
numeric `instIdCode`, string arrays and nested `upcChg` records. Every
instrument requires an exact identity and `instCategory: "3"`.

Catalog format is `okx-stocks-v1`, with `now`, `region`, `state`,
`catalog_at`, `updated_at`, `reason`, `rows`, and `capture`. Allowed collection states
are `disabled`, `starting`, `empty`, `live`, `stale`, and `error`. Each row
has raw `instrument` metadata, a `latest` object, `channels`, `coverage`,
and a boolean `captured`.
`latest` always includes nullable `ticker`, `mark_price`, `index_price`,
`funding`, and `open_interest` events. Catalog identities must be unique;
the catalog is bounded to 1024 rows, the owner's per-region discovery limit.

## Capture allowlist

The owner discovers the whole regional stock catalog but captures public
data only for the operator allowlist given by the owner option
`--stocks-instruments`. Each entry is `region:instType:instId`, for example
`eea:SWAP:AAPL-USDT-SWAP`, with at most 64 entries per region.

`capture` lists this region's allowlist: at most 64 objects with exactly
`instType`, `instId` (the same identity validation as queries), and boolean
`listed`. Entries are strictly sorted by `(instType, instId)`, so duplicates
are rejected. An empty list means discovery only. A disabled or unconfigured
owner emits `capture: []`.

Condor checks the cross-references and rejects the whole payload when they
disagree: `listed` is true exactly when the entry's identity is a catalog row,
and a row's `captured` is true exactly when its identity is on the
allowlist. A row with `captured: false` has every `latest` value null and
`channels: {}`; its `coverage` keeps the same shape. The selected
`okx-stock-market-v1` and `okx-stock-candles-v1` envelopes carry a top-level
boolean `captured`.

The page adds a Capture column. A selected instrument that is listed but
not captured shows a notice with the exact allowlist entry to add, and
Condor issues no market or candle reads for it; it never renders empty
charts as missing-data gaps. A region notice lists allowlist entries with
`listed: false`, which are not in the current catalog.

Optional `discovery` diagnostics identify complete or partial classification.
A complete discovery must account for all three product families. Each
family reports bounded `total`, `classified`, `unclassified`, and `stocks`
counts. Unclassified instruments cannot be treated as successful empty
coverage. Partial diagnostics are displayed as a warning.

The selected market format is `okx-stock-market-v1`. It repeats the region,
instrument identity and collection envelope, adds nullable `latest.books`,
up to 50 `recent_trades`, and nullable `book_depth`. Each public event has
matching `region`, `instId`, `instType`, `dataset`, nullable source
`event_time_ms`, required `received_at_ms`, `source: "rest" | "ws"`, and
the raw `data` object. Decimal strings remain strings. Funding settlement
times are not receipt or source-event freshness timestamps.

The book is a bounded projection of the reconstructed standard book, up to
50 levels per side, marked `action: "snapshot"` and
`projection: "top50_from_standard_books"`. A continuity gap removes its
current display until a new snapshot arrives. It is not the complete
immutable book journal. Recent trades are captured observations, not a
complete historical trade series.

Channels report `waiting`, `live`, `stale`, `gap`, `error`, or `unavailable`,
with event time, receipt time, receipt age at evaluation, and reason. The
coverage object reports capture start and candle bounds, while
`historical_trades` and `historical_books` remain `false`.

## Candles and display semantics

`okx-stock-candles-v1` carries exact identity, collection state, selected
range, `res_s: 60`, start/end, `price_basis: "trade"`, `adjustment: "raw"`,
buckets and totals. Optional catalog timestamps and discovery diagnostics
use the same validation as the other views. Volume is `base` for spot and
`contracts` for derivatives; Condor does not guess a contract conversion.

The existing `RecordedCandleChart` consumes the unchanged twelve-cell form:

```text
[t, open, high, low, close, volume,
 final, no_trade, unrecoverable, missing, pending, corrections]
```

`t`, start and end are epoch-second minute opens. Every closed minute of
the selected window is represented. Only a final candle may contain OHLC;
other states have null prices and volume and render as gaps. Unknown
volume remains null. Exactly one minute-state counter is set, and totals
must match the buckets. The endpoint never supplies mark or index candles
under a trade-price label.

The metadata table and selected detail use the shared DataTable and theme.
Last trade, bid, ask, mark and index remain separate labelled observations.
Additional fields expose venue 24h volume, funding settlement times, and
open interest in contracts, venue currency and venue-reported USD. An
expandable full record retains all public source fields and exact decimal
strings. It performs no annualization, currency conversion or corporate
action adjustment.

HTTP, timeout, schema and refresh failures clear the affected prior prices
and charts. Catalog failure also clears previous instrument choices.
Explicit owner `error` permits retained metadata but no current price
observations. A market or candle read whose `captured` is false is shown as
the not-captured notice, not as data. Stale data is labelled with its evaluation/source/receipt
times. A browser clock check also marks a successful snapshot stale after
90 seconds without a fresh evaluation; a future evaluation beyond five
seconds is treated as stale. Channel age is the age computed at owner
evaluation, not a continuously updated exchange timestamp.

## Focused verification

```sh
PYTHONPATH=.:tests python -m unittest test_v5_stocks_contract test_v5_stocks_transport -v
PYTHONPATH=.:tests python -m pytest -q tests/test_v5_candle_store.py tests/test_v5_stocks_contract.py tests/test_v5_stocks_transport.py tests/test_v5_stocks_routes.py
cd frontend
node --test test/v5-stocks-model.test.mjs test/v5-stocks-api.test.mjs test/v5-stocks-presentation.test.mjs test/v5-candle-presentation.test.mjs
```

The owning rsibot workspace's unchanged
`dashboard/v5-workspace/build.mjs <absolute-condor-frontend-path>` runs the
full V5 TypeScript check and production Vite build. Fixtures exercise
disabled, empty, live, stale and failed reads, exact identity and decimal
preservation, metadata extensions, candle gaps, transport authentication,
and removal of earlier successful prices after failure. Local fixture
verification does not establish live exchange availability or a deployed
collector's historical coverage.
