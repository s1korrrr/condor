from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from test_web_native_lifecycle import Response

from condor.web.auth import get_current_user
from condor.web.models import WebUser
from condor.web.read_only import ReadOnlyWeb


def client(
    monkeypatch, *, admin=True, access=True, enabled=True, allowed=True, code=202
):
    from condor.web.routes import native_entry

    calls = []

    class Session:
        def get(self, url, **kwargs):
            calls.append(("GET", url, kwargs))
            return Response(
                200,
                (
                    {
                        "status": "ok",
                        "profile": "native",
                        "native_bots": {
                            "rsi_v2": {
                                "controller_name": "rsi_modular",
                                "profile": "ok_rsi",
                                "execution_mode": "live",
                                "entry_controls": allowed,
                            }
                        },
                    }
                    if url.endswith("/health")
                    else {
                        "status": "success",
                        "data": {"bot_name": "rsi_v2", "controllers": []},
                    }
                ),
            )

        def post(self, url, **kwargs):
            calls.append(("POST", url, kwargs))
            return Response(
                code, {"publication_accepted": code == 202, "execution_verified": False}
            )

    cm = SimpleNamespace(
        is_admin=lambda user: admin, has_server_access=lambda user, name: access
    )

    async def get_client(name):
        return SimpleNamespace(
            bot_orchestration=SimpleNamespace(
                session=Session(), base_url="http://native-api"
            )
        )

    cm.get_client = get_client
    monkeypatch.setattr(native_entry, "get_config_manager", lambda: cm)
    app = FastAPI()
    app.include_router(native_entry.router, prefix="/api/v1")
    app.dependency_overrides[get_current_user] = lambda: WebUser(
        id=1, role="admin" if admin else "user"
    )
    return TestClient(ReadOnlyWeb(app, allow_native_entry=enabled)), calls


@pytest.mark.parametrize("action", ["pause", "resume", "acknowledge-daily-loss"])
@pytest.mark.parametrize("code", [202, 409])
def test_exact_owner_entry_mapping_preserves_publication_or_rejection(
    monkeypatch, action, code
):
    c, calls = client(monkeypatch, code=code)
    response = c.post(
        f"/api/v1/servers/v2/bots/rsi_v2/native/entries/{action}",
        json={"command_id": "id-1"},
    )
    assert response.status_code == code
    assert response.json()["execution_verified"] is False
    assert calls[-1][1] == f"http://native-api/mobile-controls/rsi/bots/rsi_v2/{action}"
    assert calls[-1][2]["json"] == {
        "command_id": "id-1",
        "requested_by": "condor-web:1",
    }
    assert calls[-1][2]["allow_redirects"] is False


@pytest.mark.parametrize(
    "changes,code",
    [
        ({"admin": False}, 403),
        ({"access": False}, 404),
        ({"enabled": False}, 403),
        ({"allowed": False}, 409),
    ],
)
def test_entry_guards_reject_before_publication(monkeypatch, changes, code):
    c, calls = client(monkeypatch, **changes)
    assert (
        c.post(
            "/api/v1/servers/v2/bots/rsi_v2/native/entries/pause",
            json={"command_id": "id-1"},
        ).status_code
        == code
    )
    assert not any(call[0] == "POST" for call in calls)


def test_unknown_owner_and_unsupported_commands_rejected(monkeypatch):
    c, calls = client(monkeypatch)
    assert (
        c.post(
            "/api/v1/servers/v2/bots/other/native/entries/pause",
            json={"command_id": "id-1"},
        ).status_code
        == 409
    )
    assert (
        c.post(
            "/api/v1/servers/v2/bots/rsi_v2/native/entries/global-resume", json={}
        ).status_code
        == 403
    )
    assert (
        c.post(
            "/api/v1/servers/v2/bots/rsi_v2/native/entries/resume",
            json={"command_id": "x", "controller_id": "foreign"},
        ).status_code
        == 422
    )
    assert (
        c.get("/api/v1/servers/v2/bots/rsi_v2/native/entries/status").json()["data"][
            "bot_name"
        ]
        == "rsi_v2"
    )


def test_entry_authentication_required_before_any_backend_read(monkeypatch):
    c, calls = client(monkeypatch)
    c.app.app.dependency_overrides.clear()
    assert c.post(
        "/api/v1/servers/v2/bots/rsi_v2/native/entries/pause", json={"command_id": "x"}
    ).status_code in {401, 403}
    assert calls == []


def test_read_only_status_does_not_advertise_disabled_entry_mutations(monkeypatch):
    c, _ = client(monkeypatch, enabled=False)
    result = c.get("/api/v1/servers/v2/bots/rsi_v2/native/entries/status")
    assert result.status_code == 200
    assert result.json()["command_allowed"] is False
