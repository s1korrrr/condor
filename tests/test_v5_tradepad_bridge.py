from dataclasses import replace
import hashlib
import json
import asyncio
import base64
import io
import struct
import zlib
from http.client import HTTPResponse

import aiohttp
import pytest
from fastapi.testclient import TestClient

from condor.v5.app import create_app
from condor.v5 import read_bridge
from test_v5_dashboard_bridge import make_settings, NoNetworkUpstream, TOKEN, ORIGIN

CATALOG = {"schema": "condor.tradepad.catalog.v1", "bundles": [], "errors": []}

def test_nested_records_are_validated():
    assert not read_bridge.valid_tradepad("catalog", {**CATALOG, "bundles": [None]})
    campaign = {"schema": "tradepad.bundle.v2", "delivery": "deferred-assets-v1", "campaign": {"id": "w1-2"}, "datasets": [{"id": "w1-2", "source_index": [], "strategies": [{"id": "x", "label": "x", "metrics": {"pnl": {}}, "source_basis": []}], "metrics_only": []}]}
    assert not read_bridge.valid_tradepad("campaign", campaign)
    campaign["datasets"][0]["strategies"][0]["source_basis"] = "basis"
    assert not read_bridge.valid_tradepad("campaign", campaign)
    campaign["datasets"][0]["strategies"][0]["metrics"] = {"pnl": "1.00"}
    assert read_bridge.valid_tradepad("campaign", campaign)


@pytest.mark.parametrize("path", ["https://evil.invalid/api/v1/tradepad/catalog", "//evil.invalid/api/v1/tradepad/catalog", "/api/v1/tradepad/../catalog", "/api/v1/tradepad/campaigns/w1-2?%64elivery=deferred-assets-v1"])
def test_rejects_unsafe_paths(path):
    from fastapi import HTTPException
    with pytest.raises(HTTPException):
        read_bridge.tradepad_route(path, "w1-2")


def test_asset_accepts_owner_urlsearchparams_encoded_values():
    path = f"/api/v1/tradepad/bundles/example/asset?source={'a' * 64}&dataset=test%7Eone&pair=BNBUSDC&kind=pair&sha256={'b' * 64}&strategy=one%3A%3Atwo"
    owner_path, kind = read_bridge.tradepad_route(path)
    assert kind == "asset" and "dataset=test~one" in owner_path and "strategy=one%3A%3Atwo" in owner_path


def test_campaign_collection_limit(tmp_path, monkeypatch):
    payload = ROUTES[3][1].copy()
    dataset = {**payload["datasets"][0], "strategies": [{"id": "1", "label": "one"}, {"id": "2", "label": "two"}]}
    payload["datasets"] = [dataset]
    monkeypatch.setattr(read_bridge, "MAX_STRATEGIES", 1, raising=False)
    monkeypatch.setattr(read_bridge.aiohttp, "ClientSession", lambda **kwargs: FakeSession(json.dumps(payload).encode(), []))
    with client(tmp_path, "http://owner.invalid") as test_client:
        response = test_client.get("/api/v5/dashboard/read", params={"path": ROUTES[3][0]})
        assert response.status_code == 503
        assert "owner payload exceeds" in response.json()["detail"]


def test_campaign_source_limit(tmp_path, monkeypatch):
    payload = {**ROUTES[3][1], "campaign": {"id": "w1772323200-1790812800", "sources": [{}, {}]}}
    monkeypatch.setattr(read_bridge, "MAX_SOURCES", 1)
    monkeypatch.setattr(read_bridge.aiohttp, "ClientSession", lambda **kwargs: FakeSession(json.dumps(payload).encode(), []))
    with client(tmp_path, "http://owner.invalid") as test_client:
        response = test_client.get("/api/v5/dashboard/read", params={"path": ROUTES[3][0]})
        assert response.status_code == 503 and "owner payload exceeds 1" in response.json()["detail"]


def test_timeout_and_multichunk_limit(tmp_path, monkeypatch):
    class TimeoutSession(FakeSession):
        def get(self, *args, **kwargs):
            raise asyncio.TimeoutError()

    seen = []
    class Chunks(FakeResponse):
        async def iter_chunked(self, size):
            for chunk in (b"12", b"34", b"56"):
                seen.append(chunk)
                yield chunk
    class ChunkSession(FakeSession):
        def get(self, *args, **kwargs):
            return Chunks(b"")
    with client(tmp_path, "http://owner.invalid") as test_client:
        monkeypatch.setattr(read_bridge.aiohttp, "ClientSession", lambda **kwargs: TimeoutSession(None, []))
        assert "timed out" in test_client.get("/api/v5/dashboard/read", params={"path": ROUTES[0][0]}).json()["detail"]
        monkeypatch.setattr(read_bridge, "MAX_BYTES", 3)
        monkeypatch.setattr(read_bridge.aiohttp, "ClientSession", lambda **kwargs: ChunkSession(None, []))
        assert "too large" in test_client.get("/api/v5/dashboard/read", params={"path": ROUTES[0][0]}).json()["detail"]
        assert seen == [b"12", b"34"]


def test_deadline_expires_during_stream(tmp_path, monkeypatch):
    class Slow(FakeResponse):
        async def iter_chunked(self, size):
            yield b"{"
            await asyncio.sleep(1)
            yield b"}"
    class SlowSession(FakeSession):
        def get(self, *args, **kwargs):
            return Slow(b"")
    monkeypatch.setattr(read_bridge, "TIMEOUT_SECONDS", 0.01)
    monkeypatch.setattr(read_bridge.aiohttp, "ClientSession", lambda **kwargs: SlowSession(None, []))
    with client(tmp_path, "http://owner.invalid") as test_client:
        assert "timed out" in test_client.get("/api/v5/dashboard/read", params={"path": ROUTES[0][0]}).json()["detail"]


def test_real_http_redirect_is_refused_without_following(tmp_path, monkeypatch):
    class Socket:
        def makefile(self, *args, **kwargs):
            return io.BytesIO(b"HTTP/1.1 302 Found\r\nLocation: https://other.invalid/\r\nContent-Length: 0\r\n\r\n")
    response = HTTPResponse(Socket())
    response.begin()
    assert response.status == 302 and response.getheader("Location") == "https://other.invalid/"
    class RedirectContext:
        async def __aenter__(self):
            return response
        async def __aexit__(self, *args):
            response.close()
    class RedirectSession(FakeSession):
        def get(self, url, **kwargs):
            self.calls.append((url, kwargs))
            return RedirectContext()
    calls = []
    monkeypatch.setattr(read_bridge.aiohttp, "ClientSession", lambda **kwargs: RedirectSession(None, calls))
    with client(tmp_path, "http://owner.invalid") as test_client:
        result = test_client.get("/api/v5/dashboard/read", params={"path": ROUTES[0][0]})
        assert result.status_code == 503 and "HTTP 302" in result.json()["detail"]
        assert len(calls) == 1 and calls[0][1]["allow_redirects"] is False
CAMPAIGNS = {"schema": "condor.tradepad.campaigns.v1", "campaigns": [], "errors": []}
def packed(kind, values):
    code = {"i32": "i", "u16": "H", "f64": "d"}[kind]
    raw = struct.pack("<" + code * len(values), *values)
    return {"$pack": kind, "n": len(values), "z": base64.b64encode(zlib.compress(raw)).decode()}


ASSET = json.dumps({"t0": 0, "step": 60, "n": 1, "o0": 1, "scale": 1, "vk": 1, "d": packed("i32", [0, 0, 0, 0]), "qv": packed("u16", [0]), "check": {"first": [1, 1, 1, 1], "last": [1, 1, 1, 1], "sum_close": 1}}, separators=(",", ":")).encode()
DIGEST = hashlib.sha256(ASSET).hexdigest()
PAIR = {"metrics": {}, "fills": {"n": 0}, "curve": {"t0": 0, "step": 60, "pnl": packed("f64", [0]), "invested": packed("f64", [0])}}
PAIR_RAW = json.dumps(PAIR, separators=(",", ":")).encode()
PAIR_DIGEST = hashlib.sha256(PAIR_RAW).hexdigest()


def test_rejects_malformed_nested_assets():
    malformed_candles = [{"t0": 0, "step": 60, "n": 1, "o0": 0, "d": {}, "qv": {}, "check": {}}, {**json.loads(ASSET), "qv": packed("u16", [])}]
    malformed_pairs = [{"metrics": {}, "fills": {"n": 0}, "curve": {}}, {**PAIR, "curve": {**PAIR["curve"], "pnl": packed("f64", [float("nan")])}}, {**PAIR, "fills": {"n": 1}}]
    for value, kind in [(item, "candles") for item in malformed_candles] + [(item, "pair") for item in malformed_pairs]:
        with pytest.raises(ValueError):
            read_bridge._asset(value, kind)


def test_bundle_strategy_cap_is_response_wide():
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as error:
        read_bridge._check_caps("bundle", {"datasets": [{"strategies": [None] * 6000}, {"strategies": [None] * 6000}]})
    assert "10000 strategies" in error.value.detail


def test_byte_limit_rejects_before_json_decode(monkeypatch, tmp_path):
    monkeypatch.setitem(read_bridge.READ_BYTE_LIMITS, "catalog", 2)
    monkeypatch.setattr(read_bridge.aiohttp, "ClientSession", lambda **kwargs: FakeSession(b"xxx", []))
    monkeypatch.setattr(read_bridge.json, "loads", lambda *args, **kwargs: pytest.fail("decode must not run"))
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as error:
        asyncio.run(read_bridge.read_tradepad("http://owner.invalid", "/api/v1/tradepad/catalog", "catalog"))
    assert "too large" in error.value.detail
ROUTES = [
    ("/api/v1/tradepad/catalog", CATALOG),
    ("/api/v1/tradepad/campaigns", CAMPAIGNS),
    ("/api/v1/tradepad/snapshot", {"schema": "condor.tradepad.snapshot.v1", "snapshot_sha256": "a" * 64, "catalog": CATALOG, "campaigns": CAMPAIGNS}),
    ("/api/v1/tradepad/campaigns/w1772323200-1790812800?delivery=deferred-assets-v1", {"schema": "tradepad.bundle.v2", "datasets": [{"id": "w1772323200-1790812800", "source_index": [], "strategies": [], "metrics_only": []}], "campaign": {"id": "w1772323200-1790812800"}, "delivery": "deferred-assets-v1"}),
    ("/api/v1/tradepad/bundles/example/bundle", {"schema": "tradepad.bundle.v2", "datasets": []}),
    ("/api/v1/tradepad/bundles/example/provenance", {"schema": "tradepad.bundle.v2.provenance", "bundle_sha256": "a" * 64}),
    (f"/api/v1/tradepad/bundles/example/asset?source={'a' * 64}&dataset=example&pair=BNBUSDC&kind=candles&sha256={DIGEST}", json.loads(ASSET)),
    (f"/api/v1/tradepad/bundles/example/asset?source={'a' * 64}&dataset=example&pair=BNBUSDC&kind=pair&strategy=bot&sha256={PAIR_DIGEST}", PAIR),
]


class FakeResponse:
    status = 200

    def __init__(self, raw):
        self.raw = raw
        self.content = self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def iter_chunked(self, size):
        yield self.raw


class FakeSession:
    def __init__(self, raw, calls):
        self.raw, self.calls = raw, calls

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        if self.raw is None:
            raise aiohttp.ClientConnectionError()
        return FakeResponse(self.raw)


def client(tmp_path, url):
    settings = replace(make_settings(tmp_path), tradepad_url=url, tradepad_campaign_id="w1772323200-1790812800")
    app = create_app(settings=settings, upstream=NoNetworkUpstream(), static_dir=tmp_path / "dist", reuse_bridge_connections=False)
    test_client = TestClient(app)
    assert test_client.post("/api/v5/auth/login", json={"token": TOKEN}, headers={"Origin": ORIGIN}).status_code == 200
    return test_client


@pytest.mark.parametrize("pack_kind", [[], {}])
def test_unhashable_pack_kind_returns_503(tmp_path, monkeypatch, pack_kind):
    asset = json.loads(ASSET)
    asset["d"]["$pack"] = pack_kind
    raw = json.dumps(asset, separators=(",", ":")).encode()
    digest = hashlib.sha256(raw).hexdigest()
    path = f"/api/v1/tradepad/bundles/example/asset?source={'a' * 64}&dataset=example&pair=BNBUSDC&kind=candles&sha256={digest}"
    monkeypatch.setattr(read_bridge.aiohttp, "ClientSession", lambda **kwargs: FakeSession(raw, []))
    with client(tmp_path, "http://owner.invalid") as test_client:
        test_client._transport.raise_server_exceptions = False
        result = test_client.get("/api/v5/dashboard/read", params={"path": path})
        assert result.status_code == 503
        assert result.json()["detail"].startswith("Not connected:")


@pytest.mark.parametrize("path,payload", ROUTES)
def test_tradepad_failures_and_passthrough(tmp_path, monkeypatch, path, payload):
    calls = []
    raw = json.dumps(payload, separators=(",", ":")).encode()
    monkeypatch.setattr(read_bridge.aiohttp, "ClientSession", lambda **kwargs: FakeSession(raw, calls))
    with client(tmp_path, None) as test_client:
        assert "unset" in test_client.get("/api/v5/dashboard/read", params={"path": path}).json()["detail"]
    with client(tmp_path, "http://owner.invalid") as test_client:
        result = test_client.get("/api/v5/dashboard/read", params={"path": path})
        assert result.status_code == 200 and result.content == raw
        assert calls[-1][1]["allow_redirects"] is False
        monkeypatch.setattr(read_bridge.aiohttp, "ClientSession", lambda **kwargs: FakeSession(None, calls))
        assert "unreachable" in test_client.get("/api/v5/dashboard/read", params={"path": path}).json()["detail"]
        monkeypatch.setattr(read_bridge.aiohttp, "ClientSession", lambda **kwargs: FakeSession(b'[]', calls))
        assert "bad shape" in test_client.get("/api/v5/dashboard/read", params={"path": path}).json()["detail"]
        monkeypatch.setattr(read_bridge, "MAX_BYTES", 2)
        monkeypatch.setattr(read_bridge.aiohttp, "ClientSession", lambda **kwargs: FakeSession(b'xxx', calls))
        assert "too large" in test_client.get("/api/v5/dashboard/read", params={"path": path}).json()["detail"]


def test_refuses_non_deferred_unknown_and_non_get(tmp_path):
    with client(tmp_path, "http://owner.invalid") as test_client:
        for path in ["/api/v1/tradepad/campaigns/w1772323200-1790812800", "/api/v1/tradepad/campaigns/w1772323200-1790812800?delivery=full"]:
            assert test_client.get("/api/v5/dashboard/read", params={"path": path}).status_code == 400
        assert test_client.get("/api/v5/dashboard/read", params={"path": "/api/v1/tradepad/campaigns/w1-2?delivery=deferred-assets-v1"}).status_code == 404
        assert test_client.get("/api/v5/dashboard/read", params={"path": "/api/v1/tradepad/other"}).status_code == 404
        assert test_client.get("/api/v5/dashboard/read", params={"path": "/api/v1/tradepad/bundles/example"}).status_code == 404
        assert test_client.post("/api/v5/dashboard/read", params={"path": "/api/v1/tradepad/catalog"}).status_code == 405


def test_campaign_scope_must_be_configured():
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as error:
        read_bridge.tradepad_route("/api/v1/tradepad/campaigns/w1-2?delivery=deferred-assets-v1")
    assert error.value.status_code == 503
    assert "V5_TRADEPAD_CAMPAIGN_ID is unset" in error.value.detail
