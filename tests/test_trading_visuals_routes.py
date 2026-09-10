import json

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from condor.web.auth import get_current_user
from condor.web.models import WebUser


@pytest.mark.parametrize("failure", ["oversized", "trickle"])
def test_visuals_stream_is_bounded_and_closed(monkeypatch, failure):
    import asyncio
    from condor.web.routes import trading_visuals as routes

    monkeypatch.setattr(routes, "REPORTING_MAX_BYTES", 48, raising=False)
    monkeypatch.setattr(routes, "REPORTING_TOTAL_TIMEOUT", 0.035, raising=False)

    class Stream(httpx.AsyncByteStream):
        closed = False

        async def __aiter__(self):
            for _ in range(5):
                if failure == "trickle":
                    await asyncio.sleep(0.015)
                yield b"x" * (32 if failure == "oversized" else 1)

        async def aclose(self):
            self.closed = True

    stream = Stream()
    result = client(
        monkeypatch,
        handler=lambda _: httpx.Response(
            200, stream=stream, headers={"content-type": "text/csv"}
        ),
    ).get("/api/v1/trading-visuals/export/orders.csv?bot=ok_rsi")
    assert result.status_code == 502
    assert stream.closed
    assert "detail" in result.json()


def test_visuals_accepts_three_megabyte_chart(monkeypatch):
    payload = {"points": "x" * (3 * 1024 * 1024)}
    result = client(
        monkeypatch, handler=lambda _: httpx.Response(200, json=payload)
    ).get("/api/v1/trading-visuals/chart-series?bot=ok_rsi")
    assert result.status_code == 200
    assert result.json() == payload


@pytest.mark.asyncio
async def test_visuals_cancellation_closes_stream(monkeypatch):
    import asyncio

    entered = asyncio.Event()

    class Stream(httpx.AsyncByteStream):
        closed = False

        async def __aiter__(self):
            yield b"id,pnl\n"
            entered.set()
            await asyncio.Event().wait()

        async def aclose(self):
            self.closed = True

    stream = Stream()
    fixture = client(
        monkeypatch,
        handler=lambda _: httpx.Response(
            200, stream=stream, headers={"content-type": "text/csv"}
        ),
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=fixture.app), base_url="http://fixture"
    ) as http:
        task = asyncio.create_task(
            http.get("/api/v1/trading-visuals/export/orders.csv?bot=ok_rsi")
        )
        try:
            await asyncio.wait_for(entered.wait(), 1)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert stream.closed
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


def client(monkeypatch, *, access=True, authenticated=True, admin=True, handler=None):
    from condor.web.routes import trading_visuals as routes

    monkeypatch.setenv('CONDOR_TRADING_VISUALS_SOURCES', json.dumps({
        'ok_rsi': {'server': 'local', 'url': 'http://127.0.0.1:5011/api/v1'},
        'ok_rsi_sui_sell_only': {'server': 'local', 'url': 'http://127.0.0.1:5012/api/v1'},
    }))
    class Config:
        def is_admin(self, user_id):
            return admin
        def has_server_access(self, user_id, server):
            return access and server == 'local'
    monkeypatch.setattr(routes, 'get_config_manager', lambda: Config())
    transport = httpx.MockTransport(handler or (lambda req: httpx.Response(200, json={'path': req.url.path})))
    monkeypatch.setattr(routes, '_client', lambda: httpx.AsyncClient(transport=transport))
    app = FastAPI()
    app.include_router(routes.router, prefix='/api/v1')
    if authenticated:
        app.dependency_overrides[get_current_user] = lambda: WebUser(id=1, role='admin')
    return TestClient(app)


def test_visuals_requires_authentication(monkeypatch):
    assert client(monkeypatch, authenticated=False).get('/api/v1/trading-visuals/bootstrap').status_code in (401, 403)


def test_visuals_enforces_source_server_access(monkeypatch):
    c = client(monkeypatch, access=False)
    assert c.get('/api/v1/trading-visuals/sources').json() == {'sources': []}
    assert c.get('/api/v1/trading-visuals/bootstrap?bot=ok_rsi').status_code == 404


def test_visuals_routes_exact_bot_and_strips_credentials(monkeypatch):
    def handler(req):
        assert req.url.port == 5012
        assert req.url.path == '/api/v1/bootstrap'
        assert req.url.params['bot'] == 'ok_rsi_sui_sell_only'
        assert 'authorization' not in req.headers
        assert 'cookie' not in req.headers
        return httpx.Response(200, json={'timestamp': 123, 'pnl': None})
    response = client(monkeypatch, handler=handler).get(
        '/api/v1/trading-visuals/bootstrap?bot=ok_rsi_sui_sell_only',
        headers={'Authorization': 'Bearer private', 'Cookie': 'private=value'},
    )
    assert response.json() == {'timestamp': 123, 'pnl': None}
    assert response.headers['cache-control'] == 'no-store'


@pytest.mark.parametrize('path', ['controls', 'screener/bootstrap', 'export/incidents.csv', 'drilldown/not-an-id'])
def test_visuals_rejects_unlisted_reads(monkeypatch, path):
    assert client(monkeypatch).get('/api/v1/trading-visuals/' + path).status_code == 404


@pytest.mark.parametrize('method', ['post', 'put', 'delete', 'patch'])
def test_visuals_rejects_mutations(monkeypatch, method):
    assert getattr(client(monkeypatch), method)('/api/v1/trading-visuals/bootstrap').status_code == 405


def test_visuals_unknown_bot_does_not_fall_back(monkeypatch):
    assert client(monkeypatch).get('/api/v1/trading-visuals/bootstrap?bot=unknown').status_code == 404


def test_visuals_unavailable_upstream_is_not_cached_success(monkeypatch):
    def handler(req):
        raise httpx.ConnectError('private address detail', request=req)
    response = client(monkeypatch, handler=handler).get('/api/v1/trading-visuals/bootstrap')
    assert response.status_code == 502
    assert 'private address' not in response.text


def test_visuals_does_not_forward_redirects(monkeypatch):
    response = client(monkeypatch, handler=lambda req: httpx.Response(302, headers={'location': 'https://example.com'})).get('/api/v1/trading-visuals/bootstrap')
    assert response.status_code == 502


def test_visuals_exports_keep_download_semantics(monkeypatch):
    response = client(monkeypatch, handler=lambda req: httpx.Response(200, text='id,pnl\n1,\n', headers={'content-type': 'text/csv'})).get('/api/v1/trading-visuals/export/orders.csv')
    assert response.text == 'id,pnl\n1,\n'
    assert 'orders.csv' in response.headers['content-disposition']


def test_visuals_api_hop_uses_only_configured_backend_credentials(monkeypatch):
    def handler(req):
        assert req.url.path == '/trading-visuals/bootstrap'
        assert req.headers['authorization'] == 'Basic YXBpLXVzZXI6YXBpLXBhc3M='
        return httpx.Response(200, json={'pnl': None})
    c = client(monkeypatch, handler=handler)
    monkeypatch.setenv('TEST_API_USERNAME', 'api-user')
    monkeypatch.setenv('TEST_API_PASSWORD', 'api-pass')
    monkeypatch.setenv('CONDOR_TRADING_VISUALS_SOURCES', json.dumps({
        'ok_rsi': {'server': 'local', 'url': 'http://127.0.0.1:8000/trading-visuals',
                   'username_env': 'TEST_API_USERNAME', 'password_env': 'TEST_API_PASSWORD'},
    }))
    assert c.get('/api/v1/trading-visuals/bootstrap').json() == {'pnl': None}


@pytest.mark.parametrize('admin,access,status', [(False,True,403),(True,False,404),(True,True,200)])
def test_operations_requires_admin_and_source_access(monkeypatch,admin,access,status):
    result=client(monkeypatch,admin=admin,access=access).get('/api/v1/trading-visuals/operations?bot=ok_rsi')
    assert result.status_code == status
    if status == 200:
        assert result.json()['path'] == '/api/v1/operations'
        assert result.headers['cache-control'] == 'no-store'


def test_operations_rejects_duplicate_bot_and_unknown_source(monkeypatch):
    c=client(monkeypatch)
    assert c.get('/api/v1/trading-visuals/operations?bot=ok_rsi&bot=ok_rsi').status_code == 400
    assert c.get('/api/v1/trading-visuals/operations?bot=unknown').status_code == 404
    assert c.post('/api/v1/trading-visuals/operations?bot=ok_rsi').status_code == 405
