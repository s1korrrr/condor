"""The Python port of Swift ``FleetMarketIndex.build`` (the Live Activity headline).

Unit behaviour here; bit-for-bit agreement with the Swift owner is the parity fixture's job
(``tests/fixtures/fleet_market_index_parity_v1.json``).
"""

import math

import pytest

from condor.push import market_index as mi

T0 = 1_791_878_400  # 2026-10-13T08:00:00Z, minute-aligned


def at(minute: int) -> float:
    return mi.date(T0 + 60 * minute)


def series(
    closes,
    *,
    start=0,
    freshness=None,
    age=None,
    ok=True,
    resp_pair=None,
    resp_bot=None,
    resp_interval=None,
    times=None,
):
    stamps = times if times is not None else [at(start + n) for n in range(len(closes))]
    return mi.Series(
        ok=ok,
        pair=resp_pair,
        bot_name=resp_bot,
        interval=resp_interval,
        candles=tuple(mi.Candle(t, c) for t, c in zip(stamps, closes)),
        freshness_state=freshness,
        source_age_seconds=age,
    )


def source(pair, closes, *, bot="b1", received=None, start=0, **kw):
    received_at = at(len(closes) + start + 1) if received is None else received
    return mi.Input(bot, pair, series(closes, start=start, **kw), 60, received_at)


# --------------------------------------------------------------------------- time and decoding


@pytest.mark.parametrize(
    "raw,seconds",
    [
        ("2026-10-13T08:00:00Z", T0),
        ("2026-10-13T10:00:00+02:00", T0),
        ("2026-10-13T07:30:00-00:30", T0),
        ("2026-10-13T08:00:00.5Z", T0 + 0.5),
        ("2026-10-13T08:00:00.123Z", T0 + 0.123),
        ("2024-02-29T00:00:00Z", 1_709_164_800),
    ],
)
def test_recorded_times_parse_like_swift(raw, seconds):
    assert mi.parse_recorded_time(raw) == mi.date(seconds)


@pytest.mark.parametrize(
    "raw",
    [
        "2026-10-13T08:00:00",
        "2026-10-13 08:00:00",
        "2026-02-30T00:00:00Z",
        "",
        None,
        5,
        "x",
    ],
)
def test_ambiguous_or_invalid_times_are_refused(raw):
    assert mi.parse_recorded_time(raw) is None


def test_times_are_swift_reference_date_doubles():
    assert mi.date(978307200) == 0.0
    assert mi.since1970(mi.date(T0)) == T0


def _candle(stamp="2026-10-13T08:00:00Z", close=1.0):
    return {
        "timestamp": stamp,
        "open_price": close,
        "high_price": close,
        "low_price": close,
        "close_price": close,
    }


def test_decoding_reads_status_coverage_freshness_and_ages():
    decoded = mi.decode_series(
        {
            "status": "ok",
            "pair": "BTC-USDC",
            "bot_name": "b1",
            "interval": "1m",
            "candles": [_candle(close=2), _candle("2026-10-13T08:01:00Z", 3)],
            "event_markers": [
                {"timestamp": "2026-10-13T08:00:30Z", "side": "buy", "price_quote": "x"}
            ],
            "source_age_seconds": 4,
            "coverage": {
                "status": "partial",
                "source_age_seconds": 9,
                "reasons": ["r"],
            },
        }
    )
    assert decoded.ok and decoded.pair == "BTC-USDC" and decoded.is_partial
    assert [c.close for c in decoded.candles] == [2.0, 3.0]
    assert decoded.source_age_seconds == 9.0 and decoded.freshness_state is None
    stale = mi.decode_series({"status": "ok", "coverage": {"status": "Stale"}})
    assert stale.freshness_state == "Stale" and stale.candles == ()
    nested = mi.decode_series(
        {
            "status": "error",
            "coverage": {"freshness_state": "offline"},
            "source_age_seconds": -1,
        }
    )
    assert not nested.ok and nested.freshness_state == "offline"
    assert nested.source_age_seconds is None


@pytest.mark.parametrize(
    "body",
    [
        [],
        {"status": 1},
        {"pair": 5},
        {"candles": {}},
        {"candles": [{**_candle(), "close_price": "1.5"}]},
        {"candles": [{**_candle(), "close_price": None}]},
        {"candles": [{**_candle(), "open_price": True}]},
        {"candles": [_candle(stamp="2026-10-13T08:00:00")]},
        {"event_markers": [{"timestamp": "yesterday"}]},
        {"event_markers": [{"timestamp": "2026-10-13T08:00:00Z", "side": 1}]},
        {"coverage": []},
        {"coverage": {"truncated": 1}},
        {"coverage": {"reasons": [1]}},
        {"source_age_seconds": "3"},
    ],
)
def test_what_swift_cannot_decode_is_rejected_whole(body):
    with pytest.raises(mi.SeriesDecodeError):
        mi.decode_series(body)


# --------------------------------------------------------------------------- build


def test_index_is_base_100_at_the_shared_baseline_and_equal_weighted():
    now = at(10)
    index = mi.build(
        [source("A", [10, 11, 12]), source("B", [20, 20, 30])], ["A", "B"], now
    )
    assert index.baseline_time == at(0) and index.pairs == ("A", "B")
    assert [v for _, v in index.mean] == [
        (100.0 + 100.0) / 2,
        (11 / 10 * 100 + 20 / 20 * 100) / 2,
        (12 / 10 * 100 + 30 / 20 * 100) / 2,
    ]
    assert index.missing_pairs == ()


def test_only_closed_candles_before_the_receipt_count():
    # Received at minute 2 + 59 s: the minute-2 candle had not closed yet.
    late = mi.Input("b1", "A", series([10, 11, 12]), 60, at(2) + 59)
    index = mi.build([late], ["A"], at(10))
    assert [t for t, _ in index.mean] == [at(0), at(1)]
    # The build clock also cuts: now earlier than the receipt.
    index = mi.build([source("A", [10, 11, 12], received=at(10))], ["A"], at(2))
    assert [t for t, _ in index.mean] == [at(0), at(1)]


def test_non_positive_or_non_finite_closes_are_skipped():
    index = mi.build([source("A", [10, 0, -1, math.inf, 20])], ["A"], at(10))
    assert [(t, v) for t, v in index.mean] == [(at(0), 100.0), (at(4), 200.0)]


def test_a_duplicate_time_keeps_the_last_candle():
    s = series([10, 12, 14], times=[at(0), at(1), at(1)])
    index = mi.build([mi.Input("b1", "A", s, 60, at(5))], ["A"], at(5))
    assert [v for _, v in index.mean] == [100.0, 140.0]


def test_the_longest_series_wins_and_ties_keep_the_first_input():
    short = source("A", [10, 20], bot="first")
    long = source("A", [10, 30, 40], bot="second")
    assert mi.build([short, long], ["A"], at(10)).mean[-1][1] == 400.0
    tie_a = source("A", [10, 20, 30], bot="first")
    tie_b = source("A", [10, 50, 60], bot="second")
    assert mi.build([tie_a, tie_b], ["A"], at(10)).mean[-1][1] == 300.0


def test_a_pair_without_a_recent_close_at_the_baseline_is_dropped():
    # B's history starts at minute 5; A's last candle before that is minute 2 (180 s > 90 s).
    a = source("A", [10, 11, 12])
    b = source("B", [20, 21], start=5)
    index = mi.build([a, b], ["A", "B"], at(10))
    assert index.missing_pairs == ("A",) and index.pairs == ("B",)
    assert index.baseline_time == at(5) and index.is_stale(at(10))


def test_the_anchor_is_the_last_close_at_or_before_the_baseline():
    a = source("A", [10, 11, 12, 13])  # minutes 0..3
    b = source("B", [50, 55], start=1)  # minutes 1..2 -> baseline minute 1
    index = mi.build([a, b], ["A", "B"], at(10))
    assert index.baseline_time == at(1)
    assert index.mean[0][1] == 100.0
    assert index.mean[1][1] == (12 / 11 * 100 + 55 / 50 * 100) / 2


def test_the_mean_needs_every_pair_within_the_carry():
    # B has a hole after minute 1: minute 2 is within 1.5 steps of it, minute 3 is not.
    a = source("A", [10, 10, 10, 10, 10, 10])
    b = mi.Input(
        "b1",
        "B",
        series([20, 20, 20, 20], times=[at(0), at(1), at(4), at(5)]),
        60,
        at(7),
    )
    index = mi.build([a, b], ["A", "B"], at(7))
    assert [t for t, _ in index.mean] == [at(0), at(1), at(2), at(4), at(5)]


def test_sums_run_left_to_right_in_requested_pair_order():
    lines = [[(0.0, 0.1)], [(0.0, 0.2)], [(0.0, 0.3)]]
    forward = mi._equal_weight_mean(lines, 90.0)[0][1]
    backward = mi._equal_weight_mean(list(reversed(lines)), 90.0)[0][1]
    assert forward == ((0.1 + 0.2) + 0.3) / 3.0
    assert backward == ((0.3 + 0.2) + 0.1) / 3.0
    assert (
        forward != backward
    )  # order matters in floating point; the Swift order is kept


def test_mismatched_or_unusable_inputs_are_ignored():
    good = source("A", [10, 20])
    for bad in (
        source("A", [10, 50, 60], resp_pair="B"),
        source("A", [10, 50, 60], resp_bot="other"),
        source("A", [10, 50, 60], resp_interval="5m"),
        source("A", [10, 50, 60], ok=False),
        mi.Input("b1", "A", series([10, 50, 60]), 0, at(9)),
        source("Z", [10, 50, 60]),
    ):
        assert mi.build([good, bad], ["A"], at(10)).mean[-1][1] == 200.0


# --------------------------------------------------------------------------- staleness


def test_fresh_index_is_not_stale_and_ages_into_stale():
    a = source("A", [10, 11, 12], received=at(3))
    index = mi.build([a], ["A"], at(3))
    assert index.source_age_seconds(at(3)) == 0.0 and not index.is_stale(at(3))
    assert not index.is_stale(at(3) + 90) and index.is_stale(at(3) + 90.001)


def test_explicit_stale_source_missing_pairs_and_reported_age_make_it_stale():
    assert mi.build(
        [source("A", [10, 11], freshness="Offline", received=at(2))], ["A"], at(2)
    ).is_stale(at(2))
    assert mi.build(
        [source("A", [10, 11], received=at(2))], ["A", "B"], at(2)
    ).is_stale(at(2))
    reported = mi.build([source("A", [10, 11], age=91, received=at(2))], ["A"], at(2))
    assert reported.source_age_seconds(at(2)) == 91.0 and reported.is_stale(at(2))
    old_receipt = mi.build([source("A", [10, 11], received=at(2))], ["A"], at(4))
    assert old_receipt.source_age_seconds(at(4)) == 120.0 and old_receipt.is_stale(
        at(4)
    )


def test_nothing_usable_gives_an_empty_stale_index():
    index = mi.build([source("A", [0, -1])], ["A", "", "A"], at(5))
    assert (
        index.mean == () and index.missing_pairs == ("A",) and index.requested == ("A",)
    )
    assert index.is_stale(at(5)) and mi.headline(index, at(5)) is None


# --------------------------------------------------------------------------- headline


def test_headline_is_the_last_mean_point_with_a_half_hour_spark():
    # 1D of minutes for two pairs: A climbs, B flat.
    minutes = 24 * 60 - 1
    a = source("A", [100 + n * 0.001 for n in range(minutes)], received=at(minutes))
    b = source("B", [50.0] * minutes, received=at(minutes))
    index = mi.build([a, b], ["A", "B"], at(minutes))
    head = mi.headline(index, at(minutes))
    last = index.mean[-1][1]
    assert head["value"] == "%.2f" % mi.two_places(last)
    assert head["change_pct"] == "%.2f" % mi.two_places(last - 100)
    assert head["stale"] is False and (head["pairs"], head["expected"]) == (2, 2)
    assert head["as_of_ms"] == (T0 + 60 * (minutes - 1)) * 1000
    buckets = {}
    for time, value in index.mean:  # T0 is on a half-hour boundary
        buckets[int((mi.since1970(time) - T0) // 1800)] = value
    assert len(buckets) == 48
    assert head["spark"] == [mi.two_places(buckets[k]) for k in sorted(buckets)]
    assert head["spark"][-1] == float(head["value"])


@pytest.mark.parametrize(
    "value,rounded,printed",
    [
        (0.125, 0.13, "0.13"),  # 12.5 exactly: away from zero
        (-0.125, -0.13, "-0.13"),
        (-0.001, 0.0, "0.00"),  # never "-0.00"
        (99.994, 99.99, "99.99"),
        (101.0, 101.0, "101.00"),
    ],
)
def test_two_places_rounds_half_away_from_zero_like_swift(value, rounded, printed):
    assert mi.two_places(value) == rounded and mi.text(value) == printed


def test_change_is_from_the_unrounded_latest_value():
    index = mi.Index(
        mean=((at(0), 100.0), (at(1), 98.12337624756607)),
        baseline_time=at(0),
        pairs=("A",),
        requested=("A",),
        missing_pairs=(),
        interval_seconds=60,
        latest_closed_time=at(2),
        oldest_receipt_time=at(2),
        reported_source_age_seconds=None,
        has_explicit_stale_source=False,
        built_at=at(2),
    )
    head = mi.headline(index, at(2))
    assert (head["value"], head["change_pct"]) == ("98.12", "-1.88")


# --------------------------------------------------------------------------- server-side reads

import asyncio  # noqa: E402
import json  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

import httpx  # noqa: E402

from condor.web import live_activity_market as market  # noqa: E402
from condor.web.routes import trading_visuals  # noqa: E402

SERVER = "rsibot-stack-v2"
NOW = T0 + 11 * 60


def iso(minute: int) -> str:
    stamp = datetime.fromtimestamp(T0 + 60 * minute, timezone.utc)
    return stamp.strftime("%Y-%m-%dT%H:%M:%SZ")


class Reporting:
    """A reporting backend: composite pages and pair series per bot, with request accounting."""

    def __init__(self, membership):
        self.membership = membership  # bot -> pairs
        self.requests = []
        self.fail = set()  # ("membership", bot) or (bot, pair)
        self.raw = {}  # (bot, pair) -> body text
        self.delay = 0.0
        self.in_flight = self.max_in_flight = 0

    async def handler(self, request: httpx.Request) -> httpx.Response:
        params = dict(request.url.params)
        self.requests.append(params)
        self.in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self.in_flight)
        try:
            await asyncio.sleep(self.delay or 0.001)
        finally:
            self.in_flight -= 1
        bot = params["bot"]
        if "chart_mode" in params:
            if ("membership", bot) in self.fail:
                return httpx.Response(503)
            pairs = self.membership[bot]
            return httpx.Response(
                200,
                json={
                    "chart_mode": "composite_rsi_v5",
                    "bot_name": bot,
                    "coverage": {"expected_pairs": pairs[:1]},
                    "component_pairs": pairs,
                },
            )
        pair = params["pair"]
        if (bot, pair) in self.fail:
            return httpx.Response(500)
        if (bot, pair) in self.raw:
            return httpx.Response(200, content=self.raw[(bot, pair)])
        base = {"A": 10.0, "B": 20.0, "C": 40.0}[pair]
        return httpx.Response(
            200,
            json={
                "status": "ok",
                "pair": pair,
                "bot_name": bot,
                "interval": "1m",
                "candles": [_candle(iso(m), base * (1 + m / 100)) for m in range(10)],
            },
        )


@pytest.fixture
def reporting(monkeypatch):
    market._membership.clear()
    market._published.clear()
    backend = Reporting({"b1": ["A", "B"], "b2": ["B", "C"]})
    sources = {
        "b1": {"server": SERVER, "url": "http://127.0.0.1:9101/api/v1"},
        "b2": {"server": SERVER, "url": "http://127.0.0.1:9102/api/v1"},
        "elsewhere": {"server": "other", "url": "http://127.0.0.1:9103/api/v1"},
    }
    monkeypatch.setattr(trading_visuals, "_sources", lambda: sources)
    monkeypatch.setattr(
        trading_visuals,
        "_client",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(backend.handler)),
    )
    backend.clock = [float(NOW)]
    return backend


def build_now(reporting):
    return asyncio.run(
        market.build_market_index(SERVER, clock=lambda: reporting.clock[0])
    )


def test_reads_membership_then_every_pair_like_the_app(reporting):
    head = build_now(reporting)
    composite = [r for r in reporting.requests if "chart_mode" in r]
    pairs = [r for r in reporting.requests if "pair" in r]
    assert sorted(r["bot"] for r in composite) == [
        "b1",
        "b2",
    ]  # not the other server's bot
    assert all(
        r["time_range"] == "1d"
        and r["interval"] == "1m"
        and r["chart_mode"] == "composite_rsi_v5"
        for r in composite
    )
    assert [(r["bot"], r["pair"]) for r in pairs] == [
        ("b1", "A"),
        ("b1", "B"),
        ("b2", "B"),
        ("b2", "C"),
    ]
    assert all(
        (r["time_range"], r["interval"], r["compact"], r["projection"])
        == ("1d", "1m", "false", "ohlc")
        for r in pairs
    )
    assert 1 < reporting.max_in_flight <= 4
    # All three pairs rose 9 % over the window: the index is at 109.
    assert head["value"] == "109.00" and head["change_pct"] == "9.00"
    assert (head["pairs"], head["expected"], head["stale"]) == (3, 3, False)
    assert head["as_of_ms"] == (T0 + 9 * 60) * 1000
    assert head["source_age_at_ms"] == int(reporting.clock[0] * 1000)


def test_membership_is_cached_for_an_hour(reporting):
    build_now(reporting)
    reporting.requests.clear()
    reporting.clock[0] = NOW + 3599
    old = build_now(reporting)
    assert not [r for r in reporting.requests if "chart_mode" in r]
    assert old["stale"] is True  # the same candles an hour later: built, but stale
    reporting.requests.clear()
    reporting.clock[0] = NOW + 3601
    build_now(reporting)
    assert len([r for r in reporting.requests if "chart_mode" in r]) == 2


def test_a_failed_pair_read_leaves_the_pair_missing_and_the_index_stale(reporting):
    reporting.fail = {("b2", "C")}
    head = build_now(reporting)
    assert (head["pairs"], head["expected"], head["stale"]) == (2, 3, True)


def test_a_bot_without_membership_adds_no_pairs(reporting):
    reporting.fail = {("membership", "b2")}
    head = build_now(reporting)
    assert (head["pairs"], head["expected"], head["stale"]) == (2, 2, False)


def test_a_body_swift_would_reject_is_no_input(reporting):
    good = json.dumps(
        {
            "status": "ok",
            "pair": "C",
            "bot_name": "b2",
            "interval": "1m",
            "candles": [_candle(iso(m), 40.0) for m in range(10)],
        }
    )
    reporting.raw[("b2", "C")] = good.replace(
        '"close_price": 40.0', '"close_price": NaN', 1
    )
    head = build_now(reporting)
    assert (head["pairs"], head["expected"]) == (2, 3)
    reporting.raw[("b2", "C")] = json.dumps(
        {"status": "ok", "pair": "X", "candles": []}
    )
    assert build_now(reporting)["pairs"] == 2  # identity mismatch is refused too


@pytest.mark.parametrize("case", ["no sources", "no data", "deadline"])
def test_unbuildable_indexes_raise_instead_of_inventing_one(
    reporting, monkeypatch, case
):
    if case == "no sources":
        monkeypatch.setattr(trading_visuals, "_sources", lambda: {})
    elif case == "no data":
        reporting.fail = {("b1", "A"), ("b1", "B"), ("b2", "B"), ("b2", "C")}
    else:
        monkeypatch.setattr(market, "INDEX_TIMEOUT_SECONDS", 0.05)
        reporting.delay = 1.0
    with pytest.raises(market.MarketIndexUnavailable):
        build_now(reporting)


def _stored(as_of_s, *, stale=False, source_age_ms=30_000):
    stored = {
        "value": "101.23",
        "change_pct": "1.23",
        "stale": stale,
        "spark": [101.23],
        "pairs": 3,
        "expected": 3,
        "as_of_ms": int(as_of_s * 1000),
    }
    if source_age_ms is not None:
        stored["source_age_ms"] = source_age_ms
    return stored


@pytest.mark.parametrize(
    "as_of_age,published_ago,source_age_ms,reused,stale",
    [
        (60, 0, 30_000, True, False),  # just built
        (
            179,
            119,
            30_000,
            True,
            False,
        ),  # 149 s old now: within the 300 s headline rule
        (100, 40, 260_000, True, False),  # exactly 300 s: not above it
        (100, 41, 260_000, True, True),  # 301 s
        (100, 40, None, True, True),  # unknown age is stale
        (180, 0, 30_000, False, None),  # too old to stand in for a failed pass
    ],
)
def test_a_failed_pass_reuses_the_last_good_index_for_180_s(
    as_of_age, published_ago, source_age_ms, reused, stale
):
    market._published.clear()
    stored = _stored(NOW - as_of_age, source_age_ms=source_age_ms)
    market.remember_index(SERVER, stored, now=NOW - published_ago)
    got = market.reusable_index(SERVER, now=NOW)
    assert (got is not None) is reused
    if reused:
        assert got["stale"] is stale and got["value"] == "101.23"
        assert (
            got.get("source_age_ms") == source_age_ms
        )  # the build-time age, unchanged
    assert market.reusable_index("other", now=NOW) is None


def test_a_stale_index_stays_stale_when_reused():
    market._published.clear()
    market.remember_index(SERVER, _stored(NOW - 60, stale=True), now=NOW)
    assert market.reusable_index(SERVER, now=NOW)["stale"] is True


def test_the_route_serves_only_a_recently_published_index():
    market._published.clear()
    assert market.published_index(SERVER, max_age_seconds=120, now=NOW) is None
    stored = _stored(NOW - 70, source_age_ms=250_000)
    market.remember_index(SERVER, stored, now=NOW - 10)
    assert (
        market.published_index(SERVER, max_age_seconds=120, now=NOW)["stale"] is False
    )
    late = market.published_index(SERVER, max_age_seconds=120, now=NOW + 100)
    assert late["stale"] is True  # 250 s at build + 110 s since: above 300 s
    assert market.published_index(SERVER, max_age_seconds=120, now=NOW + 111) is None


def test_the_route_side_never_builds():
    assert not hasattr(market, "market_index_for")
    assert not hasattr(market, "_locks")


# --------------------------------------------------------------------------- parity with Swift

PARITY = json.loads(
    (
        __import__("pathlib").Path(__file__).parent
        / "fixtures"
        / "fleet_market_index_parity_v1.json"
    ).read_text()
)


def test_the_parity_fixture_is_the_swift_generated_v1():
    assert PARITY["schema"] == "fleet_market_index_parity.v1"
    assert "never edited by hand" in PARITY["generated_by"]
    assert [case["name"] for case in PARITY["cases"]][0] == "live"


@pytest.mark.parametrize("case", PARITY["cases"], ids=lambda case: case["name"])
def test_the_port_matches_swift_on_the_parity_fixture(case):
    inputs = [
        mi.Input(
            item["bot"],
            item["pair"],
            mi.decode_series(item["series"]),
            item["interval_seconds"],
            mi.date(item["received_at_ms"] / 1000),
        )
        for item in case["inputs"]
    ]
    now = mi.date(case["now_ms"] / 1000)
    index = mi.build(inputs, case["expected_pairs"], now)
    expected = case["expected"]
    assert mi.milliseconds(index.baseline_time) == expected["baseline_ms"]
    assert list(index.missing_pairs) == expected["missing_pairs"]
    assert mi.headline_is_stale(index, now) is expected["stale"]
    assert len(index.mean) == len(expected["mean"])
    for (time, value), (want_ms, want) in zip(index.mean, expected["mean"]):
        assert mi.milliseconds(time) == want_ms
        assert abs(value - want) <= 1e-12, (want_ms, value, want)
    assert abs(index.mean[-1][1] - expected["latest"]) <= 1e-12
    head = mi.headline(index, now)
    assert head["value"] == expected["value"]
    assert head["change_pct"] == expected["change_pct"]
    assert head["as_of_ms"] == expected["as_of_ms"]
    assert head["pairs"] == expected["pairs"]
    assert head["spark"] == expected["spark"]
    assert head["stale"] is expected["stale"]
    assert head.get("source_age_ms") == expected.get("source_age_ms")


def test_only_the_headline_tolerates_a_minute_cadence():
    """The headline's 300 s rule is looser than the Market tab's 1.5-interval rule, which stays."""
    cases = {case["name"]: case for case in PARITY["cases"]}
    for name, headline_stale in (
        ("age_only_fresh_200s", False),
        ("age_only_stale_400s", True),
    ):
        case = cases[name]
        now = mi.date(case["now_ms"] / 1000)
        index = mi.build(
            [
                mi.Input(
                    item["bot"],
                    item["pair"],
                    mi.decode_series(item["series"]),
                    item["interval_seconds"],
                    mi.date(item["received_at_ms"] / 1000),
                )
                for item in case["inputs"]
            ],
            case["expected_pairs"],
            now,
        )
        assert mi.headline_is_stale(index, now) is headline_stale
        assert index.is_stale(now)
