# Candle store Market view

Opt in with `V5_CANDLE_STORE_SOCKET=/run/candle-store/api.sock`. With no setting,
the existing profile JSON is unchanged, the Recorded candles tab is absent, and candle
reads return 404 after authentication. Existing pages retain their bindings.

The separate Market → Stocks page stays visible with an explicit unconfigured
state. Its additional public-data views use the same authenticated transport
and a separate strict contract documented in [STOCKS.md](STOCKS.md).

The owner is hummingbot `services/candle-store/candle_store_dashboard`, served
with `--v5-api-only` over a private Unix socket. The dashboard mounts only its
socket directory read-only and joins the socket group. It never mounts or
opens the live SQLite/WAL, reaches host loopback through a Docker bridge,
accepts a user URL, forwards credentials, follows redirects, or sends writes.
The owner reads file bytes into private in-memory SQLite snapshots. A damaged
partition can retain older observations; partition errors are shown explicitly.

The crypto consumer allowlists overview, symbols and candles, validates identities,
limits responses to 2 MB, overview to 128 lanes, symbols to 1024 rows and
charts to 10080 one-minute buckets. It accepts 1h, 6h, 24h and 7d, always 1m.
Two in-flight consumer reads and a twelve-second total deadline bound reads;
the owner permits at most two computations and rejects excess work instead of building an unbounded
queue. The owner has no collector or download controls. Socket filesystem
permissions are the host capability; browser reads require normal V5 sign-in.

Tiles show lane health, held/listed instruments and separately labelled minute
states. The shared DataTable supports search, column filters, sorting, keyboard
and pointer resizing. The shared chart uses the app's lightweight-charts and
theme tokens, supports hover, pan and zoom, and inserts whitespace for unknown
price minutes. Unknown volume stays null, never zero. Price is in the pair's
quote asset; owner volume units, venue, spot/perpetual and UTC are explicit.

Collector heartbeat age describes liveness only. Owner health and settle grace
are not exchange-source correctness or finality guarantees. Coverage denominators
exclude pending minutes. Tiles/tables label 7d states; chart totals refer only
to the selected range. Independent reads show their evaluation times and can
cross a minute boundary. HTTP, schema, timeout and missing owner failures remove
old data rather than silently showing a cached success. No promotion or trading
authority follows from this view.

Tests: `PYTHONPATH=tests python -m pytest tests/test_v5_*.py -q` and the owning
workspace's `dashboard/v5-workspace/build.mjs` plus frontend policy tests.

## Consumer contract (including Bots pair charts)

All routes require the existing V5 authenticated session cookie; no extra
browser secret, observation token, CORS origin or service URL is needed.

`GET /api/v5/candle-store/overview` (no parameters) returns:
`{state: "AVAILABLE", reason: null, data: {now, status_age_s, status_error, tiles}}`.
`now` is owner evaluation time in epoch seconds. `status_age_s` is null when
unknown; never equate a current heartbeat with final candle coverage. Each
tile identifies `lane`, `venue`, `segment` (spot or perpetual), `health`,
`health_rules: [{level, rule, detail}]`, `pairs_listed`, `pairs_held`, `available`,
`unavailable_reason`, `partition_errors: [{day, error}]`, coverage fractions,
and separately labelled `gaps_7d`, `pending`, `unrecoverable_7d`, `no_trade_7d`.

`GET /api/v5/candle-store/symbols` (no parameters) returns the same envelope
with `data: {now, rows}`. Each row has `lane`, `venue`, `segment`, `pair`,
`health`, `health_rules`, `volume_unit`, `last_minute` (epoch-seconds minute
open, nullable), `last_minute_age_s` (since that minute's close), `grace_s`,
`coverage_1h`, `coverage_24h`, `coverage_7d` (0..1 or null), `gaps_7d`,
`pending`, `unrecoverable_7d`, `no_trade_7d`, `ws_state`,
`ws_last_message_age_s`. Null means unavailable, not zero. There are no
cross-market aggregates. A listed instrument without held candles remains a
row with unavailable price/freshness, not an invented series.

`GET /api/v5/candle-store/candles?lane=binance__spot&pair=BTC-USDT&range=1h`
returns the same envelope with data keys `now`, `lane`, `venue`, `segment`,
`pair`, `range`, `res_s` (always 60), `start`, `end` (inclusive minute-open
epoch seconds), `volume_unit`, `buckets`, `totals`. Required parameters:
`lane` matches `[a-z0-9_]{1,48}__(spot|perpetual)`; `pair` is the exact owner
instrument, two 1..24-character alphanumeric identifiers separated by `-`.
Optional `range`: 1h, 6h, 24h (default), 7d. `res`, arbitrary URLs/paths,
duplicate and unknown parameters are rejected. Do not derive venue-specific
symbols from another venue: select from the symbols endpoint. In particular
Hyperliquid spot uses native `UBTC-USDC` etc., not `BTC-USDT`.

Each bucket is exactly:

```text
[t, open, high, low, close, volume,
 final, no_trade, unrecoverable, missing, pending, corrections]
```

`t` is the UTC epoch-seconds open of a closed 1m interval (not milliseconds).
The five minute-state counters sum to 1; corrections is separate revision
metadata. Draw prices only when `final == 1` and all OHLC are finite.
No-trade/missing/pending/unrecoverable buckets have null OHLCV: draw whitespace,
not previous-close values or zero. A final candle can have null volume: never
substitute zero. Prices use the pair's quote asset; volume uses `volume_unit`
(base or the venue's derivative contract unit). The chart is **recorded closed
minutes**, not proof of immutable exchange finality. The owner can revise bars;
pending only means inside settle grace. `totals` sums the six counter columns
over the selected range and is checked against the buckets before delivery.

Limits: 2 MB encoded response, 128 tiles, 1024 symbol rows, 10080 buckets;
two concurrent reads, ten-second upstream timeout, twelve-second total deadline.
No redirects, proxy environment, network URL input, resampling or pagination.
HTTP 401: sign-in required. HTTP 404: unconfigured/unknown view. HTTP 422:
invalid query. HTTP 503: `{state: "UNAVAILABLE", reason: <bounded stable code>,
data: null}` (missing socket, timeout, owner HTTP failure or rejected schema).
Responses are `Cache-Control: no-store`. Consumers must clear earlier success
on a failed refresh. Hide the Recorded candles tab unless the profile has
`candle_store: {configured: true}`; this property is absent when disabled.

Shared-file reconciliation: app.py adds the candle import, owner construction,
conditional profile field, one authenticated GET route and one SPA route.
V5App.tsx adds one `/market/candles` route. V5AppShell.tsx changes only its
notice on that route. V5MarketHome.tsx adds the opt-in tab/branch; api.ts adds
one optional profile property. No paper/dashboard/upstream semantics change.

## Review polish (2026-10-29)

The chart defaults to held OKX spot BTC-USDC when present, otherwise held
OKX spot BTC-USDT. The qualified store currently holds OKX spot BTC-USDT,
ETH-USDT, BNB-USDT, XRP-USDT and SOL-USDT, not any of V5's BNB-USDC,
BTC-USDC, ETH-USDC, SOL-USDC or XRP-USDC pairs. The view discloses the held
and missing pairs from each instrument response; it does not substitute or
convert USDT candles into USDC candles. A listed pair with no held minute
does not establish held coverage.

Failed reads use one consolidated alert with the dashboard's UTC check time,
explicitly not an invented owner evaluation time. An unavailable/empty
instrument list hides chart selectors and gives a reason. Candle-only failure
keeps the valid instrument/range choices so the operator can retry/change them.
Table headers wrap within a candle-view-only CSS scope; default column widths
fit the desktop content area and shared resize controls remain active.
The shared V5AppShell mobile header/nav is deliberately unchanged for its owner.

## Independent-review schema/deadline repairs

The consumer rejects duplicate JSON keys, lone Unicode surrogates, non-finite
numbers, integers longer than 19 digits, numeric magnitudes beyond JS's safe
integer ceiling (2^53-1), and nesting deeper than 32. This applies to the whole
owner tree, including fields not projected to the browser. Projected fields
also have domain checks: integer minute counters; bounded counts, timestamps,
ages and coverage; explicit boolean/text/map types; unique lane/instrument
identities. Minute-open timestamps are integers on the 60-second grid within
epoch [0, 2100-01-01]. Owner evaluation time can have fractional seconds.
The candle start/end must exactly span the requested range, end at the last
closed minute, and match every contiguous minute bucket; start must precede
end. Matched but oversized corrections/totals cannot pass validation.
Rejection returns typed UNAVAILABLE, never AVAILABLE with Infinity or an
unencodable string. The owner uses two disposable Linux worker processes
with an eight-second deadline and bounded kill/reap before slot release; a
consumer timeout cannot leave indefinitely running owner threads.
The browser aborts after fourteen seconds. These nested budgets include cold
parallel private snapshots: a measured single cold overview took 3.37 seconds,
and a four-second owner deadline rejected legitimate parallel reads. The
process deadline is still hard; no retries or abandoned work extend it.

## Cross-venue, coverage heatmap and store facts (2026-11-03)

The Candle store page has four tabs built from the shared kit (`TileGrid`,
`DataTable`, `TimeSeriesChart`, `HeatStrip`, `TooltipCard`) with V5 theme
tokens: **Lanes & chart** (the views above), **Cross-venue**, **Coverage
heatmap** and **Store facts**. They replace the standalone owner page on
`127.0.0.1:8095` for V5 users. Only the open tab reads: overview, symbols and
candles run on Lanes & chart only, so other tabs do not compete for the two
owner slots. Strict validators live in `condor/v5/candle_views.py`.

| Route | Query | Owner loads |
|---|---|---|
| `GET /api/v5/candle-store/cross` | `asset` (`[A-Za-z0-9]{1,24}`), `segment` (`spot`/`perpetual`), optional `range` (default 24h); always `res=auto` | that segment's lanes, `range` + 1 day |
| `GET /api/v5/candle-store/heatmap` | `segment` | that segment's lanes, last 8 days |
| `GET /api/v5/candle-store/store` | none | file listings and `status.json` only |

`cross` returns per venue the bucketed final close and the mean deviation (bps)
from the median of venues with a final close in that minute (at least two),
plus statistics. The consumer re-derives `res`/`res_s` from the range (1m, 1m,
5m, 15m), the window from owner `now`, and requires identical lane/pair
identities and order in `series` and `table`, `n <= minutes_with_close`, the
quote equal to the pair suffix, and ordered on-grid points. Quote currencies
differ (USDT, USDC, USD); the page discloses this and converts nothing.
Hyperliquid spot is the wrapped `UBTC-USDC`, so its deviation includes quote
and wrapping basis.

`heatmap` returns 168 consecutive UTC hours ending at the hour of the last
closed minute, and per instrument five minute counts (final, no-trade,
unrecoverable, missing, pending), or null outside the store window. Each cell
sums to at most 60. Strips show the newest hour on the left (kit convention);
colour is never the only signal (legend, per-row settled coverage, tooltip
text, keyboard focus). Pending uses the neutral token so the colour-blind
theme still separates it from complete hours.

`store` publishes no path, pid, host or file-name list: owner messages are
redacted to `<path>`, and the consumer rejects any message that still holds an
absolute path segment (`owner_path_disclosure`). Process facts are an
allowlist of finite numbers; lanes carry byte counts per kind, WAL bytes and
journal/sealed day lists. Journal read errors stay on the overview tiles.

Owner timing measured on razer (14 lanes, 9 journal days, load 9-14,
2026-11-03): cross 1.1-3.7 s, heatmap 3.0-4.1 s, store 0.01-0.08 s. **Known
limit, not changed here:** overview and symbols still load the whole store
cold in each disposable worker. A single cold read now takes 6-7.5 s (it was
3.37 s when the eight-second budget was set), and the two parallel reads of
the Lanes & chart tab both reached the deadline (`owner_compute_timeout`)
under load 10-14. The page then shows one timestamped alert and no stale
values. A warm owner reader is the structural fix and needs a design decision
on the "no retained worker cache" rule.

## Combined summary read and owner states (2026-11-03)

`GET /api/v5/candle-store/summary` (no parameters) returns the overview object and the instrument rows from one owner
pass: `{now, status_age_s, status_error, tiles, rows}`. Each part is validated exactly as `overview` and `symbols` are.
The Lanes & chart tab makes this one read instead of two parallel whole-store reads. The owner serves it from one warm
summary process (hummingbot `candle_store_dashboard`, design `docs/plans/active/2026-11-03-candle-store-warm-reader.md`
in rsibot), so a refresh costs well under a second instead of a 6-7.5 s cold load.

Non-200 owner replies are classified from a bounded body (`{"error": "<code>"}`, first 4 KiB) against an allowlist:
`owner_warming`, `owner_warm_unavailable`, `owner_busy`, `owner_compute_timeout`, `owner_supervisor_unavailable`,
`owner_read_unavailable`, `owner_response_limit`, `owner_invalid_request_or_data`. Anything else is
`owner_http_error`; a 404 is `owner_view_unavailable`. The page names the state in its one timestamped alert, clears
earlier tiles and rows, and retries every 5 s while the owner is warming (30 s otherwise).

Deploy order: owner first. Against an owner that does not serve `summary` (404), the consumer reads `overview` and
`symbols` concurrently (each under its own deadline, as the page did before) and combines them, so a Condor deployed
first still works within the browser's 14 s limit when each legacy read finishes.
