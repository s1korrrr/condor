"""Rebuild a bot's native PnL history from its Hummingbot recorder, as `points` rows Condor can read.

Condor records native PnL once a minute only while it is watching. This tool reconstructs the stretches it
was not watching (before recording began, and gaps while Condor or the API was down) from what the bot's own
recorder saved. It never touches live samples and never overwrites an existing row.

Method (all arithmetic is exact `Decimal`; nothing is fitted to the live numbers):

* total PnL at time t is the cash-flow identity per pair: cumulative quote flow of every recorded fill (buys
  pay price*amount and receive amount minus the base-asset fee; sells receive price*amount minus the quote fee
  and give up amount plus any base fee) plus net base inventory valued at the last completed 1m candle close.
  It is independent of lot-matching policy, so it equals the engine's executor-plus-held-position total.
* realized PnL at time t replays the engine's own accounting (`ExecutorOrchestrator.generate_performance_report`):
  the net PnL of every done non-POSITION_HOLD executor at its close time, plus each held position's running
  average-cost realized PnL minus its cumulative fees, replayed from `PositionHoldLedger` in recorded order.
* unrealized PnL is total minus realized, so the stored triple is exactly consistent (Condor rejects a sample
  whose total differs from realized plus unrealized by more than 1e-6).

Rows are written with identity `backfill:<bot>` and segment `backfill-<bot>`, only at grid times that no live
sample covers. Native realized PnL is cumulative across engine restarts (verified against saved samples), so
the frontend joins backfill rows to live rows without an owner boundary (see `performance-history.ts`).

    python -m condor.pnl_backfill --dest copy-of-native-performance.sqlite3 --server rsibot-stack-v2 \
        --bot ok_rsi=copy-of-ok_rsi.sqlite --bot rsi_modular_v2=copy-of-rsi_modular_v2.sqlite \
        --bot meridian_v3=copy-of-meridian_v3.sqlite [--apply | --rollback]

The recorders must be plain read-only copies (never open a live WAL recorder with a host sqlite client). The
default is a dry run that prints row counts and a validation against the live samples already in `--dest`.
"""

from __future__ import annotations

import argparse
import datetime
import json
import re
import sqlite3
import sys
from bisect import bisect_right
from collections import defaultdict
from contextlib import closing
from dataclasses import dataclass
from decimal import ROUND_HALF_EVEN, Decimal, localcontext
from pathlib import Path

from condor.performance_history import PerformanceHistory

BACKFILL_SEGMENT_PREFIX = "backfill-"
BACKFILL_IDENTITY_PREFIX = "backfill:"
SIMPLE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$")
PAIR = re.compile(r"^[A-Z0-9]+-[A-Z0-9]+$")
POSITION_HOLD = 10  # CloseType.POSITION_HOLD: its fills are accounted by the held-position ledger instead
TERMINATED = 4  # RunnableStatus.TERMINATED
QUANTUM = Decimal("1e-10")
SCALED_UNIT = Decimal(10) ** 6  # TradeFill.price/amount/fee without exact_* columns are stored in 1e-6 units
CANDLE_SECONDS = 60
POINT_COLUMNS = (
    "server", "bot", "timestamp", "identity", "segment", "quote",
    "realized_pnl_quote", "unrealized_pnl_quote", "total_pnl_quote",
)


class PnlBackfillError(ValueError):
    pass


@dataclass(frozen=True)
class Fill:
    ts: float
    pair: str
    side: str
    amount: Decimal
    price: Decimal
    base_fee: Decimal
    quote_fee: Decimal
    exact: bool


@dataclass(frozen=True)
class Recording:
    """Everything one bot recorder contributes, already parsed."""

    fills: tuple
    realized_events: tuple  # (timestamp, realized delta in quote)
    candles: dict  # pair -> {open_seconds: close Decimal}
    life_start: float | None
    horizon: float
    held_entries: int
    executors_counted: int
    quote: str | None
    candle_end: float | None = None


def _simple(value, label):
    if not isinstance(value, str) or not SIMPLE.fullmatch(value):
        raise PnlBackfillError(f"{label} must be a simple identity")
    return value


def _tables(conn):
    return {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def _dec(value):
    return Decimal(str(value))


def parse_fill(row, receipts=None):
    """One TradeFill row; exact decimals when the recorder kept them, else the held-order receipt for the same
    exchange trade id, else the 1e-6 integer columns (reported as rounded)."""
    symbol = row["symbol"]
    if not isinstance(symbol, str) or not PAIR.fullmatch(symbol):
        raise PnlBackfillError(f"unsupported symbol {symbol!r}")
    base, quote = symbol.split("-")
    side = str(row["trade_type"]).upper()
    if side not in ("BUY", "SELL"):
        raise PnlBackfillError(f"unsupported trade type {row['trade_type']!r}")
    exact = row["exact_amount"] is not None and row["exact_price"] is not None
    if exact:
        amount, price = _dec(row["exact_amount"]), _dec(row["exact_price"])
    elif receipts and str(row["exchange_trade_id"]) in receipts:
        amount, price = (_dec(value) for value in receipts[str(row["exchange_trade_id"])])
        exact = True
    else:
        amount, price = _dec(row["amount"]) / SCALED_UNIT, _dec(row["price"]) / SCALED_UNIT
    fee = json.loads(row["trade_fee"]) if row["trade_fee"] else {}
    if _dec(fee.get("percent", "0") or "0") != 0:
        raise PnlBackfillError("percentage trade fees are not supported")
    base_fee = quote_fee = Decimal(0)
    for item in fee.get("flat_fees", []):
        if item["token"] == base:
            base_fee += _dec(item["amount"])
        elif item["token"] == quote:
            quote_fee += _dec(item["amount"])
        else:
            raise PnlBackfillError(f"unsupported fee token {item['token']!r} on {symbol}")
    if amount <= 0 or price <= 0:
        raise PnlBackfillError(f"non-positive fill on {symbol}")
    return Fill(row["timestamp"] / 1000, symbol, side, amount, price, base_fee, quote_fee, exact)


def _base_fee(order, base):
    """Mirror of hummingbot `order_accounting.base_fee_amount`."""
    if "actual_base_fee" in order:
        return _dec(order["actual_base_fee"])
    total = Decimal(0)
    for fill in (order.get("order_fills") or {}).values():
        fee = fill.get("fee") or {}
        total += sum((_dec(item["amount"]) for item in fee.get("flat_fees", []) if item["token"] == base), Decimal(0))
        token = fee.get("percent_token")
        if token == base or (token is None and fee.get("fee_type") == "DeductedFromReturns" and order.get("trade_type") == "BUY"):
            total += _dec(fee.get("percent", "0")) * _dec(fill["fill_base_amount"])
    return total


def held_realized_events(entries):
    """Replay held-position orders like `PositionHold.get_position_summary`; yields (timestamp, delta).

    `entries` are (timestamp, pair, order payload) in recorded order for ONE controller; positions are kept per
    pair. The reported contribution is running average-cost realized PnL minus cumulative fees paid. The caller
    passes the time the engine registered the order in the held position (its executor's close time).
    """
    state = defaultdict(lambda: {"net": Decimal(0), "be": Decimal(0), "realized": Decimal(0), "fees": Decimal(0)})
    events = []
    for stamp, pair, order in entries:
        trade_type = order.get("trade_type")
        if trade_type not in ("BUY", "SELL"):
            raise PnlBackfillError("held order has no valid side")
        position = state[pair]
        base = _dec(order.get("executed_amount_base", 0))
        quote = _dec(order.get("executed_amount_quote", 0))
        fee = _dec(order.get("cumulative_fee_paid_quote", 0))
        before = position["realized"] - position["fees"]
        base_fee = _base_fee(order, pair.split("-")[0])
        if base > 0:
            direction = Decimal(1) if trade_type == "BUY" else Decimal(-1)
            if "actual_base_fee" not in order:
                quote -= direction * base_fee * (quote / base)
            base -= direction * base_fee
        if base < 0:
            raise PnlBackfillError("held base fee exceeds the acquired quantity")
        position["fees"] += fee
        if base > 0:
            price = quote / base
            signed = base if trade_type == "BUY" else -base
            net = position["net"]
            if net == 0 or net * signed > 0:
                position["be"] = (abs(net) * position["be"] + base * price) / (abs(net) + base)
            else:
                matched = min(abs(net), base)
                position["realized"] += (price - position["be"]) * matched * (Decimal(1) if net > 0 else Decimal(-1))
                if base > abs(net):
                    position["be"] = price
            position["net"] = net + signed
            if position["net"] == 0:
                position["be"] = Decimal(0)
        delta = position["realized"] - position["fees"] - before
        if delta:
            events.append((float(stamp), delta))
    return events


def load_recording(path, *, immutable=False):
    """Parse one Hummingbot recorder (a plain copy) read-only."""
    path = Path(path)
    if not path.is_file():
        raise PnlBackfillError(f"recorder {path.name} does not exist")
    uri = f"file:{path.resolve()}?mode=ro" + ("&immutable=1" if immutable else "")
    with closing(sqlite3.connect(uri, uri=True)) as conn:
        conn.row_factory = sqlite3.Row
        have = _tables(conn)
        if "TradeFill" not in have:
            raise PnlBackfillError(f"recorder {path.name} has no TradeFill table")
        with localcontext() as ctx:
            ctx.prec = 50
            receipts = {}
            if "PositionHoldLedger" in have:
                for (payload,) in conn.execute("SELECT order_payload FROM PositionHoldLedger"):
                    for trade_id, fill in (json.loads(payload).get("order_fills") or {}).items():
                        if "fill_base_amount" in fill and "fill_price" in fill:
                            receipts[str(trade_id)] = (fill["fill_base_amount"], fill["fill_price"])
            fills = tuple(parse_fill(row, receipts) for row in conn.execute("SELECT * FROM TradeFill ORDER BY timestamp, rowid"))
            quotes = {fill.pair.split("-")[1] for fill in fills}
            if len(quotes) > 1:
                raise PnlBackfillError("mixed quote currencies in one recorder")
            events = []
            counted = 0
            closed_at = {}
            if "Executors" in have:
                for row in conn.execute("SELECT id, type, close_type, close_timestamp, net_pnl_quote, status, config FROM Executors"):
                    if row["close_timestamp"] is not None:
                        closed_at[row["id"]] = row["close_timestamp"]
                    config = json.loads(row["config"]) if row["config"] else {}
                    if row["type"] == "order_executor" and config.get("level_id") == "signal_exit":
                        raise PnlBackfillError("unknown-wallet-sale executors are not supported")
                    if row["status"] == TERMINATED and row["close_type"] is not None and row["close_type"] != POSITION_HOLD:
                        if row["close_timestamp"] is None:
                            raise PnlBackfillError("done executor without a close timestamp")
                        counted += 1
                        if row["net_pnl_quote"]:
                            events.append((float(row["close_timestamp"]), _dec(row["net_pnl_quote"])))
            held = defaultdict(list)
            if "PositionHoldLedger" in have:
                for row in conn.execute(
                    "SELECT controller_id, executor_id, trading_pair, timestamp, order_payload FROM PositionHoldLedger ORDER BY timestamp, rowid"
                ):
                    # The engine adds a held order to its position when the executor ends, not when the order filled.
                    registered = max(row["timestamp"], closed_at.get(row["executor_id"], row["timestamp"]))
                    held[row["controller_id"]].append((registered, row["trading_pair"], json.loads(row["order_payload"])))
            held_entries = 0
            for entries in held.values():
                held_entries += len(entries)
                events.extend(held_realized_events(entries))
            candles = defaultdict(dict)
            if "ChartSnapshot" in have:
                for row in conn.execute(
                    "SELECT pair, candle_timestamp, close_price FROM ChartSnapshot WHERE interval='1m' AND close_price IS NOT NULL ORDER BY id"
                ):
                    candles[row["pair"]][int(row["candle_timestamp"] // 1000)] = _dec(row["close_price"])
            life = [row[0] for row in conn.execute("SELECT MIN(timestamp) FROM Controllers")] if "Controllers" in have else []
            stamps = [fill.ts for fill in fills] + [stamp for stamp, _ in events]
            horizon = [max(stamps)] if stamps else []
            for table, column, scale in (
                ("MarketState", "timestamp", 1000), ("Order", "last_update_timestamp", 1000),
                ("OrderStatus", "timestamp", 1000), ("Executors", "close_timestamp", 1),
            ):
                if table in have:
                    value = conn.execute(f'SELECT MAX("{column}") FROM "{table}"').fetchone()[0]
                    if value is not None:
                        horizon.append(value / scale)
            for pair_candles in candles.values():
                horizon.append(max(pair_candles) + CANDLE_SECONDS)
    starts = [value for value in life if value is not None] + ([fills[0].ts] if fills else [])
    if not horizon:
        raise PnlBackfillError(f"recorder {path.name} holds no fills or executors")
    return Recording(
        fills=fills, realized_events=tuple(sorted(events, key=lambda item: item[0])), candles=dict(candles),
        life_start=min(starts) if starts else None, horizon=max(horizon), held_entries=held_entries,
        executors_counted=counted, quote=quotes.pop() if quotes else None,
        candle_end=max((max(c) + CANDLE_SECONDS for c in candles.values()), default=None),
    )


class Marks:
    """Last completed 1m candle close per pair; the first source that has a candle wins."""

    def __init__(self, sources, lag=CANDLE_SECONDS, max_age=1800):
        merged = defaultdict(dict)
        for source in sources:
            for pair, candles in source.items():
                for opened, close in candles.items():
                    merged[pair].setdefault(opened, close)
        self.opens = {pair: sorted(c) for pair, c in merged.items()}
        self.closes = {pair: [c[o] for o in self.opens[pair]] for pair, c in merged.items()}
        self.lag, self.max_age = lag, max_age

    def at(self, pair, stamp):
        opens = self.opens.get(pair)
        if not opens:
            return None
        index = bisect_right(opens, stamp - self.lag) - 1
        if index < 0 or stamp - (opens[index] + CANDLE_SECONDS) > self.max_age:
            return None
        return self.closes[pair][index]


class Reconstruction:
    """Cumulative realized, unrealized and total PnL of one bot at any time, from a parsed recording."""

    def __init__(self, recording, marks):
        self.marks = marks
        flows = defaultdict(lambda: ([], [], []))
        state = defaultdict(lambda: [Decimal(0), Decimal(0)])
        for fill in recording.fills:
            quote, base = state[fill.pair]
            if fill.side == "BUY":
                quote -= fill.amount * fill.price + fill.quote_fee
                base += fill.amount - fill.base_fee
            else:
                quote += fill.amount * fill.price - fill.quote_fee
                base -= fill.amount + fill.base_fee
            state[fill.pair] = [quote, base]
            times, quotes, bases = flows[fill.pair]
            times.append(fill.ts), quotes.append(quote), bases.append(base)
        self.pairs = dict(flows)
        self.realized_times, self.realized_values = [], []
        running = Decimal(0)
        for stamp, delta in recording.realized_events:
            running += delta
            self.realized_times.append(stamp)
            self.realized_values.append(running)
        self.life_start = recording.life_start
        self.quote = recording.quote or "USDC"

    def at(self, stamp):
        """(realized, unrealized, total, missing_pair). A pair with inventory but no fresh mark makes the row unmarked."""
        with localcontext() as ctx:
            ctx.prec = 50
            total = Decimal(0)
            for pair, (times, quotes, bases) in self.pairs.items():
                index = bisect_right(times, stamp) - 1
                if index < 0:
                    continue
                total += quotes[index]
                if bases[index] != 0:
                    mark = self.marks.at(pair, stamp)
                    if mark is None:
                        return None, None, None, pair
                    total += bases[index] * mark
            index = bisect_right(self.realized_times, stamp) - 1
            realized = self.realized_values[index] if index >= 0 else Decimal(0)
            return realized, total - realized, total, None


def grid_times(start, end, as_of, *, fine_days=7, fine_step=60, coarse_step=300):
    """UTC-aligned grid in [start, end]: fine_step inside the last fine_days before as_of, coarse_step before."""
    if fine_step <= 0 or coarse_step <= 0 or coarse_step % fine_step:
        raise PnlBackfillError("coarse step must be a positive multiple of the fine step")
    fine_from = as_of - fine_days * 86400
    first = int(start // fine_step) * fine_step
    out = []
    stamp = first
    while stamp <= end:
        if stamp >= start and (stamp >= fine_from or stamp % coarse_step == 0):
            out.append(stamp)
        stamp += fine_step
    return out


def live_intervals(conn, server, bot):
    """[first, last] of each live (non-backfill) segment."""
    rows = conn.execute(
        "SELECT MIN(timestamp), MAX(timestamp) FROM points WHERE server=? AND bot=? AND segment NOT LIKE ? GROUP BY segment ORDER BY 1",
        (server, bot, BACKFILL_SEGMENT_PREFIX + "%"),
    ).fetchall()
    return [(row[0], row[1]) for row in rows]


def _fmt(value):
    value = value.quantize(QUANTUM, rounding=ROUND_HALF_EVEN)
    return format(Decimal(0) if value == 0 else value, "f")


def plan_rows(server, bot, reconstruction, times, intervals):
    """Rows for grid `times` that no live interval covers. Returns (rows, skipped_covered, unmarked)."""
    rows, covered, unmarked = [], 0, 0
    identity, segment = BACKFILL_IDENTITY_PREFIX + bot, BACKFILL_SEGMENT_PREFIX + bot
    for stamp in times:
        if any(first <= stamp <= last for first, last in intervals):
            covered += 1
            continue
        realized, _, total, missing = reconstruction.at(stamp)
        if missing:
            unmarked += 1
            continue
        total_q, realized_q = total.quantize(QUANTUM, rounding=ROUND_HALF_EVEN), realized.quantize(QUANTUM, rounding=ROUND_HALF_EVEN)
        rows.append((server, bot, float(stamp), identity, segment, reconstruction.quote,
                     _fmt(realized_q), _fmt(total_q - realized_q), _fmt(total_q)))
    return rows, covered, unmarked


def _stats(values):
    if not values:
        return None
    ordered = sorted(abs(value) for value in values)
    return {
        "n": len(values), "mean": float(sum(values) / len(values)), "max_abs": float(ordered[-1]),
        "p95_abs": float(ordered[int(0.95 * (len(ordered) - 1))]), "last": float(values[-1]),
    }


def validate_against_live(conn, server, bot, reconstruction):
    """Residual of the reconstruction against every live native sample already in the database."""
    rows = conn.execute(
        "SELECT timestamp, realized_pnl_quote, total_pnl_quote FROM points WHERE server=? AND bot=? AND segment NOT LIKE ? ORDER BY timestamp",
        (server, bot, BACKFILL_SEGMENT_PREFIX + "%"),
    ).fetchall()
    total_res, realized_res, per_day = [], [], {}
    for stamp, realized, total in rows:
        r, _, t, missing = reconstruction.at(stamp)
        if missing:
            continue
        total_res.append(t - _dec(total))
        realized_res.append(r - _dec(realized))
        day = per_day.setdefault(int(stamp // 86400), [None, None, None, None])
        if day[0] is None:
            day[0], day[2] = _dec(total), t
        day[1], day[3] = _dec(total), t
    days = {
        datetime.datetime.fromtimestamp(key * 86400, datetime.timezone.utc).strftime("%Y-%m-%d"): {
            "native_delta": float(v[1] - v[0]), "reconstructed_delta": float(v[3] - v[2]),
            "difference": float((v[3] - v[2]) - (v[1] - v[0])),
        } for key, v in sorted(per_day.items())
    }
    return {"live_samples": len(rows), "compared": len(total_res), "total_residual": _stats(total_res),
            "realized_residual": _stats(realized_res), "per_day_live_span_delta": days}


def parse_bot_arguments(items):
    bots = {}
    for item in items:
        name, separator, path = item.partition("=")
        if not separator or not path:
            raise PnlBackfillError("--bot must be NAME=RECORDER_COPY_PATH")
        bots[_simple(name, "bot")] = Path(path)
    if not bots:
        raise PnlBackfillError("at least one --bot is required")
    return bots


def export_sql(path, plans):
    """Write the planned rows as one transactional, idempotent SQL script (INSERT OR IGNORE)."""
    quote = lambda text: "'" + str(text).replace("'", "''") + "'"
    lines = ["-- condor.pnl_backfill: backfill rows for the `points` table; idempotent, remove with segment LIKE 'backfill-%'",
             "BEGIN IMMEDIATE;"]
    for rows in plans.values():
        for server, bot, stamp, identity, segment, currency, realized, unrealized, total in rows:
            lines.append(
                f"INSERT OR IGNORE INTO points ({','.join(POINT_COLUMNS)}) VALUES ({quote(server)},{quote(bot)},{stamp!r},"
                f"{quote(identity)},{quote(segment)},{quote(currency)},{quote(realized)},{quote(unrealized)},{quote(total)});"
            )
    lines.append("COMMIT;")
    Path(path).write_text("\n".join(lines) + "\n")


def backfill(dest, server, bots, *, apply=False, rollback=False, fine_days=7, fine_step=60, coarse_step=300,
             max_mark_age=1800, end=None, immutable=False, sql_out=None):
    """Plan (and with `apply`, write) backfill rows. Returns a JSON-serialisable report."""
    server = _simple(server, "server")
    dest = Path(dest)
    if not dest.is_file():
        raise PnlBackfillError("destination database does not exist")
    report = {"server": server, "applied": apply, "rollback": rollback, "bots": {}}
    if rollback:
        with closing(sqlite3.connect(f"file:{dest.resolve()}?mode=ro", uri=True)) as conn:
            counts = {bot: conn.execute("SELECT COUNT(*) FROM points WHERE server=? AND bot=? AND segment=?",
                                        (server, bot, BACKFILL_SEGMENT_PREFIX + bot)).fetchone()[0] for bot in bots}
        if apply:
            with PerformanceHistory(dest)._connect() as conn:
                for bot in bots:
                    conn.execute("DELETE FROM points WHERE server=? AND bot=? AND segment=?",
                                 (server, bot, BACKFILL_SEGMENT_PREFIX + bot))
        report["bots"] = {bot: {"backfill_rows_removed" if apply else "backfill_rows_to_remove": count} for bot, count in counts.items()}
        return report
    recordings = {bot: load_recording(path, immutable=immutable) for bot, path in bots.items()}
    marks_for = {}
    for bot, recording in recordings.items():
        others = [other.candles for name, other in recordings.items() if name != bot]
        marks_for[bot] = Marks([recording.candles, *others], max_age=max_mark_age)
    as_of = max(recording.horizon for recording in recordings.values())
    # A quiet recorder (no fills or candles of its own for hours) is known complete up to the moment the recorders were
    # copied, which the newest candle in any copy shows. The live-sample validation in the report would expose a
    # missed fill as a large residual.
    snapshot = max((r.candle_end for r in recordings.values() if r.candle_end is not None), default=0)
    plans = {}
    with closing(sqlite3.connect(f"file:{dest.resolve()}?mode=ro", uri=True)) as conn:
        if "points" not in _tables(conn):
            raise PnlBackfillError("destination has no points table")
        for bot, recording in recordings.items():
            reconstruction = Reconstruction(recording, marks_for[bot])
            intervals = live_intervals(conn, server, bot)
            horizon = max(recording.horizon, snapshot)
            stop = end if end is not None else (intervals[-1][1] if intervals else horizon)
            stop = min(stop, horizon)
            start = recording.life_start if recording.life_start is not None else recording.fills[0].ts
            times = grid_times(start, stop, as_of, fine_days=fine_days, fine_step=fine_step, coarse_step=coarse_step)
            rows, covered, unmarked = plan_rows(server, bot, reconstruction, times, intervals)
            at_horizon = reconstruction.at(horizon)
            plans[bot] = rows
            report["bots"][bot] = {
                "recorder_fills": len(recording.fills), "fills_with_rounded_1e-6_precision": sum(not f.exact for f in recording.fills),
                "executors_counted_realized": recording.executors_counted, "held_ledger_entries": recording.held_entries,
                "life_start": start, "recorder_horizon": horizon, "backfill_end": stop,
                "live_segments": len(intervals),
                "grid_rows_planned": len(rows), "grid_skipped_live_covered": covered, "grid_skipped_unmarked": unmarked,
                "first_row": rows[0][2:] if rows else None, "last_row": rows[-1][2:] if rows else None,
                "reconstruction_at_horizon": None if at_horizon[3] else {
                    "realized": float(at_horizon[0]), "unrealized": float(at_horizon[1]), "total": float(at_horizon[2])},
                "validation_against_live_samples": validate_against_live(conn, server, bot, reconstruction),
            }
    if sql_out is not None:
        export_sql(sql_out, plans)
        report["sql_script"] = str(sql_out)
    if apply:
        with PerformanceHistory(dest)._connect() as conn:
            for bot, rows in plans.items():
                inserted = 0
                for row in rows:
                    inserted += conn.execute(
                        f"INSERT OR IGNORE INTO points ({','.join(POINT_COLUMNS)}) VALUES ({','.join('?' * len(POINT_COLUMNS))})", row
                    ).rowcount
                report["bots"][bot].update(rows_inserted=inserted, rows_already_present=len(rows) - inserted)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dest", type=Path, required=True, help="a COPY of the Condor native-performance database")
    parser.add_argument("--server", required=True)
    parser.add_argument("--bot", action="append", default=[], metavar="NAME=RECORDER_COPY",
                        help="repeatable; plain copy of the bot's Hummingbot recorder")
    parser.add_argument("--fine-days", type=int, default=7)
    parser.add_argument("--fine-step", type=int, default=60)
    parser.add_argument("--coarse-step", type=int, default=300)
    parser.add_argument("--max-mark-age", type=int, default=1800)
    parser.add_argument("--end", type=float, default=None, help="latest timestamp to fill (default: last live sample)")
    parser.add_argument("--immutable", action="store_true", help="open the recorder copies with immutable=1")
    parser.add_argument("--export-sql", type=Path, default=None, metavar="PATH",
                        help="also write the planned rows as an idempotent INSERT OR IGNORE script")
    parser.add_argument("--apply", action="store_true", help="write to --dest (default: dry run)")
    parser.add_argument("--rollback", action="store_true", help="remove this tool's rows for the named bots")
    args = parser.parse_args(argv)
    try:
        report = backfill(
            args.dest, args.server, parse_bot_arguments(args.bot), apply=args.apply, rollback=args.rollback,
            fine_days=args.fine_days, fine_step=args.fine_step, coarse_step=args.coarse_step,
            max_mark_age=args.max_mark_age, end=args.end, immutable=args.immutable, sql_out=args.export_sql,
        )
    except (PnlBackfillError, sqlite3.Error, json.JSONDecodeError) as error:
        print(f"pnl backfill refused: {error}", file=sys.stderr)
        return 2
    print(json.dumps(report, indent=2, sort_keys=True, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
