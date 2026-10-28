from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from condor.v5.app import create_app
from condor.v5.config import Settings


TOKEN = "d" * 48
ORIGIN = "https://v5.example.test"
SERVER = "rsibot-v5"


class NoNetworkUpstream:
    def __init__(self):
        self.calls = []

    async def observation(self, path):
        self.calls.append(("GET", path))
        raise AssertionError("the compatibility bridge must not proxy owner reads")

    async def task_profiles(self):
        self.calls.append(("GET", "/v1/tasks"))
        raise AssertionError("the compatibility bridge must not proxy owner reads")

    async def request_report(self, task_id, snapshot_id):
        self.calls.append(("POST", task_id, snapshot_id))
        raise AssertionError("the compatibility bridge must not call the advisor")


def make_settings(tmp_path: Path) -> Settings:
    dashboard_token = tmp_path / "dashboard.token"
    observation_token = tmp_path / "observation.token"
    request_token = tmp_path / "request.token"
    dashboard_token.write_text(TOKEN)
    observation_token.write_text("r" * 48)
    request_token.write_text("q" * 48)
    return Settings(
        runtime_root=tmp_path / "v5-runtime",
        dashboard_token_file=dashboard_token,
        dashboard_origin=ORIGIN,
        observation_base_url="http://observation.internal:8080",
        observation_read_token_file=observation_token,
        advisor_control_base_url="http://advisor.internal:8081",
        advisor_request_token_file=request_token,
        cookie_secure=False,
    )


def authenticated_client(tmp_path: Path, upstream: NoNetworkUpstream):
    app = create_app(
        settings=make_settings(tmp_path),
        upstream=upstream,
        static_dir=tmp_path / "dist",
    )
    client = TestClient(app)
    response = client.post(
        "/api/v5/auth/login", json={"token": TOKEN}, headers={"Origin": ORIGIN}
    )
    assert response.status_code == 200
    return client, app


def test_profile_is_fixed_and_explicitly_unbound(tmp_path):
    upstream = NoNetworkUpstream()
    client, _ = authenticated_client(tmp_path, upstream)
    with client:
        profile = client.get("/api/v5/dashboard/profile").json()
    assert profile == {
        "schema_version": "v5-dashboard-profile.v1",
        "server": {
            "server_id": SERVER,
            "host": "razer",
            "port": 8088,
            "mode": "reports-only",
            "execution_enabled": False,
        },
        "condor": {"base_revision": "ff8858df765cffe4d325fde384f7a2eecdf51641"},
        "readiness": {
            "native_owner": "UNBOUND",
            "native_owner_reason": "The exact V5 controller baseline and native decision trace are not bound.",
            "account_owner": "UNBOUND",
            "account_owner_reason": "No V5 account and position owner is bound.",
            "research_owner": "UNBOUND",
            "research_owner_reason": "No V5 Research OS source is bound.",
            "tradepad_owner": "UNBOUND",
            "tradepad_owner_reason": "No V5 Tradepad session or publication is bound.",
            "market_picture_owner": "UNBOUND",
            "market_picture_owner_reason": "The V5 context is not an ordinary Condor Market Picture frame.",
        },
    }
    assert upstream.calls == []


def test_compatibility_bridge_requires_v5_authentication(tmp_path):
    upstream = NoNetworkUpstream()
    app = create_app(
        settings=make_settings(tmp_path),
        upstream=upstream,
        static_dir=tmp_path / "dist",
    )
    with TestClient(app) as client:
        assert client.get("/api/v5/dashboard/profile").status_code == 401
        assert (
            client.get(
                "/api/v5/dashboard/read",
                params={"path": "/api/v1/servers"},
            ).status_code
            == 401
        )
    assert upstream.calls == []


def test_only_fixed_server_catalog_status_bot_and_visual_sources_are_projected(
    tmp_path,
):
    upstream = NoNetworkUpstream()
    client, _ = authenticated_client(tmp_path, upstream)
    with client:
        servers = client.get(
            "/api/v5/dashboard/read", params={"path": "/api/v1/servers"}
        )
        assert servers.status_code == 200
        assert servers.json() == [
            {
                "name": SERVER,
                "host": "razer",
                "port": 8088,
                "online": True,
                "permission": "observer",
            }
        ]

        status = client.get(
            "/api/v5/dashboard/read",
            params={"path": f"/api/v1/servers/{SERVER}/status"},
        )
        assert status.status_code == 200
        assert status.json()["status"] == "online"
        assert status.json()["process_health"] == "RUNNING"
        assert status.json()["native_owner"] == "UNBOUND"
        assert status.json()["native_owner_reason"]
        assert status.json()["baseline_binding"] is None
        assert status.json()["execution_enabled"] is False
        assert status.json()["profile"] == "native"
        assert status.json()["capabilities"]["native_status"] is True
        assert all(
            status.json()["capabilities"][capability] is False
            for capability in (
                "accounts",
                "account_management",
                "portfolio_read",
                "manual_trading",
                "executor_management",
                "docker",
                "fleet_catalogue",
                "market_screener",
                "market_picture",
                "native_controls_enabled",
                "native_stop",
                "performance_history",
            )
        )

        bots = client.get(
            "/api/v5/dashboard/read",
            params={"path": f"/api/v1/servers/{SERVER}/bots"},
        )
        assert bots.status_code == 200
        assert bots.json()["controllers"] == []
        assert bots.json()["bots"] == []
        assert bots.json()["total_pnl"] is None
        assert bots.json()["total_volume"] is None
        assert bots.json()["metrics_available"] is False
        assert bots.json()["native_owner"] == "UNBOUND"
        assert "unbound" in bots.json()["error_hint"].lower()

        sources = client.get(
            "/api/v5/dashboard/read",
            params={"path": "/api/v1/trading-visuals/sources"},
        )
        assert sources.status_code == 200
        assert sources.json() == {"sources": []}
    assert upstream.calls == []


def test_financial_research_tradepad_and_market_picture_reads_fail_closed(tmp_path):
    upstream = NoNetworkUpstream()
    client, _ = authenticated_client(tmp_path, upstream)
    paths = [
        f"/api/v1/servers/{SERVER}/portfolio",
        f"/api/v1/servers/{SERVER}/portfolio/history?range=1D",
        f"/api/v1/servers/{SERVER}/account-balances",
        f"/api/v1/servers/{SERVER}/executors",
        f"/api/v1/servers/{SERVER}/market-picture/status",
        f"/api/v1/servers/{SERVER}/screener/capabilities",
        "/api/v1/research/overview",
        "/api/v1/tradepad/sessions",
    ]
    with client:
        for path in paths:
            response = client.get("/api/v5/dashboard/read", params={"path": path})
            assert response.status_code == 503, path
            assert isinstance(response.json()["detail"], str), path
            assert "unbound" in response.json()["detail"].lower(), path
            assert "0" not in response.json()["detail"], path
    assert upstream.calls == []


def test_invalid_absolute_traversal_wrong_server_and_unknown_paths_reject(tmp_path):
    upstream = NoNetworkUpstream()
    client, _ = authenticated_client(tmp_path, upstream)
    cases = [
        ("https://evil.example/api/v1/servers", 400),
        ("//evil.example/api/v1/servers", 400),
        ("/api/v1/servers/../secrets", 400),
        ("/api/v1/servers/%2e%2e/status", 400),
        ("/api/v1/servers/other/status", 403),
        (f"/api/v1/servers/{SERVER}/unknown", 404),
        ("/api/v1/unknown", 404),
    ]
    with client:
        for path, expected_status in cases:
            response = client.get("/api/v5/dashboard/read", params={"path": path})
            assert response.status_code == expected_status, (path, response.text)
    assert upstream.calls == []


def test_bridge_is_get_only_and_does_not_mount_normal_condor_routers(tmp_path):
    upstream = NoNetworkUpstream()
    client, app = authenticated_client(tmp_path, upstream)
    with client:
        assert (
            client.post(
                "/api/v5/dashboard/read",
                params={"path": "/api/v1/servers"},
                headers={"Origin": ORIGIN},
            ).status_code
            == 405
        )
    routes = {getattr(route, "path", "") for route in app.routes}
    assert "/api/v1/servers" not in routes
    assert not any(path.startswith("/api/v1/agents") for path in routes)
    assert not any(path.startswith("/api/v1/executors") for path in routes)
    assert upstream.calls == []


def test_full_dashboard_deep_links_serve_only_known_ui_paths(tmp_path):
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "v5.html").write_text("<html>full V5 dashboard</html>")
    (dist / "condor_old.jpeg").write_bytes(b"test-logo")
    app = create_app(
        settings=make_settings(tmp_path), upstream=NoNetworkUpstream(), static_dir=dist
    )
    with TestClient(app) as client:
        logo = client.get("/condor_old.jpeg")
        assert logo.status_code == 200 and logo.content == b"test-logo"
        assert logo.headers["content-type"] == "image/jpeg"
        for path in (
            "/capital",
            "/bots",
            "/operations",
            "/research",
            "/backtests",
            "/agents",
            "/agents/market_analyst",
            "/sessions",
            "/sessions/" + "a" * 32,
            "/settings",
            "/market/evidence",
            "/v5/readiness",
        ):
            response = client.get(path)
            assert response.status_code == 200
            assert "full V5 dashboard" in response.text
        for path in (
            "/api/v1/servers",
            "/api/unknown",
            "/secrets",
            "/agents/unknown",
            "/sessions/wrong",
        ):
            response = client.get(path)
            assert response.status_code == 404
            assert "full V5 dashboard" not in response.text
