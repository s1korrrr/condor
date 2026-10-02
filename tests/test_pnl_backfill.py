import json
import sqlite3
from contextlib import closing
from decimal import Decimal

import pytest

from condor import pnl_backfill as pb
from condor.performance_history import PerformanceHistory

T0 = 1_790_000_040  # a UTC minute boundary (divisible by 60)
assert T0 % 60 == 0


def make_recorder(path, *, fills=(), executors=(), ledger=(), candles=(), controllers=(T0 - 600.0,)):
    with closing(sqlite3.connect(path)) as conn:
        conn.executescript(
            """
            CREATE TABLE TradeFill (symbol TEXT, timestamp INTEGER, trade_type TEXT, price INTEGER, amount INTEGER,
                trade_fee TEXT, exact_amount TEXT, exact_price TEXT, exchange_trade_id TEXT);
            CREATE TABLE Executors (id TEXT, type TEXT, close_type INTEGER, close_timestamp INTEGER, net_pnl_quote REAL,
                status INTEGER, config TEXT, controller_id TEXT);
            CREATE TABLE PositionHoldLedger (controller_id TEXT, executor_id TEXT, trading_pair TEXT, timestamp INTEGER,
                order_payload TEXT);
            CREATE TABLE ChartSnapshot (id INTEGER PRIMARY KEY, pair TEXT, interval TEXT, candle_timestamp INTEGER, close_price REAL);
            CREATE TABLE Controllers (id INTEGER, controller_id TEXT, timestamp REAL);
            """
        )
        for fill in fills:
            conn.execute("INSERT INTO TradeFill VALUES (?,?,?,?,?,?,?,?,?)", (*fill, None))
        for executor in executors:
            conn.execute("INSERT INTO Executors VALUES (?,?,?,?,?,?,?,?)", executor)
        for entry in ledger:
            conn.execute("INSERT INTO PositionHoldLedger VALUES (?,?,?,?,?)", entry)
        for pair, minute, close in candles:
            conn.execute(
                "INSERT INTO ChartSnapshot (pair, interval, candle_timestamp, close_price) VALUES (?,?,?,?)",
                (pair, "1m", (T0 + minute * 60) * 1000, close),
            )
        for stamp in controllers:
            conn.execute("INSERT INTO Controllers VALUES (1, 'c', ?)", (stamp,))
        conn.commit()


def fee_json(token, amount, kind="AddedToCost"):
    return json.dumps({"fee_type": kind, "percent": "0", "flat_fees": [{"token": token, "amount": amount}]})


def buy(minute, amount, price, base_fee="0.001"):
    return ("ABC-USDC", (T0 + minute * 60) * 1000, "BUY", 0, 0, fee_json("ABC", base_fee), amount, price)


def sell(minute, amount, price, quote_fee="0.1"):
    return ("ABC-USDC", (T0 + minute * 60) * 1000, "SELL", 0, 0, fee_json("USDC", quote_fee, "DeductedFromReturns"), amount, price)


def flat_candles(first, last, close, pair="ABC-USDC"):
    return [(pair, minute, close) for minute in range(first, last + 1)]


def reconstruction(path, **options):
    recording = pb.load_recording(path)
    return recording, pb.Reconstruction(recording, pb.Marks([recording.candles], **options))


def test_fill_parsing_uses_exact_columns_and_falls_back_to_scaled_integers():
    row = {"symbol": "ABC-USDC", "timestamp": 1000, "trade_type": "BUY", "price": 103480000, "amount": 107660,
           "trade_fee": fee_json("ABC", "0.0001"), "exact_amount": None, "exact_price": None, "exchange_trade_id": "7"}
    fill = pb.parse_fill(row)
    assert (fill.price, fill.amount, fill.exact) == (Decimal("103.48"), Decimal("0.10766"), False)
    assert fill.base_fee == Decimal("0.0001") and fill.quote_fee == 0
    exact = pb.parse_fill({**row, "exact_amount": "0.107661234", "exact_price": "103.481"})
    assert (exact.price, exact.amount, exact.exact) == (Decimal("103.481"), Decimal("0.107661234"), True)
    receipt = pb.parse_fill(row, {"7": ("0.10766123", "103.48")})
    assert (receipt.amount, receipt.exact) == (Decimal("0.10766123"), True)  # a held-order receipt for the same trade id
    with pytest.raises(pb.PnlBackfillError, match="unsupported fee token"):
        pb.parse_fill({**row, "trade_fee": fee_json("OKB", "1")})
    with pytest.raises(pb.PnlBackfillError, match="percentage"):
        pb.parse_fill({**row, "trade_fee": json.dumps({"percent": "0.001", "flat_fees": []})})


def test_total_is_the_cash_flow_identity_with_base_fee_paid_in_inventory(tmp_path):
    path = tmp_path / "bot.sqlite"
    make_recorder(path, fills=[buy(1, "1", "100", "0.001")], candles=flat_candles(0, 10, 110))
    _, recon = reconstruction(path)
    realized, unrealized, total, missing = recon.at(T0 + 5 * 60)
    # pay 100, hold 0.999 of the asset worth 110 each
    assert missing is None
    assert total == Decimal("-100") + Decimal("0.999") * 110
    assert (realized, unrealized) == (0, total)
    assert recon.at(T0)[2] == 0  # nothing before the first fill


def test_a_sell_with_a_quote_fee_closes_the_cash_flow(tmp_path):
    path = tmp_path / "bot.sqlite"
    make_recorder(path, fills=[buy(1, "1", "100", "0"), sell(3, "1", "103", "0.1")], candles=flat_candles(0, 10, 105))
    _, recon = reconstruction(path)
    assert recon.at(T0 + 8 * 60)[2] == Decimal("2.9")  # -100 + 103 - 0.1, flat inventory needs no mark


def test_realized_replays_executor_pnl_and_the_held_position_average_cost(tmp_path):
    held_buy = {"trade_type": "BUY", "executed_amount_base": "2", "executed_amount_quote": "200", "cumulative_fee_paid_quote": "0.2",
                "order_fills": {"1": {"fill_base_amount": "2", "fee": {"flat_fees": [{"token": "ABC", "amount": "0.002"}]}}}}
    held_sell = {"trade_type": "SELL", "executed_amount_base": "1", "executed_amount_quote": "110", "cumulative_fee_paid_quote": "0.11"}
    path = tmp_path / "bot.sqlite"
    make_recorder(
        path,
        executors=[("e1", "position_executor", 6, T0 + 120, 1.5, 4, "{}", "c"),
                   ("e2", "position_executor", 10, T0 + 180, -9.0, 4, "{}", "c"),   # held: counted by the ledger, not here
                   ("e3", "position_executor", None, None, 7.0, 2, "{}", "c")],     # still running: never realized
        ledger=[("c", "e2", "ABC-USDC", T0 + 60, json.dumps(held_buy)), ("c", "e2", "ABC-USDC", T0 + 90, json.dumps(held_sell))],
        fills=[buy(1, "2", "100", "0.002")], candles=flat_candles(0, 10, 100),
    )
    recording, recon = reconstruction(path)
    assert recording.executors_counted == 1 and recording.held_entries == 2
    # Before the executor and the held order close nothing is realized; the held buy only costs its fee.
    assert recon.at(T0 + 60)[0] == 0
    # Executor e2 closed at T0+180, which is when the engine registers both held orders.
    assert recon.at(T0 + 119)[0] == 0
    assert recon.at(T0 + 120)[0] == Decimal("1.5")
    # held base 1.998 at average cost 100 (fee already removed from base): sell 1 at 110 realizes 10, fees 0.2 + 0.11 are charged.
    assert recon.at(T0 + 180)[0] == Decimal("1.5") + Decimal("10") - Decimal("0.2") - Decimal("0.11")


def test_unknown_wallet_sale_executors_are_refused(tmp_path):
    path = tmp_path / "bot.sqlite"
    make_recorder(path, fills=[buy(1, "1", "100")],
                  executors=[("w", "order_executor", 10, T0, 0.0, 4, json.dumps({"level_id": "signal_exit"}), "c")])
    with pytest.raises(pb.PnlBackfillError, match="wallet-sale"):
        pb.load_recording(path)


def test_marks_use_the_last_completed_candle_and_refuse_stale_prices(tmp_path):
    marks = pb.Marks([{"ABC-USDC": {T0: Decimal("1"), T0 + 60: Decimal("2")}}], max_age=300)
    assert marks.at("ABC-USDC", T0 + 60) == 1       # the candle opened at T0 closes at T0+60
    assert marks.at("ABC-USDC", T0 + 119) == 1       # the candle opened at T0+60 is still forming
    assert marks.at("ABC-USDC", T0 + 120) == 2
    assert marks.at("ABC-USDC", T0 + 120 + 301) is None
    assert marks.at("ABC-USDC", T0) is None
    other = pb.Marks([{"ABC-USDC": {T0: Decimal("1")}}, {"ABC-USDC": {T0: Decimal("9"), T0 + 60: Decimal("3")}}])
    assert other.at("ABC-USDC", T0 + 120) == 3 and other.at("ABC-USDC", T0 + 60) == 1  # the first source wins


def test_grid_is_fine_inside_the_window_and_coarse_before_it_and_always_aligned():
    times = pb.grid_times(T0 + 7, T0 + 3600, T0 + 3600, fine_days=1 / 48, fine_step=60, coarse_step=300)
    assert all(t % 60 == 0 for t in times) and times[0] >= T0 + 7
    fine_from = T0 + 3600 - 1800
    assert [t for t in times if t < fine_from] == [t for t in times if t < fine_from and t % 300 == 0]
    assert len([t for t in times if t >= fine_from]) == 31
    with pytest.raises(pb.PnlBackfillError):
        pb.grid_times(0, 1, 1, fine_step=60, coarse_step=100)


@pytest.fixture
def scenario(tmp_path):
    recorder, dest = tmp_path / "bot.sqlite", tmp_path / "condor.sqlite3"
    make_recorder(
        recorder, fills=[buy(2, "1", "100", "0"), sell(8, "1", "104", "0")],
        executors=[("e1", "position_executor", 6, T0 + 8 * 60, 4.0, 4, "{}", "c")],
        candles=flat_candles(0, 12, 100), controllers=(T0 + 60.0,),
    )
    history = PerformanceHistory(dest)
    with history._connect() as conn:  # one live run from minute 5 to 6 (the recorder keeps going after it)
        for minute in (5, 6):
            conn.execute("INSERT INTO points VALUES (?,?,?,?,?,?,?,?,?)",
                         ("srv", "bot", T0 + minute * 60, "live-a", "seg-1", "USDC", "0", "0.5", "0.5"))
    return recorder, dest


def points(dest, segment_like="%"):
    with closing(sqlite3.connect(dest)) as conn:
        return conn.execute(
            "SELECT timestamp, identity, segment, quote, realized_pnl_quote, unrealized_pnl_quote, total_pnl_quote FROM points "
            "WHERE bot='bot' AND segment LIKE ? ORDER BY timestamp", (segment_like,)).fetchall()


def test_dry_run_plans_rows_outside_live_coverage_and_writes_nothing(scenario):
    recorder, dest = scenario
    before = points(dest)
    report = pb.backfill(dest, "srv", {"bot": recorder}, end=T0 + 11 * 60)
    bot = report["bots"]["bot"]
    # grid minutes 1..11 (life starts at minute 1); minutes 5 and 6 are live, so 9 rows are planned
    assert bot["grid_rows_planned"] == 9 and bot["grid_skipped_live_covered"] == 2 and bot["grid_skipped_unmarked"] == 0
    assert points(dest) == before
    residual = bot["validation_against_live_samples"]["total_residual"]
    assert residual["n"] == 2  # compared with the two live samples; the fill at minute 2 gives total 0 flat inventory


def test_apply_writes_consistent_rows_with_backfill_identity_and_is_idempotent(scenario):
    recorder, dest = scenario
    first = pb.backfill(dest, "srv", {"bot": recorder}, apply=True, end=T0 + 11 * 60)["bots"]["bot"]
    assert first["rows_inserted"] == 9 and first["rows_already_present"] == 0
    rows = points(dest, "backfill-%")
    assert {(row[1], row[2], row[3]) for row in rows} == {("backfill:bot", "backfill-bot", "USDC")}
    for stamp, _, _, _, realized, unrealized, total in rows:
        assert Decimal(realized) + Decimal(unrealized) == Decimal(total)  # Condor rejects totals that differ by > 1e-6
    by_minute = {int((row[0] - T0) // 60): row for row in rows}
    assert by_minute[1][6] == "0.0000000000" or Decimal(by_minute[1][6]) == 0
    assert Decimal(by_minute[4][6]) == Decimal("0")                  # long 1 @100 marked 100
    assert Decimal(by_minute[7][6]) == Decimal("0")
    assert Decimal(by_minute[9][6]) == Decimal("4")                  # sold at 104, flat
    assert (Decimal(by_minute[9][4]), Decimal(by_minute[9][5])) == (Decimal("4"), Decimal("0"))  # executor realized 4
    assert len(points(dest, "seg-%")) == 2                           # live rows untouched
    second = pb.backfill(dest, "srv", {"bot": recorder}, apply=True, end=T0 + 11 * 60)["bots"]["bot"]
    assert second["rows_inserted"] == 0 and second["rows_already_present"] == 9
    assert len(points(dest, "backfill-%")) == 9
    read = PerformanceHistory(dest).read("srv", "bot", "1D", now=T0 + 3600)
    assert read["coverage_start"] == T0 + 60 and len(read["points"]) == 11  # 9 backfill + 2 live, one ordered series


def test_exported_sql_script_inserts_the_same_rows_idempotently(scenario, tmp_path):
    recorder, dest = scenario
    script = tmp_path / "backfill.sql"
    report = pb.backfill(dest, "srv", {"bot": recorder}, end=T0 + 11 * 60, sql_out=script)
    assert report["sql_script"] == str(script) and points(dest, "backfill-%") == []  # exporting alone writes nothing
    other = tmp_path / "other.sqlite3"
    with PerformanceHistory(other)._connect():
        pass
    for _ in range(2):
        with closing(sqlite3.connect(other)) as conn:
            conn.executescript(script.read_text())
    pb.backfill(dest, "srv", {"bot": recorder}, apply=True, end=T0 + 11 * 60)
    assert points(other, "backfill-%") == points(dest, "backfill-%") and len(points(other)) == 9


def test_rollback_removes_only_backfill_rows(scenario):
    recorder, dest = scenario
    pb.backfill(dest, "srv", {"bot": recorder}, apply=True, end=T0 + 11 * 60)
    dry = pb.backfill(dest, "srv", {"bot": recorder}, rollback=True)["bots"]["bot"]
    assert dry == {"backfill_rows_to_remove": 9} and len(points(dest, "backfill-%")) == 9
    done = pb.backfill(dest, "srv", {"bot": recorder}, rollback=True, apply=True)["bots"]["bot"]
    assert done == {"backfill_rows_removed": 9}
    assert points(dest, "backfill-%") == [] and len(points(dest, "seg-%")) == 2


def test_rows_without_a_fresh_mark_are_skipped_not_invented(tmp_path):
    recorder, dest = tmp_path / "bot.sqlite", tmp_path / "condor.sqlite3"
    make_recorder(recorder, fills=[buy(1, "1", "100", "0"), buy(30, "0.001", "100", "0")],
                  candles=flat_candles(0, 2, 100), controllers=(T0 + 60.0,))
    with PerformanceHistory(dest)._connect():
        pass
    report = pb.backfill(dest, "srv", {"bot": recorder}, end=T0 + 3600, max_mark_age=300)["bots"]["bot"]
    # candles end at minute 2 (closing at minute 3); inventory is open, so rows later than 300s after that are unmarked
    assert report["grid_rows_planned"] == 8 and report["grid_skipped_unmarked"] == 22


def test_cli_refuses_malformed_input_and_names_the_problem(tmp_path, capsys):
    assert pb.main(["--dest", str(tmp_path / "missing.sqlite3"), "--server", "srv", "--bot", "bot=x"]) == 2
    assert "does not exist" in capsys.readouterr().err
    assert pb.main(["--dest", str(tmp_path), "--server", "srv", "--bot", "novalue"]) == 2
    assert "NAME=RECORDER" in capsys.readouterr().err
