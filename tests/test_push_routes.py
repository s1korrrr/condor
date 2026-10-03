"""Authenticated device registry routes, behind the private read-only boundary."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from condor.push.store import Registry
from condor.web import auth
from condor.web.models import WebUser
from condor.web.read_only import ReadOnlyWeb
from condor.web.routes import push as push_routes
from tests.push_support import BUNDLE, TOKEN_A, TOKEN_B, TOKEN_W, WATCH_BUNDLE

NOW = 1_790_001_000.0
H = {"Authorization": "Bearer test"}


def _client(
    monkeypatch,
    tmp_path,
    *,
    user_id=1,
    environment="both",
    configured=True,
    allow=True,
    bundle=BUNDLE,
):
    registry_path = tmp_path / "state" / "registry.sqlite"
    if configured:
        monkeypatch.setenv(push_routes.ENV_REGISTRY, str(registry_path))
        monkeypatch.setenv(push_routes.ENV_BUNDLE, bundle)
        monkeypatch.setenv(push_routes.ENV_ENVIRONMENT, environment)
    else:
        for name in (
            push_routes.ENV_REGISTRY,
            push_routes.ENV_BUNDLE,
            push_routes.ENV_ENVIRONMENT,
        ):
            monkeypatch.delenv(name, raising=False)
    push_routes._registry_at.cache_clear()
    monkeypatch.setattr(push_routes, "_clock", lambda: NOW)
    app = FastAPI()
    app.include_router(push_routes.router, prefix="/api/v1")
    app.dependency_overrides[auth.get_current_user] = lambda: WebUser(
        id=user_id, role="user"
    )
    return TestClient(ReadOnlyWeb(app, allow_push_devices=allow)), (
        Registry(registry_path) if configured else None
    )


def _device(token=TOKEN_A, **kw):
    return {
        "token": token,
        "platform": "iphone",
        "bundle_id": BUNDLE,
        "environment": "sandbox",
        "app_version": "1.0",
        **kw,
    }


def test_routes_need_a_login_and_a_configured_server(monkeypatch, tmp_path):
    app = FastAPI()
    app.include_router(push_routes.router, prefix="/api/v1")
    anonymous = TestClient(ReadOnlyWeb(app, allow_push_devices=True))
    assert anonymous.get("/api/v1/push/settings").status_code in (401, 403)
    assert anonymous.post("/api/v1/push/devices", json=_device()).status_code in (
        401,
        403,
    )
    client, _ = _client(monkeypatch, tmp_path, configured=False)
    for method, path in [
        ("get", "/settings"),
        ("get", "/heartbeat"),
        ("post", "/devices"),
        ("post", "/test"),
    ]:
        response = getattr(client, method)(
            "/api/v1/push" + path,
            headers=H,
            **({"json": _device()} if method == "post" and path == "/devices" else {}),
        )
        assert response.status_code == 503, path


def test_register_update_list_and_unregister_a_device(monkeypatch, tmp_path):
    client, registry = _client(monkeypatch, tmp_path)
    created = client.post("/api/v1/push/devices", json=_device(), headers=H)
    assert created.status_code == 200
    body = created.json()
    device = body["device"]
    assert body["server"] == {
        "bundle_id": BUNDLE,
        "environments": ["sandbox", "production"],
    }
    assert TOKEN_A not in created.text and device["token_suffix"] == TOKEN_A[-6:]
    assert device["recipient_server_id"] == registry.recipient_server_id
    assert (
        device["classes"]["fill_entry"] is True
        and device["classes"]["summary"] is False
    )
    updated = client.post(
        "/api/v1/push/devices",
        json=_device(
            classes={"summary": True, "fill_exit": False},
            quiet_hours={
                "enabled": True,
                "start": "23:00",
                "end": "06:30",
                "tz": "Europe/Warsaw",
            },
        ),
        headers=H,
    ).json()["device"]
    assert updated["device_id"] == device["device_id"]
    assert (
        updated["classes"]["summary"] is True
        and updated["classes"]["fill_exit"] is False
    )
    assert updated["quiet_hours"] == {
        "enabled": True,
        "start": "23:00",
        "end": "06:30",
        "tz": "Europe/Warsaw",
        "bypass_critical": True,
    }
    settings = client.get("/api/v1/push/settings", headers=H).json()
    assert [d["device_id"] for d in settings["devices"]] == [device["device_id"]]
    assert (
        settings["devices"][0]["recipient_server_id"] == device["recipient_server_id"]
    )
    assert (
        settings["read_only"] is True
        and settings["heartbeat"]["state"] == "unavailable"
    )
    classes = {c["id"]: c["default"] for c in settings["classes"]}
    assert (
        "test" not in classes
        and classes["summary"] is False
        and classes["incident"] is True
    )
    assert client.delete(
        f"/api/v1/push/devices/{device['device_id']}", headers=H
    ).json() == {"deleted": device["device_id"]}
    assert client.get("/api/v1/push/settings", headers=H).json()["devices"] == []
    assert registry.get_device(device["device_id"]) is None


def test_devices_are_private_to_their_owner(monkeypatch, tmp_path):
    mine, _ = _client(monkeypatch, tmp_path, user_id=1)
    device = mine.post("/api/v1/push/devices", json=_device(), headers=H).json()[
        "device"
    ]
    theirs, _ = _client(monkeypatch, tmp_path, user_id=2)
    assert theirs.get("/api/v1/push/settings", headers=H).json()["devices"] == []
    assert (
        theirs.delete(
            f"/api/v1/push/devices/{device['device_id']}", headers=H
        ).status_code
        == 404
    )
    assert (
        theirs.post(
            "/api/v1/push/test", json={"device_id": device["device_id"]}, headers=H
        ).status_code
        == 404
    )
    assert (
        mine.get("/api/v1/push/settings", headers=H).json()["devices"][0]["device_id"]
        == device["device_id"]
    )


def test_watch_bundles_beneath_the_app_are_accepted_and_foreign_bundles_are_not(
    monkeypatch, tmp_path
):
    client, _ = _client(monkeypatch, tmp_path)
    ok = client.post(
        "/api/v1/push/devices",
        json=_device(TOKEN_W, platform="watch", bundle_id=WATCH_BUNDLE),
        headers=H,
    )
    assert ok.status_code == 200 and ok.json()["device"]["platform"] == "watch"
    for bundle in ("com.evil.app", BUNDLE + "x", BUNDLE + ".watchevil", "com.rsibot"):
        response = client.post(
            "/api/v1/push/devices", json=_device(TOKEN_B, bundle_id=bundle), headers=H
        )
        assert response.status_code == 422, bundle


def test_environment_must_be_enabled_on_the_server(monkeypatch, tmp_path):
    client, _ = _client(monkeypatch, tmp_path, environment="production")
    assert (
        client.post(
            "/api/v1/push/devices", json=_device(environment="sandbox"), headers=H
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/v1/push/devices", json=_device(environment="production"), headers=H
        ).status_code
        == 200
    )


@pytest.mark.parametrize(
    "change",
    [
        {"token": "nothex"},
        {"token": "a" * 300},
        {"platform": "android"},
        {"environment": "staging"},
        {"classes": {"trade": True}},
        {"classes": {"fill_entry": "yes"}},
        {"quiet_hours": {"enabled": True, "start": "99:00"}},
        {"quiet_hours": {"tz": "Mars/Base"}},
        {"quiet_hours": {"enabled": True, "start": "22:00", "end": "22:00"}},
        {"unknown_field": 1},
    ],
)
def test_invalid_registrations_are_rejected_without_storing_anything(
    monkeypatch, tmp_path, change
):
    client, registry = _client(monkeypatch, tmp_path)
    assert (
        client.post(
            "/api/v1/push/devices", json=_device(**change), headers=H
        ).status_code
        == 422
    )
    assert registry.devices_for_user(1) == []


def test_device_limit_returns_a_clear_error(monkeypatch, tmp_path):
    client, _ = _client(monkeypatch, tmp_path)
    for i in range(8):
        assert (
            client.post(
                "/api/v1/push/devices", json=_device(f"{i:02x}" * 32), headers=H
            ).status_code
            == 200
        )
    response = client.post("/api/v1/push/devices", json=_device("ff" * 32), headers=H)
    assert response.status_code == 422 and "too many" in response.json()["detail"]


def test_test_alert_is_queued_for_the_worker_and_rate_limited(monkeypatch, tmp_path):
    client, registry = _client(monkeypatch, tmp_path)
    assert (
        client.post("/api/v1/push/test", headers=H).status_code == 409
    )  # nothing registered yet
    device = client.post("/api/v1/push/devices", json=_device(), headers=H).json()[
        "device"
    ]
    queued = client.post("/api/v1/push/test", headers=H)
    assert queued.status_code == 202
    data = queued.json()
    assert (
        data["devices"] == 1 and data["worker"] == "unavailable"
    )  # no worker has ever reported in
    assert client.get(f"/api/v1/push/test/{data['request_id']}", headers=H).json() == {
        "request_id": data["request_id"],
        "state": "pending",
        "result": None,
    }
    assert client.post("/api/v1/push/test", headers=H).status_code == 429
    pending = registry.requests("pending")
    assert pending[0]["user_id"] == 1 and pending[0]["device_ids"] == []
    targeted, _ = _client(monkeypatch, tmp_path, user_id=1)
    monkeypatch.setattr(push_routes, "_clock", lambda: NOW + 60)
    assert (
        targeted.post(
            "/api/v1/push/test", json={"device_id": device["device_id"]}, headers=H
        ).status_code
        == 202
    )
    assert registry.requests("pending")[1]["device_ids"] == [device["device_id"]]
    assert client.get("/api/v1/push/test/" + "0" * 24, headers=H).status_code == 404
    assert client.get("/api/v1/push/test/not-an-id", headers=H).status_code == 404


def test_heartbeat_reports_fresh_stale_and_unavailable(monkeypatch, tmp_path):
    client, registry = _client(monkeypatch, tmp_path)
    assert (
        client.get("/api/v1/push/heartbeat", headers=H).json()["state"] == "unavailable"
    )
    registry.set_meta(
        "worker_heartbeat",
        {
            "status": "running",
            "updated_at": NOW - 30,
            "degraded_reasons": [],
            "pending_deliveries": 0,
        },
    )
    fresh = client.get("/api/v1/push/heartbeat", headers=H).json()
    assert (
        fresh["configured"] is True
        and fresh["state"] == "fresh"
        and fresh["age_seconds"] == 30
        and fresh["max_age_seconds"] == 120
    )
    registry.set_meta(
        "worker_heartbeat", {"status": "running", "updated_at": NOW - 400}
    )
    assert client.get("/api/v1/push/heartbeat", headers=H).json()["state"] == "stale"
    registry.set_meta(
        "worker_heartbeat",
        {"status": "degraded", "updated_at": NOW - 5, "degraded_reasons": ["apns"]},
    )
    degraded = client.get("/api/v1/push/heartbeat", headers=H).json()
    assert (
        degraded["state"] == "fresh"
        and degraded["status"] == "degraded"
        and degraded["degraded_reasons"] == ["apns"]
    )
    assert (
        client.get("/api/v1/push/heartbeat", headers=H).headers["cache-control"]
        == "no-store"
    )


# ------------------------------------------------------------------ the read-only boundary


def test_boundary_allows_only_the_device_and_test_routes_when_push_is_enabled(
    monkeypatch, tmp_path
):
    client, _ = _client(monkeypatch, tmp_path)
    device_id = "0" * 32
    for method, path in [
        ("put", "/api/v1/push/devices"),
        ("patch", "/api/v1/push/devices"),
        ("delete", "/api/v1/push/devices"),
        ("post", f"/api/v1/push/devices/{device_id}"),
        ("delete", "/api/v1/push/devices/not-hex"),
        ("delete", f"/api/v1/push/devices/{device_id}/x"),
        ("post", "/api/v1/push/settings"),
        ("post", "/api/v1/push/heartbeat"),
        ("post", "/api/v1/push/test/abc"),
        ("post", "/api/v1/push/send"),
        ("post", "/api/v1/servers/local/bots/x/native/start"),
        ("post", "/api/v1/trade/order"),
    ]:
        assert getattr(client, method)(path, headers=H).status_code == 403, (
            method,
            path,
        )


def test_boundary_blocks_push_mutations_unless_the_deployment_enables_push(
    monkeypatch, tmp_path
):
    client, _ = _client(monkeypatch, tmp_path, allow=False)
    assert (
        client.post("/api/v1/push/devices", json=_device(), headers=H).status_code
        == 403
    )
    assert client.post("/api/v1/push/test", headers=H).status_code == 403
    assert (
        client.delete("/api/v1/push/devices/" + "0" * 32, headers=H).status_code == 403
    )
    assert (
        client.get("/api/v1/push/settings", headers=H).status_code == 200
    )  # reads stay available


def test_push_enabling_does_not_open_any_other_mutation(monkeypatch, tmp_path):
    client, _ = _client(monkeypatch, tmp_path)
    for path in (
        "/api/v1/settings/credentials",
        "/api/v1/servers/s/bots/b/native/entries/pause",
        "/api/v1/auth/logout",
    ):
        assert client.post(path, headers=H).status_code == 403


def test_router_exposes_only_the_documented_paths():
    paths = sorted(
        (tuple(sorted(r.methods)), r.path) for r in push_routes.router.routes
    )
    assert paths == [
        (("DELETE",), "/push/devices/{device_id}"),
        (("GET",), "/push/heartbeat"),
        (("GET",), "/push/settings"),
        (("GET",), "/push/test/{request_id}"),
        (("POST",), "/push/devices"),
        (("POST",), "/push/test"),
    ]
