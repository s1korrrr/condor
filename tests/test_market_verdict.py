"""Server verdict == browser verdict.

``condor/web/market_verdict.py`` is a port of ``frontend/src/features/market-picture/pulse.mjs``. The shared cases in
``tests/fixtures/fleet_summary/verdict_cases.json`` are replayed here and by
``frontend/test/fleet-summary-parity.test.mjs``; the ``expected`` blocks were produced by the browser implementation
(``FLEET_SUMMARY_WRITE_GOLDEN=1``), so passing here means the two agree to 1e-12.
"""

import json
import math
from pathlib import Path

import pytest

from condor.web import market_verdict as mv

FIXTURES = Path(__file__).parent / "fixtures"
CASES = json.loads((FIXTURES / "fleet_summary" / "verdict_cases.json").read_text())
CUT = 1_800_000_000_000
MINUTE = 60_000
PRESSURE_HORIZONS = ("15", "60", "240", "1440")


def expand_history(spec):
    """The compact history spec of verdict_cases.json as display history points (same expansion as the JS test)."""
    if spec is None:
        return None
    points = []
    for seg in spec:
        for k in range(seg["from_min"], seg["to_min"] - 1, -1):
            pressure = seg["pressure"] + seg.get("step", 0) * (seg["from_min"] - k)
            points.append(
                {
                    "time": CUT - k * MINUTE,
                    "gapBefore": seg.get("gap_first") is True and k == seg["from_min"],
                    "breadth": {
                        h: {"pressure": pressure if h in PRESSURE_HORIZONS else None}
                        for h in mv.HORIZONS
                    },
                }
            )
    return points


def wire_history(spec):
    """The same spec as stored wire rows (decimal strings), for the raw owner-frame path."""
    items = []
    for seg in spec:
        for k in range(seg["from_min"], seg["to_min"] - 1, -1):
            pressure = str(seg["pressure"] + seg.get("step", 0) * (seg["from_min"] - k))
            cutoff = CUT - k * MINUTE
            items.append(
                {
                    "cutoff_ms": cutoff,
                    "available_at_ms": cutoff + 1000,
                    "snapshot_id": "ab" * 32,
                    "gap_before": seg.get("gap_first") is True and k == seg["from_min"],
                    "breadth": {
                        h: {
                            "positive": None,
                            "negative": None,
                            "flat": None,
                            "pressure": pressure if h in PRESSURE_HORIZONS else None,
                        }
                        for h in mv.HORIZONS
                    },
                }
            )
    return items


def assert_same(actual, expected, path="verdict"):
    if isinstance(expected, dict):
        assert sorted(actual) == sorted(
            expected
        ), f"{path}: keys {sorted(actual)} != {sorted(expected)}"
        for key in expected:
            assert_same(actual[key], expected[key], f"{path}.{key}")
    elif isinstance(expected, list):
        assert len(actual) == len(expected), f"{path}: length"
        for index, item in enumerate(expected):
            assert_same(actual[index], item, f"{path}[{index}]")
    elif isinstance(expected, float) and not isinstance(expected, bool):
        assert isinstance(actual, (int, float)) and math.isclose(
            actual, expected, rel_tol=0, abs_tol=1e-12
        ), f"{path}: {actual} != {expected}"
    else:
        assert actual == expected, f"{path}: {actual!r} != {expected!r}"


def run(entry):
    verdict = mv.market_verdict(
        entry["frame"],
        entry["horizon"],
        history=expand_history(entry["history"]),
        smooth=entry.get("smooth", True),
    )
    if verdict is None:
        return None
    verdict = dict(verdict)
    verdict.pop(
        "horizon_label"
    )  # server-only presentation field; the browser derives it separately
    return verdict


@pytest.mark.parametrize("entry", CASES["cases"], ids=lambda entry: entry["name"])
def test_display_frame_cases_match_the_browser(entry):
    assert_same(run(entry), entry["expected"], entry["name"])


def raw_frame(entry):
    raw = json.loads((FIXTURES / entry["fixture"]).read_text())
    for mutation in entry["mutations"]:
        raw["market_metrics"][mutation["metric_id"]]["value"] = mutation["value"]
    return raw


@pytest.mark.parametrize("entry", CASES["raw_cases"], ids=lambda entry: entry["name"])
def test_raw_owner_frame_cases_match_the_browser(entry):
    raw = raw_frame(entry)
    history = (
        mv.history_from_items(wire_history(entry["history"]), raw["cutoff_ms"])
        if entry["history"]
        else None
    )
    verdict = mv.market_verdict(
        mv.frame_from_raw(raw), entry["horizon"], history=history
    )
    if verdict is not None:
        verdict = {k: v for k, v in verdict.items() if k != "horizon_label"}
    assert_same(verdict, entry["expected"], entry["name"])


def test_the_shared_cases_cover_the_rule():
    expected = [entry["expected"] for entry in CASES["cases"]]
    assert len(expected) >= 6 and len(CASES["raw_cases"]) >= 3
    states = {e["state"] if e else None for e in expected}
    assert {"risk-on", "risk-off", "mixed", None} <= states
    held = [e for e in expected if e and e["held"]]
    assert {e["state"] for e in held} == {
        "risk-on",
        "risk-off",
    }, "both hold bands are exercised"
    assert any(e and e["smoothed"] for e in expected) and any(
        e and not e["smoothed"] for e in expected
    )
    # A coverage break must change the outcome compared with the same history without one.
    reset = next(e for e in CASES["cases"] if "coverage break" in e["name"])
    kept = next(
        e
        for e in CASES["cases"]
        if e["name"] == "hysteresis: risk-on is held inside the band"
    )
    assert (
        reset["expected"]["state"] == "mixed" and kept["expected"]["state"] == "risk-on"
    )


def test_thresholds_and_state_machine():
    assert mv.next_verdict_state("mixed", 0.25) == "risk-on"
    assert mv.next_verdict_state("mixed", 0.2499) == "mixed"
    assert mv.next_verdict_state("risk-on", 0.1001) == "risk-on"
    assert mv.next_verdict_state("risk-on", 0.1) == "mixed"
    assert mv.next_verdict_state("risk-off", -0.1001) == "risk-off"
    assert mv.next_verdict_state("risk-off", -0.1) == "mixed"
    assert mv.next_verdict_state("risk-on", -0.25) == "risk-off"


def test_unavailable_inputs_never_invent_a_verdict():
    assert mv.market_verdict(None) is None
    assert (
        mv.market_verdict({"pressure": {}, "distribution": {}, "summary": {}}) is None
    )
    assert (
        mv.implied_move(None, 60) is None
        and mv.implied_move(0, 60) is None
        and mv.implied_move(float("nan"), 60) is None
    )
    assert (
        mv.horizon_label("60") == "1h"
        and mv.horizon_label("10080") == "7d"
        and mv.horizon_label("30") == "30m"
    )


def test_history_adapter_orders_rows_and_drops_rows_after_the_frame():
    rows = [
        {
            "cutoff_ms": 3,
            "gap_before": True,
            "snapshot_id": "b",
            "breadth": {"60": {"pressure": "1.5"}},
        },
        {"cutoff_ms": 1, "snapshot_id": "a", "breadth": {"60": {"pressure": None}}},
        {"cutoff_ms": 99, "snapshot_id": "z", "breadth": {}},
    ]
    points = mv.history_from_items(rows, cutoff_ms=10)
    assert [p["time"] for p in points] == [1, 3]
    assert (
        points[1]["gapBefore"] is True and points[1]["breadth"]["60"]["pressure"] == 1.5
    )
    assert points[0]["breadth"]["60"]["pressure"] is None
