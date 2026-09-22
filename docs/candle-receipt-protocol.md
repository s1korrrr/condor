# Candle receipt provenance

Condor WebSocket candle messages distinguish historical snapshots from current
source receipts without changing channel identity or the OHLCV row format.

| Producer path | type | kind | source |
|---|---|---|---|
| Buffered subscription/reconnect snapshot | candles | history | snapshot |
| Duration expansion/backfill | candles | history | backfill |
| Upstream stream batch | candles | live | stream |
| Upstream single candle | candle_update | live | stream |
| Successful REST fallback poll | candles | live | rest |
| Successful uncached Gecko poll | candles | live | gecko |

`live` means a current stream or poll receipt. It does **not** establish exchange
event freshness, candle finality, execution readiness, or trading authority.
The frontend ages these receipts in its own clock domain. An unchanged
successful poll is still a receipt; empty/invalid data and older-only batches
cannot refresh the latest series. Poll messages include `receipt_max_age_ms`
at twice their polling cadence, bounded by the frontend to 120 seconds. This
keeps a valid 60-second Gecko cadence from appearing stale every 30 seconds.
Normal interval freshness limits still apply when larger, and resumed streaming
removes the poll-specific deadline.

History cannot refresh current receipts or overwrite conflicting live values.
Unmarked `candles` messages from older servers remain historical; the old
single-candle message stays compatible. Backend and frontend should therefore
be shipped together to obtain corrected batch/poll freshness. No deployment or
restart is implied by merging this source change.

Socket detach, disconnect, reconnect, and source errors invalidate current
receipts while retaining historical rows by exact server/connector/pair/interval
identity. A reconnect snapshot cannot restore freshness without a new current
receipt.

Validation: `node --test test/candle-wire.test.mjs test/candle-evidence.test.mjs
test/candle-hook-identity.test.mjs` in frontend, and `pytest -q
tests/test_candle_wire.py tests/test_ws_authorization.py` at the repository root.
The local Vite fixture at `frontend/test/browser/native-timing/` exercises real
React/QueryClient receipt timing, stale expiry, acknowledgements, and candle-hook
identity/freshness with synthetic data. Its server serves only fixture status
and rejects command requests; it has no native-service or feed connection.
