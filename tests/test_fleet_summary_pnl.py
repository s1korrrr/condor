"""Fleet PnL windows: golden numbers from a seeded temp performance DB.

The scenario in ``tests/fixtures/fleet_summary/performance_cases.json`` (times are minutes before ``now_ms``):

* ``ok_rsi``: backfill rows (segment ``backfill-ok_rsi``) join the first live run, then the engine restarts
  (boot-a1 -> boot-a2). The step across the restart is a boundary, never a delta.
* ``rsi_modular_v2``: a single owner run that starts 10 hours ago, so a 24h window is only partly covered.
* ``meridian_v3``: one sample only -> cannot form a change. ``alt_usdt``: another quote. ``no_history``: nothing stored.

Hand arithmetic (USDC):

  ok_rsi day   : 13->15 (+2), 15->16 is the restart (skipped), 16->20 (+4), 20->21 (+1)       = 7   (realized 3.5)
  ok_rsi week  : 8->10 (+2), 10->12 (+2), 12->13 (+1, backfill joins live), 13->15 (+2),
                 restart skipped, 16->20 (+4), 20->21 (+1)                                     = 12  (realized 6)
  rsi_modular_v2: 0->1.5 (+1.5), 1.5->1 (-0.5), 1->3 (+2)                                       = 3   (realized 1)
  fleet day    : 7 + 3 = 10 over 2 of 5 bots (realized 4.5, unrealized 5.5); week/month/all: 12 + 3 = 15
"""

import json
from decimal import Decimal
from pathlib import Path

import pytest

from condor.performance_history import PerformanceHistory
from condor.web import fleet_pnl

FIXTURE = json.loads(
    (
        Path(__file__).parent / "fixtures" / "fleet_summary" / "performance_cases.json"
    ).read_text()
)
NOW_MS = FIXTURE["now_ms"]
NOW_S = NOW_MS / 1000
SERVER = FIXTURE["server"]
BOTS = FIXTURE["bots"]
RANGES = ("1D", "1W", "1M", "ALL")


@pytest.fixture(scope="module")
def store(tmp_path_factory):
    store = PerformanceHistory(
        tmp_path_factory.mktemp("perf") / "native-performance.sqlite3"
    )
    with store._connect() as conn:
        for bot, rows in FIXTURE["seed"].items():
            for minutes, total, realized, identity, segment, quote in rows:
                conn.execute(
                    "INSERT INTO points VALUES (?,?,?,?,?,?,?,?,?)",
                    (
                        SERVER,
                        bot,
                        NOW_S - minutes * 60,
                        identity,
                        segment,
                        quote,
                        str(realized),
                        str(round(total - realized, 10)),
                        str(total),
                    ),
                )
    return store


def test_the_recorded_reads_are_exactly_what_the_reader_serves(store):
    """The browser replays `reads`; this proves they are the real wire shape, not an invention."""
    for bot in BOTS:
        for range_ in RANGES:
            assert (
                store.read(SERVER, bot, range_, NOW_S) == FIXTURE["reads"][bot][range_]
            ), (bot, range_)


def histories(store, range_, now_ms=NOW_MS):
    clock = now_ms + 5_000
    return [
        fleet_pnl.parse_bot_history(
            store.read(SERVER, bot, range_, now_ms / 1000), bot, range_, clock
        )
        for bot in BOTS
    ]


def window(store, name):
    all_ = fleet_pnl.compute_windows(
        {r: histories(store, r) for r in RANGES}, BOTS, NOW_MS
    )
    return all_[name]


def summarize(w):
    return {
        "total": float(w.total) if w.total is not None else None,
        "realized": float(w.realized) if w.realized is not None else None,
        "unrealized": float(w.unrealized) if w.unrealized is not None else None,
        "counted": w.counted,
        "expected": w.expected,
        "partial": w.partial,
        "since_ms": round(w.since) if w.since is not None else None,
        "latest_at_ms": round(w.latest_at) if w.latest_at is not None else None,
        "missing": [m["bot"] for m in w.missing],
        "restarts": {b.bot: b.restarts for b in w.bots},
        "per_bot": {b.bot: float(b.change) for b in w.bots},
        "gaps": w.gaps,
    }


@pytest.mark.parametrize(
    ("name", "case"),
    list(zip(("day", "week", "month", "all"), FIXTURE["cases"])),
    ids=lambda v: v if isinstance(v, str) else "",
)
def test_golden_windows(store, name, case):
    assert summarize(window(store, name)) == case["expected"], case["name"]


def test_exact_decimals_and_reason_codes(store):
    day = window(store, "day")
    assert (
        day.total == Decimal("10")
        and day.realized == Decimal("4.5")
        and day.unrealized == Decimal("5.5")
    )
    assert (
        fleet_pnl.decimal_text(day.total) == "10"
        and fleet_pnl.decimal_text(day.realized) == "4.5"
    )
    assert {m["bot"]: m["reason"] for m in day.missing} == {
        "meridian_v3": fleet_pnl.NEEDS_TWO_SAMPLES,
        "alt_usdt": fleet_pnl.QUOTE_MISMATCH,
        "no_history": fleet_pnl.NO_SAMPLES,
    }
    assert day.quote == "USDC"


def test_restart_is_a_boundary_not_a_delta(store):
    """16 - 15 across the restart would add +1 if it were counted: ok_rsi day is 7, not 8."""
    day = window(store, "day")
    ok = next(b for b in day.bots if b.bot == "ok_rsi")
    assert ok.change == Decimal("7") and ok.restarts == 1 and ok.full is True


def test_backfill_segment_joins_live_rows_without_an_owner_boundary(store):
    week = window(store, "week")
    ok = next(b for b in week.bots if b.bot == "ok_rsi")
    # 8->10, 10->12 are backfill rows; 12->13 crosses backfill/live and still counts; only boot-a1 -> boot-a2 is a restart.
    assert ok.change == Decimal("12") and ok.restarts == 1
    parsed = fleet_pnl.parse_bot_history(
        store.read(SERVER, "ok_rsi", "1W", NOW_S), "ok_rsi", "1W", NOW_MS + 5000
    )
    assert [s.owner for s in parsed.samples] == [0, 0, 0, 0, 0, 1, 1, 1]


def test_without_the_backfill_bridge_the_join_would_be_a_restart(store):
    payload = json.loads(json.dumps(FIXTURE["reads"]["ok_rsi"]["1W"]))
    for point in payload["points"]:
        point["segment"] = point["segment"].replace("backfill-", "plain-")
    parsed = fleet_pnl.parse_bot_history(payload, "ok_rsi", "1W", NOW_MS + 5000)
    assert [s.owner for s in parsed.samples] == [0, 0, 0, 1, 1, 2, 2, 2]


def test_partial_windows_say_where_history_starts(store):
    day, week = window(store, "day"), window(store, "week")
    assert day.partial and day.full_bots == 1 and week.partial and week.full_bots == 0
    assert day.since == NOW_MS - 1439 * 60_000 and week.since == NOW_MS - 40 * 3600_000
    all_ = window(store, "all")
    assert (
        all_.full_bots == 1 and all_.partial
    )  # ok_rsi opens the window, rsi_modular_v2 does not


def test_staleness_follows_the_newest_sample(store):
    later = NOW_MS + 10 * 60_000  # ten minutes on, nothing new was stored
    w = fleet_pnl.compute_windows(
        {r: histories(store, r, later) for r in RANGES}, BOTS, later
    )["day"]
    assert w.stale is True
    assert window(store, "day").stale is False


@pytest.mark.parametrize(
    "mutate",
    [
        lambda p: p.update(source="somebody_else"),
        lambda p: p.update(bot_name="other"),
        lambda p: p.update(range="1W"),
        lambda p: p.update(bucket_seconds=7),
        lambda p: p["points"][1].update(total_pnl_quote="NaN"),
        lambda p: p["points"][1].update(
            total_pnl_quote="999"
        ),  # total != realized + unrealized
        lambda p: p["points"][1].update(quote="usdc"),
        lambda p: p["points"][1].update(quote="USDT"),  # mixed quotes in one read
        lambda p: p["points"][1].update(
            timestamp=p["points"][0]["timestamp"]
        ),  # not strictly increasing
        lambda p: p["points"][-1].update(
            timestamp=NOW_S + 3600
        ),  # a sample from the future
        lambda p: p["points"][1].update(identity=""),
    ],
)
def test_invalid_reads_are_rejected_whole(mutate):
    payload = json.loads(json.dumps(FIXTURE["reads"]["ok_rsi"]["1D"]))
    mutate(payload)
    parsed = fleet_pnl.parse_bot_history(payload, "ok_rsi", "1D", NOW_MS + 5000)
    assert parsed.samples == [] and parsed.reason == fleet_pnl.HISTORY_INVALID


def _numeric_history(first, second):
    payload = json.loads(json.dumps(FIXTURE["reads"]["ok_rsi"]["1D"]))
    payload["points"] = payload["points"][:2]
    for point, text in zip(payload["points"], (first, second)):
        point["total_pnl_quote"] = text
        point["realized_pnl_quote"] = text
        point["unrealized_pnl_quote"] = "0"
    return payload


@pytest.mark.parametrize(
    "bad",
    [
        "1_000",
        " 1 ",
        "1\n",
        "1\r",
        "1\r\n",
        "0x10",
        "１２",
        "١",
        "1e1000000",
        "1e-1000000",
    ],
)
def test_numeric_history_rejects_non_ascii_or_unrepresentable_amounts(bad):
    parsed = fleet_pnl.parse_bot_history(
        _numeric_history("0", bad), "ok_rsi", "1D", NOW_MS + 5000
    )
    assert parsed.samples == [] and parsed.reason == fleet_pnl.HISTORY_INVALID


def test_numeric_history_rejects_context_overflow_without_throwing():
    payload = _numeric_history("0", "1e1000000")
    payload["points"][1]["realized_pnl_quote"] = "0"
    parsed = fleet_pnl.parse_bot_history(payload, "ok_rsi", "1D", NOW_MS + 5000)
    assert parsed.samples == [] and parsed.reason == fleet_pnl.HISTORY_INVALID


def test_owner_amounts_and_derived_results_share_mobile_significant_digit_limit():
    assert fleet_pnl._amount("9" * 38) is not None
    assert fleet_pnl._amount("9" * 39) is None
    assert fleet_pnl._amount("1e127") is not None
    assert fleet_pnl._amount("9" * 38 + "0" * 90) is not None
    assert fleet_pnl.exact_sum([Decimal("9" * 38), Decimal("2")]) is None
    parsed = fleet_pnl.parse_bot_history(
        _numeric_history("0", "9" * 39), "ok_rsi", "1D", NOW_MS + 5000
    )
    assert parsed.samples == [] and parsed.reason == fleet_pnl.HISTORY_INVALID


def test_exact_server_deltas_and_fleet_sum_do_not_round_away_small_peer():
    first = fleet_pnl.parse_bot_history(
        _numeric_history("1e30", "1000000000000000000000000000001"),
        "ok_rsi",
        "1D",
        NOW_MS + 5000,
    )
    second = fleet_pnl.parse_bot_history(
        _numeric_history("0", "1e30"),
        "ok_rsi",
        "1D",
        NOW_MS + 5000,
    )
    second.bot = "peer"
    window = fleet_pnl.fleet_window(
        [first, second], ["ok_rsi", "peer"], 0, NOW_MS, NOW_MS
    )
    assert window.total == Decimal("1000000000000000000000000000001")
    assert fleet_pnl.decimal_text(window.total) == "1000000000000000000000000000001"


def test_numeric_window_rejects_unrepresentable_derived_delta_with_reason():
    parsed = fleet_pnl.parse_bot_history(
        _numeric_history("-" + "9" * 38 + "0" * 89, "9" * 38 + "0" * 90), "ok_rsi", "1D", NOW_MS + 5000
    )
    window = fleet_pnl.fleet_window([parsed], ["ok_rsi"], 0, NOW_MS, NOW_MS)
    assert window.total is None and window.counted == 0
    assert window.missing == [
        {"bot": "ok_rsi", "reason": fleet_pnl.HISTORY_INVALID, "samples": 2}
    ]


def test_extreme_zero_exponent_does_not_expand_arithmetic_context():
    zero = fleet_pnl._amount("0e-" + "9" * 240)
    assert zero is not None and fleet_pnl.decimal_text(zero) == "0"
    assert fleet_pnl.exact_sum([zero, Decimal("1")]) == 1


def test_boundary_width_equal_components_can_cancel_without_false_rejection():
    parsed = fleet_pnl.parse_bot_history(
        _numeric_history("9" * 38 + "0" * 90, "9" * 38 + "0" * 90), "ok_rsi", "1D", NOW_MS + 5000
    )
    assert len(parsed.samples) == 2
    assert fleet_pnl.fleet_window([parsed], ["ok_rsi"], 0, NOW_MS, NOW_MS).total == 0


@pytest.mark.parametrize("sign", ("", "-"))
def test_balance_tolerance_uses_exact_decimal_beyond_default_context(sign):
    payload = _numeric_history(
        "0", f"{sign}0.000001{'0' * 35}1"
    )
    payload["points"][1]["realized_pnl_quote"] = "0"
    invalid = fleet_pnl.parse_bot_history(payload, "ok_rsi", "1D", NOW_MS + 5000)
    assert invalid.samples == [] and invalid.reason == fleet_pnl.HISTORY_INVALID
    payload["points"][1]["total_pnl_quote"] = f"{sign}0.000001"
    valid = fleet_pnl.parse_bot_history(payload, "ok_rsi", "1D", NOW_MS + 5000)
    assert len(valid.samples) == 2


def test_failed_missing_and_empty_reads_carry_their_own_code():
    assert (
        fleet_pnl.parse_bot_history(None, "b", "1D", NOW_MS, failed=True).reason
        == fleet_pnl.HISTORY_READ_FAILED
    )
    assert (
        fleet_pnl.parse_bot_history(None, "b", "1D", NOW_MS).reason
        == fleet_pnl.NOT_READ
    )
    empty = json.loads(json.dumps(FIXTURE["reads"]["no_history"]["1D"]))
    assert (
        fleet_pnl.parse_bot_history(empty, "no_history", "1D", NOW_MS).reason
        == fleet_pnl.NO_SAMPLES
    )
    w = fleet_pnl.fleet_window([], ["a"], 0, NOW_MS, NOW_MS)
    assert (
        w.total is None
        and w.missing == [{"bot": "a", "reason": fleet_pnl.NOT_READ}]
        and w.counted == 0
    )


def test_window_payload_is_plain_and_lists_missing_bots(store):
    payload = fleet_pnl.window_payload(
        window(store, "day"), span_ms=86_400_000, detail=True
    )
    assert (
        payload["total"] == "10"
        and payload["realized"] == "4.5"
        and payload["unrealized"] == "5.5"
    )
    assert (
        payload["span_ms"] == 86_400_000
        and "to_ms" not in payload
        and "from_ms" not in payload
    )
    assert (
        payload["unit"] == "USDC"
        and payload["counted"] == 2
        and payload["expected"] == 5
        and payload["partial"] is True
    )
    assert [b["bot"] for b in payload["bots"]] == ["ok_rsi", "rsi_modular_v2"]
    assert payload["bots"][0]["change"] == "7" and payload["bots"][0]["restarts"] == 1
    assert {m["bot"] for m in payload["missing"]} == {
        "meridian_v3",
        "alt_usdt",
        "no_history",
    }
    compact = fleet_pnl.window_payload(
        window(store, "day"), span_ms=86_400_000, detail=False
    )
    assert "bots" not in compact
    json.dumps(payload, allow_nan=False)


@pytest.mark.parametrize(
    ("value", "text"),
    [
        (Decimal("1E-7"), "0.0000001"),
        (Decimal("-0.000"), "0"),
        (Decimal("12.3400"), "12.34"),
        (Decimal("100"), "100"),
        (Decimal("-2.50"), "-2.5"),
        (None, None),
    ],
)
def test_decimal_text(value, text):
    assert fleet_pnl.decimal_text(value) == text
