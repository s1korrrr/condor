"""Read-only, owner-scoped fleet Telegram command worker tests."""

import asyncio
import json
import time
from types import SimpleNamespace

import aiohttp
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


def _discovery_config():
    config = _source_config()
    config["bots"][0]["endpoints"] = {
        key: endpoint.replace("limit=5", "limit=10")
        for key, endpoint in config["bots"][0]["endpoints"].items()
    }
    config["bots"].append(
        {
            "id": "v3",
            "label": "Meridian V3",
            "native_bot_name": "meridian_v3",
            "api_base_url": "http://native-api:8000",
            "api_username": "reader",
            "api_password": "private-test-secret",
            "endpoints": {
                "status": "/trading-visuals/runtime-status?bot=meridian_v3",
                "orders": "/trading-visuals/orders?bot=meridian_v3&limit=10",
                "fills": "/trading-visuals/fills?bot=meridian_v3&limit=10",
                "executors": "/trading-visuals/executors?bot=meridian_v3&limit=10",
            },
        }
    )
    config["discovery"] = {
        "api_base_url": "http://native-api:8000",
        "api_username": "reader",
        "api_password": "private-test-secret",
        "endpoint": "/bot-orchestration/catalogue",
        "aliases": {"rsi_modular_v2": "v2", "meridian_v3": "v3"},
        "refresh_seconds": 30,
    }
    config["trade_alerts"] = True
    return config


def _catalogue(*rows):
    return {"schema_version": "native-catalogue/1", "bots": list(rows)}


def _catalogue_bot(identity, label=None):
    return {
        "id": identity,
        "display_name": label or identity,
        "profile": "spot",
        "execution_mode": "paper",
        "simulated": True,
        "capabilities": {"status": True, "reporting": True, "controls": False},
        "endpoints": {
            "status": f"/bot-orchestration/{identity}/status",
            "bootstrap": f"/trading-visuals/bootstrap?bot={identity}",
            "runtime_status": f"/trading-visuals/runtime-status?bot={identity}",
            "orders": f"/trading-visuals/orders?bot={identity}&limit=5",
            "fills": f"/trading-visuals/fills?bot={identity}&limit=5",
            "executors": f"/trading-visuals/executors?bot={identity}&limit=5",
        },
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


@pytest.mark.parametrize(
    ("message", "expected"),
    [
        ("HTTP 503", {"reason": "http_status", "http_status": 503}),
        (
            "TimeoutError",
            {"reason": "request_timeout", "http_status": None},
        ),
        (
            "https://reader:credential-secret@native.example/bot/token-secret?chat_id=private-id",
            {"reason": "native_read_error", "http_status": None},
        ),
        (
            "response failed with credential-secret",
            {"reason": "native_read_error", "http_status": None},
        ),
    ],
)
def test_native_read_error_summary_never_exposes_urls_or_credentials(message, expected):
    summary = fleet.safe_native_read_error(fleet.NativeReadError(message))

    assert summary == expected
    assert "credential-secret" not in repr(summary)
    assert "token-secret" not in repr(summary)
    assert "private-id" not in repr(summary)
    assert "native.example" not in repr(summary)


def test_deployed_aiohttp_error_classes_have_allowlisted_summaries():
    # This is the complete ClientError subclass set in the deployed aiohttp 3.13.3 image.
    deployed_names = {
        "ClientConnectionError",
        "ClientConnectionResetError",
        "ClientConnectorCertificateError",
        "ClientConnectorDNSError",
        "ClientConnectorError",
        "ClientConnectorSSLError",
        "ClientHttpProxyError",
        "ClientOSError",
        "ClientPayloadError",
        "ClientProxyConnectionError",
        "ClientResponseError",
        "ClientSSLError",
        "ConnectionTimeoutError",
        "ContentTypeError",
        "InvalidURL",
        "InvalidUrlClientError",
        "InvalidUrlRedirectClientError",
        "NonHttpUrlClientError",
        "NonHttpUrlRedirectClientError",
        "RedirectClientError",
        "ServerConnectionError",
        "ServerDisconnectedError",
        "ServerFingerprintMismatch",
        "ServerTimeoutError",
        "SocketTimeoutError",
        "TooManyRedirects",
        "UnixClientConnectorError",
        "WSServerHandshakeError",
    }

    assert all(
        fleet.safe_native_read_error(fleet.NativeReadError(name))["reason"]
        != "native_read_error"
        for name in deployed_names
    )


def test_trade_alert_read_logs_safe_reason_and_clears_it_after_recovery(
    tmp_path, monkeypatch, caplog
):
    config_value = _source_config()
    config_value["trade_alerts"] = True
    config = _load(tmp_path, config_value)
    secrets = (
        "reader",
        "private-test-secret",
        "reader-user",
        "credential-secret",
        "token-secret",
        "private-chat-id",
        "native.example",
    )
    calls = 0

    class FakeBot:
        def __init__(self):
            self.sent = []

        async def send_message(self, **kwargs):
            self.sent.append(kwargs)

    class FakeNativeReadClient:
        def __init__(self, _config):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        async def get(self, source, command):
            nonlocal calls
            assert command == "fills"
            assert source.api_username == "reader"
            assert source.api_password == "private-test-secret"
            calls += 1
            if calls == 1:
                raise fleet.NativeReadError(
                    "https://reader-user:credential-secret@native.example/"
                    "bot/token-secret?chat_id=private-chat-id"
                )
            return {
                "api_projection": {"bot_name": source.native_bot_name},
                "rows": [
                    {
                        "fill_id": "fill-1",
                        "order_id": "order-1",
                        "bot_name": source.native_bot_name,
                        "connector_name": "okx",
                        "source_db_id": "native-db",
                        "pair": "BTC-USDC",
                        "side": "buy",
                        "exact_amount": "0.001",
                        "exact_price": "100",
                        "exact_trade_fee_in_quote": "0.01",
                        "timestamp": time.time() + 1,
                    }
                ],
            }

    monkeypatch.setattr(fleet, "NativeReadClient", FakeNativeReadClient)
    bot = FakeBot()
    worker = fleet.FleetTelegramWorker(
        config, "token-secret", str(tmp_path / "alerts.sqlite"), bot=bot
    )
    key = "trade_alert_error:" + fleet.source_key(config.bots[0])
    try:
        asyncio.run(worker.notify_trades())
        stored = worker.state.db.execute(
            "SELECT value FROM state WHERE key=?", (key,)
        ).fetchone()[0]
        assert json.loads(stored) == {
            "http_status": None,
            "reason": "native_read_error",
        }
        assert "reason=native_read_error" in caplog.text
        assert "http_status=none" in caplog.text
        for secret in secrets:
            assert secret not in caplog.text
        assert bot.sent == []

        asyncio.run(worker.notify_trades())
        stored = worker.state.db.execute(
            "SELECT value FROM state WHERE key=?", (key,)
        ).fetchone()[0]
        assert stored == ""
        assert len(bot.sent) == 1
        assert "BUY" in bot.sent[0]["text"]
    finally:
        worker.state.close()


def test_handle_update_command_reply_uses_capturing_telegram_transport(
    tmp_path, monkeypatch
):
    requests = []

    class CapturingBot:
        def __init__(self):
            self.messages = []

        async def send_message(self, **kwargs):
            self.messages.append(kwargs)

    class ReadOnlyNativeClient:
        def __init__(self, _config):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        async def get(self, source, endpoint):
            requests.append((source.id, endpoint))
            return {
                "runtime_status": {
                    "updated_at": time.time(),
                    "summary": {"state": "running"},
                },
                "api_projection": {"bot_name": source.native_bot_name},
            }

    monkeypatch.setattr(fleet, "NativeReadClient", ReadOnlyNativeClient)
    bot = CapturingBot()
    worker = fleet.FleetTelegramWorker(
        _load(tmp_path), "test-token-not-sent", str(tmp_path / "state.sqlite"), bot=bot
    )
    try:
        asyncio.run(worker.process_update(_update(text="/status v2")))

        assert requests == [("v2", "status")]
        assert len(bot.messages) == 1
        assert "RSI Modular V2 ·" in bot.messages[0]["text"]
        assert bot.messages[0]["chat_id"] == 12345
    finally:
        worker.state.close()


@pytest.mark.parametrize(
    ("error_kind", "status", "expected"),
    [
        (
            "server_disconnected",
            None,
            {"http_status": None, "reason": "server_disconnected"},
        ),
        (
            "client_response",
            503,
            {"http_status": 503, "reason": "http_status"},
        ),
        (
            "client_response_default_status",
            0,
            {"http_status": None, "reason": "http_response_error"},
        ),
        (
            "client_response_string_status",
            "503",
            {"http_status": None, "reason": "http_response_error"},
        ),
        (
            "client_response_missing_status",
            None,
            {"http_status": None, "reason": "http_response_error"},
        ),
        (
            "unknown_secret_error",
            None,
            {"http_status": None, "reason": "native_read_error"},
        ),
    ],
)
def test_aiohttp_transport_errors_are_safely_classified_in_alert_path(
    error_kind, status, expected, tmp_path, monkeypatch, caplog
):
    config_value = _source_config()
    config_value["trade_alerts"] = True
    config = _load(tmp_path, config_value)
    secrets = (
        "https://reader:credential-secret@native.example/bot/token-secret",
        "private-chat-id",
    )

    if error_kind == "server_disconnected":
        transport_error = aiohttp.ServerDisconnectedError(secrets[0])
    elif error_kind.startswith("client_response"):
        request_info = SimpleNamespace(
            real_url=aiohttp.client_reqrep.URL(secrets[0]),
            method="GET",
            headers={},
            real_method="GET",
        )
        transport_error = aiohttp.ClientResponseError(
            request_info,
            (),
            status=status,
            message=secrets[1],
        )
    else:

        class CredentialBearingClientError(aiohttp.ClientError):
            pass

        transport_error = CredentialBearingClientError(secrets[0] + secrets[1])

    class FakeSession:
        def __init__(self, **_kwargs):
            pass

        def get(self, *_args, **_kwargs):
            raise transport_error

        async def close(self):
            return None

    monkeypatch.setattr(fleet.aiohttp, "ClientSession", FakeSession)
    bot = type("CapturingBot", (), {"sent": []})()
    worker = fleet.FleetTelegramWorker(
        config, "telegram-token-secret", str(tmp_path / "state.sqlite"), bot=bot
    )
    key = "trade_alert_error:" + fleet.source_key(config.bots[0])
    try:
        asyncio.run(worker.notify_trades())

        stored = worker.state.db.execute(
            "SELECT value FROM state WHERE key=?", (key,)
        ).fetchone()[0]
        assert json.loads(stored) == expected
        assert f"reason={expected['reason']}" in caplog.text
        for secret in (*secrets, "telegram-token-secret"):
            assert secret not in caplog.text
            assert secret not in stored
        assert bot.sent == []
    finally:
        worker.state.close()


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


def test_catalogue_discovers_third_bot_and_preserves_v2_v3_source_cursors(
    tmp_path, monkeypatch
):
    config = _load(tmp_path, _discovery_config())
    catalogue = _catalogue(
        _catalogue_bot("rsi_modular_v2", "RSI V2"),
        _catalogue_bot("meridian_v3", "Meridian V3"),
        _catalogue_bot("breakout_v4", "Breakout V4"),
    )
    requests = []

    class ReadOnlyClient:
        def __init__(self, _config):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        async def get_catalogue(self):
            return catalogue

        async def get(self, source, command):
            requests.append((source.id, command))
            return {
                "runtime_status": {
                    "updated_at": time.time(),
                    "summary": {"state": "running"},
                },
                "api_projection": {"bot_name": source.native_bot_name},
            }

    monkeypatch.setattr(fleet, "NativeReadClient", ReadOnlyClient)
    worker = fleet.FleetTelegramWorker(
        config,
        "test-token-not-sent",
        str(tmp_path / "state.sqlite"),
        bot=SimpleNamespace(),
    )
    try:
        old_keys = {source.id: fleet.source_key(source) for source in config.bots}
        old_started = {
            key: worker.state.db.execute(
                "SELECT started FROM trade_sources WHERE source=?", (source_key,)
            ).fetchone()[0]
            for key, source_key in old_keys.items()
        }
        seen_key = json.dumps(
            ["rsi_modular_v2", "native-db", "okx", "order-old", "fill-old"],
            separators=(",", ":"),
        )
        worker.state.db.execute(
            "INSERT INTO trade_seen VALUES (?,?)", (old_keys["v2"], seen_key)
        )
        worker.state.db.execute(
            "INSERT INTO trade_outbox(source,recipient,rows_json,delivered) VALUES(?,?,?,?)",
            (old_keys["v3"], 12345, '[{"fill_id":"pending"}]', 0),
        )
        worker.state.db.commit()

        assert asyncio.run(worker.refresh_catalogue(force=True)) is True
        assert [source.id for source in worker.config.bots] == [
            "breakout_v4",
            "v2",
            "v3",
        ]
        assert {
            source.id: fleet.source_key(source)
            for source in worker.config.bots
            if source.id in old_keys
        } == old_keys
        assert {
            key: worker.state.db.execute(
                "SELECT started FROM trade_sources WHERE source=?", (source_key,)
            ).fetchone()[0]
            for key, source_key in old_keys.items()
        } == old_started
        assert worker.state.db.execute(
            "SELECT fill FROM trade_seen WHERE source=?", (old_keys["v2"],)
        ).fetchall() == [(seen_key,)]
        assert worker.state.db.execute(
            "SELECT recipient,rows_json,delivered FROM trade_outbox WHERE source=?",
            (old_keys["v3"],),
        ).fetchall() == [(12345, '[{"fill_id":"pending"}]', 0)]

        result = asyncio.run(worker.render("status", "breakout_v4"))
        assert [source_id for source_id, _ in result] == ["breakout_v4"]
        assert "Breakout V4" in result[0][1].text
        assert requests == [("breakout_v4", "status")]
    finally:
        worker.state.close()


@pytest.mark.parametrize(
    "rows",
    [
        (
            _catalogue_bot("rsi_modular_v2"),
            _catalogue_bot("breakout_v4"),
            _catalogue_bot("breakout_v4"),
        ),
        (_catalogue_bot("../bad"),),
        (_catalogue_bot("bad id"),),
    ],
)
def test_invalid_or_duplicate_catalogue_ids_fail_closed(tmp_path, monkeypatch, rows):
    class ReadOnlyClient:
        def __init__(self, _config):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        async def get_catalogue(self):
            return _catalogue(*rows)

    monkeypatch.setattr(fleet, "NativeReadClient", ReadOnlyClient)
    state_path = tmp_path / "state.sqlite"
    worker = fleet.FleetTelegramWorker(
        _load(tmp_path, _discovery_config()),
        "test-token-not-sent",
        str(state_path),
        bot=SimpleNamespace(),
    )
    try:
        assert asyncio.run(worker.refresh_catalogue(force=True)) is False
        assert [source.id for source in worker.config.bots] == ["v2", "v3"]
        assert worker.catalogue_error == "catalogue_invalid"
        assert worker.state.db.execute(
            "SELECT value FROM state WHERE key='catalogue_discovery_error'"
        ).fetchone() == ("catalogue_invalid",)
    finally:
        worker.state.close()


def test_catalogue_outage_keeps_last_known_sources_and_surfaces_error(
    tmp_path, monkeypatch
):
    catalogue = _catalogue(
        _catalogue_bot("rsi_modular_v2", "RSI V2"),
        _catalogue_bot("meridian_v3", "Meridian V3"),
        _catalogue_bot("breakout_v4", "Breakout V4"),
    )
    fail_catalogue = False

    class ReadOnlyClient:
        def __init__(self, _config):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        async def get_catalogue(self):
            if fail_catalogue:
                raise fleet.NativeReadError("HTTP 503")
            return catalogue

        async def get(self, source, command):
            return {
                "runtime_status": {
                    "updated_at": time.time(),
                    "summary": {"state": "running"},
                },
                "api_projection": {"bot_name": source.native_bot_name},
            }

    monkeypatch.setattr(fleet, "NativeReadClient", ReadOnlyClient)
    state_path = tmp_path / "state.sqlite"
    worker = fleet.FleetTelegramWorker(
        _load(tmp_path, _discovery_config()),
        "test-token-not-sent",
        str(state_path),
        bot=SimpleNamespace(),
    )
    try:
        assert asyncio.run(worker.refresh_catalogue(force=True)) is True
        known_sources = tuple(worker.config.bots)
        fail_catalogue = True
        assert asyncio.run(worker.refresh_catalogue(force=True)) is False
        assert tuple(worker.config.bots) == known_sources
        worker.state.close()

        worker = fleet.FleetTelegramWorker(
            _load(tmp_path, _discovery_config()),
            "test-token-not-sent",
            str(state_path),
            bot=SimpleNamespace(),
        )
        assert [source.id for source in worker.config.bots] == [
            "breakout_v4",
            "v2",
            "v3",
        ]
        result = asyncio.run(worker.render("status", "v3"))
        assert len(result) == 1
        assert "Meridian V3" in result[0][1].text
        assert "Bot discovery unavailable" in result[0][1].text
        assert "HTTP 503" in result[0][1].text
    finally:
        worker.state.close()


def test_long_catalogue_id_uses_bounded_callback_target(tmp_path, monkeypatch):
    native_id = "breakout_" + "x" * 60
    catalogue = _catalogue(
        _catalogue_bot("rsi_modular_v2"),
        _catalogue_bot("meridian_v3"),
        _catalogue_bot(native_id, "Long name bot"),
    )

    class ReadOnlyClient:
        def __init__(self, _config):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        async def get_catalogue(self):
            return catalogue

    monkeypatch.setattr(fleet, "NativeReadClient", ReadOnlyClient)
    worker = fleet.FleetTelegramWorker(
        _load(tmp_path, _discovery_config()),
        "test-token-not-sent",
        str(tmp_path / "state.sqlite"),
        bot=SimpleNamespace(),
    )
    try:
        assert asyncio.run(worker.refresh_catalogue(force=True)) is True
        keyboard = worker.keyboard("status", native_id)
        callback = keyboard.inline_keyboard[0][0].callback_data
        assert len(callback.encode("utf-8")) <= 64
        parsed = fleet.views.parse_callback(callback)
        assert parsed == ("status", worker._callback_target(native_id), 0)
        assert worker._resolve_callback_target(parsed[1]) == native_id
    finally:
        worker.state.close()


def test_catalogue_accepts_owner_maximum_id_and_display_name(tmp_path):
    native_id = "n" * 100
    label = "L" * 120
    seed = _source_config(bot=native_id)
    seed["bots"][0]["label"] = label
    assert _load(tmp_path, seed).bots[0].native_bot_name == native_id
    value = _discovery_config()
    value["discovery"]["aliases"][native_id] = "long"
    config = _load(tmp_path, value)
    sources = fleet._catalogue_source_rows(
        _catalogue(_catalogue_bot(native_id, label)), config
    )
    assert [
        (source.id, source.native_bot_name, source.label) for source in sources
    ] == [("long", native_id, label)]


def test_discovery_without_seed_alias_retains_one_native_owner_and_cursor(
    tmp_path, monkeypatch
):
    value = _discovery_config()
    value["discovery"]["aliases"].pop("rsi_modular_v2")
    config = _load(tmp_path, value)

    class ReadOnlyClient:
        def __init__(self, _config):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        async def get_catalogue(self):
            return _catalogue(
                _catalogue_bot("rsi_modular_v2"), _catalogue_bot("meridian_v3")
            )

    monkeypatch.setattr(fleet, "NativeReadClient", ReadOnlyClient)
    worker = fleet.FleetTelegramWorker(
        config,
        "test-token-not-sent",
        str(tmp_path / "state.sqlite"),
        bot=SimpleNamespace(),
    )
    try:
        old_key = fleet.source_key(config.bots[0])
        assert asyncio.run(worker.refresh_catalogue(force=True)) is True
        assert [source.native_bot_name for source in worker.config.bots].count(
            "rsi_modular_v2"
        ) == 1
        assert (
            next(
                source
                for source in worker.config.bots
                if source.native_bot_name == "rsi_modular_v2"
            ).id
            == "v2"
        )
        assert (
            fleet.source_key(
                next(
                    source
                    for source in worker.config.bots
                    if source.native_bot_name == "rsi_modular_v2"
                )
            )
            == old_key
        )
    finally:
        worker.state.close()


def test_seed_registry_rejects_two_aliases_for_one_native_owner(tmp_path):
    value = _discovery_config()
    duplicate = dict(value["bots"][0])
    duplicate["id"] = "other_v2"
    value["bots"].append(duplicate)
    with pytest.raises(fleet.ConfigError, match="duplicate native bot name"):
        _load(tmp_path, value)


def test_successful_catalogue_removal_retires_reads_but_drains_pending_outbox(
    tmp_path, monkeypatch
):
    config = _load(tmp_path, _discovery_config())
    catalogue = _catalogue(
        _catalogue_bot("rsi_modular_v2"),
        _catalogue_bot("meridian_v3"),
        _catalogue_bot("breakout_v4", "Breakout V4"),
    )
    reads = []

    class ReadOnlyClient:
        def __init__(self, _config):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        async def get_catalogue(self):
            return catalogue

        async def get(self, source, command):
            reads.append((source.id, command))
            return {"api_projection": {"bot_name": source.native_bot_name}, "rows": []}

    class CapturingBot:
        def __init__(self):
            self.sent = []

        async def send_message(self, **kwargs):
            self.sent.append(kwargs)

    monkeypatch.setattr(fleet, "NativeReadClient", ReadOnlyClient)
    state_path = str(tmp_path / "state.sqlite")
    bot = CapturingBot()
    worker = fleet.FleetTelegramWorker(
        config, "test-token-not-sent", state_path, bot=bot
    )
    try:
        assert asyncio.run(worker.refresh_catalogue(force=True)) is True
        retired = next(
            source for source in worker.config.bots if source.id == "breakout_v4"
        )
        retired_key = fleet.source_key(retired)
        fill = {
            "fill_id": "f1",
            "order_id": "o1",
            "bot_name": "breakout_v4",
            "connector_name": "okx",
            "source_db_id": "db",
            "side": "buy",
            "pair": "BTC-USDC",
            "exact_amount": "0.001",
            "exact_price": "100",
            "exact_trade_fee_in_quote": "0.01",
            "timestamp": time.time() + 1,
        }
        worker.state.db.execute(
            "INSERT INTO trade_outbox(source,recipient,rows_json) VALUES(?,?,?)",
            (retired_key, 12345, json.dumps([fill])),
        )
        worker.state.db.commit()
        catalogue = _catalogue(_catalogue_bot("rsi_modular_v2"))
        assert asyncio.run(worker.refresh_catalogue(force=True)) is True
        assert [source.id for source in worker.config.bots] == ["v2", "v3"]
        assert worker._missing_seed_ids == {"v3"}
        assert worker.catalogue_error is None
        worker.state.close()

        worker = fleet.FleetTelegramWorker(
            config, "test-token-not-sent", state_path, bot=bot
        )
        assert [source.id for source in worker.config.bots] == ["v2", "v3"]
        assert worker._missing_seed_ids == {"v3"}
        status = asyncio.run(worker.render("status", "v3"))
        assert "absent from the current native catalogue" in status[0][1].text
        reads.clear()
        asyncio.run(worker.notify_trades())
        assert reads == [("v2", "fills"), ("v3", "fills")]
        assert len(bot.sent) == 1
        assert "Breakout V4" in bot.sent[0]["text"]
        assert bot.sent[0].get("reply_markup") is None
        assert worker.trade_alerts.pending([12345]) == []
    finally:
        worker.state.close()


@pytest.mark.parametrize("count", [101, 128, 129])
def test_catalogue_count_matches_shared_owner_contract(tmp_path, count):
    config = _load(tmp_path, _discovery_config())
    payload = _catalogue(*(_catalogue_bot(f"future_{i}") for i in range(count)))
    if count > 128:
        with pytest.raises(fleet.ConfigError, match="limit"):
            fleet._catalogue_source_rows(payload, config)
    else:
        assert len(fleet._catalogue_source_rows(payload, config)) == count


def test_trade_alerts_deliver_pending_and_healthy_source_before_slow_read(
    tmp_path, monkeypatch
):
    config = _source_config()
    config["trade_alerts"] = True
    for index in range(1, 10):
        row = dict(config["bots"][0])
        row["id"] = f"owner_{index}"
        row["native_bot_name"] = f"owner_{index}"
        row["endpoints"] = {
            key: value.replace("{bot}", row["native_bot_name"])
            for key, value in row["endpoints"].items()
        }
        config["bots"].append(row)
    loaded = _load(tmp_path, config)
    sent = []
    preexisting_delivered = asyncio.Event()
    healthy_delivered = asyncio.Event()
    release_slow = asyncio.Event()
    eight_started = asyncio.Event()
    active = 0
    peak = 0

    def alert_fill(source, fill_id):
        return {
            "fill_id": fill_id,
            "order_id": fill_id,
            "bot_name": source.native_bot_name,
            "connector_name": "okx",
            "source_db_id": "db",
            "side": "buy",
            "pair": "BTC-USDC",
            "exact_amount": "0.001",
            "exact_price": "100",
            "exact_trade_fee_in_quote": "0.01",
            "timestamp": time.time() + 1,
        }

    class CapturingBot:
        async def send_message(self, **kwargs):
            sent.append(kwargs["text"])
            if "preexisting" in kwargs["text"]:
                preexisting_delivered.set()
            if "healthy-fill" in kwargs["text"]:
                healthy_delivered.set()

    worker = fleet.FleetTelegramWorker(
        loaded,
        "test-token-not-sent",
        str(tmp_path / "alerts.sqlite"),
        bot=CapturingBot(),
    )
    source = loaded.bots[0]
    worker.state.db.execute("UPDATE trade_sources SET started=0")
    worker.state.db.execute(
        "INSERT INTO trade_outbox(source,recipient,rows_json) VALUES(?,?,?)",
        (
            fleet.source_key(source),
            12345,
            json.dumps([alert_fill(source, "preexisting")]),
        ),
    )
    worker.state.db.commit()

    async def refresh_after_pending():
        assert preexisting_delivered.is_set()
        return False

    monkeypatch.setattr(worker, "refresh_catalogue", refresh_after_pending)

    async def fake_read(_client, selected, command):
        nonlocal active, peak
        assert preexisting_delivered.is_set()
        assert command == "fills" and "limit=1000" in selected.endpoints["fills"]
        active += 1
        peak = max(peak, active)
        if active == 8:
            eight_started.set()
        try:
            if selected.id != "owner_1":
                await release_slow.wait()
                return {
                    "api_projection": {"bot_name": selected.native_bot_name},
                    "rows": [],
                }
            return {
                "api_projection": {"bot_name": selected.native_bot_name},
                "rows": [alert_fill(selected, "healthy-fill")],
            }
        finally:
            active -= 1

    monkeypatch.setattr(fleet.NativeReadClient, "get", fake_read)

    async def scenario():
        task = asyncio.create_task(worker.notify_trades())
        try:
            await asyncio.wait_for(preexisting_delivered.wait(), 2)
            await asyncio.wait_for(healthy_delivered.wait(), 2)
            await asyncio.wait_for(eight_started.wait(), 2)
            assert not release_slow.is_set()
            assert peak <= 8
            release_slow.set()
            await asyncio.wait_for(task, 2)
        finally:
            release_slow.set()
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    try:
        asyncio.run(scenario())
        assert len(sent) == 2
        assert worker.trade_alerts.pending([12345]) == []
    finally:
        worker.state.close()


def test_trade_read_cancellation_closes_bounded_inflight_requests(
    tmp_path, monkeypatch
):
    config = _source_config()
    config["trade_alerts"] = True
    for index in range(1, 12):
        row = dict(config["bots"][0])
        row["id"] = f"owner_{index}"
        row["native_bot_name"] = f"owner_{index}"
        config["bots"].append(row)
    entered_eight = asyncio.Event()
    never_released = asyncio.Event()
    closed = asyncio.Event()
    active = 0
    peak = 0

    class HoldingClient:
        def __init__(self, _config):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            closed.set()

        async def get(self, _source, _command):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            if active == fleet.MAX_TRADE_READ_CONCURRENCY:
                entered_eight.set()
            try:
                await never_released.wait()
            finally:
                active -= 1

    monkeypatch.setattr(fleet, "NativeReadClient", HoldingClient)
    worker = fleet.FleetTelegramWorker(
        _load(tmp_path, config),
        "test-token-not-sent",
        str(tmp_path / "state.sqlite"),
        bot=SimpleNamespace(),
    )

    async def scenario():
        task = asyncio.create_task(worker.notify_trades())
        try:
            await asyncio.wait_for(entered_eight.wait(), 2)
            assert active == fleet.MAX_TRADE_READ_CONCURRENCY
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(task, 2)
            assert active == 0
            assert closed.is_set()
            assert peak <= fleet.MAX_TRADE_READ_CONCURRENCY
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    try:
        asyncio.run(scenario())
    finally:
        worker.state.close()
