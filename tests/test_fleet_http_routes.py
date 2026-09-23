"""Fleet HTTP routes retain Condor authentication and server scoping."""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from condor.web.auth import get_current_user
from condor.web.models import WebUser
from condor.web.routes import fleet


def _client(monkeypatch, *, authenticated=True, access=True, client=None):
    class Config:
        def has_server_access(self, user_id, name):
            return access and user_id == 7 and name == "local"

        async def get_client(self, name):
            return client

    monkeypatch.setattr(fleet, "get_config_manager", lambda: Config())
    app = FastAPI()
    app.include_router(fleet.router, prefix="/api/v1")
    if authenticated:
        app.dependency_overrides[get_current_user] = lambda: WebUser(id=7, role="admin")
    return TestClient(app)


def test_fleet_routes_require_authentication(monkeypatch):
    http = _client(monkeypatch, authenticated=False)
    assert http.get("/api/v1/servers/local/fleet/bots").status_code in (401, 403)
    assert http.get("/api/v1/servers/local/fleet/bots/a").status_code in (401, 403)


def test_fleet_routes_hide_inaccessible_server_before_source_read(monkeypatch):
    http = _client(monkeypatch, access=False)
    assert http.get("/api/v1/servers/local/fleet/bots").status_code == 404
    assert http.get("/api/v1/servers/local/fleet/bots/a").status_code == 404


def test_fleet_list_returns_complete_visible_revision(monkeypatch):
    paths = []

    async def read_path(_client, path):
        paths.append(path)
        if len(paths) == 1:
            return {"catalogue_revision": "rev-1", "items": [{"bot_key": "a"}], "count": 2, "cursor": "next"}
        return {"catalogue_revision": "rev-1", "items": [{"bot_key": "b"}], "count": 2, "cursor": None}

    monkeypatch.setattr(fleet, "_read_fleet_path", read_path)
    response = _client(monkeypatch, client=object()).get("/api/v1/servers/local/fleet/bots")
    assert response.status_code == 200
    body = response.json()
    assert [bot["bot_key"] for bot in body["bots"]] == ["a", "b"]
    assert body["command_available"] is False
    assert body["aggregated_pnl"] is None
    assert paths == ["/fleet/v1/bots?limit=100", "/fleet/v1/bots?limit=100&cursor=next"]


def test_fleet_list_displays_unavailable_after_later_page_fails(monkeypatch):
    calls = 0

    async def read_path(_client, _path):
        nonlocal calls
        calls += 1
        if calls == 1:
            return {"catalogue_revision": "rev-1", "items": [{"bot_key": "a"}], "count": 2, "cursor": "next"}
        return {"items": [], "reason_code": "source_unavailable"}

    monkeypatch.setattr(fleet, "_read_fleet_path", read_path)
    response = _client(monkeypatch, client=object()).get("/api/v1/servers/local/fleet/bots")
    assert response.status_code == 200
    assert response.json()["bots"] == []
    assert response.json()["reason_code"] == "source_unavailable"
