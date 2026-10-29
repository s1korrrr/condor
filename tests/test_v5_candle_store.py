from dataclasses import replace

import pytest
from aiohttp import web
from fastapi.testclient import TestClient
from test_v5_dashboard_bridge import ORIGIN, TOKEN, NoNetworkUpstream, make_settings

from condor.v5.app import create_app
from condor.v5.candles import CandleOwner, OwnerUnavailable, validate_payload


def test_disabled_preserves_profile_and_rejects_reads(tmp_path):
    with TestClient(
        create_app(settings=make_settings(tmp_path), upstream=NoNetworkUpstream())
    ) as client:
        assert client.get("/api/v5/candle-store/overview").status_code == 401
        client.post(
            "/api/v5/auth/login", json={"token": TOKEN}, headers={"Origin": ORIGIN}
        )
        profile = client.get("/api/v5/dashboard/profile").json()
        assert "candle_store" not in profile
        assert client.get("/api/v5/candle-store/overview").status_code == 404


def test_configured_is_authenticated_and_unavailable_not_zero(tmp_path):
    settings = replace(
        make_settings(tmp_path), candle_store_socket=tmp_path / "absent.sock"
    )
    with TestClient(
        create_app(settings=settings, upstream=NoNetworkUpstream())
    ) as client:
        assert client.get("/api/v5/candle-store/overview").status_code == 401
        client.post(
            "/api/v5/auth/login", json={"token": TOKEN}, headers={"Origin": ORIGIN}
        )
        assert client.get("/api/v5/dashboard/profile").json()["candle_store"] == {
            "configured": True
        }
        response = client.get("/api/v5/candle-store/overview")
        assert response.status_code == 503
        assert response.json() == {
            "state": "UNAVAILABLE",
            "reason": "owner_unreachable",
            "data": None,
        }
        for path in ("store", "..", "cross"):
            assert client.get(f"/api/v5/candle-store/{path}").status_code in (404, 422)
        for query in (
            "lane=../../secrets&pair=BTC-USDT",
            "lane=okx__spot&pair=X&range=90d",
            "lane=okx__spot&pair=X&res=5m",
            "lane=okx__spot&pair=X&pair=Y",
        ):
            assert (
                client.get("/api/v5/candle-store/candles?" + query).status_code == 422
            )
        assert client.post("/api/v5/candle-store/overview").status_code == 405


@pytest.mark.asyncio
async def test_bounded_transport_rejects_redirect_and_oversize(tmp_path):
    for index, response in enumerate(
        (
            web.Response(status=302, headers={"location": "http://secret.invalid"}),
            web.Response(body=b"x" * (2_000_001)),
            web.Response(body=b'{"now":NaN}'),
            web.json_response([]),
        )
    ):
        app = web.Application()

        async def respond(request):
            return response

        app.router.add_get("/api/overview", respond)
        runner = web.AppRunner(app)
        await runner.setup()
        path = str(tmp_path / f"owner{index}.sock")
        site = web.UnixSite(runner, path)
        await site.start()
        try:
            with pytest.raises(OwnerUnavailable):
                await CandleOwner(path).read("overview", {})
        finally:
            await runner.cleanup()


def candle_payload():
    return {
        "lane": "okx__spot",
        "venue": "okx",
        "segment": "spot",
        "pair": "BTC-USDT",
        "range": "1h",
        "res_s": 60,
        "start": 60,
        "end": 60,
        "now": 120,
        "volume_unit": "base",
        "totals": {
            "final": 1,
            "no_trade": 0,
            "unrecoverable": 0,
            "missing": 0,
            "pending": 0,
            "corrections": 0,
        },
        "buckets": [[60, 2, 3, 1, 2, None, 1, 0, 0, 0, 0, 0]],
    }


def test_preserves_unknown_volume_and_rejects_fabricated_prices():
    payload = candle_payload()
    assert validate_payload("candles", payload)["buckets"][0][5] is None
    for index, value in ((1, float("inf")), (3, 4), (6, -1), (0, 61), (6, True)):
        broken = candle_payload()
        broken["buckets"][0][index] = value
        with pytest.raises(OwnerUnavailable):
            validate_payload("candles", broken)
    payload["buckets"].append(payload["buckets"][0])
    with pytest.raises(OwnerUnavailable):
        validate_payload("candles", payload)


def test_untrusted_overview_is_bounded():
    for payload in ({}, {"now": 1, "tiles": [None]}, {"now": 1, "tiles": [{}] * 129}):
        with pytest.raises(OwnerUnavailable):
            validate_payload("overview", payload)
