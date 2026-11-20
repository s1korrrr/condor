"""One shared owner session per client, and Server-Timing on the V5 API routes."""

from __future__ import annotations

import asyncio
import re
import time
from concurrent.futures import Future
from contextlib import asynccontextmanager
from dataclasses import replace

import aiohttp
import httpx
import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer
from fastapi import HTTPException
from fastapi.testclient import TestClient

from condor.v5 import app as app_module
from condor.v5 import http_pool, read_bridge, timing
from condor.v5.app import create_app
from condor.v5.http_pool import SharedSession
from condor.v5.upstream import UpstreamError, V5Upstream
from test_v5_dashboard_bridge import ORIGIN, TOKEN, NoNetworkUpstream, make_settings
from test_v5_paper_binding import NOW, status, write_status
from test_v5_tradepad_bridge import CATALOG

CATALOG_PATH = "/api/v1/tradepad/catalog"
CAMPAIGN = "w1772323200-1790812800"
TIMING = re.compile(r'^app;dur=\d+\.\d{2}(, owner;dur=\d+\.\d{2};desc="calls=\d+")?(, parse;dur=\d+\.\d{2})?$')


class Owner:
    """A real local owner that remembers which TCP connection served each request."""

    def __init__(self, payload=None, delay=0.0):
        self.payload = {"ok": True} if payload is None else payload
        self.delay = delay
        self.transports = []

    async def handler(self, request):
        self.transports.append(request.transport)
        if self.delay:
            await asyncio.sleep(self.delay)
        return web.json_response(self.payload)

    @property
    def connections(self) -> int:
        return len({id(transport) for transport in self.transports})


@asynccontextmanager
async def serve(owner):
    application = web.Application()
    application.router.add_get("/{tail:.*}", owner.handler)
    async with TestServer(application) as server:
        yield str(server.make_url("/")).rstrip("/")


def owner_settings(tmp_path, base):
    return replace(make_settings(tmp_path), observation_base_url=base, advisor_control_base_url=base)


# ---- V5Upstream: one shared session -------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_sequential_owner_reads_share_one_connector(tmp_path, monkeypatch):
    built = []

    class Counting(aiohttp.TCPConnector):
        def __init__(self, *args, **kwargs):
            built.append(1)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(http_pool.aiohttp, "TCPConnector", Counting)
    owner = Owner()
    async with serve(owner) as base:
        upstream = V5Upstream(owner_settings(tmp_path, base))
        try:
            for _ in range(5):
                assert await upstream.observation("/v1/context") == {"ok": True}
        finally:
            await upstream.close()
    assert len(owner.transports) == 5
    assert len(built) == 1 and upstream._shared.created == 1
    assert owner.connections == 1


@pytest.mark.asyncio
async def test_an_injected_session_factory_still_opens_one_session_per_read(tmp_path):
    # The behaviour before the shared session: every read paid a new connection.
    owner = Owner()
    async with serve(owner) as base:
        upstream = V5Upstream(owner_settings(tmp_path, base), session_factory=aiohttp.ClientSession)
        for _ in range(5):
            await upstream.observation("/v1/context")
        await upstream.close()
    assert owner.connections == 5


@pytest.mark.asyncio
async def test_close_is_terminal_for_shared_reads(tmp_path, monkeypatch):
    owner = Owner()
    async with serve(owner) as base:
        upstream = V5Upstream(owner_settings(tmp_path, base))
        async with http_pool.lease(upstream._shared, None, aiohttp.ClientTimeout()) as (session, _):
            connector = session.connector
        await upstream.observation("/v1/context")
        started, release = asyncio.Event(), asyncio.Event()
        close = session.close

        async def pause_close():
            started.set()
            await release.wait()
            await close()

        monkeypatch.setattr(session, "close", pause_close)
        closing = asyncio.create_task(upstream.close())
        try:
            await asyncio.wait_for(started.wait(), timeout=2)
            with pytest.raises(RuntimeError, match="closed"):
                await upstream.observation("/v1/context")
        finally:
            release.set()
            await closing
        assert session.closed and connector.closed
        with pytest.raises(RuntimeError, match="closed"):
            await upstream.observation("/v1/context")
        assert upstream._shared.created == 1
        await upstream.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("close_first", [False, True], ids=["stopped-loop", "closed-runner"])
async def test_shutdown_closes_owner_transports_from_two_runners(close_first):
    async with serve(Owner()) as base:
        async def read(shared):
            async with http_pool.lease(shared, None, aiohttp.ClientTimeout(total=2)) as (session, extra):
                async with session.get(base, **extra) as response:
                    assert await response.json() == {"ok": True}
                connector = session.connector
                [(protocol, _)] = next(iter(connector._conns.values()))
                return session, connector, protocol.transport

        def exercise():
            shared = SharedSession()
            with asyncio.Runner() as first:
                first_session, first_connector, first_transport = first.run(read(shared))
                if close_first:
                    first.close()
                with asyncio.Runner() as second:
                    second_session, second_connector, second_transport = second.run(read(shared))
                    try:
                        assert first_session is not second_session
                        second.run(shared.close())
                        assert second_session.closed and second_connector.closed and second_transport.is_closing()
                        assert first_session.closed and first_connector.closed and first_transport.is_closing()
                    finally:
                        second.run(second_session.close())
                        if not close_first:
                            first.run(first_session.close())

        await asyncio.to_thread(exercise)


@pytest.mark.asyncio
async def test_shutdown_closes_a_session_on_another_running_loop():
    shared = SharedSession()
    ready = Future()

    async def hold_session():
        async with http_pool.lease(shared, None, aiohttp.ClientTimeout()) as (session, _):
            release = asyncio.Event()
            ready.set_result((asyncio.get_running_loop(), session, release))
            await release.wait()

    worker = asyncio.create_task(asyncio.to_thread(asyncio.run, hold_session()))
    loop, session, release = await asyncio.wait_for(asyncio.wrap_future(ready), timeout=2)
    try:
        await asyncio.wait_for(shared.close(), timeout=2)
        assert session.closed
    finally:
        loop.call_soon_threadsafe(release.set)
        await worker


@pytest.mark.asyncio
@pytest.mark.parametrize("reset_fresh_connection", [False, True])
async def test_report_post_uses_a_fresh_connection_when_the_idle_peer_closes(
    tmp_path, monkeypatch, reset_fresh_connection,
):
    owner = Owner()
    posts = []

    async def post(request):
        posts.append((request.transport, await request.json()))
        if reset_fresh_connection:
            request.transport.abort()
        return web.json_response({"queued": True})

    connect = aiohttp.TCPConnector.connect

    async def close_idle_peer(connector, request, **kwargs):
        connection = await connect(connector, request, **kwargs)
        if request.method == "POST":
            owner.transports[0].abort()
        return connection

    monkeypatch.setattr(aiohttp.TCPConnector, "connect", close_idle_peer)
    application = web.Application()
    application.router.add_get("/v1/context", owner.handler)
    application.router.add_post("/v1/assessments", post)
    async with TestServer(application) as server:
        base = str(server.make_url("/")).rstrip("/")
        upstream = V5Upstream(owner_settings(tmp_path, base))
        try:
            await upstream.observation("/v1/context")
            if reset_fresh_connection:
                with pytest.raises(UpstreamError, match="^upstream_unavailable$"):
                    await upstream.request_report("market_context", "snapshot-1")
            else:
                assert await upstream.request_report("market_context", "snapshot-1") == {"queued": True}
        finally:
            await upstream.close()
    assert len(posts) == 1
    assert posts[0][0] is not owner.transports[0]
    assert posts[0][1] == {"task_id": "market_context", "snapshot_id": "snapshot-1"}


@pytest.mark.asyncio
async def test_shared_connector_uses_the_ingress_keepalive_budget():
    shared = SharedSession()
    try:
        async with http_pool.lease(shared, None, aiohttp.ClientTimeout()) as (session, _):
            assert session.connector._keepalive_timeout == 2.0
    finally:
        await shared.close()


@pytest.mark.asyncio
async def test_a_timeout_still_fires_and_does_not_poison_the_shared_session(tmp_path):
    owner = Owner(delay=1.0)
    async with serve(owner) as base:
        settings = owner_settings(tmp_path, base)
        upstream = V5Upstream(settings)
        try:
            started = time.perf_counter()
            with pytest.raises(UpstreamError) as error:
                await upstream._request(base, "/v1/context", settings.observation_read_token_file, timeout_sec=0.2)
            assert error.value.code == "upstream_timeout"
            assert time.perf_counter() - started < 0.9
            owner.delay = 0.0
            assert await upstream.observation("/v1/context") == {"ok": True}
        finally:
            await upstream.close()


@pytest.mark.asyncio
async def test_each_read_keeps_its_own_deadline(tmp_path, monkeypatch):
    class Response:
        status = 200

        def __init__(self):
            self.body = b"{}"
            self.content = self

        async def read(self, size):
            chunk, self.body = self.body[:size], b""
            return chunk

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

    class Recording:
        def __init__(self):
            self.calls = []

        def request(self, method, url, **kwargs):
            self.calls.append((method, url, kwargs))
            return Response()

    @asynccontextmanager
    async def one_off(*, timeout):
        assert timeout.total == 12.0
        yield direct

    upstream = V5Upstream(make_settings(tmp_path))
    pooled, direct = Recording(), Recording()

    async def get():
        return pooled

    monkeypatch.setattr(aiohttp, "ClientSession", one_off)
    monkeypatch.setattr(upstream._shared, "get", get)
    await upstream.observation("/v1/context")
    await upstream.observation("/v1/paper/status")
    await upstream.request_report("market_context", "snapshot-1")
    assert [kwargs["timeout"].total for *_, kwargs in pooled.calls] == [5.0, 8.0]
    assert [method for method, *_ in direct.calls] == ["POST"]
    assert all(kwargs["allow_redirects"] is False for *_, kwargs in pooled.calls + direct.calls)


@pytest.mark.asyncio
async def test_the_shared_session_keeps_no_owner_cookies(tmp_path):
    async def cookie_owner(request):
        response = web.json_response({"cookie": request.headers.get("Cookie")})
        response.set_cookie("owner", "secret")
        return response

    application = web.Application()
    application.router.add_get("/v1/context", cookie_owner)
    async with TestServer(application) as server:
        base = str(server.make_url("/")).rstrip("/")
        upstream = V5Upstream(owner_settings(tmp_path, base))
        try:
            assert await upstream.observation("/v1/context") == {"cookie": None}
            assert await upstream.observation("/v1/context") == {"cookie": None}
        finally:
            await upstream.close()


# ---- read bridge ---------------------------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_bridge_reads_share_one_connector_when_given_a_shared_session():
    owner = Owner(payload=CATALOG)
    async with serve(owner) as base:
        shared = SharedSession()
        try:
            for _ in range(5):
                assert await read_bridge.read_tradepad(base, CATALOG_PATH, "catalog", shared)
        finally:
            await shared.close()
        assert owner.connections == 1 and shared.created == 1
        for _ in range(5):  # without one, each read opens its own session as before
            await read_bridge.read_tradepad(base, CATALOG_PATH, "catalog")
        assert owner.connections == 6


@pytest.mark.asyncio
async def test_bridge_timeout_still_fires_on_a_shared_session(monkeypatch):
    owner = Owner(payload=CATALOG, delay=1.0)
    monkeypatch.setattr(read_bridge, "TIMEOUT_SECONDS", 0.2)
    async with serve(owner) as base:
        shared = SharedSession()
        try:
            with pytest.raises(HTTPException) as error:
                await read_bridge.read_tradepad(base, CATALOG_PATH, "catalog", shared)
            assert error.value.status_code == 503 and "timed out" in error.value.detail
            owner.delay = 0.0
            assert await read_bridge.read_tradepad(base, CATALOG_PATH, "catalog", shared)
        finally:
            await shared.close()


@pytest.mark.asyncio
async def test_a_hung_bridge_owner_does_not_starve_the_other_owner(monkeypatch):
    arrived = asyncio.Queue()
    release = asyncio.Event()

    class HungOwner:
        async def handler(self, request):
            arrived.put_nowait(None)
            await release.wait()
            return web.json_response(CATALOG)

    monkeypatch.setattr(read_bridge, "TIMEOUT_SECONDS", 5.0)
    shared = SharedSession()
    async with serve(HungOwner()) as hung, serve(Owner(payload=CATALOG)) as healthy:
        reads = [asyncio.create_task(read_bridge.read_tradepad(hung, CATALOG_PATH, "catalog", shared)) for _ in range(36)]
        try:
            for _ in range(16):
                await asyncio.wait_for(arrived.get(), timeout=2.0)
            result = await asyncio.wait_for(read_bridge.read_tradepad(healthy, CATALOG_PATH, "catalog", shared), timeout=1.0)
            assert result
            assert arrived.empty()
        finally:
            release.set()
            await asyncio.gather(*reads, return_exceptions=True)
            await shared.close()


@pytest.mark.parametrize("store_raises", [False, True])
def test_app_shutdown_closes_the_upstream_and_the_bridge_session(tmp_path, monkeypatch, store_raises):
    closed = []

    class Spy(SharedSession):
        async def close(self):
            closed.append("bridge")
            await super().close()

    class Upstream(NoNetworkUpstream):
        async def close(self):
            closed.append("upstream")

    monkeypatch.setattr(app_module, "SharedSession", Spy)
    app = create_app(settings=make_settings(tmp_path), upstream=Upstream(), static_dir=tmp_path / "dist")
    if store_raises:
        def fail_close():
            raise RuntimeError("store close failed")

        monkeypatch.setattr(app.state.v5_state, "close", fail_close, raising=False)
        with pytest.raises(RuntimeError, match="store close failed"), TestClient(app):
            assert closed == []
    else:
        with TestClient(app):
            assert closed == []
    assert sorted(closed) == ["bridge", "upstream"]


# ---- Server-Timing -------------------------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_owner_reads_and_parses_are_summed_into_the_header(tmp_path):
    owner = Owner()
    async with serve(owner) as base:
        upstream = V5Upstream(owner_settings(tmp_path, base))
        current, token = timing.begin()
        try:
            for _ in range(3):
                await upstream.observation("/v1/context")
            timing.record_parse(0.0005)
        finally:
            timing.end(token)
            await upstream.close()
    header = current.header()
    assert TIMING.match(header), header
    assert 'desc="calls=3"' in header and "parse;dur=0.50" in header


def test_nothing_is_recorded_outside_a_timed_request():
    timing.record_owner(1.0)
    timing.record_parse(1.0)  # no active Timing: must not raise


class Down:
    """An owner that is unreachable: the routes answer their degraded state."""

    async def observation(self, path):
        raise UpstreamError("upstream_unavailable")

    async def task_profiles(self):
        raise UpstreamError("upstream_unavailable")

    async def latest_task_report(self, task_id):
        raise UpstreamError("upstream_unavailable")

    async def request_report(self, task_id, snapshot_id):
        raise UpstreamError("upstream_unavailable")


@pytest.mark.asyncio
async def test_v5_api_routes_answer_with_a_well_formed_server_timing_header(tmp_path):
    owner = Owner(payload=CATALOG)
    async with serve(owner) as base:
        settings = replace(
            make_settings(tmp_path),
            tradepad_url=base,
            tradepad_campaign_id=CAMPAIGN,
            paper_status_file=write_status(tmp_path, status()),
        )
        app = create_app(settings=settings, upstream=Down(), static_dir=tmp_path / "dist", clock=lambda: int(NOW * 1000))
        async with app.router.lifespan_context(app):
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                unauthorized = await client.get("/api/v5/money")
                assert unauthorized.status_code == 401 and TIMING.match(unauthorized.headers["server-timing"])
                login = await client.post("/api/v5/auth/login", json={"token": TOKEN}, headers={"Origin": ORIGIN})
                assert login.status_code == 200 and TIMING.match(login.headers["server-timing"])
                seen = {}
                for route in (
                    f"/api/v5/dashboard/read?path={CATALOG_PATH}",
                    "/api/v5/dashboard/profile",
                    "/api/v5/workspace",
                    "/api/v5/settings",
                    "/api/v5/money",
                    "/api/v5/candle-store/summary",  # no candle owner configured: a 404 is still timed
                ):
                    response = await client.get(route)
                    header = response.headers.get("server-timing")
                    assert header and TIMING.match(header), (route, response.status_code, header)
                    assert TOKEN not in header and "/" not in header and "http" not in header
                    seen[route] = header
                assert 'desc="calls=1"' in seen[f"/api/v5/dashboard/read?path={CATALOG_PATH}"]
                assert "parse;dur=" in seen["/api/v5/dashboard/profile"]
                assert "owner;" not in seen["/api/v5/money"]
                assert "server-timing" not in (await client.get("/health")).headers


@pytest.mark.asyncio
async def test_unhandled_v5_error_has_safe_headers_and_is_logged(tmp_path, caplog):
    app = create_app(settings=make_settings(tmp_path), upstream=Down(), static_dir=tmp_path / "dist")

    @app.get("/api/v5/test-error")
    async def fail():
        timing.record_owner(0.001)
        raise RuntimeError("private error detail")

    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/api/v5/test-error")
    assert response.status_code == 500
    assert response.text == "Internal Server Error"
    assert TIMING.match(response.headers["server-timing"])
    assert 'desc="calls=1"' in response.headers["server-timing"]
    assert response.headers["Cache-Control"] == "no-store"
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["Referrer-Policy"] == "no-referrer"
    assert response.headers["X-V5-Authority"] == "reports-only"
    assert "frame-ancestors 'none'" in response.headers["Content-Security-Policy"]
    assert "RuntimeError: private error detail" in caplog.text
