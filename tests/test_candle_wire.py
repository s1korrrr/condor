"""Exercise actual producer loops with synthetic clients; never open a feed."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
import config_manager
from condor.web import ws_manager


def candle(close=100):
    return dict(timestamp=1800000000, open=100, high=110, low=90, close=close, volume=1)


@pytest.mark.asyncio
@pytest.mark.parametrize("gecko", [False, True])
async def test_poll_marks_changed_and_unchanged_current_batches(monkeypatch, gecko):
    manager = ws_manager.WebSocketManager()
    channel = "candles:v2:okx:BTC-USDC:1h"
    manager.broadcast = AsyncMock()
    rows = [[candle()], [candle(103)], [candle(103)]]
    fetch = AsyncMock(side_effect=rows)
    cm = SimpleNamespace(
        get_client=AsyncMock(
            return_value=SimpleNamespace(
                market_data=SimpleNamespace(get_historical_candles=fetch)
            )
        )
    )
    monkeypatch.setattr(config_manager, "get_config_manager", lambda: cm)
    monkeypatch.setattr(ws_manager.dex_candles, "uses_gecko_candles", lambda _: gecko)
    monkeypatch.setattr(ws_manager.dex_candles, "fetch_dex_candles", fetch)
    ticks = 0

    async def tick(_):
        nonlocal ticks
        ticks += 1
        if ticks > 3:
            raise asyncio.CancelledError

    monkeypatch.setattr(ws_manager.asyncio, "sleep", tick)
    await manager._candle_poll_fallback(channel)
    messages = [call.args[1] for call in manager.broadcast.await_args_list]
    assert (
        len(messages) == 3
    ), "unchanged successful polls still supply current receipts"
    assert [message["data"][0]["close"] for message in messages] == [100, 103, 103]
    assert all(message["kind"] == "live" for message in messages)
    assert all(
        message["source"] == ("gecko" if gecko else "rest") for message in messages
    )
    assert all(
        message["receipt_max_age_ms"] == (120000 if gecko else 20000)
        for message in messages
    )
    if gecko:
        assert all(call.kwargs["use_cache"] is False for call in fetch.await_args_list)


@pytest.mark.asyncio
@pytest.mark.parametrize("provenance", [None, "history", "live"])
async def test_stream_batch_requires_explicit_current_provenance(
    monkeypatch,
    provenance,
):
    manager = ws_manager.WebSocketManager()
    channel = "candles:v2:okx:BTC-USDC:1h"
    manager.broadcast = AsyncMock()
    manager._ensure_candle_poll_fallback = Mock()
    manager._ensure_stream = Mock()
    manager._send = AsyncMock()
    message = {"type": "candles", "data": [candle(103)]}
    if provenance is not None:
        message["kind"] = provenance
    messages = iter([message])

    class Feed:
        subscribe_candles = AsyncMock()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

        def __aiter__(self):
            return self

        async def __anext__(self):
            try:
                return next(messages)
            except StopIteration:
                raise asyncio.CancelledError

    cm = SimpleNamespace(
        get_client=AsyncMock(
            return_value=SimpleNamespace(ws=SimpleNamespace(market_data=lambda: Feed()))
        )
    )
    monkeypatch.setattr(config_manager, "get_config_manager", lambda: cm)
    monkeypatch.setattr(ws_manager.dex_candles, "uses_gecko_candles", lambda _: False)
    await manager._candle_stream(channel)
    current = manager.broadcast.await_args.args[1]
    assert current["kind"] == ("live" if provenance == "live" else "history")
    assert current["source"] == "stream"
    assert (channel in manager._last_candle_ws_update) is (provenance == "live")
    await manager._handle_candle_subscribe(object(), channel, 0)
    snapshot = manager._send.await_args.args[2]
    assert snapshot["kind"] == "history" and snapshot["source"] == "snapshot"
    manager._backfill_candles = AsyncMock()
    await manager._handle_candle_duration_change(object(), channel, 100 * 86400)
    backfill = manager.broadcast.await_args.args[1]
    assert backfill["kind"] == "history" and backfill["source"] == "backfill"
