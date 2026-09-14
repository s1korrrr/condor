# Windows for a Directional Controller

Companion to the `backtesting` playbook.

**Cost, resolution and the run mechanics are not here.** `trade_cost` (including the
per-exchange fee table), what `backtesting_resolution` actually controls, blocking
vs `run_async`/`get_instance`, and how runs are saved and retained all live in the
shared `backtest_flow` skill — one copy, read it there:

```
manage_skill(action="read", name="backtest_flow")
```

What follows is the part calibrated to directional trading.

## Window selection

**Illustrative windows by controller interval** (verify independent sample support):

| Controller interval | Minimum window | Preferred      |
|---------------------|----------------|----------------|
| 15m                 | 7 days         | 30–60 days     |
| 1h                  | 30 days        | 90–180 days    |
| 1d                  | 90 days        | 180–365 days   |

These are starting windows for directional exploration; duration alone cannot
establish enough independent entry/exit observations or regime coverage. A strategy
that earns continuously rather than per-signal sizes its window differently.

**Rules:**
- Prefer 3–6 months covering at least one full regime cycle (trend *and* range).
- Avoid a window that is entirely one regime — a pure bull run just fits the trend.
- Include recent data (end within the last 7 days) so the result is relevant.
- Hold out the most recent ~30 days from the sweep; `go_no_go.md` needs it clean.

```python
import time
end_time = int(time.time())
start_time = end_time - (90 * 86400)   # 90 days
```

## Resolution, applied to a sweep

The general rule is in `backtest_flow`. Its directional application:

- Baseline and final validation at `1m`.
- Match the controller interval (`15m`, `1h`) while sweeping wide, then re-run the
  winner at `1m` before it goes anywhere near `go_no_go.md`.

## Comparability

Each `backtest_chart` row carries window, resolution and cost columns; verify
them before ranking. Also bind controller/config/data/adapter identities,
decision-time semantics, continuous-account convention and comparable owner
baseline. Keep spot and futures accounting separate. Metadata makes a comparison
auditable; it does not itself establish comparability or prevent invalid ranking.
