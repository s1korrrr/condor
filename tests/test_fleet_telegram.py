"""Read-only, owner-scoped fleet Telegram command worker tests."""

import asyncio
import json
import time
from types import SimpleNamespace

import pytest

import condor.fleet_telegram as fleet


def _source_config(bot="rsi_modular_v2", identity="v2"):
    return {
        "authorized_user_ids": [12345],
        "bots": [
            {
                "id": identity,
                "label": "RSI Modular V2",
                "native_bot_name": bot,
                "api_base_url": "http://native-api:8000",
                "api_username": "reader",
                "api_password": "private-test-secret",
                "endpoints": {
                    "status": "/trading-visuals/runtime-status?bot={bot}",
                    "orders": "/trading-visuals/orders?bot={bot}&limit=5",
                    "fills": "/trading-visuals/fills?bot={bot}&limit=5",
                    "executors": "/trading-visuals/executors?bot={bot}&limit=5",
                },
            }
        ],
    }


def _load(tmp_path, value=None):
    path = tmp_path / "worker.json"
    path.write_text(json.dumps(value or _source_config()), encoding="utf-8")
    return fleet.load_config(str(path))


def _update(
    *, user_id=12345, chat_id=None, chat_type="private", text="/status v2", update_id=1
):
    if chat_id is None:
        chat_id = user_id
    return SimpleNamespace(
        update_id=update_id,
        message=SimpleNamespace(
            from_user=SimpleNamespace(id=user_id),
            chat=SimpleNamespace(id=chat_id, type=chat_type),
            text=text,
        ),
    )


def test_config_rejects_non_numeric_authorized_id_and_external_endpoint(tmp_path):
    config = _source_config()
    config["authorized_user_ids"] = ["12345"]
    path = tmp_path / "bad.json"
    path.write_text(json.dumps(config), encoding="utf-8")
    with pytest.raises(fleet.ConfigError):
        fleet.load_config(str(path))

    config = _source_config()
    config["bots"][0]["endpoints"]["orders"] = "https://elsewhere.example/orders"
    path.write_text(json.dumps(config), encoding="utf-8")
    with pytest.raises(fleet.ConfigError):
        fleet.load_config(str(path))


def test_config_encodes_registered_native_bot_in_fixed_paths(tmp_path):
    config = _load(tmp_path)
    assert (
        config.bots[0].endpoints["status"]
        == "/trading-visuals/runtime-status?bot=rsi_modular_v2"
    )


def test_native_read_client_collects_partial_chunks_before_json_decode(tmp_path):
    config = _load(tmp_path)
    body = json.dumps(
        {
            "api_projection": {"bot_name": "rsi_modular_v2"},
            "rows": [
                {"order_id": f"order-{n}", "bot_name": "rsi_modular_v2"}
                for n in range(100)
            ],
        }
    ).encode()

    class PartialContent:
        def __init__(self):
            self.offset = 0

        async def read(self, size):
            end = min(len(body), self.offset + min(size, 7))
            chunk = body[self.offset : end]
            self.offset = end
            return chunk

    class Response:
        status = 200
        content_length = None

        def __init__(self):
            self.content = PartialContent()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

    class Session:
        def get(self, *_args, **_kwargs):
            return Response()

    async def read():
        client = fleet.NativeReadClient(config)
        client.session = Session()
        return await client.get(config.bots[0], "orders")

    payload = asyncio.run(read())
    assert len(payload["rows"]) == 100


def test_parse_command_supports_start_help_and_rejects_unknown():
    assert fleet.parse_command("/start") == ("start", "all")
    assert fleet.parse_command("/help") == ("help", "all")
    assert fleet.parse_command("/orders@rsibot_v2_bot v2") == ("orders", "v2")
    assert fleet.parse_command("/trade") is None
    assert fleet.parse_command("/status v2 extra") is None


def test_runtime_projection_uses_runtime_timestamp_and_hides_unapproved_status_fields():
    source = _config_sources()[0]
    payload = {
        "runtime_status": {
            "updated_at": 1_700_000_000,
            "summary": {
                "active_executor_count": 2,
                "pnl_available": False,
                "net_pnl_quote": 0,
                "balance_value_quote": 5000,
            },
            "active_orders_count": 3,
            "active_orders_status": "fresh",
            "private_field": "must-not-render",
        },
        "generated_at": time.time(),
        "balance_value_quote": 9999,
        "runtime_parity": {
            "runtime_status_available": True,
            "pnl_comparison_status": "UNAVAILABLE",
            "mismatches": [{"field": "held_position", "value": "private-value"}],
        },
        "api_projection": {"bot_name": "rsi_modular_v2", "source": "native_reporting"},
    }
    fleet._validate_owner_identity(payload, source)
    rendered = fleet._render_status(payload)
    assert "Stale snapshot" in rendered
    assert "old" in rendered
    assert "Active executors" in rendered
    assert "PnL unavailable" in rendered
    assert "Active orders: <b>3</b>" in rendered
    assert "1 reported mismatch" in rendered
    assert "balance_value_quote" not in rendered
    assert "must-not-render" not in rendered
    assert "private-value" not in rendered
    future_payload = {
        "runtime_status": {"updated_at": 4_000_000_000, "summary": {}},
        "api_projection": {"bot_name": "rsi_modular_v2"},
    }
    assert "Clock mismatch" in fleet._render_status(future_payload)
    with pytest.raises(fleet.NativeReadError, match="runtime_status"):
        fleet._render_status({"generated_at": time.time(), "status": {"balance": 4}})
    payload["api_projection"]["bot_name"] = "other-bot"
    with pytest.raises(fleet.NativeReadError):
        fleet._validate_owner_identity(payload, source)


def _config_sources():
    config_path = __file__
    # Construct through the same validator without writing persistent config.
    import tempfile

    with tempfile.TemporaryDirectory() as directory:
        source = _load(__import__("pathlib").Path(directory))
    return source.bots


def test_rows_require_known_schema_and_keep_native_ids():
    source = _config_sources()[0]
    payload = {
        "api_projection": {"bot_name": "rsi_modular_v2"},
        "rows": [
            {
                "order_id": "o-1",
                "bot_name": "rsi_modular_v2",
                "pair": "BTC-USDC",
                "side": "BUY",
                "amount_base": 0.01,
                "secret": "must-not-render",
            }
        ],
    }
    fleet._validate_owner_identity(payload, source, require_rows=True)
    text = fleet._render_rows("orders", payload)
    assert "o-1" in text and "BTC-USDC" in text and "0.01 BTC" in text
    assert "must-not-render" not in text
    with pytest.raises(fleet.NativeReadError):
        fleet._render_rows("orders", {"unexpected": []})
    for invalid_rows in ([None], [{"order_id": "missing-owner"}]):
        malformed = {
            "api_projection": {"bot_name": source.native_bot_name},
            "rows": invalid_rows,
        }
        with pytest.raises(fleet.NativeReadError):
            fleet._validate_owner_identity(malformed, source, require_rows=True)
    with pytest.raises(fleet.NativeReadError):
        fleet._render_rows("orders", {"rows": [None]})


def test_offset_store_is_durable_and_prevents_second_owner(tmp_path):
    path = tmp_path / "updates.sqlite"
    store = fleet.OffsetStore(str(path))
    store.set_offset(202)
    with pytest.raises(fleet.ConfigError, match="another fleet Telegram worker"):
        fleet.OffsetStore(str(path))
    store.close()
    restored = fleet.OffsetStore(str(path))
    assert restored.get_offset() == 202
    restored.close()


def test_process_update_requires_exact_user_and_private_chat(tmp_path, monkeypatch):
    config = _load(tmp_path)

    class FakeBot:
        def __init__(self):
            self.sent = []

        async def send_message(self, **kwargs):
            self.sent.append(kwargs)

    class FakeNativeReadClient:
        calls = 0

        def __init__(self, config):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        async def get(self, source, endpoint):
            type(self).calls += 1
            if endpoint == "status":
                return {
                    "runtime_status": {
                        "updated_at": 1_800_000_000,
                        "summary": {"state": "running"},
                    },
                    "api_projection": {"bot_name": source.native_bot_name},
                }
            return {
                "runtime_status": {"updated_at": 1_800_000_000},
                "api_projection": {"bot_name": source.native_bot_name},
            }

    monkeypatch.setattr(fleet, "NativeReadClient", FakeNativeReadClient)
    bot = FakeBot()
    worker = fleet.FleetTelegramWorker(
        config, "fake-token-never-logged", str(tmp_path / "state.sqlite"), bot=bot
    )
    try:
        asyncio.run(worker.process_update(_update(user_id=99999)))
        asyncio.run(
            worker.process_update(_update(chat_id=-10012345, chat_type="group"))
        )
        assert bot.sent == []
        assert FakeNativeReadClient.calls == 0

        asyncio.run(worker.process_update(_update(text="/start")))
        assert "Condor · Bot monitor" in bot.sent[-1]["text"]
        assert FakeNativeReadClient.calls == 0

        asyncio.run(worker.process_update(_update(text="/status v2")))
        assert len(bot.sent) == 2
        assert "RSI Modular V2 ·" in bot.sent[-1]["text"]
        assert FakeNativeReadClient.calls == 1
    finally:
        worker.state.close()


def test_api_failure_isolated_per_registered_bot(tmp_path, monkeypatch):
    config_value = _source_config()
    second = _source_config(bot="ok_rsi", identity="v1")["bots"][0]
    second["label"] = "OK RSI V1"
    config_value["bots"].append(second)
    config = _load(tmp_path, config_value)

    class FakeNativeReadClient:
        def __init__(self, config):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        async def get(self, source, endpoint):
            if source.id == "v1":
                raise fleet.NativeReadError("HTTP 503")
            if endpoint == "orders":
                return {
                    "api_projection": {"bot_name": source.native_bot_name},
                    "rows": [],
                }
            return {
                "runtime_status": {
                    "updated_at": 1_800_000_000,
                    "summary": {"state": "running"},
                },
                "api_projection": {"bot_name": source.native_bot_name},
            }

    monkeypatch.setattr(fleet, "NativeReadClient", FakeNativeReadClient)
    worker = fleet.FleetTelegramWorker(
        config, "fake-token", str(tmp_path / "state.sqlite"), bot=object()
    )
    try:
        response = asyncio.run(worker.execute("orders", "all"))
        assert "RSI Modular V2 ·" in response
        assert "No order history returned" in response
        assert "OK RSI V1 ·" in response
        assert "Data unavailable" in response and "HTTP 503" in response
    finally:
        worker.state.close()


def test_heartbeat_healthcheck_requires_recent_poll(tmp_path):
    path = tmp_path / "updates.sqlite"
    store = fleet.OffsetStore(str(path))
    store.heartbeat(
        status="running",
        last_poll_at=1000,
        last_successful_poll_at=1000,
        last_successful_command=900,
    )
    store.close()
    assert fleet.healthcheck(str(path), now=1050)
    assert not fleet.healthcheck(str(path), now=1200)


def test_failed_poll_attempt_does_not_keep_worker_healthy(tmp_path):
    path = tmp_path / "updates.sqlite"
    store = fleet.OffsetStore(str(path))
    store.heartbeat(status="retrying", last_poll_at=1190, last_successful_poll_at=1000)
    store.close()
    assert not fleet.healthcheck(
        str(path), now=1100 + fleet.HEARTBEAT_MAX_AGE_SECONDS + 1
    )


def test_retry_after_honors_server_delay_and_exits_on_cancel(tmp_path, monkeypatch):
    config = _load(tmp_path)
    path = tmp_path / "updates.sqlite"
    delays = []

    class FakeBot:
        calls = 0

        async def initialize(self):
            return None

        async def shutdown(self):
            return None

        async def get_updates(self, **_kwargs):
            self.calls += 1
            if self.calls == 1:
                raise fleet.RetryAfter(4)
            raise asyncio.CancelledError()

    async def fake_sleep(seconds):
        delays.append(seconds)

    monkeypatch.setattr(fleet.asyncio, "sleep", fake_sleep)
    worker = fleet.FleetTelegramWorker(config, "fake", str(path), bot=FakeBot())
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(worker.run())
    assert delays == [4]
    restored = fleet.OffsetStore(str(path))
    try:
        assert restored.get_offset() is None
    finally:
        restored.close()


def test_polling_conflict_is_persisted_and_does_not_restart_polling(tmp_path):
    config = _load(tmp_path)
    path = tmp_path / "updates.sqlite"

    class FakeBot:
        calls = 0

        async def initialize(self):
            return None

        async def shutdown(self):
            return None

        async def get_updates(self, **_kwargs):
            self.calls += 1
            raise fleet.Conflict("another poller")

    bot = FakeBot()
    worker = fleet.FleetTelegramWorker(config, "fake", str(path), bot=bot)
    with pytest.raises(fleet.Conflict):
        asyncio.run(worker.run())
    assert bot.calls == 1
    heartbeat = json.loads((tmp_path / "updates.sqlite.heartbeat.json").read_text())
    assert heartbeat["status"] == "conflict"

    second = fleet.FleetTelegramWorker(config, "fake", str(path), bot=bot)
    try:
        with pytest.raises(fleet.ConfigError, match="failed closed"):
            asyncio.run(second.run())
        assert bot.calls == 1
    finally:
        second.state.close()


def test_failed_reply_does_not_advance_persisted_update_offset(tmp_path, monkeypatch):
    config = _load(tmp_path)
    path = tmp_path / "updates.sqlite"
    offsets = []
    update = _update(text="/start", update_id=55)

    class FakeBot:
        calls = 0

        async def initialize(self):
            return None

        async def shutdown(self):
            return None

        async def get_updates(self, *, offset, **_kwargs):
            offsets.append(offset)
            self.calls += 1
            if self.calls == 1:
                return [update]
            raise asyncio.CancelledError()

        async def send_message(self, **_kwargs):
            raise fleet.TelegramError("send failed")

    async def no_wait(_seconds):
        return None

    monkeypatch.setattr(fleet.asyncio, "sleep", no_wait)
    bot = FakeBot()
    worker = fleet.FleetTelegramWorker(config, "fake", str(path), bot=bot)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(worker.run())
    assert offsets == [None, None]
    restored = fleet.OffsetStore(str(path))
    try:
        assert restored.get_offset() is None
    finally:
        restored.close()


def test_buttons_recheck_private_user_and_route_read_only_with_pagination(
    tmp_path, monkeypatch
):
    class FakeBot:
        def __init__(self):
            self.sent, self.edited, self.answered = [], [], []

        async def send_message(self, **kw):
            self.sent.append(kw)

        async def edit_message_text(self, **kw):
            self.edited.append(kw)

        async def answer_callback_query(self, **kw):
            self.answered.append(kw)

    calls = []

    class FakeClient:
        def __init__(self, config):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            pass

        async def get(self, source, key):
            calls.append((source.id, key))
            return {
                "api_projection": {"bot_name": source.native_bot_name},
                "rows": [
                    {
                        "bot_name": source.native_bot_name,
                        "order_id": f"order-{i}",
                        "pair": "BTC-USDC",
                        "side": "buy",
                    }
                    for i in range(10)
                ],
            }

    monkeypatch.setattr(fleet, "NativeReadClient", FakeClient)
    bot = FakeBot()
    worker = fleet.FleetTelegramWorker(
        _load(tmp_path), "fake", str(tmp_path / "cursor.sqlite"), bot=bot
    )

    def callback(data="fleet:v2:orders:1", user=12345, chat=12345, kind="private"):
        return SimpleNamespace(
            callback_query=SimpleNamespace(
                id="q",
                data=data,
                from_user=SimpleNamespace(id=user),
                message=SimpleNamespace(
                    message_id=9, chat=SimpleNamespace(id=chat, type=kind)
                ),
            )
        )

    try:
        asyncio.run(worker.process_update(callback(user=987)))
        asyncio.run(worker.process_update(callback(chat=-22, kind="group")))
        assert not calls and not bot.answered and not bot.edited
        asyncio.run(worker.process_update(callback("fleet:v2:buy:0")))
        asyncio.run(worker.process_update(callback("fleet:unregistered:orders:0")))
        assert not calls and not bot.edited
        asyncio.run(worker.process_update(callback()))
        assert calls == [("v2", "orders")]
        assert len(bot.edited) == 1 and not bot.sent
        assert "6–10 of 10" in bot.edited[0]["text"]
        assert bot.edited[0]["parse_mode"] == "HTML"
        buttons = [
            button.callback_data
            for row in bot.edited[0]["reply_markup"].inline_keyboard
            for button in row
        ]
        assert "fleet:v2:orders:0" in buttons and "fleet:v2:fills:0" in buttons
        assert all(len(value.encode()) <= 64 for value in buttons)
    finally:
        worker.state.close()


def test_unchanged_callback_acknowledges_without_duplicate_message(
    tmp_path, monkeypatch
):
    class FakeBot:
        sent = []

        async def answer_callback_query(self, **kw):
            pass

        async def edit_message_text(self, **kw):
            raise fleet.BadRequest("Message is not modified")

        async def send_message(self, **kw):
            self.sent.append(kw)

    bot = FakeBot()
    worker = fleet.FleetTelegramWorker(
        _load(tmp_path), "fake", str(tmp_path / "cursor.sqlite"), bot=bot
    )
    update = SimpleNamespace(
        callback_query=SimpleNamespace(
            id="q",
            data="fleet:v2:help:0",
            from_user=SimpleNamespace(id=12345),
            message=SimpleNamespace(
                message_id=9, chat=SimpleNamespace(id=12345, type="private")
            ),
        )
    )
    try:
        asyncio.run(worker.process_update(update))
        assert not bot.sent and worker.last_successful_command is not None
    finally:
        worker.state.close()


def test_quote_currency_is_configured_not_assumed(tmp_path):
    value = _source_config()
    value["bots"][0]["quote_currency"] = "USDC"
    assert _load(tmp_path, value).bots[0].quote_currency == "USDC"
    value["bots"][0]["quote_currency"] = "<b>USD</b>"
    with pytest.raises(fleet.ConfigError):
        _load(tmp_path, value)
