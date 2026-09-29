"""Gateway boundaries are tested without an engine, worker or exchange connection."""

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from condor.web.auth import get_current_user
from condor.web.models import WebUser
from condor.web.routes import market_picture as routes


class Upstream:
    def __init__(
        self,
        status=503,
        body=b'{"detail":{"reasons":["SOURCE_DISABLED"]}}',
        headers=None,
    ):
        self.status, self.body = status, body
        self.headers = {"Content-Type": "application/json", **(headers or {})}
        self.content = self

    async def iter_chunked(self, size):
        for start in range(0, len(self.body), size):
            await asyncio.sleep(0)
            yield self.body[start : start + size]

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False


def client_for(
    monkeypatch, response=None, *, access=True, authenticated=True, server_name="v2"
):
    calls = []

    class Session:
        def get(self, url, **kwargs):
            calls.append((url, kwargs))
            return response or Upstream()

    class Config:
        def has_server_access(self, user_id, name):
            return access and name == server_name and user_id == 7

        async def get_client(self, name):
            return SimpleNamespace(
                bot_orchestration=SimpleNamespace(
                    base_url="http://native/api/v1", session=Session()
                )
            )

    monkeypatch.setattr(routes, "get_config_manager", lambda: Config())
    app = FastAPI()
    app.include_router(routes.router, prefix="/api/v1")
    if authenticated:
        app.dependency_overrides[get_current_user] = lambda: WebUser(id=7, role="user")
    return TestClient(app), calls


def test_authentication_and_source_authorization_precede_network(monkeypatch):
    for auth, access in [(False, True), (True, False)]:
        client, calls = client_for(monkeypatch, authenticated=auth, access=access)
        assert client.get("/api/v1/servers/v2/market-picture/latest").status_code in {
            401,
            403,
            404,
        }
        assert calls == []


@pytest.mark.parametrize(
    "path",
    [
        "unknown",
        "latest?url=http://evil",
        "latest?limit=2&limit=3",
        "history?limit=9999",
        "snapshots/not-a-hash",
        "assets/BTC",
        "events?cursor=" + "a" * 4097,
    ],
)
def test_invalid_queries_do_not_reach_the_owner(monkeypatch, path):
    client, calls = client_for(monkeypatch)
    assert client.get("/api/v1/servers/v2/market-picture/" + path).status_code in {
        400,
        404,
        413,
    }
    assert calls == []


def test_disabled_source_is_typed_and_does_not_become_empty_market(monkeypatch):
    client, calls = client_for(monkeypatch)
    response = client.get("/api/v1/servers/v2/market-picture/latest")
    assert response.status_code == 503
    assert response.json() == {"detail": {"reasons": ["SOURCE_DISABLED"]}}
    assert calls[0][0] == "http://native/api/v1/screener/market-picture/v1/latest"
    assert calls[0][1]["allow_redirects"] is False


@pytest.mark.parametrize(
    "upstream",
    [
        Upstream(302, b""),
        Upstream(200, b"<html>", {"Content-Type": "text/html"}),
        Upstream(200, b'{"value":NaN}'),
        Upstream(200, b"{}"),
        Upstream(200, b"x" * (2 * 1024 * 1024 + 1)),
    ],
)
def test_untrusted_success_is_rejected(monkeypatch, upstream):
    client, _ = client_for(monkeypatch, upstream)
    assert client.get("/api/v1/servers/v2/market-picture/latest").status_code == 502


def test_upstream_errors_are_sanitized(monkeypatch):
    client, _ = client_for(monkeypatch, Upstream(500, b"password=private secret"))
    response = client.get("/api/v1/servers/v2/market-picture/latest")
    assert response.status_code == 502
    assert "private" not in response.text


def test_etag_revalidation_requires_same_client_tag(monkeypatch):
    tag = '"' + "a" * 64 + '"'
    client, calls = client_for(monkeypatch, Upstream(304, b"", {"ETag": tag}))
    assert client.get("/api/v1/servers/v2/market-picture/latest").status_code == 502
    response = client.get(
        "/api/v1/servers/v2/market-picture/latest", headers={"If-None-Match": tag}
    )
    assert response.status_code == 304
    assert response.headers["ETag"] == tag
    assert calls[-1][1]["headers"]["If-None-Match"] == tag


def test_stored_read_must_match_requested_snapshot(monkeypatch):
    import json

    body = {
        "schema_version": "market-picture.v1",
        "snapshot_id": "b" * 64,
        "items": [],
        "next_cursor": None,
        "read_at_ms": 1,
    }
    client, _ = client_for(monkeypatch, Upstream(200, json.dumps(body).encode()))
    response = client.get(
        "/api/v1/servers/v2/market-picture/events?snapshot_id=" + "a" * 64
    )
    assert response.status_code == 502


def test_stored_read_rejects_undeclared_data(monkeypatch):
    import json

    body = {
        "schema_version": "market-picture.v1",
        "snapshot_id": "a" * 64,
        "items": [],
        "next_cursor": None,
        "read_at_ms": 1,
        "debug": "untrusted",
    }
    client, _ = client_for(monkeypatch, Upstream(200, json.dumps(body).encode()))
    assert client.get("/api/v1/servers/v2/market-picture/events").status_code == 502


def test_cursor_principal_supports_server_labels_with_spaces_and_unicode(monkeypatch):
    from urllib.parse import quote

    name = "V2 Warszawa • spot"
    client, calls = client_for(monkeypatch, server_name=name)
    assert (
        client.get(
            f"/api/v1/servers/{quote(name, safe='')}/market-picture/latest"
        ).status_code
        == 503
    )
    value = calls[0][1]["headers"]["X-Market-Picture-Principal"]
    assert value.startswith("condor:") and value.endswith(":7")
    assert value.isascii() and not any(char.isspace() for char in value)
