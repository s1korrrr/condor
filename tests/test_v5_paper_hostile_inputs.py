"""Hostile paper status inputs (independent re-review of PR #77): parent/final-component races, descriptor
leaks, unrepresentable JSON numbers, malformed native sides and search-only parents. Every case must give an
unavailable source or a 200 read, never a redirected read or an HTTP 500."""
import errno
import json
import os
from pathlib import Path

import pytest
from test_v5_paper_binding import (
    BOT,
    NOW,
    SERVER,
    ReviewUpstream,
    client_for,
    observe,
    status,
    write_status,
)

from condor.v5 import paper
from condor.v5.dashboard import read_compatibility_path


@pytest.mark.parametrize("timing", ["directory", "file"])
def test_parent_swap_cannot_redirect_to_outside(tmp_path, monkeypatch, timing):
    path = write_status(tmp_path, status())
    mounted = path.parent
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / path.name).write_text(json.dumps(status(controller_kind="OUTSIDE")))
    original_open = os.open
    swapped = False

    def racing_open(target, flags, *args, **kwargs):
        nonlocal swapped
        trigger = mounted.name if timing == "directory" else path.name
        if target == trigger and not swapped:
            swapped = True
            mounted.rename(tmp_path / "old-mounted")
            mounted.symlink_to(outside, target_is_directory=True)
        return original_open(target, flags, *args, **kwargs)

    monkeypatch.setattr(paper.os, "open", racing_open)
    result = paper.read_paper_status(path, now=NOW)
    assert swapped
    if timing == "directory":
        assert result.state == "UNAVAILABLE"
    else:
        assert result.state == "FRESH"
        assert result.status["controller_kind"] != "OUTSIDE"


@pytest.mark.parametrize("replacement", ["symlink", "fifo"])
def test_final_component_race_is_refused(tmp_path, monkeypatch, replacement):
    path = write_status(tmp_path, status())
    outside = tmp_path / "outside.status.json"
    outside.write_text(path.read_text())
    original_open = os.open
    swapped = False

    def racing_open(target, flags, *args, **kwargs):
        nonlocal swapped
        if target == path.name and not swapped:
            swapped = True
            path.unlink()
            if replacement == "symlink":
                path.symlink_to(outside)
            else:
                os.mkfifo(path)
        return original_open(target, flags, *args, **kwargs)

    monkeypatch.setattr(paper.os, "open", racing_open)
    result = paper.read_paper_status(path, now=NOW)
    assert swapped
    assert result.state == "UNAVAILABLE"


@pytest.mark.parametrize("denied", ["directory", "file"])
def test_permissions_and_repeated_opens_do_not_leak_descriptors(
    tmp_path, monkeypatch, denied
):
    path = write_status(tmp_path, status())
    original_open = os.open
    baseline = len(os.listdir("/proc/self/fd"))
    for _ in range(100):
        assert paper.read_paper_status(path, now=NOW).state == "FRESH"
    trigger = path.parent.name if denied == "directory" else path.name

    def forbidden_open(target, flags, *args, **kwargs):
        if target == trigger:
            raise PermissionError(errno.EACCES, "review permission fixture")
        return original_open(target, flags, *args, **kwargs)

    monkeypatch.setattr(paper.os, "open", forbidden_open)
    for _ in range(100):
        assert paper.read_paper_status(path, now=NOW).state == "UNAVAILABLE"
    assert len(os.listdir("/proc/self/fd")) == baseline


@pytest.mark.parametrize("field", ["generated_at", "report_observed_at"])
def test_unbounded_integer_time_is_unavailable(tmp_path, field):
    payload = status()
    payload[field] = 10**400
    path = write_status(tmp_path, payload)
    assert paper.read_paper_status(path, now=NOW).state == "UNAVAILABLE"


def test_unbounded_integer_time_does_not_break_dashboard_profile(tmp_path):
    payload = status()
    payload["generated_at"] = 10**400
    with client_for(tmp_path, ReviewUpstream(False), payload=payload) as client:
        client._transport.raise_server_exceptions = False
        response = client.get("/api/v5/dashboard/profile")
    assert response.status_code == 200, (response.status_code, response.text)
    assert response.json()["readiness"]["paper_owner"]["state"] == "UNAVAILABLE"


def test_missing_one_controller_report_withholds_whole_bot_counters(tmp_path):
    payload = status()
    missing = payload["controllers"][0]["id"]
    del payload["native_reports"][missing]
    response = read_compatibility_path(
        f"/api/v1/trading-visuals/bootstrap?bot={BOT}", observe(tmp_path, payload)
    )
    runtime = response["runtime_status"]
    assert runtime["active_executors"] is None
    assert runtime["positions_held"] is None
    assert any(
        row["observation_status"] == "available" for row in runtime["controllers"]
    )
    assert any(
        row["observation_status"] == "unavailable" for row in runtime["controllers"]
    )


def test_finite_components_overflowing_total_are_withheld(tmp_path):
    payload = status()
    for report in payload["native_reports"].values():
        report["performance"]["global_pnl_quote"] = "1e308"
    response = read_compatibility_path(
        f"/api/v1/servers/{SERVER}/bots", observe(tmp_path, payload)
    )
    assert response["metrics_available"] is False
    assert response["total_pnl"] is None


def test_unhashable_native_side_does_not_break_bootstrap(tmp_path):
    payload = status()
    for report in payload["native_reports"].values():
        report["executors"][0]["config"]["side"] = []
    with client_for(tmp_path, ReviewUpstream(False), payload=payload) as client:
        client._transport.raise_server_exceptions = False
        response = client.get(
            "/api/v5/dashboard/read",
            params={"path": f"/api/v1/trading-visuals/bootstrap?bot={BOT}"},
        )
    assert response.status_code == 200, (response.status_code, response.text)


def test_json_exponent_overflow_does_not_break_paper_owner(tmp_path):
    payload = status()
    payload["simulation_assumptions"]["book_depth"] = "EXPONENT_FIXTURE"
    with client_for(tmp_path, ReviewUpstream(False), payload=payload) as client:
        path = tmp_path / "runtime_status" / f"{BOT}.status.json"
        assert path.exists()
        path.write_text(path.read_text().replace('"EXPONENT_FIXTURE"', "1e999"))
        client._transport.raise_server_exceptions = False
        response = client.get("/api/v5/dashboard/profile")
    assert response.status_code == 200, (response.status_code, response.text)


def test_searchable_but_unlistable_parent_is_a_readable_source(tmp_path):
    path = write_status(tmp_path, status())
    path.parent.chmod(0o100)
    try:
        assert path.read_bytes()
        result = paper.read_paper_status(path, now=NOW)
        assert result.state == "FRESH", result.reason
    finally:
        path.parent.chmod(0o700)


@pytest.mark.parametrize("spelling", ["relative", "parent", "odd"])
def test_component_walk_path_spellings(tmp_path, spelling):
    if spelling == "odd":
        nested = tmp_path / "odd parent" / "żółć..dir"
        nested.mkdir(parents=True)
        path = write_status(nested, status())
        assert paper.read_paper_status(path, now=NOW).state == "FRESH"
    else:
        path = write_status(tmp_path, status())
        requested = (
            Path(os.path.relpath(path))
            if spelling == "relative"
            else path.parent / ".." / path.parent.name / path.name
        )
        assert paper.read_paper_status(requested, now=NOW).state == "UNAVAILABLE"
