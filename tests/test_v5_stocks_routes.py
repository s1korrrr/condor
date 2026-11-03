"""Native FastAPI boundary checks, executed in the normal V5 test environment."""

from dataclasses import replace

from fastapi.testclient import TestClient

from condor.v5.app import create_app
from test_v5_dashboard_bridge import ORIGIN, TOKEN, NoNetworkUpstream, make_settings


def test_stock_reads_keep_session_auth_and_disabled_behavior(tmp_path):
    with TestClient(create_app(settings=make_settings(tmp_path), upstream=NoNetworkUpstream())) as client:
        for view in ("stocks", "stock-market", "stock-candles"):
            assert client.get(f"/api/v5/candle-store/{view}?region=eea").status_code == 401
        client.post("/api/v5/auth/login", json={"token": TOKEN}, headers={"Origin": ORIGIN})
        for view in ("stocks", "stock-market", "stock-candles"):
            assert client.get(f"/api/v5/candle-store/{view}?region=eea").status_code == 404
        assert "candle_store" not in client.get("/api/v5/dashboard/profile").json()


def test_stock_queries_fail_before_socket_read_and_no_write_route_exists(tmp_path):
    settings = replace(make_settings(tmp_path), candle_store_socket=tmp_path / "missing.sock")
    with TestClient(create_app(settings=settings, upstream=NoNetworkUpstream())) as client:
        client.post("/api/v5/auth/login", json={"token": TOKEN}, headers={"Origin": ORIGIN})
        for query in ("region=eea&region=global", "region=auto", "region=eea&url=https://example.invalid"):
            assert client.get(f"/api/v5/candle-store/stocks?{query}").status_code == 422
        response = client.get("/api/v5/candle-store/stocks?region=eea")
        assert response.status_code == 503
        assert response.json() == {"state": "UNAVAILABLE", "reason": "owner_unreachable", "data": None}
        assert response.headers["Cache-Control"] == "no-store"
        assert client.post("/api/v5/candle-store/stocks?region=eea").status_code == 405


def test_stock_route_supports_direct_page_load(tmp_path):
    static = tmp_path / "dist"
    static.mkdir()
    (static / "v5.html").write_text("<!doctype html><title>V5 workspace</title><div id='root'></div>")
    with TestClient(create_app(settings=make_settings(tmp_path), upstream=NoNetworkUpstream(), static_dir=static)) as client:
        response = client.get("/market/stocks")
        assert response.status_code == 200
        assert "V5 workspace" in response.text
