"""The bot page reads current owner status without waiting for history writes."""

import asyncio
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from condor.web.models import WebUser


def _native_status(now: float):
    def bot(controller, realized):
        return {
            "source": "native_mqtt",
            "status": "running",
            "performance_current": True,
            # Live native status publishes the verified source identity (2026-10-25).
            "identity_verified": True,
            "received_at": now,
            "stale_after_seconds": 30,
            "heartbeat": {"received_at": now, "source_timestamp": now * 1_000_000},
            "lifecycle": {
                "valid": True,
                "observation": {"received_at": now, "payload": {"generated_at": now}},
            },
            "performance": {
                controller: {
                    "status": "running",
                    "custom_info": {"pair": "ETH-USDC"},
                    "performance": {
                        "realized_pnl_quote": realized,
                        "unrealized_pnl_quote": 2,
                        "global_pnl_pct": 0,
                        "volume_traded": 10,
                    },
                }
            },
        }

    return {
        "data": {
            "ok_rsi": bot("v1", 1),
            "rsi_modular_v2": bot("v2", 3),
            "meridian_v3": bot("v3", 5),
            "meridian_v4_paper": {
                "source": "native_paper_reporting",
                "status": "reporting_only",
            },
        }
    }


def _client(source):
    return SimpleNamespace(
        bot_orchestration=SimpleNamespace(
            get_active_bots_status=AsyncMock(return_value=source),
            get_bot_runs=AsyncMock(return_value={"data": []}),
            get_latest_controller_performance=AsyncMock(return_value={"data": []}),
        ),
        controllers=SimpleNamespace(
            get_bot_controller_configs=AsyncMock(return_value=[])
        ),
    )


def _allow(monkeypatch, client):
    from condor.web.routes import bots

    get_client = AsyncMock(return_value=client)
    monkeypatch.setattr(
        bots,
        "get_config_manager",
        lambda: SimpleNamespace(
            has_server_access=lambda *_: True, get_client=get_client
        ),
    )
    return get_client


@pytest.mark.asyncio
async def test_native_page_uses_current_owner_performance_while_sds_is_blocked(
    monkeypatch,
):
    from condor import server_data_service
    from condor.web.routes import bots

    # A current observation by wall clock: native performance expires after stale_after_seconds.
    now = float(int(time.time()))
    source = _native_status(now)
    client = _client(source)
    get_client = _allow(monkeypatch, client)

    async def blocked_history(*_):
        await asyncio.sleep(15)

    stale_sds = SimpleNamespace(get_or_fetch=AsyncMock(side_effect=blocked_history))
    monkeypatch.setattr(
        server_data_service, "get_server_data_service", lambda: stale_sds
    )

    page = await asyncio.wait_for(
        bots.list_bots("native", WebUser(id=1, role="admin")), timeout=0.1
    )
    get_client.assert_awaited_once_with("native")
    client.bot_orchestration.get_active_bots_status.assert_awaited_once_with()
    stale_sds.get_or_fetch.assert_not_awaited()
    client.bot_orchestration.get_bot_runs.assert_not_awaited()
    client.bot_orchestration.get_latest_controller_performance.assert_not_awaited()
    client.controllers.get_bot_controller_configs.assert_not_awaited()
    assert page.metrics_available is True
    assert page.total_pnl == 15
    assert {row.controller_id for row in page.controllers} == {"v1", "v2", "v3"}
    assert {row.bot_name: row.controller_count_current for row in page.bots} == {
        "ok_rsi": True,
        "rsi_modular_v2": True,
        "meridian_v3": True,
        "meridian_v4_paper": None,
    }
    assert all(row.performance_received_at == now for row in page.bots[:3])


@pytest.mark.asyncio
async def test_native_page_does_not_replay_sds_cache_after_owner_fetch_fails(
    monkeypatch,
):
    from condor import server_data_service
    from condor.web.routes import bots

    client = _client(_native_status(1_000.0))
    client.bot_orchestration.get_active_bots_status.side_effect = ConnectionError(
        "native API unavailable"
    )
    _allow(monkeypatch, client)
    stale_sds = SimpleNamespace(
        get_or_fetch=AsyncMock(return_value=_native_status(900.0))
    )
    monkeypatch.setattr(
        server_data_service, "get_server_data_service", lambda: stale_sds
    )
    page = await bots.list_bots("native", WebUser(id=1, role="admin"))
    assert page.server_online is False
    assert page.bots == []
    stale_sds.get_or_fetch.assert_not_awaited()


@pytest.mark.asyncio
async def test_full_api_bot_page_preserves_enrichment_and_one_owner_read(monkeypatch):
    from condor.web.routes import bots

    client = _client({"data": {"legacy": {"status": "running"}}})
    get_client = _allow(monkeypatch, client)
    page = await bots.list_bots("full", WebUser(id=1, role="admin"))
    assert page.server_online is True
    get_client.assert_awaited_once_with("full")
    client.bot_orchestration.get_active_bots_status.assert_awaited_once_with()
    client.controllers.get_bot_controller_configs.assert_awaited_once_with("legacy")
    client.bot_orchestration.get_latest_controller_performance.assert_awaited_once_with()
    assert client.bot_orchestration.get_bot_runs.await_count >= 1


@pytest.mark.asyncio
async def test_owner_status_none_is_unavailable_without_stale_fallback(monkeypatch):
    from condor.web.routes import bots

    _allow(monkeypatch, _client(None))
    page = await bots.list_bots("native", WebUser(id=1, role="admin"))
    assert page.server_online is False
    assert page.bots == []
