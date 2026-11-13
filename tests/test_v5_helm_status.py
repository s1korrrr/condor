import json
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from condor.v5.app import create_app
from condor.v5.config import ConfigurationError, Settings
from condor.v5.helm import read_helm_status
from test_v5_dashboard_bridge import NoNetworkUpstream, ORIGIN, TOKEN, make_settings

NOW = 1_793_929_900.0


def helm_status(**overrides):
    """A trimmed copy of the real helm_v5_paper runtime status (2026-11-06 shutdown)."""
    value = {
        "schema_version": 1,
        "paper_runtime_schema": "helm_v5_paper_runtime_v1",
        "bot_name": "helm_v5_paper",
        "execution_mode": "paper",
        "controller_kind": "helm_v5",
        "generated_at": NOW - 10,
        "ready": False,
        "failure": None,
        "reasons": ["runtime_stopped"],
        "steps": 5086,
        "actions": 0,
        "helm": {
            "schema": "rsibot.helm-v5-paper.status.helm.v2",
            "phase": "P1",
            "entries_held": "operator_entry_pause",
            "operator_entry_paused": True,
            "kill_switch": False,
            "shutdown": {"checkpoint": True, "clean": True, "closed": True},
            "mandate": {"mandate_id": "helm-v5-paper-20261105", "state": "active", "days_to_expiry": 29.708, "valid_until_ms": 1796496650500},
            "native_risk": {"reason": "risk_clear", "latched": False, "daily_loss_use": 0, "risk_reference_quote": 200000, "unit": "USDC"},
            "control_rejections": {"count": 1, "recent": [{"action": "resume_entries", "at_ms": 1793926101828, "reason": "stop_persistence_failed: explicit emergency reset required", "command_id": "x"}]},
            "controls": {"path": "/home/hummingbot/data/runtime_status/helm_v5_paper.controls.json"},
        },
        "controllers": [{
            "id": "modular_spot_helm_v5_paper",
            "custom_info": {
                "portfolio": {"candidate_holds": {"BNB-USDC": "low_volatility"}},
                "symbols": {"BNB-USDC": {"status": "operator_entry_pause", "bag": {"held_amount": "0", "breakeven_price": "0", "trail_armed": False, "reason": "no_bag"}, "last_decision": {"at": NOW - 20, "reason": "operator_entry_pause"}}},
            },
        }],
    }
    value.update(overrides)
    return value


def write(tmp_path, value, name="helm_v5_paper.status.json"):
    path = tmp_path / name
    path.write_text(json.dumps(value))
    return path


def test_fresh_status_projects_only_shown_fields(tmp_path):
    result = read_helm_status(write(tmp_path, helm_status()), now=NOW)
    assert (result["state"], result["reason"], result["bot"]) == ("FRESH", "HELM_STATUS_FRESH", "helm_v5_paper")
    status = result["status"]
    assert status["reasons"] == ["runtime_stopped"] and status["ready"] is False
    assert status["mandate"]["state"] == "active" and status["risk"]["latched"] is False
    assert status["control_rejections"]["recent"] == [{"action": "resume_entries", "at_ms": 1793926101828, "reason": "stop_persistence_failed: explicit emergency reset required"}]
    assert status["withheld"] == 0 and status["failure_reported"] is False
    symbol = status["symbols"][0]
    assert symbol["pair"] == "BNB-USDC" and symbol["candidate_hold"] == "low_volatility"
    # Decimal text stays text, flags stay flags; container paths and command ids are not projected.
    assert symbol["bag"] == {"held_amount": "0", "breakeven_price": "0"}
    assert symbol["last_decision"] == {"at": NOW - 20, "reason": "operator_entry_pause"}
    assert "/home/hummingbot" not in json.dumps(result) and "command_id" not in json.dumps(result)


def test_stopped_runtime_is_stale_not_hidden(tmp_path):
    result = read_helm_status(write(tmp_path, helm_status(generated_at=NOW - 7 * 86400)), now=NOW)
    assert result["state"] == "STALE" and result["status"]["age_s"] == pytest.approx(7 * 86400)


@pytest.mark.parametrize("change", [
    {"paper_runtime_schema": "native_component_paper_runtime_v1"},
    {"execution_mode": "live"},
    {"bot_name": "meridian_v5_paper"},
    {"helm": {"schema": "other"}},
    {"generated_at": True},
])
def test_wrong_identity_or_schema_is_refused(tmp_path, change):
    result = read_helm_status(write(tmp_path, helm_status(**change)), now=NOW)
    assert (result["state"], result["reason"], result["status"]) == ("UNAVAILABLE", "HELM_STATUS_SCHEMA", None)


def test_missing_future_and_symlinked_files_are_unavailable(tmp_path):
    assert read_helm_status(tmp_path / "helm_v5_paper.status.json", now=NOW)["reason"] == "HELM_STATUS_MISSING"
    assert read_helm_status(write(tmp_path, helm_status(generated_at=NOW + 60)), now=NOW)["reason"] == "HELM_STATUS_CLOCK_SKEW"
    other = tmp_path / "other"
    other.mkdir()
    source = write(other, helm_status())
    link = tmp_path / "linked" / "helm_v5_paper.status.json"
    link.parent.mkdir()
    link.symlink_to(source)
    assert read_helm_status(link, now=NOW)["state"] == "UNAVAILABLE"


def test_config_requires_a_status_file_name(tmp_path):
    base = {key: value for key, value in env_for(tmp_path).items()}
    assert Settings.from_env({**base, "V5_HELM_STATUS_FILE": str(tmp_path / "helm_v5_paper.status.json")}).helm_status_file is not None
    with pytest.raises(ConfigurationError):
        Settings.from_env({**base, "V5_HELM_STATUS_FILE": "relative/helm_v5_paper.status.json"})
    with pytest.raises(ConfigurationError):
        Settings.from_env({**base, "V5_HELM_STATUS_FILE": str(tmp_path / "helm.json")})


def env_for(tmp_path):
    settings = make_settings(tmp_path)
    return {
        "V5_RUNTIME_ROOT": str(settings.runtime_root),
        "V5_DASHBOARD_TOKEN_FILE": str(settings.dashboard_token_file),
        "V5_DASHBOARD_ORIGIN": settings.dashboard_origin,
        "V5_OBSERVATION_BASE_URL": settings.observation_base_url,
        "V5_OBSERVATION_TOKEN_FILE": str(settings.observation_read_token_file),
        "V5_ADVISOR_CONTROL_BASE_URL": settings.advisor_control_base_url,
        "V5_ADVISORY_REQUEST_TOKEN_FILE": str(settings.advisor_request_token_file),
    }


@pytest.mark.parametrize("bound", [False, True])
def test_route_requires_sign_in_and_reports_unbound(tmp_path, bound):
    settings = make_settings(tmp_path)
    if bound:
        settings = replace(settings, helm_status_file=write(tmp_path, helm_status()))
    app = create_app(settings=settings, upstream=NoNetworkUpstream(), static_dir=tmp_path / "dist", clock=lambda: int(NOW * 1000))
    with TestClient(app) as client:
        assert client.get("/api/v5/helm").status_code == 401
        assert client.post("/api/v5/auth/login", json={"token": TOKEN}, headers={"Origin": ORIGIN}).status_code == 200
        response = client.get("/api/v5/helm")
        assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
        assert response.json()["state"] == ("FRESH" if bound else "UNBOUND")
        assert client.post("/api/v5/helm", headers={"Origin": ORIGIN}).status_code == 405


def test_path_like_and_out_of_range_values_are_withheld_and_counted(tmp_path):
    value = helm_status(failure="/home/hummingbot/data/private failed")
    info = value["controllers"][0]["custom_info"]["symbols"]["BNB-USDC"]
    info["last_decision"] = {"command_id": "x", "token": "secret", "path": "/home/hummingbot/data/private", "reason": "/home/hummingbot/data/private", "at": NOW}
    info["bag"]["held_amount"] = True
    info["bag"]["breakeven_price"] = "1e999"
    value["helm"]["mandate"]["valid_until_ms"] = 999999999999999999
    result = read_helm_status(write(tmp_path, value), now=NOW)
    status = result["status"]
    symbol = status["symbols"][0]
    assert symbol["last_decision"] == {"at": NOW, "reason": None}
    assert symbol["bag"] == {"held_amount": None, "breakeven_price": None}
    assert status["mandate"]["valid_until_ms"] is None
    assert status["failure"] is None and status["failure_reported"] is True
    assert status["withheld"] == 5
    text = json.dumps(result)
    assert "secret" not in text and "/home/hummingbot" not in text and "command_id" not in text


@pytest.mark.parametrize("generated", [-1e300, 1e300, 0, "1793929890"])
def test_generated_time_must_be_a_real_epoch(tmp_path, generated):
    result = read_helm_status(write(tmp_path, helm_status(generated_at=generated)), now=NOW)
    assert (result["state"], result["status"]) == ("UNAVAILABLE", None)


def test_unpublished_blocks_stay_unknown_and_rejections_sort_newest_first(tmp_path):
    value = helm_status()
    for name in ("control_rejections", "operator_entry_paused", "entries_held"):
        value["helm"].pop(name)
    status = read_helm_status(write(tmp_path, value), now=NOW)["status"]
    assert status["control_rejections"] is None
    assert status["operator_entry_paused"] is None and status["entries_held"] is None
    value = helm_status()
    value["helm"]["control_rejections"]["recent"] = [{"action": "a", "at_ms": 1000}, {"action": "b", "at_ms": 3000}, {"action": "c", "at_ms": 2000}]
    recent = read_helm_status(write(tmp_path, value), now=NOW)["status"]["control_rejections"]["recent"]
    assert [row["action"] for row in recent] == ["b", "c", "a"]
