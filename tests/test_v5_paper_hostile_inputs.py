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
    payload["unavailable_controller_ids"] = [missing]  # as the runtime writes it
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


def test_condor_deep_json_is_unavailable_not_http_500(tmp_path):
    with client_for(tmp_path, ReviewUpstream(False), payload=status()) as client:
        path = tmp_path / "runtime_status" / f"{BOT}.status.json"
        document = path.read_text().rstrip()
        path.write_text(
            document[:-1] + ',"review_probe":' + "[" * 12000 + "0" + "]" * 12000 + "}"
        )
        assert path.stat().st_size < paper.MAX_STATUS_BYTES
        client._transport.raise_server_exceptions = False
        response = client.get("/api/v5/dashboard/profile")
    assert response.status_code == 200, (response.status_code, response.text)
    assert response.json()["readiness"]["paper_owner"]["state"] == "UNAVAILABLE"


def test_condor_deep_custom_info_is_unavailable_not_http_500(tmp_path):
    payload = status()
    payload["controllers"][0]["custom_info"]["review_probe"] = "DEEP_FIXTURE"
    with client_for(tmp_path, ReviewUpstream(False), payload=payload) as client:
        path = tmp_path / "runtime_status" / f"{BOT}.status.json"
        path.write_text(
            path.read_text().replace('"DEEP_FIXTURE"', "[" * 1500 + "0" + "]" * 1500)
        )
        assert path.stat().st_size < paper.MAX_STATUS_BYTES
        client._transport.raise_server_exceptions = False
        response = client.get(
            "/api/v5/dashboard/read",
            params={"path": f"/api/v1/trading-visuals/bootstrap?bot={BOT}"},
        )
    # The malformed status makes the bound bot unavailable (503), never an encoder crash (500).
    assert response.status_code == 503, (response.status_code, response.text)


@pytest.mark.parametrize("operation", ["fstat", "read"])
def test_condor_io_fault_is_unavailable_not_http_500(tmp_path, monkeypatch, operation):
    with client_for(tmp_path, ReviewUpstream(False), payload=status()) as client:
        path = tmp_path / "runtime_status" / f"{BOT}.status.json"
        original = getattr(os, operation)
        attempted = []
        baseline = len(os.listdir("/proc/self/fd"))

        def failed_operation(descriptor, *args, **kwargs):
            if os.readlink(f"/proc/self/fd/{descriptor}") == str(path):
                attempted.append(descriptor)
                raise OSError(errno.EIO, "review injected status I/O failure")
            return original(descriptor, *args, **kwargs)

        monkeypatch.setattr(os, operation, failed_operation)
        client._transport.raise_server_exceptions = False
        response = client.get("/api/v5/dashboard/profile")
        monkeypatch.undo()
        assert attempted
        assert len(os.listdir("/proc/self/fd")) == baseline
    assert response.status_code == 200, (response.status_code, response.text)
    assert response.json()["readiness"]["paper_owner"]["state"] == "UNAVAILABLE"


def _hostile(case):
    payload = status()
    first_report = next(iter(payload["native_reports"].values()))
    if case == "surrogate-failure":
        payload["failure"] = "\ud800"
    elif case == "surrogate-custom-info":
        payload["controllers"][0]["custom_info"]["probe"] = "\ud800"
    elif case == "surrogate-key":
        payload["controllers"][0]["custom_info"]["\ud800"] = 1
    elif case == "decimal-double-underscore":
        first_report["performance"]["global_pnl_quote"] = "1__0"
    elif case == "decimal-no-digits":
        first_report["performance"]["global_pnl_quote"] = "_1"
    elif case == "missing-failure":
        del payload["failure"]
    elif case == "missing-report-time":
        del payload["report_observed_at"]
    return payload


@pytest.mark.parametrize(
    "case,compatibility_path,unavailable",
    [
        ("surrogate-failure", None, True),
        ("surrogate-custom-info", f"/api/v1/trading-visuals/bootstrap?bot={BOT}", True),
        ("surrogate-key", f"/api/v1/trading-visuals/bootstrap?bot={BOT}", True),
        ("decimal-double-underscore", f"/api/v1/servers/{SERVER}/bots", False),
        ("decimal-no-digits", f"/api/v1/servers/{SERVER}/bots", False),
        ("missing-failure", f"/api/v1/servers/{SERVER}/bots", True),
        ("missing-report-time", f"/api/v1/servers/{SERVER}/bots", True),
    ],
)
def test_hostile_status_values_never_bind_falsely_or_cause_http_500(
    tmp_path, case, compatibility_path, unavailable
):
    # Lone surrogates and absent nullable keys make the status malformed; a malformed
    # metric string is withheld while the rest of the status stays usable.
    with client_for(tmp_path, ReviewUpstream(False), payload=_hostile(case)) as client:
        path = tmp_path / "runtime_status" / f"{BOT}.status.json"
        state = paper.read_paper_status(path, now=NOW).state
        assert state == ("UNAVAILABLE" if unavailable else "FRESH")
        client._transport.raise_server_exceptions = False
        if compatibility_path is None:
            response = client.get("/api/v5/dashboard/profile")
        else:
            response = client.get(
                "/api/v5/dashboard/read", params={"path": compatibility_path}
            )
    assert response.status_code in (200, 503), (response.status_code, response.text)
    if case.startswith("decimal-"):
        assert response.json()["metrics_available"] is False


@pytest.mark.parametrize(
    "change",
    [
        "drop-declaration",
        "empty-declarations",
        "report-and-unavailable",
        "undeclared-unavailable",
        "undeclared-retained",
    ],
)
def test_controller_declarations_must_account_for_every_report(tmp_path, change):
    # A truncated declaration would let totals and inventory present partial data as complete.
    payload = status()
    first = payload["controllers"][0]["id"]
    if change == "drop-declaration":
        payload["controllers"] = payload["controllers"][1:]
    elif change == "empty-declarations":
        payload["controllers"] = []
    elif change == "report-and-unavailable":
        payload["unavailable_controller_ids"] = [first]
    elif change == "undeclared-unavailable":
        payload["unavailable_controller_ids"] = ["modular_spot_unknown"]
    else:
        payload["retained_reports"] = {"modular_spot_unknown": {}}
    path = write_status(tmp_path, payload)
    assert paper.read_paper_status(path, now=NOW).state == "UNAVAILABLE"


@pytest.mark.parametrize(
    "name", ["meridian_v5", "meridian_v5_live", "paper_meridian_v5"]
)
def test_only_a_paper_suffixed_identity_can_bind(tmp_path, name):
    # The shared frontend labels paper bots by their _paper suffix; another name would render as live.
    payload = status(bot_name=name)
    path = write_status(tmp_path, payload, name=f"{name}.status.json")
    observation = paper.read_paper_status(path, now=NOW)
    assert (
        observation.state == "UNAVAILABLE" and observation.reason == "PAPER_STATUS_PATH"
    )
