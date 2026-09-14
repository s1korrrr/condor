---
name: slot_exit
description: Decide hold vs exit for an open LP slot (TP/SL/range-abandoned), close
  it swapping back to quote, and rotate the freed capital.
when_to_use: When deciding whether an open LP slot should be held or exited, and how
  to close it and rotate the freed capital.
created: '2026-07-20T23:27:07Z'
source: agent:solana_dex_lp_expert
---

# Slot Exit — TP/SL + rotation

Use the already-authorized strategy thresholds and emergency policy. An exit
request does not itself authorize rotating capital into a new position.

## Exit triggers (evaluate every authorized tick, per open slot)
Exit when ANY is true:
- **Take profit:** slot `net_pnl_pct ≥ take_profit_pct` (use the approved configured value).
- **Stop loss:** slot `net_pnl_pct ≤ −stop_loss_pct` (use the approved configured value).
- **Range abandoned:** OUT_OF_RANGE for a sustained period AND OHLCV trend continues away from the range (continued adverse movement is observed; recovery remains uncertain).

Measure PnL in `quote_asset` terms (net of fees earned, IL, rent, tx). Use executor `net_pnl_pct` / `custom_info` when available; otherwise compute from current vs initial value.

## How to exit within the approved action scope
`manage_executors(action="stop", executor_id=<id>, keep_position=false)`
- `keep_position=false` removes on-chain liquidity, runs the close-out swap back to `quote_asset`, and refunds position rent.
- Confirm the executor reaches COMPLETE and rent is refunded (`position_rent_refunded > 0`).

## Rotate
- Refill a freed slot only when rotation/new entries are authorized, the prior
  close and available balances are verified, and a fresh `pool_ranking` passes.
- Do NOT immediately re-enter the pool you just exited (esp. a stop-loss) unless it clearly re-ranks on top — avoid churn/fee bleed.
- Journal each exit: pool, reason (TP/SL/abandoned), realized PnL, fees earned, duration.
