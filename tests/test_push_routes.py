"""Authenticated device registry routes, behind the private read-only boundary."""

import copy
import json
from pathlib import Path

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
SERVER = "rsibot-stack-v2"


class Servers:
    """Server access as the config manager answers it: users 1 and 2 see SERVER only."""

    def has_server_access(self, user_id, name):
        return name == SERVER and user_id in (1, 2)

    def is_admin(self, user_id):
        return user_id == 1


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
    monkeypatch.setattr(push_routes, "get_config_manager", lambda: Servers())
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
        ("put", "/api/v1/push/live-activities"),
        ("post", f"/api/v1/push/live-activities/{device_id}"),
        ("delete", "/api/v1/push/live-activities"),
        ("delete", "/api/v1/push/live-activities/NOT-HEX"),
        ("delete", f"/api/v1/push/live-activities/{device_id}/x"),
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
        client.post(
            "/api/v1/push/live-activities", json={"kind": "start"}, headers=H
        ).status_code
        == 403
    )
    assert (
        client.delete("/api/v1/push/live-activities/" + "0" * 32, headers=H).status_code
        == 403
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
        (("DELETE",), "/push/live-activities/{live_id}"),
        (("GET",), "/push/heartbeat"),
        (("GET",), "/push/live-activities/content"),
        (("GET",), "/push/settings"),
        (("GET",), "/push/test/{request_id}"),
        (("POST",), "/push/devices"),
        (("POST",), "/push/live-activities"),
        (("POST",), "/push/test"),
    ]


# ------------------------------------------------------------------ Live Activity tokens

ACTIVITY = "8a1d3c55-7c2e-4f0b-9a57-2f3e0c7b1d42"
LIVE_TOKEN = "d4" * 40


def _live(device_id, **kw):
    return {
        "kind": "update",
        "token": LIVE_TOKEN,
        "environment": "sandbox",
        "bundle_id": BUNDLE,
        "device_id": device_id,
        "server": SERVER,
        "activity_id": ACTIVITY,
        **kw,
    }


def _registered(client):
    return client.post("/api/v1/push/devices", json=_device(), headers=H).json()[
        "device"
    ]["device_id"]


def test_live_activity_routes_need_a_login_and_a_configured_server(
    monkeypatch, tmp_path
):
    app = FastAPI()
    app.include_router(push_routes.router, prefix="/api/v1")
    anonymous = TestClient(ReadOnlyWeb(app, allow_push_devices=True))
    assert anonymous.post(
        "/api/v1/push/live-activities", json=_live("0" * 32)
    ).status_code in (401, 403)
    assert anonymous.delete("/api/v1/push/live-activities/" + "0" * 32).status_code in (
        401,
        403,
    )
    client, _ = _client(monkeypatch, tmp_path, configured=False)
    assert (
        client.post(
            "/api/v1/push/live-activities", json=_live("0" * 32), headers=H
        ).status_code
        == 503
    )
    assert (
        client.delete("/api/v1/push/live-activities/" + "0" * 32, headers=H).status_code
        == 503
    )


def test_register_a_live_activity_token_idempotently_and_unregister_it(
    monkeypatch, tmp_path
):
    client, registry = _client(monkeypatch, tmp_path)
    device_id = _registered(client)
    created = client.post(
        "/api/v1/push/live-activities", json=_live(device_id), headers=H
    )
    assert created.status_code == 201
    assert created.headers["cache-control"] == "no-store"
    live_id = created.json()["id"]
    assert set(created.json()) == {"id"} and len(live_id) == 32
    assert LIVE_TOKEN not in created.text
    again = client.post(
        "/api/v1/push/live-activities", json=_live(device_id), headers=H
    )
    assert again.status_code == 201 and again.json() == {"id": live_id}
    start = client.post(
        "/api/v1/push/live-activities",
        json=_live(device_id, kind="start", token="f6" * 40, activity_id=None),
        headers=H,
    )
    assert start.status_code == 201 and start.json()["id"] != live_id
    stored = registry.get_live_activity(live_id)
    assert (stored.kind, stored.activity_id, stored.device_id, stored.server) == (
        "update",
        ACTIVITY,
        device_id,
        SERVER,
    )
    deleted = client.delete(f"/api/v1/push/live-activities/{live_id}", headers=H)
    assert deleted.status_code == 204 and deleted.content == b""
    assert (
        client.delete(f"/api/v1/push/live-activities/{live_id}", headers=H).status_code
        == 404
    )
    # Unregistering the device (sign-out, stop alerts) removes its remaining tokens.
    assert (
        client.delete(f"/api/v1/push/devices/{device_id}", headers=H).status_code == 200
    )
    assert registry.get_live_activity(start.json()["id"]) is None


def test_live_activity_tokens_belong_to_the_devices_owner(monkeypatch, tmp_path):
    client, _ = _client(monkeypatch, tmp_path)
    device_id = _registered(client)
    live_id = client.post(
        "/api/v1/push/live-activities", json=_live(device_id), headers=H
    ).json()["id"]
    other, _ = _client(monkeypatch, tmp_path, user_id=2)
    assert (
        other.post(
            "/api/v1/push/live-activities",
            json=_live(device_id, token="e5" * 40),
            headers=H,
        ).status_code
        == 404
    )
    assert (
        other.delete(f"/api/v1/push/live-activities/{live_id}", headers=H).status_code
        == 404
    )


@pytest.mark.parametrize(
    "change,status",
    [
        ({"kind": "end"}, 422),
        ({"token": "not hex"}, 422),
        ({"token": "ab" * 8}, 422),
        ({"token": "ab" * 129}, 422),
        ({"environment": "staging"}, 422),
        ({"environment": "production"}, 422),  # not the device's environment
        ({"bundle_id": "com.other.app"}, 422),
        (
            {"bundle_id": BUNDLE + ".watch"},
            422,
        ),  # allowed by the server, not this device's
        ({"activity_id": None}, 422),
        ({"activity_id": "not-a-uuid"}, 422),
        ({"kind": "start"}, 422),  # a push-to-start token carries no activity id
        ({"device_id": "0" * 32}, 404),
        ({"device_id": "XYZ"}, 404),
        ({"unknown": 1}, 422),
        ({"server": None}, 422),
        ({"server": "x" * 101}, 422),
        ({"server": "../etc"}, 404),
        ({"server": "-leading-dash"}, 404),
        (
            {"server": "other-server"},
            404,
        ),  # no access: same answer as an unknown server
    ],
)
def test_invalid_live_activity_registrations_store_nothing(
    monkeypatch, tmp_path, change, status
):
    client, registry = _client(monkeypatch, tmp_path)
    device_id = _registered(client)
    body = {**_live(device_id), **change}
    response = client.post("/api/v1/push/live-activities", json=body, headers=H)
    assert response.status_code == status, response.text
    assert registry.active_live_activities() == []


def test_live_activities_need_an_environment_the_server_sends_to(monkeypatch, tmp_path):
    client, _ = _client(monkeypatch, tmp_path, environment="production")
    assert (
        client.post(
            "/api/v1/push/live-activities", json=_live("0" * 32), headers=H
        ).status_code
        == 422
    )


def test_a_watch_registration_takes_no_live_activity(monkeypatch, tmp_path):
    client, _ = _client(monkeypatch, tmp_path)
    watch = client.post(
        "/api/v1/push/devices",
        json=_device(TOKEN_W, platform="watch", bundle_id=WATCH_BUNDLE),
        headers=H,
    ).json()["device"]["device_id"]
    response = client.post(
        "/api/v1/push/live-activities",
        json=_live(watch, bundle_id=WATCH_BUNDLE),
        headers=H,
    )
    assert response.status_code == 422 and "iPhone" in response.text


def test_registration_requires_a_server(monkeypatch, tmp_path):
    client, registry = _client(monkeypatch, tmp_path)
    device_id = _registered(client)
    body = _live(device_id)
    del body["server"]
    response = client.post("/api/v1/push/live-activities", json=body, headers=H)
    assert response.status_code == 422 and "server" in response.text
    assert registry.active_live_activities() == []


# ------------------------------------------------------------------ Live Activity content


FULL = json.loads(
    (
        Path(__file__).parent
        / "fixtures"
        / "fleet_summary"
        / "summary_full.example.json"
    ).read_text()
)
SHARED_CONTENT = json.loads(
    (Path(__file__).parent / "fixtures" / "live_activity_content_v1.json").read_text()
)


def _content_client(
    monkeypatch, tmp_path, *, user_id=1, allow=True, index=None, full=FULL
):
    from condor.web.routes import fleet_summary as summary_routes

    client, _ = _client(monkeypatch, tmp_path, user_id=user_id, allow=allow)
    calls = []

    async def cached_summary(name, *, admin, user_id, view="full"):
        calls.append((name, admin, user_id, view))
        return full if view == "full" else summary_routes.summary.glance(full)

    async def never(server):
        raise AssertionError("the content route must not build the Market index")

    market = push_routes.live_activity_market
    monkeypatch.setattr(market, "_published", {})
    monkeypatch.setattr(market, "build_market_index", never)
    if index is not None:
        market.remember_index(SERVER, index, now=NOW - 30)
    monkeypatch.setattr(summary_routes, "get_config_manager", lambda: Servers())
    monkeypatch.setattr(summary_routes, "cached_summary", cached_summary)
    return client, calls


def test_content_route_serves_the_content_state_of_the_cached_glance(
    monkeypatch, tmp_path
):
    monkeypatch.delenv(
        "CONDOR_PUSH_LIVE_ACTIVITY", raising=False
    )  # default interval 60
    client, calls = _content_client(monkeypatch, tmp_path)
    response = client.get(
        "/api/v1/push/live-activities/content", params={"server": SERVER}, headers=H
    )
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    # The glance of the builder's full example is the glance example; its content state is
    # the shared fixture the app decodes.
    assert response.json() == SHARED_CONTENT  # no Market index published: omitted
    assert calls == [(SERVER, True, 1, "glance")]


def test_content_route_omits_stale_market_verdict_without_hiding_current_peers(
    monkeypatch, tmp_path
):
    full = copy.deepcopy(FULL)
    full["sections"]["market"].update(status="stale", reason="FRAME_STALE")
    full["market"]["frame"]["freshness"] = "stale"
    client, _ = _content_client(monkeypatch, tmp_path, full=full)
    body = client.get(
        "/api/v1/push/live-activities/content", params={"server": SERVER}, headers=H
    ).json()
    assert body["stale"] is False
    assert body["day_pnl"] == SHARED_CONTENT["day_pnl"]
    assert body["equity"] == SHARED_CONTENT["equity"]
    assert "market_label" not in body and "market_state" not in body


def test_content_route_adds_the_servers_market_index(monkeypatch, tmp_path):
    index = {
        "value": "101.23",
        "change_pct": "1.23",
        "stale": False,
        "spark": [100.0, 101.23],
        "pairs": 15,
        "expected": 15,
        "as_of_ms": int((NOW - 90) * 1000),
        "source_age_ms": 200_000,
        "source_age_at_ms": int((NOW - 30) * 1000),
    }
    monkeypatch.setenv(
        "CONDOR_PUSH_LIVE_ACTIVITY", '{"enabled": true, "interval_seconds": 90}'
    )
    client, _ = _content_client(monkeypatch, tmp_path, index=index)
    url, params = "/api/v1/push/live-activities/content", {"server": SERVER}
    body = client.get(url, params=params, headers=H).json()
    assert body == {
        **SHARED_CONTENT,
        "market_index": index,
    }  # 200 s + 30 s since: fresh
    # Published 120 s ago: still served (< 2 x 90 s), but 200 + 120 s is above 300 s.
    monkeypatch.setattr(push_routes, "_clock", lambda: NOW + 90)
    body = client.get(url, params=params, headers=H).json()
    assert body["market_index"] == {**index, "stale": True}
    # Published more than two intervals ago: omitted, and nothing is built in its place.
    monkeypatch.setattr(push_routes, "_clock", lambda: NOW + 151)
    assert "market_index" not in client.get(url, params=params, headers=H).json()


def test_content_route_needs_a_login_and_access_to_the_server(monkeypatch, tmp_path):
    app = FastAPI()
    app.include_router(push_routes.router, prefix="/api/v1")
    anonymous = TestClient(ReadOnlyWeb(app, allow_push_devices=True))
    assert anonymous.get(
        "/api/v1/push/live-activities/content", params={"server": SERVER}
    ).status_code in (401, 403)
    client, calls = _content_client(monkeypatch, tmp_path, user_id=3)
    for server in (SERVER, "unknown", "bad/name", "-x"):
        response = client.get(
            "/api/v1/push/live-activities/content", params={"server": server}, headers=H
        )
        assert response.status_code == 404, server
    assert (
        client.get("/api/v1/push/live-activities/content", headers=H).status_code == 422
    )
    assert calls == []


def test_content_route_is_a_read_that_needs_no_push_mutation_rights(
    monkeypatch, tmp_path
):
    client, calls = _content_client(monkeypatch, tmp_path, allow=False)
    response = client.get(
        "/api/v1/push/live-activities/content", params={"server": SERVER}, headers=H
    )
    assert response.status_code == 200 and len(calls) == 1


def test_content_route_reports_a_summary_deadline(monkeypatch, tmp_path):
    from condor.web.routes import fleet_summary as summary_routes

    client, _ = _client(monkeypatch, tmp_path)

    async def slow(name, *, admin, user_id, view="full"):
        raise TimeoutError

    monkeypatch.setattr(summary_routes, "get_config_manager", lambda: Servers())
    monkeypatch.setattr(summary_routes, "cached_summary", slow)
    response = client.get(
        "/api/v1/push/live-activities/content", params={"server": SERVER}, headers=H
    )
    assert response.status_code == 504
