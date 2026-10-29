import json
from dataclasses import replace

import pytest

from condor.v5.host_operations import read_host_operations
from condor.v5.app import create_app
from fastapi.testclient import TestClient
from test_v5_dashboard_bridge import NoNetworkUpstream, ORIGIN, TOKEN, make_settings
from test_v5_paper_binding import BOT, NOW, status, write_status


def payload():
    return dict(
        schema="rsibot.v5-paper.read.v1",
        section="operations",
        execution_mode="paper",
        simulated=True,
        snapshot_id="host-monitor:1000000",
        generated_at_ms=1000000,
        observed_at_ms=1000000,
        state="available",
        reason=None,
        data=dict(services=[], checks=[], incidents=[]),
    )


def test_host_operations_preserves_owner_values_and_expiry(tmp_path):
    path = tmp_path / "operations.json"
    path.write_text(json.dumps(payload()))
    assert read_host_operations(path, 1000000) == payload()
    stale = read_host_operations(path, 1100000)
    assert stale["state"] == "stale" and stale["data"] == payload()["data"]


def test_missing_host_export_is_collecting_not_zero_services(tmp_path):
    value = read_host_operations(tmp_path / "missing.json", 1000000)
    assert value["state"] == "collecting" and value["data"] is None


@pytest.mark.parametrize(
    "fault", ["symlink", "oversized", "identity", "future", "nonfinite", "exponent"]
)
def test_host_operations_refuses_untrusted_records(tmp_path, fault):
    path = tmp_path / "operations.json"
    source = tmp_path / "source.json"
    value = payload()
    if fault == "identity":
        value["execution_mode"] = "live"
    if fault == "future":
        value["generated_at_ms"] = 2000000
    if fault == "nonfinite":
        value["data"]["number"] = float("nan")
    source.write_text(json.dumps(value))
    if fault == "symlink":
        path.symlink_to(source)
    else:
        raw = b" " * 2097153 if fault == "oversized" else source.read_bytes()
        if fault == "exponent":
            raw = raw.replace(b'"services": []', b'"services": [], "number": 1e999')
        path.write_bytes(raw)
    with pytest.raises(ValueError):
        read_host_operations(path, 1000000)


def test_authenticated_operations_route_reads_host_without_upstream_calls(tmp_path):
    path = tmp_path / "operations.json"
    value = payload()
    value.update(generated_at_ms=int(NOW * 1000), observed_at_ms=int(NOW * 1000))
    path.write_text(json.dumps(value))
    settings = replace(
        make_settings(tmp_path),
        host_operations_file=path,
        paper_status_file=write_status(tmp_path, status()),
    )
    upstream = NoNetworkUpstream()
    app = create_app(
        settings=settings,
        upstream=upstream,
        static_dir=tmp_path / "dist",
        clock=lambda: int(NOW * 1000),
    )
    with TestClient(app) as client:
        query = {"path": "/api/v1/operations"}
        assert client.get("/api/v5/dashboard/read", params=query).status_code == 401
        assert (
            client.post(
                "/api/v5/auth/login", json={"token": TOKEN}, headers={"Origin": ORIGIN}
            ).status_code
            == 200
        )
        response = client.get("/api/v5/dashboard/read", params=query)
        assert response.status_code == 200, response.text
        assert response.json()["data"] == value["data"]
        assert response.json()["bot_id"] == BOT
        value["execution_mode"] = "live"
        path.write_text(json.dumps(value))
        response = client.get("/api/v5/dashboard/read", params=query)
        assert response.status_code == 503
        assert response.json()["detail"]["code"] == "HOST_OPERATIONS_INVALID"
    assert upstream.calls == []


@pytest.mark.parametrize(
    "configured", ["relative/operations.json", "/run/../operations.json"]
)
def test_host_operations_configuration_requires_normalized_absolute_path(
    tmp_path, configured
):
    from condor.v5.config import ConfigurationError, Settings

    settings = make_settings(tmp_path)
    env = dict(
        V5_RUNTIME_ROOT=str(settings.runtime_root),
        V5_DASHBOARD_ORIGIN=ORIGIN,
        V5_DASHBOARD_TOKEN_FILE=str(settings.dashboard_token_file),
        V5_OBSERVATION_BASE_URL="http://observation:8080",
        V5_OBSERVATION_TOKEN_FILE=str(settings.observation_read_token_file),
        V5_ADVISOR_CONTROL_BASE_URL="http://advisor:8081",
        V5_ADVISORY_REQUEST_TOKEN_FILE=str(settings.advisor_request_token_file),
        V5_HOST_OPERATIONS_FILE=configured,
    )
    with pytest.raises(ConfigurationError, match="V5_HOST_OPERATIONS_FILE"):
        Settings.from_env(env)
