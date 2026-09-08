"""Capability reads recover promptly after an API process becomes healthy."""

from unittest.mock import AsyncMock

import pytest

from condor.fetchers.server_status import fetch_server_status
from condor.server_data_service import ServerDataService, ServerDataType


@pytest.mark.asyncio
async def test_cached_connection_failure_refetches_after_ten_seconds(monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr("condor.server_data_service.time.time", lambda: clock[0])
    verify = AsyncMock(
        side_effect=[
            ConnectionError("API restarting"),
            {"profile": "native", "capabilities": {"native_lifecycle": True}},
        ]
    )
    monkeypatch.setattr("condor.api_health.verify_api_connection", verify)
    service = ServerDataService()
    monkeypatch.setattr(service, "_get_client", AsyncMock(return_value=object()))
    service.register_fetch(ServerDataType.SERVER_STATUS, fetch_server_status)

    failed = await service.get_or_fetch("native", ServerDataType.SERVER_STATUS)
    assert failed["status"] == "error"
    clock[0] += 9
    assert await service.get_or_fetch("native", ServerDataType.SERVER_STATUS) == failed
    assert verify.await_count == 1

    clock[0] += 1.01
    recovered = await service.get_or_fetch("native", ServerDataType.SERVER_STATUS)
    assert recovered["status"] == "online"
    assert recovered["profile"] == "native"
    assert recovered["capabilities"]["native_lifecycle"] is True
    assert verify.await_count == 2


def test_other_data_cache_lifetimes_remain_unchanged(monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr("condor.server_data_service.time.time", lambda: clock[0])
    service = ServerDataService()
    service.put("native", ServerDataType.PRICES, {"price": 1})
    service.put("native", ServerDataType.BOT_RUNS, {"runs": []})
    clock[0] += 11
    assert service.get("native", ServerDataType.PRICES) == {"price": 1}
    clock[0] += 20
    assert service.get("native", ServerDataType.PRICES) is None
    assert service.get("native", ServerDataType.BOT_RUNS) == {"runs": []}


@pytest.mark.asyncio
async def test_bot_status_cache_refetches_owner_observation_after_five_seconds(
    monkeypatch,
):
    clock = [1000.0]
    monkeypatch.setattr("condor.server_data_service.time.time", lambda: clock[0])
    fetch = AsyncMock(
        side_effect=[
            {"data": {"sui": {"performance_current": False}}},
            {
                "data": {
                    "sui": {
                        "performance_current": True,
                        "performance_received_at": 1005,
                    }
                }
            },
        ]
    )
    service = ServerDataService()
    monkeypatch.setattr(service, "_get_client", AsyncMock(return_value=object()))
    service.register_fetch(ServerDataType.BOTS_STATUS, fetch)
    first = await service.get_or_fetch("native", ServerDataType.BOTS_STATUS)
    clock[0] += 4
    assert await service.get_or_fetch("native", ServerDataType.BOTS_STATUS) == first
    assert fetch.await_count == 1
    clock[0] += 1.01
    fresh = await service.get_or_fetch("native", ServerDataType.BOTS_STATUS)
    assert fresh["data"]["sui"]["performance_current"] is True
    assert fresh["data"]["sui"]["performance_received_at"] == 1005
    assert fetch.await_count == 2
