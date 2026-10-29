# Candle store Market view

Opt in with `V5_CANDLE_STORE_SOCKET=/run/candle-store/api.sock`. With no setting,
the existing profile JSON is unchanged, the Market tab is absent, and candle
reads return 404 after authentication. Existing pages retain their bindings.

The owner is hummingbot `services/candle-store/candle_store_dashboard`, served
with `--v5-api-only` over a private Unix socket. The dashboard mounts only its
socket directory read-only and joins the socket group. It never mounts or
opens the live SQLite/WAL, reaches host loopback through a Docker bridge,
accepts a user URL, forwards credentials, follows redirects, or sends writes.
The owner reads file bytes into private in-memory SQLite snapshots. A damaged
partition can retain older observations; partition errors are shown explicitly.

The consumer allowlists overview, symbols and candles, validates identities,
limits responses to 2 MB, overview to 128 lanes, symbols to 1024 rows and
charts to 10080 one-minute buckets. It accepts 1h, 6h, 24h and 7d, always 1m.
Two in-flight consumer reads and an eight-second total deadline bound reads;
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
two concurrent reads, six-second upstream timeout, eight-second total deadline.
No redirects, proxy environment, network URL input, resampling or pagination.
HTTP 401: sign-in required. HTTP 404: unconfigured/unknown view. HTTP 422:
invalid query. HTTP 503: `{state: "UNAVAILABLE", reason: <bounded stable code>,
data: null}` (missing socket, timeout, owner HTTP failure or rejected schema).
Responses are `Cache-Control: no-store`. Consumers must clear earlier success
on a failed refresh. Hide the tab unless the profile has
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
