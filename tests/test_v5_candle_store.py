import asyncio
import json
import tempfile
from dataclasses import replace
from pathlib import Path

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
        path = str(Path(tempfile.mkdtemp(prefix="uds-")) / f"owner{index}.sock")
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
        "end": 3600,
        "now": 3660,
        "volume_unit": "base",
        "totals": {
            "final": 60,
            "no_trade": 0,
            "unrecoverable": 0,
            "missing": 0,
            "pending": 0,
            "corrections": 0,
        },
        "buckets": [
            [minute * 60, 2, 3, 1, 2, None, 1, 0, 0, 0, 0, 0] for minute in range(1, 61)
        ],
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
    for payload in (
        {},
        {"now": 1, "tiles": []},
        {"now": 1, "tiles": [None]},
        {"now": 1, "tiles": [{}] * 129},
    ):
        with pytest.raises(OwnerUnavailable):
            validate_payload("overview", payload)


@pytest.mark.parametrize("value", [10**1000, 1e300, float("nan"), True])
def test_hostile_timestamp_is_unavailable_not_browser_crash(value):
    payload = candle_payload()
    payload["now"] = value
    with pytest.raises(OwnerUnavailable):
        validate_payload("candles", payload)


def test_owner_totals_cannot_disagree_with_chart():
    payload = candle_payload()
    payload["totals"]["final"] = 0
    with pytest.raises(OwnerUnavailable, match="inconsistent_totals"):
        validate_payload("candles", payload)


def test_native_health_rule_contract_uses_rule_not_name():
    payload = {
        "now": 120,
        "status_age_s": 2,
        "status_error": None,
        "tiles": [
            {
                "lane": "okx__spot",
                "venue": "okx",
                "segment": "spot",
                "health": "green",
                "health_rules": [
                    {"level": "green", "rule": "service", "detail": "status age 2 s"}
                ],
                "partition_errors": [],
                "available": True,
                "gaps_7d": 0,
            }
        ],
    }
    result = validate_payload("overview", payload)
    assert result["tiles"][0]["health_rules"][0]["rule"] == "service"


@pytest.mark.parametrize(
    "field,value",
    [
        ("start", {"not": "a timestamp"}),
        ("end", 10**1000),
        ("start", True),
        ("end", 61),
    ],
)
def test_candle_window_fields_are_strict(field, value):
    payload = candle_payload()
    payload[field] = value
    with pytest.raises(OwnerUnavailable):
        validate_payload("candles", payload)


def test_corrections_are_bounded_even_when_totals_agree():
    payload = candle_payload()
    payload["buckets"][0][11] = payload["totals"]["corrections"] = 10**1000
    with pytest.raises(OwnerUnavailable):
        validate_payload("candles", payload)


def symbol_payload(view="symbols"):
    row = {
        "lane": "okx__spot",
        "venue": "okx",
        "segment": "spot",
        "pair": "BTC-USDT",
        "health": "green",
        "health_rules": [],
        "partition_errors": [],
    }
    return {
        "now": 120,
        "status_age_s": 2,
        "status_error": None,
        "tiles" if view == "overview" else "rows": [row],
    }


@pytest.mark.parametrize("view", ["overview", "symbols"])
@pytest.mark.parametrize(
    "field,value",
    [
        ("gaps_7d", 10**1000),
        ("pending", 0.5),
        ("last_minute", 61),
        ("volume_unit", "\ud800"),
        ("health_rules", [{"level": "green", "rule": "test", "detail": "\udfff"}]),
        ("available", "yes"),
        ("backfill_done", 1),
        ("ws_states", {"connected": 10**1000}),
    ],
)
def test_summary_fields_reject_hostile_types_and_numbers(view, field, value):
    payload = symbol_payload(view)
    payload["tiles" if view == "overview" else "rows"][0][field] = value
    with pytest.raises(OwnerUnavailable):
        validate_payload(view, payload)


@pytest.mark.asyncio
async def test_authenticated_hostile_owner_socket_fails_closed(tmp_path):
    payload = candle_payload()
    payload["buckets"][0][11] = payload["totals"]["corrections"] = 10**1000
    payload["start"], payload["end"] = {"not": "a timestamp"}, 10**1000
    app = web.Application()
    app.router.add_get("/api/candles", lambda request: web.json_response(payload))
    runner = web.AppRunner(app)
    await runner.setup()
    path = Path(tempfile.mkdtemp(prefix="uds-")) / "hostile.sock"
    await web.UnixSite(runner, str(path)).start()

    def request():
        settings = replace(make_settings(tmp_path), candle_store_socket=path)
        with TestClient(
            create_app(settings=settings, upstream=NoNetworkUpstream())
        ) as client:
            client.post(
                "/api/v5/auth/login", json={"token": TOKEN}, headers={"Origin": ORIGIN}
            )
            return client.get(
                "/api/v5/candle-store/candles?lane=okx__spot&pair=BTC-USDT&range=1h"
            )

    try:
        response = await asyncio.to_thread(request)
        assert response.status_code == 503
        assert response.json()["state"] == "UNAVAILABLE"
        assert response.json()["data"] is None
    finally:
        await runner.cleanup()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "extra",
    [
        '"duplicate":1,"duplicate":2',
        '"text":"\\ud800"',
        '"value":1e999',
        '"integer":999999999999999999999',
        '"deep":' + "[" * 33 + "0" + "]" * 33,
    ],
)
async def test_owner_json_boundary_rejects_hostile_values(extra):
    payload = symbol_payload()
    raw = json.dumps(payload)[:-1] + "," + extra + "}"
    app = web.Application()
    app.router.add_get(
        "/api/symbols",
        lambda request: web.Response(text=raw, content_type="application/json"),
    )
    runner = web.AppRunner(app)
    await runner.setup()
    path = str(Path(tempfile.mkdtemp(prefix="uds-")) / "json.sock")
    await web.UnixSite(runner, path).start()
    try:
        with pytest.raises(OwnerUnavailable):
            await CandleOwner(path).read("symbols", {})
    finally:
        await runner.cleanup()
