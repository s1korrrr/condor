from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from condor.web.auth import get_current_user
from condor.web.models import WebUser


class Response:
    def __init__(self, status, payload):
        self.status, self.payload = status, payload

    async def __aenter__(self):
        if isinstance(self.payload, Exception):
            raise self.payload
        return self

    async def __aexit__(self, *args):
        pass

    async def json(self):
        return self.payload


def make_client(
    monkeypatch,
    *,
    health=None,
    result=None,
    status=200,
    access=True,
    authenticated=True,
):
    from condor.web.read_only import ReadOnlyWeb
    from condor.web.routes import bots

    calls = []
    health = (
        health
        if health is not None
        else {
            "status": "ok",
            "profile": "native",
            "capabilities": {
                "native_controls_enabled": True,
                "native_start": True,
                "native_stop": True,
            },
        }
    )
    result = (
        result
        if result is not None
        else {
            "status": "success",
            "response": {
                "execution_verified": True,
                "acknowledgement": {"accepted": True, "state": "running"},
            },
        }
    )

    class Session:
        def get(self, url, **kwargs):
            calls.append(("GET", url, kwargs))
            return Response(
                200,
                (
                    health
                    if url.endswith("/health")
                    else {
                        "status": "success",
                        "data": {
                            "bot_name": "ok_rsi",
                            "lifecycle": {"valid": True, "state": "running"},
                        },
                    }
                ),
            )

        def post(self, url, **kwargs):
            calls.append(("POST", url, kwargs))
            return Response(status, result)

    class Config:
        def has_server_access(self, user_id, server):
            return access and server == "native-ok-rsi"

        async def get_client(self, name):
            return SimpleNamespace(
                bot_orchestration=SimpleNamespace(
                    session=Session(), base_url="http://private-api"
                )
            )

    monkeypatch.setattr(bots, "get_config_manager", lambda: Config())
    app = FastAPI()
    app.include_router(bots.router, prefix="/api/v1")
    if authenticated:
        app.dependency_overrides[get_current_user] = lambda: WebUser(id=1, role="admin")
    return TestClient(ReadOnlyWeb(app, allow_native_lifecycle=True)), calls


@pytest.mark.parametrize("action", ["start", "stop"])
@pytest.mark.parametrize("status", [200, 202, 403, 409])
def test_native_routes_preserve_owner_status_and_only_forward_exact_identity(
    monkeypatch, action, status
):
    expected = {
        "status": "unknown" if status == 202 else "owner-result",
        "response": {
            "execution_verified": status == 200,
            "outcome_unknown": status == 202,
            "acknowledgement": {"request_id": "owner-id"},
        },
    }
    client, calls = make_client(monkeypatch, result=expected, status=status)
    response = client.post(
        f"/api/v1/servers/native-ok-rsi/bots/ok_rsi/native/{action}", json={}
    )
    assert response.status_code == status
    assert response.json() == expected
    assert response.headers["cache-control"] == "no-store"
    assert len(calls) == 2
    assert calls[0][1] == "http://private-api/health"
    assert calls[1][1] == f"http://private-api/bot-orchestration/{action}-bot"
    assert calls[1][2]["json"] == {"bot_name": "ok_rsi"}
    assert calls[0][2]["allow_redirects"] is False
    assert calls[1][2]["allow_redirects"] is False


@pytest.mark.parametrize(
    "authenticated,access,expected", [(False, True, 401), (True, False, 404)]
)
def test_native_routes_require_auth_and_source_access_before_client_reads(
    monkeypatch, authenticated, access, expected
):
    client, calls = make_client(monkeypatch, authenticated=authenticated, access=access)
    response = client.post("/api/v1/servers/native-ok-rsi/bots/ok_rsi/native/start")
    assert (
        response.status_code in (401, 403)
        if expected == 401
        else response.status_code == expected
    )
    assert calls == []


@pytest.mark.parametrize(
    "health",
    [
        {
            "status": "ok",
            "profile": "full",
            "capabilities": {"native_controls_enabled": True, "native_start": True},
        },
        {
            "status": "ok",
            "profile": "native",
            "capabilities": {"native_controls_enabled": False, "native_start": True},
        },
        {
            "status": "ok",
            "profile": "native",
            "capabilities": {"native_controls_enabled": True, "native_start": "true"},
        },
        {"status": "ok", "profile": "native"},
        {
            "status": "offline",
            "profile": "native",
            "capabilities": {"native_controls_enabled": True, "native_start": True},
        },
    ],
)
def test_native_routes_fail_closed_without_current_native_capability(
    monkeypatch, health
):
    client, calls = make_client(monkeypatch, health=health)
    assert (
        client.post(
            "/api/v1/servers/native-ok-rsi/bots/ok_rsi/native/start"
        ).status_code
        == 409
    )
    assert len(calls) == 1


@pytest.mark.parametrize(
    "body",
    [
        {"script": "different.py"},
        {"skip_order_cancellation": True},
        {"bot_name": "other"},
    ],
)
def test_native_route_rejects_configuration_or_identity_overrides(monkeypatch, body):
    client, calls = make_client(monkeypatch)
    assert (
        client.post(
            "/api/v1/servers/native-ok-rsi/bots/ok_rsi/native/start", json=body
        ).status_code
        == 422
    )
    assert calls == []


def test_native_status_is_read_only_and_preserves_owner_lifecycle(monkeypatch):
    client, calls = make_client(monkeypatch)
    response = client.get("/api/v1/servers/native-ok-rsi/bots/ok_rsi/native/status")
    assert response.status_code == 200
    assert response.json()["data"]["lifecycle"] == {"valid": True, "state": "running"}
    assert all(call[0] == "GET" for call in calls)
    assert calls[-1][1] == "http://private-api/bot-orchestration/ok_rsi/status"


def test_native_command_transport_timeout_is_unknown_without_retry(monkeypatch):
    client, calls = make_client(
        monkeypatch, result=TimeoutError("private backend detail")
    )
    response = client.post("/api/v1/servers/native-ok-rsi/bots/ok_rsi/native/stop")
    assert response.status_code == 202
    assert response.json()["response"]["outcome_unknown"] is True
    assert response.json()["response"]["execution_verified"] is False
    assert "private backend detail" not in response.text
    assert len(calls) == 2


def test_native_read_remains_available_when_controls_are_disabled(monkeypatch):
    client, calls = make_client(
        monkeypatch,
        health={
            "status": "ok",
            "profile": "native",
            "capabilities": {"native_controls_enabled": False},
        },
    )
    assert (
        client.get(
            "/api/v1/servers/native-ok-rsi/bots/ok_rsi/native/status"
        ).status_code
        == 200
    )
    assert len(calls) == 2
    assert all(call[0] == "GET" for call in calls)


@pytest.mark.parametrize("authenticated,access", [(False, True), (True, False)])
def test_native_status_requires_auth_and_access(monkeypatch, authenticated, access):
    client, calls = make_client(monkeypatch, authenticated=authenticated, access=access)
    assert client.get(
        "/api/v1/servers/native-ok-rsi/bots/ok_rsi/native/status"
    ).status_code in (401, 403, 404)
    assert calls == []


@pytest.mark.parametrize("status", [302, 307, 308])
def test_native_redirect_is_an_unknown_outcome_not_a_second_request(
    monkeypatch, status
):
    client, calls = make_client(monkeypatch, status=status)
    response = client.post("/api/v1/servers/native-ok-rsi/bots/ok_rsi/native/start")
    assert response.status_code == 202
    assert response.json()["response"]["outcome_unknown"] is True
    assert len(calls) == 2
