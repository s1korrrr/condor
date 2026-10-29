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
