---
name: backtest_flow
description: The shared backtesting contract — intake, how to run the routines, and the
  rules that hold for every strategy family. Family-specific thresholds live with the
  agent that owns them.
when_to_use: User asks to run a backtest, test a strategy, or compare configs — any
  backtest-related request. Also the reference any agent reads before running the
  backtest routines itself.
created: '2026-08-05T05:55:31Z'
source: chat
---

## Backtest Flow

### Seat check — read this first
The routines below are **shared**: run them from any seat. What differs is not
the tooling but the judgement:

- **You are the chat (Condor)** → follow the whole flow below. It is **intake
  only**: the depth — window choice, metric thresholds, parameter sweeps,
  overfitting checks, go/no-go — belongs to the `directional_trader` agent,
  whose `backtesting` playbook covers it. Use that playbook for the judgement.
  Delegate a bounded task only when routing policy and available tools permit it
  and the hand-off improves the work; delegation adds no authority.
- **You are `directional_trader`** → backtesting is YOUR domain. Use your own
  `backtesting` playbook; do not hand the judgement to another agent. Steps 1–2
  below are still a good intake checklist for what to pin down before running
  anything. For a long grid, use the asynchronous routine handles below and
  collect completion or failure evidence. Do not recursively delegate yourself.
- **You are any other agent** → you can run these, and for a single backtest
  that is the right move. For a sweep, an overfitting check or a deploy
  decision, use the specialist playbook and, when useful and permitted,
  `delegate(action="start", agent="directional_trader", task="...")`.

### Step 1 — Show available controllers first
Reuse a controller/config already identified in the task. For discovery, call
`manage_controllers(action="list", controller_type="directional_trading")` and
present what's available (controllers + their saved configs). Ask only when the
choice is missing and materially changes the requested comparison.

### Step 2 — Get parameters
Read these from the task and saved config; ask only for missing material inputs:
- **Date range** — suggest 3 months as a default
- **Resolution** — `1m`, `5m`, `15m`, `1h` (1m is the finest; 1s only on Binance spot)
- **Trade cost** — derive it from the cost section below; `0.0006` is illustrative

### Step 3 — Run
- **Single config** → run the `backtest_chart` routine directly
- **Multiple configs, a parameter sweep, or "which is best?"** → use bounded
  asynchronous runs and collect their results. Optional specialist delegation
  follows the seat check above; do not treat dispatch as completion.

### Step 4 — Compare (optional)
Every backtest is saved, whoever ran it — use the `backtest_compare` routine to
overlay PnL curves and rank by metrics.

---

## The tool contract

This section is the **single copy**. Every backtesting playbook links here rather
than restating it.

For this Condor workflow, use the shared `backtest_chart`
routine. It runs the backtest, saves it, charts it, and hands back the metrics as
data. Dates are `YYYY-MM-DD` strings, not epoch seconds.

```python
# Blocking — one short run you are waiting on interactively.
manage_routines(action="run", name="backtest_chart", config={
    "config_name": ..., "start_date": "2025-04-22", "end_date": "2025-07-22",
    "resolution": "1m", "trade_cost": 0.0006, "chart": False,
})

# Fire and forget — long windows and every sweep. submit → read back.
manage_routines(action="run_async", name="backtest_chart", config={...})  # → instance_id
manage_routines(action="get_instance", name=<instance_id>)
```

### Blocking vs fire-and-forget
Both are the same routine — the difference is only whether you wait.

- **`action="run"`** gives up after ~2 minutes and hands you the `instance_id`;
  the run itself keeps going. It is not a failure, it is a handle.
- **`action="run_async"` → `action="get_instance"`** for long windows and *every*
  sweep. Submit the whole grid, then read the instances back; do not serialize a
  15-variant sweep through blocking calls.

`get_instance` returns the finished run in full — the metrics row in `table_data`,
the summary in `text`, the error text on failure, and the status otherwise. You
never need to re-run a window just to see its numbers.

### Read the numbers from `table_data`
One row per run, never parsed from `text`. N runs concatenate into one table.

| Group | Columns |
|---|---|
| Identity | `task_id`, `config_name` |
| Parameters | `start_date`, `end_date`, `resolution`, `trade_cost` |
| Metrics | `net_pnl_quote`, `net_pnl_pct`, `sharpe_ratio`, `max_drawdown_pct`, `accuracy_pct`, `profit_factor`, `total_executors`, `win_signals`, `loss_signals`, `total_fees_quote`, `total_volume` |

The parameter columns are there so a metric is never quoted without the window,
resolution and cost it was measured under — **the row is self-describing, so you
never have to remember to record them separately.**

Set **`chart=False` for every sweep** — otherwise each run pushes an image into the
user's chat. The chart still reaches the web report; a single run you are
presenting is the one case worth leaving `chart=True`.

### Every run is saved
The routine stores each completed backtest under its server-side `task_id`,
whoever ran it and from wherever. That is what makes the rest possible:

- re-render a past run with `backtest_chart` `config={"task_id": ...}` — no re-run,
  no API call;
- rank past runs against each other with `backtest_compare` (2–6 runs, overlaid
  curves + a ranked table);
- a run from the chat, the dashboard or an agent is one record, not three.

The `task_id` is in the metrics row and in the summary text. Record it.

**Retention:** the Hummingbot API archives finished results to
`bots/data/backtests/{task_id}.json.gz` and keeps a count of results — 100 by
default via `BACKTESTING_MAX_RESULTS` (`BACKTESTING_RESULTS_PATH` sets the
directory). Results survive an API restart. Condor's own copy is independent of
that reaping, so a run you saved stays renderable and comparable after the API has
dropped it.

Config variants are created with
`manage_controllers(action="upsert", target="config", config_name=..., config_data={...})`,
adding `confirm_override=True` when overwriting. Config writes require existing
authority for the target store; a tool confirmation flag is not user authorization.

---

## Rules that hold for every strategy family

These are not directional-specific. They apply to any backtest, run by any agent.

### Trade cost — the easiest way to fake an edge
`trade_cost` is a decimal fraction of notional.

| Setting  | Meaning                                                 |
|----------|---------------------------------------------------------|
| `0.0002` | Tool default — roughly a maker leg                      |
| `0.0006` | Illustrative aggregate cost assumption; verify for the actual venue |

Historical examples (one leg), not current fee quotes:

| Exchange | Maker  | Taker   |
|----------|--------|---------|
| Binance  | 0.0002 | 0.0004  |
| Bybit    | 0.0002 | 0.00055 |

Verify the venue, account tier, order types and installed adapter semantics. The
position simulator deducts `trade_cost` once from cumulative returns; derive the
aggregate modeled cost accordingly. Include fees, spread, slippage, funding,
latency and partial-fill assumptions as relevant; report unsupported components
as unavailable. Cost sensitivity can invalidate the measured result without
proving the underlying signal has no edge in every setting.

### Resolution is fill fidelity, not the candle interval
`backtesting_resolution` is the granularity the engine simulates fills at, not the
controller's candle interval.

- `1m` — maximum fidelity, slowest. Use it for the baseline and the final
  validation run.
- Match the controller interval (`15m`, `1h`) for speed during a wide sweep, then
  re-run the winner at `1m` before deploying.
- A winner that only survives at coarse resolution is not a winner — the gap is
  usually intrabar stop/TP ordering.

### Trade count is a validity gate, not a statistic
Under ~20 executors, treat inference as thin-sample exploratory evidence. This
heuristic does not establish validity above 20 trades. A thin run is
flagged above its own numbers in the summary and carries a `Trades` KPI marked
below the gate. Report the observed metrics with the limitation; widen the
window under the experiment plan. Do not loosen strategy filters just to pass
a sample-count gate.

### Sweeping and deploying
- **Never sweep every parameter at once** — that is curve fitting with extra steps.
  One parameter at a time, looking for a plateau.
- **Stability beats the peak.** An isolated Sharpe spike surrounded by collapse is
  a warning sign; a plateau warrants further validation, not a claim of edge.
- **Never deploy on in-sample numbers alone** — a held-out window is mandatory.
  Hold out the most recent ~30 days from the sweep and keep it clean.
- **Report the numbers you actually got, including the bad ones.** A NO-GO is a
  successful outcome, not a failed one.

Passing these research checks does not establish paper, canary or live readiness.
Report research validity and promotion status separately, keeping spot and futures
accounting and owner-equivalent baselines distinct.

### What is NOT shared
Metric *thresholds* — what Sharpe is acceptable, what win rate is a red flag, how
long a trade should last — are calibrated per strategy family and do not transfer.
A 95% win rate at profit factor 1.1 is a red flag for a directional strategy and
the normal shape of a funding-arb trade. Read the thresholds from the agent that
owns the family (`directional_trader` → `backtesting/interpret_metrics.md`), or
state that you don't have calibrated ones. Do not borrow another family's table.
