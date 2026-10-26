# Current inventory projection contract

Condor projects execution-owner observations. It does not own exchange inventory, recovery or capital. Stopping a runtime does not establish that its inventory disappeared.

## Sources and scopes

`GET /api/v1/servers/{server_name}/positions` reads active orchestration membership directly. Historical controller performance is not a runtime registry. Current bot positions come from the active response's own controller observations; cached performance joined by a reused bot/controller name cannot establish current inventory. Native MQTT observations also require verified identity, current performance, running status and unexpired source observation time.

Executor positions and bot positions carry separate availability. `available` with a valid empty list establishes an empty **source scope**; `partial` or `unavailable` does not establish zero account exposure. Per-row source instance, reporting scope, timestamps and reconciliation status travel with the response. Historical/non-current observations stay separate from current bot positions. They do not prove that residual inventory exists or that the account is flat. Account holdings and recovery must be reconciled through their existing native owners.

Duplicate identities, missing instruments, malformed amounts, nonfinite/overflow values and unavailable valuation inputs cannot establish complete current metrics. Invalid marks remain unknown. Legitimate zero quantities and empty successful reads remain distinct from absent or failed data.

## Agent consumers

Current unrealized PnL, current positions and open counts use the active runtime projection. Realized PnL, fees and volume retain their session/lifetime accounting scope. They must not be silently relabeled as current-session returns. Nullable current metrics and `current_book_status` propagate through REST models, dashboard cards, session reports, journals and provider summaries.

Bot adoption uses active runtime membership, not performance-history membership. A newly running instance can be discovered before it has performance history. An unavailable or ambiguous owned runtime keeps discovery pending. While discovery or current inventory is incomplete, new executor creation and bot deploy/config changes are blocked at the permission boundary. Existing stop/cancel actions and independent drawdown/kill rails remain available.

Emergency shutdown keeps two separate facts: confirmed stop targets and inventory completeness. It attempts stops for known targets even if another owned runtime is unknown. Failed enumeration, missing availability, failed position verification or failed stops produces an unverified alert and journal entry. It cannot produce a flat/complete result. No historical snapshot is treated as proof of completeness.

## Verification

Deterministic regression fixtures cover restart generations, stopped controllers, direct executor failures, partial/malformed data, duplicate identities, missing instruments and nonfinite economics. `tests/test_unknown_inventory_risk.py`, `tests/test_bot_ownership.py` and `tests/test_shutdown.py` cover unknown-book permission handling, adoption and emergency winddown. `frontend/test/inventory-availability.test.mjs` renders actual session components and distinguishes pending/unknown data from genuine zero.

These checks do not establish deployed image identity, exchange account reconciliation, residual exit management or trading authority. Rollback is a revert of the software change; no persistent inventory migration is introduced.

## Second-pass hardening (2026-10-26)

A registry map key must agree with an embedded bot identity; a conflict cannot rename observations into another runtime. A running runtime with absent/empty performance remains unknown. Starting/stopping runtime and controller rows remain non-current observations. Current inventory and price reads share a five-second route deadline; a failed source cannot erase a successfully read independent source. Agent runtime discovery reads use the same bounded unknown outcome.

`notional_value` is quantity times a valid current mark. `cost_basis_value` is quantity times entry basis. An absent/invalid mark leaves current notional unknown and source availability partial while retaining known inventory quantities. The position panel labels any displayed incomplete subset explicitly.
