"""Dated paper valuations retain observation time across heartbeats."""

import json
from pathlib import Path

import pytest

from condor.paper_performance import project_paper
from condor.performance_history import PerformanceHistory
from tests.test_paper_performance import BOT, NOW, iso, runtime


def test_retained_valuation_uses_observation_time_and_duplicates_do_not_split(tmp_path):
    store = PerformanceHistory(tmp_path / "history.sqlite3")
    body = runtime(at=NOW - 5)
    body["runtime_status"]["summary"].update(
        pnl_basis="retained_marks", pnl_observed_at=iso(NOW - 50)
    )
    point = project_paper(body, BOT, NOW)
    assert point["timestamp"] == NOW - 50
    store.record_paper("v2", {BOT: point}, NOW)
    # A new heartbeat carries the same observed valuation. It adds no artificial point.
    body["runtime_status"]["updated_at"] = iso(NOW)
    repeated = project_paper(body, BOT, NOW + 1)
    assert repeated["timestamp"] == point["timestamp"]
    store.record_paper("v2", {BOT: repeated}, NOW + 1)
    body["runtime_status"]["summary"]["pnl_observed_at"] = iso(NOW + 10)
    advanced = project_paper(body, BOT, NOW + 11)
    store.record_paper("v2", {BOT: advanced}, NOW + 11)
    points = store.read("v2", BOT, "1D", NOW + 11)["points"]
    assert len(points) == 2
    assert len({p["segment"] for p in points}) == 1


@pytest.mark.parametrize(
    "observed",
    ["", "not-a-date", 123, iso(NOW - 120), iso(NOW + 6), "2026-10-29T12:00:00"],
)
def test_bad_valuation_time_cannot_fall_back_to_fresh_heartbeat(observed):
    body = runtime(at=NOW)
    body["runtime_status"]["summary"].update(
        pnl_basis="retained_marks", pnl_observed_at=observed
    )
    with pytest.raises(ValueError):
        project_paper(body, BOT, NOW)


def test_retained_basis_requires_valuation_time():
    body = runtime(at=NOW)
    body["runtime_status"]["summary"]["pnl_basis"] = "retained_marks"
    with pytest.raises(ValueError, match="observation time is missing"):
        project_paper(body, BOT, NOW)


def test_explicit_native_valuation_time_is_also_used():
    body = runtime()
    body["runtime_status"]["summary"].update(
        pnl_basis="native_paper_controller_performance", pnl_observed_at=iso(NOW - 20)
    )
    assert project_paper(body, BOT, NOW)["timestamp"] == NOW - 20


@pytest.mark.parametrize("bot", ["meridian_v4_paper", "meridian_v4_d2h_paper"])
def test_captured_quiet_runtime_projection_records_the_retained_time(bot):
    path = Path(__file__).parent / "fixtures" / "paper_quiet_20261029" / f"{bot}.json"
    body = json.loads(path.read_text())
    source = body["_fixture_source"]
    point = project_paper(body, bot, source["status_timestamp"] + 0.1)
    assert point["timestamp"] == source["retained_observed_at"]
    assert point["quote"] == "USDC"
    assert body["runtime_status"]["ready"] is False
    assert body["runtime_status"]["native_reports_complete"] is False
