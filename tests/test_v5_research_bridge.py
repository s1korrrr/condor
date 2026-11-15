from dataclasses import replace
import json

import pytest
from fastapi.testclient import TestClient

from condor.v5.app import create_app
from condor.v5 import read_bridge
from test_v5_dashboard_bridge import make_settings, NoNetworkUpstream, TOKEN, ORIGIN
from test_v5_tradepad_bridge import FakeSession

OVERVIEW = {"revision": "r1", "generated_at": "2026-10-29T12:00:00Z", "counts": {}, "facets": {}, "limitations": []}
NETWORK = {"revision": "r1", "node_fields": ["id", "kind", "title", "family", "lane"], "edge_fields": ["source", "target", "relation", "basis"], "nodes": [], "edges": [], "unresolved_edges": 0, "total_nodes": 0, "total_edges": 0, "stats": {"kinds": [], "families": [], "lanes": [], "relations": []}}


@pytest.mark.parametrize("state", ["current", "OTHER"])
def test_unknown_owner_freshness_state_fails_closed(state):
    assert not read_bridge.valid_research("overview", {**OVERVIEW, "freshness": {"state": state}})


@pytest.mark.parametrize("state", ["CURRENT", "PENDING", "UNAVAILABLE"])
def test_documented_owner_freshness_states_are_accepted(state):
    assert read_bridge.valid_research("overview", {**OVERVIEW, "freshness": {"state": state}})


@pytest.mark.parametrize("field,value", [("counts", {"ideas": -1}), ("facets", {"kinds": False}), ("facets", {"kinds": [None]}), ("limitations", [{}]), ("freshness", {"pending_events": False}), ("freshness", {"max_verification_age_seconds": []})])
def test_overview_rejects_bad_nested_records(field, value):
    assert not read_bridge.valid_research("overview", {**OVERVIEW, field: value})


def test_research_rejects_absolute_and_encoded_paths():
    from fastapi import HTTPException
    for path in ("https://evil.invalid/api/v1/research/overview", "/api/v1/research/overview?%73erver=rsibot-v5"):
        with pytest.raises(HTTPException):
            read_bridge.research_route(path)


@pytest.mark.parametrize("field,limit", [("nodes", "MAX_NODES"), ("edges", "MAX_EDGES")])
def test_network_collection_limits(tmp_path, monkeypatch, field, limit):
    payload = {**NETWORK, field: [None, None]}
    monkeypatch.setattr(read_bridge, limit, 1)
    monkeypatch.setattr(read_bridge.aiohttp, "ClientSession", lambda **kwargs: FakeSession(json.dumps(payload).encode(), []))
    with client(tmp_path, "http://owner.invalid") as test_client:
        result = test_client.get("/api/v5/dashboard/read", params={"path": "/api/v1/research/network"})
        assert result.status_code == 503 and "owner payload exceeds 1" in result.json()["detail"]


def test_network_stats_limit(tmp_path, monkeypatch):
    payload = {**NETWORK, "stats": {**NETWORK["stats"], "kinds": [{}, {}]}}
    monkeypatch.setattr(read_bridge, "MAX_STATS_ROWS", 1)
    monkeypatch.setattr(read_bridge.aiohttp, "ClientSession", lambda **kwargs: FakeSession(json.dumps(payload).encode(), []))
    with client(tmp_path, "http://owner.invalid") as test_client:
        result = test_client.get("/api/v5/dashboard/read", params={"path": "/api/v1/research/network"})
        assert result.status_code == 503 and "owner payload exceeds 1" in result.json()["detail"]


def client(tmp_path, url):
    settings = replace(make_settings(tmp_path), research_url=url)
    app = create_app(settings=settings, upstream=NoNetworkUpstream(), static_dir=tmp_path / "dist")
    result = TestClient(app)
    assert result.post("/api/v5/auth/login", json={"token": TOKEN}, headers={"Origin": ORIGIN}).status_code == 200
    return result


@pytest.mark.parametrize("kind,payload", [("overview", OVERVIEW), ("network", NETWORK)])
def test_research_failures_and_passthrough(tmp_path, monkeypatch, kind, payload):
    path = f"/api/v1/research/{kind}?server=rsibot-v5"
    raw = json.dumps(payload, separators=(",", ":")).encode()
    calls = []
    monkeypatch.setattr(read_bridge.aiohttp, "ClientSession", lambda **kwargs: FakeSession(raw, calls))
    with client(tmp_path, None) as test_client:
        assert "unset" in test_client.get("/api/v5/dashboard/read", params={"path": path}).json()["detail"]
    with client(tmp_path, "http://owner.invalid") as test_client:
        result = test_client.get("/api/v5/dashboard/read", params={"path": path})
        assert result.status_code == 200 and result.content == raw
        assert calls[-1][0] == f"http://owner.invalid/api/knowledge/{kind}"
        assert calls[-1][1]["allow_redirects"] is False
        monkeypatch.setattr(read_bridge.aiohttp, "ClientSession", lambda **kwargs: FakeSession(None, calls))
        assert "unreachable" in test_client.get("/api/v5/dashboard/read", params={"path": path}).json()["detail"]
        monkeypatch.setattr(read_bridge.aiohttp, "ClientSession", lambda **kwargs: FakeSession(b'{}', calls))
        assert "bad shape" in test_client.get("/api/v5/dashboard/read", params={"path": path}).json()["detail"]
        monkeypatch.setattr(read_bridge, "MAX_BYTES", 2)
        monkeypatch.setattr(read_bridge.aiohttp, "ClientSession", lambda **kwargs: FakeSession(b'xxx', calls))
        assert "too large" in test_client.get("/api/v5/dashboard/read", params={"path": path}).json()["detail"]
        assert test_client.post("/api/v5/dashboard/read", params={"path": path}).status_code == 405
        assert test_client.get("/api/v5/dashboard/read", params={"path": f"/api/v1/research/{kind}?server=other"}).status_code == 400


def test_other_research_paths_stay_unbound(tmp_path):
    with client(tmp_path, "http://owner.invalid") as test_client:
        assert test_client.get("/api/v5/dashboard/read", params={"path": "/api/v1/research/nodes"}).status_code == 503
