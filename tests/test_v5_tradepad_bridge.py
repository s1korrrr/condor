from dataclasses import replace
import hashlib
import json

import aiohttp
import pytest
from fastapi.testclient import TestClient

from condor.v5.app import create_app
from condor.v5 import read_bridge
from test_v5_dashboard_bridge import make_settings, NoNetworkUpstream, TOKEN, ORIGIN

CATALOG = {"schema": "condor.tradepad.catalog.v1", "bundles": [], "errors": []}
CAMPAIGNS = {"schema": "condor.tradepad.campaigns.v1", "campaigns": [], "errors": []}
ASSET = b'{"t0":0,"step":60,"n":1,"o0":1,"d":{},"qv":{},"check":{}}'
DIGEST = hashlib.sha256(ASSET).hexdigest()
PAIR = {"metrics": {}, "fills": {"n": 0}, "curve": {}}
PAIR_RAW = json.dumps(PAIR, separators=(",", ":")).encode()
PAIR_DIGEST = hashlib.sha256(PAIR_RAW).hexdigest()
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
    app = create_app(settings=settings, upstream=NoNetworkUpstream(), static_dir=tmp_path / "dist")
    test_client = TestClient(app)
    assert test_client.post("/api/v5/auth/login", json={"token": TOKEN}, headers={"Origin": ORIGIN}).status_code == 200
    return test_client


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
        assert test_client.post("/api/v5/dashboard/read", params={"path": "/api/v1/tradepad/catalog"}).status_code == 405


def test_campaign_scope_must_be_configured():
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as error:
        read_bridge.tradepad_route("/api/v1/tradepad/campaigns/w1-2?delivery=deferred-assets-v1")
    assert error.value.status_code == 503
    assert "V5_TRADEPAD_CAMPAIGN_ID is unset" in error.value.detail
