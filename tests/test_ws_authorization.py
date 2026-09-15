import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
import config_manager
from config_manager import UserRole
from condor.web import ws_manager


@pytest.fixture
def authorization(monkeypatch):
    state = SimpleNamespace(role=UserRole.USER, allowed=True, expires=time.time() + 60)
    cm = SimpleNamespace(
        get_user_role=lambda _: state.role, has_server_access=lambda *_: state.allowed
    )
    monkeypatch.setattr(config_manager, "get_config_manager", lambda: cm)
    monkeypatch.setattr(
        ws_manager, "decode_jwt", lambda _: {"sub": "7", "exp": state.expires}
    )
    return state


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["role", "allowed", "expiry"])
async def test_existing_subscription_stops_sending_after_revocation(
    authorization, change, monkeypatch
):
    manager = ws_manager.WebSocketManager()
    ws = AsyncMock()
    conn = await manager.connect(ws, "signed-token")
    conn.channels.add("bots:owner")
    await manager.broadcast("bots:owner", {"value": 1})
    assert ws.send_json.await_count == 1
    if change == "role":
        authorization.role = UserRole.BLOCKED
    elif change == "allowed":
        authorization.allowed = False
    else:
        # Advance the application clock beyond the original signed expiry.
        monkeypatch.setattr(ws_manager.time, "time", lambda: authorization.expires + 1)
    await manager.broadcast("bots:owner", {"value": 2})
    assert ws.send_json.await_count == 1
    assert conn not in manager._connections
    ws.close.assert_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("expiry", [None, True, "1000", float("nan"), 0])
async def test_connection_requires_valid_signed_expiry(authorization, expiry):
    authorization.expires = expiry
    ws = AsyncMock()
    assert await ws_manager.WebSocketManager().connect(ws, "signed-token") is None
    ws.accept.assert_not_awaited()


@pytest.mark.asyncio
async def test_direct_snapshot_send_rechecks_authorization(authorization):
    manager = ws_manager.WebSocketManager()
    ws = AsyncMock()
    conn = await manager.connect(ws, "signed-token")
    authorization.allowed = False
    await manager._send(conn, "portfolio:owner", {"private": "snapshot"})
    ws.send_json.assert_not_awaited()


@pytest.mark.asyncio
async def test_duration_changes_require_current_authorized_subscription(authorization):
    manager = ws_manager.WebSocketManager()
    conn = await manager.connect(AsyncMock(), "signed-token")
    manager._handle_candle_duration_change = AsyncMock()
    channel = "candles:other-server:okx:ETH-USDC:1m"
    message = json.dumps(
        {"action": "set_candle_duration", "channel": channel, "duration": 86400}
    )
    await manager.handle_message(conn, message)
    manager._handle_candle_duration_change.assert_not_awaited()
    conn.channels.add(channel)
    await manager.handle_message(conn, message)
    assert manager._handle_candle_duration_change.await_count == 1
    authorization.allowed = False
    await manager.handle_message(conn, message)
    assert manager._handle_candle_duration_change.await_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("message", [[], None, {"action": []}, {"action": {}, "channel": "bots:owner"}, {"action": "subscribe", "channel": []}])
async def test_malformed_messages_do_not_raise_or_subscribe(authorization, message):
    manager = ws_manager.WebSocketManager()
    conn = await manager.connect(AsyncMock(), "signed-token")
    await manager.handle_message(conn, json.dumps(message))
    assert not conn.channels
