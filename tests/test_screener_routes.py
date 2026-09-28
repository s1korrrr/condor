import asyncio
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from condor.web.auth import get_current_user
from condor.web.models import WebUser
from condor.web.routes import screener as routes


class Content:
    def __init__(self, body):
        self.body = body

    async def iter_chunked(self, size):
        for offset in range(0, len(self.body), size):
            await asyncio.sleep(0)
            yield self.body[offset : offset + size]


class Upstream:
    def __init__(self, status=200, body=b'{"ok":true}', content_type="application/json"):
        self.status = status
        self.headers = {"Content-Type": content_type}
        self.content = Content(body)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class Session:
    def __init__(self, response=None):
        self.response = response or Upstream()
        self.calls = []

    def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self.response


def make_client(monkeypatch, *, authenticated=True, access=True, response=None):
    session = Session(response)

    class Config:
        def has_server_access(self, user_id, server):
            return access and server == "v2"

        async def get_client(self, server):
            return SimpleNamespace(bot_orchestration=SimpleNamespace(base_url="http://native/api/v1", session=session))

    monkeypatch.setattr(routes, "get_config_manager", lambda: Config())
    app = FastAPI()
    app.include_router(routes.router, prefix="/api/v1")
    if authenticated:
        app.dependency_overrides[get_current_user] = lambda: WebUser(id=7, role="user")
    return TestClient(app), session


def test_screener_gateway_requires_authentication_and_server_access(monkeypatch):
    anonymous, _ = make_client(monkeypatch, authenticated=False)
    assert anonymous.get("/api/v1/servers/v2/screener/capabilities?bot=alpha").status_code in {401, 403}
    denied, _ = make_client(monkeypatch, access=False)
    assert denied.get("/api/v1/servers/v2/screener/capabilities?bot=alpha").status_code == 404


def test_screener_gateway_maps_only_fixed_native_gets(monkeypatch):
    client, session = make_client(monkeypatch)
    response = client.get(
        "/api/v1/servers/v2/screener/snapshot?bot=alpha&screen=rsi_low&interval=1m&limit=100&search=BTC"
    )
    assert response.status_code == 200
    url, options = session.calls[0]
    assert url == "http://native/api/v1/market-screener/snapshot"
    assert options["params"] == [
        ("screen", "rsi_low"), ("interval", "1m"), ("limit", "100"),
        ("search", "BTC"), ("bot", "alpha"),
    ]
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"


def test_screener_source_index_is_server_scoped_and_does_not_need_a_client_bot_choice(monkeypatch):
    client, session = make_client(monkeypatch)
    response = client.get("/api/v1/servers/v2/screener/capabilities")
    assert response.status_code == 200
    assert session.calls[0][0] == "http://native/api/v1/market-screener/capabilities"
    assert session.calls[0][1]["params"] == []


@pytest.mark.parametrize(
    "suffix,query,status",
    [
        ("not-listed", "bot=alpha", 404),
        ("instruments", "bot=alpha", 404),
        ("instruments/../../health", "bot=alpha", 404),
        ("capabilities", "bot=alpha&bot=beta", 400),
        ("snapshot", "bot=alpha&screen=all&screen=rsi_low", 400),
        ("snapshot", "bot=alpha&arbitrary_url=http://example.com", 400),
        ("candles", "bot=alpha&instrument_id=BTC-USDC", 400),
        ("snapshot", "bot=alpha&screen=watchlist&watchlist_ids=not-qualified", 400),
    ],
)
def test_screener_gateway_rejects_unknown_or_ambiguous_inputs(monkeypatch, suffix, query, status):
    client, session = make_client(monkeypatch)
    response = client.get(f"/api/v1/servers/v2/screener/{suffix}?{query}")
    assert response.status_code == status
    assert not session.calls


def test_screener_gateway_rejects_redirect_and_non_json(monkeypatch):
    client, _ = make_client(monkeypatch, response=Upstream(302, b"", "text/plain"))
    response = client.get("/api/v1/servers/v2/screener/health?bot=alpha")
    assert response.status_code == 502
    html, _ = make_client(monkeypatch, response=Upstream(200, b"<html>login</html>", "text/html"))
    assert html.get("/api/v1/servers/v2/screener/health?bot=alpha").status_code == 502


def test_screener_gateway_bounds_response_bytes(monkeypatch):
    monkeypatch.setattr(routes, "JSON_MAX_BYTES", 16)
    client, _ = make_client(monkeypatch, response=Upstream(200, b"x" * 17))
    response = client.get("/api/v1/servers/v2/screener/health?bot=alpha")
    assert response.status_code == 502

@pytest.mark.parametrize('instrument', ['okx:spot:A-USDC', 'okx:spot:' + 'A' * 30 + '-USDC'])
def test_gateway_accepts_reader_instrument_lengths(monkeypatch, instrument):
    client, session = make_client(monkeypatch)
    assert client.get('/api/v1/servers/v2/screener/candles', params={'bot':'alpha', 'instrument_id':instrument}).status_code == 200
    assert session.calls


def test_gateway_rejects_foreign_quote_watchlist(monkeypatch):
    client, session = make_client(monkeypatch)
    assert client.get('/api/v1/servers/v2/screener/snapshot', params={'bot':'alpha', 'watchlist_ids':'okx:spot:BTC-USDT'}).status_code == 400
    assert not session.calls
