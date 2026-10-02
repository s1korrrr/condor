import sqlite3
import pytest
from condor.fleet_trade_alerts import TradeAlerts, render_fill_alert


def fill(identity="one", **changes):
    row = dict(
        fill_id=identity,
        order_id="order-1",
        bot_name="v2",
        connector_name="okx",
        source_db_id="db",
        side="buy",
        pair="BTC-USDC",
        exact_amount="0.00011",
        exact_price="84105.6",
        exact_trade_fee_in_quote="0.0074012928",
        timestamp="2026-09-24T08:26:09+00:00",
    )
    return row | changes


def test_restart_dedup_and_retry_persistence(tmp_path):
    path = tmp_path / "alerts.sqlite"
    db = sqlite3.connect(path)
    store = TradeAlerts(db)
    store.start("s", 0)
    assert store.ingest("s", [fill()], [12]) == 1
    assert store.ingest("s", [fill()], [12]) == 0
    delivery = store.pending([12])[0]
    db.close()
    db = sqlite3.connect(path)
    store = TradeAlerts(db)
    assert store.pending([12])[0] == delivery
    store.sent(delivery[0])
    assert store.pending([12]) == []
    assert store.ingest("s", [fill()], [12]) == 0


def test_history_not_replayed_and_new_fills_grouped():
    store = TradeAlerts(sqlite3.connect(":memory:"))
    store.start("s", 1790238369)
    old = fill("old", timestamp="2026-09-23T00:00:00Z")
    assert (
        store.ingest(
            "s", [old, fill(), fill("two", exact_amount="0.00036461")], [12, 13]
        )
        == 2
    )
    assert len(store.pending([12, 13])) == 2
    rows = store.pending([12])[0][3]
    assert len(rows) == 2
    text = render_fill_alert("RSI V2", rows)
    assert "0.00047461" in text and "39.92" in text
    assert "2 fills" in text


def test_invalid_batch_is_atomic_and_source_scope_isolated():
    store = TradeAlerts(sqlite3.connect(":memory:"))
    store.start("s", 0)
    with pytest.raises(ValueError):
        store.ingest("s", [fill(), fill("bad", side=None)], [12])
    assert store.pending([12]) == []
    assert store.ingest("s", [fill()], [12]) == 1
    store.start("other", 0)
    assert store.ingest("other", [fill()], [12]) == 1
    assert store.pending([99]) == []


@pytest.mark.parametrize(
    "change",
    [
        {"fill_id": None},
        {"timestamp": "bad"},
        {"exact_amount": "NaN"},
        {"exact_price": "-1"},
        {"pair": "BTC"},
        {"exact_trade_fee_in_quote": "Infinity"},
    ],
)
def test_invalid_fill_rejected(change):
    with pytest.raises(ValueError):
        render_fill_alert("V2", [fill(**change)])


def test_sell_unknown_basis_not_fabricated_and_html_escaped():
    text = render_fill_alert(
        "<V2>", [fill(side="sell", order_id="<order>", exact_trade_fee_in_quote=None)]
    )
    assert (
        "🔴" in text
        and "SELL" in text
        and "&lt;V2&gt;" in text
        and "&lt;order&gt;" in text
    )
    assert "Realized PnL: unavailable" in text and "Fee: unavailable" in text
    assert "maker" not in text.lower()


def test_tail_saturation_needs_overlap():
    store = TradeAlerts(sqlite3.connect(":memory:"))
    store.start("s", 0)
    assert not store.has_coverage("s", [fill()], limit=1)
    store.ingest("s", [fill()], [12])
    assert store.has_coverage("s", [fill()], limit=1)


def test_worker_delivers_retries_and_rejects_wrong_owner(tmp_path, monkeypatch):
    import asyncio
    from unittest.mock import AsyncMock
    from condor import fleet_telegram as fleet

    source = fleet.BotSource(
        "v2",
        "RSI V2",
        "http://native:8000",
        "reader",
        "test",
        "v2",
        {"fills": "/fills?bot=v2&limit=10"},
    )
    config = fleet.WorkerConfig(frozenset([12]), (source,), trade_alerts=True)
    bot = type(
        "Bot",
        (),
        {"send_message": AsyncMock(side_effect=[RuntimeError("network"), None])},
    )()
    worker = fleet.FleetTelegramWorker(
        config, "unused", str(tmp_path / "state.sqlite"), bot=bot
    )
    worker.state.db.execute("UPDATE trade_sources SET started=0")
    worker.state.db.commit()
    payload = {"api_projection": {"bot_name": "v2"}, "rows": [fill()]}

    async def read(self, selected, command):
        assert "limit=1000" in selected.endpoints["fills"]
        return payload

    monkeypatch.setattr(fleet.NativeReadClient, "get", read)
    with pytest.raises(RuntimeError):
        asyncio.run(worker.notify_trades())
    assert len(worker.trade_alerts.pending([12])) == 1
    asyncio.run(worker.notify_trades())
    asyncio.run(worker.notify_trades())
    assert bot.send_message.await_count == 2
    assert worker.trade_alerts.pending([12]) == []
    payload["rows"] = [fill("wrong", bot_name="v1")]
    asyncio.run(worker.notify_trades())
    assert bot.send_message.await_count == 2
    worker.state.close()


# --- V1 (ok_rsi) legacy-shaped rows --------------------------------------------------
# Shapes taken from the live V1 TradeFill table via the reporting normalizer
# (2026-10-02): 13 rows from 2026-09-09/10 predate exact receipts and carry explicit
# nulls in every exact_* field; later rows are exact. V1 reports execution_mode=None.
V1_ACTIVATION = 1790917200  # 2026-10-02T05:00:00Z, shortly after V1 was discovered


def v1_exact(identity="2481938", **changes):
    row = dict(
        schema_version=1,
        source_db="/reader/data/ok_rsi.sqlite",
        source_db_id="b1f0c2d4e5a6f708",
        bot_name="ok_rsi",
        execution_mode=None,
        simulated=False,
        fill_id=identity,
        order_id="93027a12dac34fBCSEHUC73af32da5a2",
        pair="ETH-USDC",
        connector_name="okx",
        config_name="ok_rsi",
        strategy_name="v2_with_controllers",
        side="sell",
        raw_status="SELL",
        normalized_status="filled",
        order_type="LIMIT",
        amount_base=0.025235,
        price_quote=2715.78,
        exact_amount="0.025235",
        exact_price="2715.78",
        exact_trade_fee_in_quote="0.0685327083",
        exact_receipt_source="order_filled_event_v1",
        fee_quote=0.0685327083,
        economics_available=True,
        economics_status="AVAILABLE",
        timestamp="2026-10-02T05:30:00+00:00",
    )
    return row | changes


def v1_legacy(identity="1521831", **changes):
    return v1_exact(
        identity,
        order_id="93027a12dac34fBCBSLUC711e53d2957",
        pair="SOL-USDC",
        side="buy",
        order_type="LIMIT_MAKER",
        amount_base=0.10766,
        price_quote=103.48,
        exact_amount=None,
        exact_price=None,
        exact_trade_fee_in_quote=None,
        exact_receipt_source=None,
        fee_quote=0.008912,
        economics_available=False,
        economics_status="UNAVAILABLE",
        economics_unavailable_reason="legacy_receipt_unverified",
        timestamp="2026-09-09T01:30:16+00:00",
    ) | changes


def v1_history():
    legacy = [v1_legacy(str(1521831 + n)) for n in range(13)]
    exact_old = [
        v1_exact(str(2000000 + n), timestamp="2026-10-01T13:09:44+00:00")
        for n in range(3)
    ]
    return legacy + exact_old + [v1_exact("2481938", timestamp="2026-10-02T03:09:09+00:00")]


def test_v1_legacy_history_is_recorded_not_announced_and_does_not_block_new_fills():
    store = TradeAlerts(sqlite3.connect(":memory:"))
    store.start("v1", V1_ACTIVATION)
    history = v1_history()
    # Activation read: the whole long history, including null-exact legacy rows, is
    # accepted and recorded as seen without a single alert.
    assert store.ingest("v1", history, [12]) == 0
    assert store.pending([12]) == []
    # A new post-activation exact fill alerts exactly once, with exact economics.
    new = v1_exact("2481999", timestamp="2026-10-02T05:30:00+00:00")
    assert store.ingest("v1", [new, *history], [12]) == 1
    assert store.ingest("v1", [new, *history], [12]) == 0
    (_, _, _, rows), = store.pending([12])
    assert [r["fill_id"] for r in rows] == ["2481999"]
    text = render_fill_alert("OK RSI V1", rows)
    assert "OK RSI V1" in text and "SELL" in text and "ETH-USDC" in text
    assert "0.025235 ETH" in text and "2,715.78 USDC" in text and "0.06853271 USDC" in text


def test_v1_legacy_row_after_activation_fails_closed_without_partial_state():
    store = TradeAlerts(sqlite3.connect(":memory:"))
    store.start("v1", V1_ACTIVATION)
    late_legacy = v1_legacy("9999", timestamp="2026-10-02T06:00:00+00:00")
    good_new = v1_exact("2481999")
    with pytest.raises(ValueError):
        store.ingest("v1", [good_new, late_legacy], [12])
    # Nothing was marked seen or queued: the good row still alerts once repaired.
    assert store.pending([12]) == []
    assert store.ingest("v1", [good_new], [12]) == 1


@pytest.mark.parametrize(
    "change",
    [
        {"fill_id": None},
        {"order_id": ""},
        {"source_db_id": None},
        {"connector_name": None},
        {"bot_name": 7},
        {"side": None},
        {"pair": "ETH"},
        {"timestamp": None},
        {"timestamp": "bad"},
    ],
)
def test_v1_history_rows_still_need_full_identity(change):
    store = TradeAlerts(sqlite3.connect(":memory:"))
    store.start("v1", V1_ACTIVATION)
    with pytest.raises(ValueError):
        store.ingest("v1", [v1_legacy(**change)], [12])
    assert store.db.execute("SELECT COUNT(*) FROM trade_seen").fetchone()[0] == 0


def test_dedup_identity_includes_source_origin_across_bots_and_databases():
    # V1 and V2 both emit small numeric exchange fill ids; origin must separate them.
    v2 = fill("2481938", bot_name="rsi_modular_v2", source_db_id="3afcd34cb87596c4")
    v1 = v1_exact("2481938", timestamp="2026-10-02T05:30:00+00:00")
    db = sqlite3.connect(":memory:")
    store = TradeAlerts(db)
    store.start("v1-key", V1_ACTIVATION)
    store.start("v2-key", 0)
    assert store.ingest("v1-key", [v1], [12]) == 1
    assert store.ingest("v2-key", [v2], [12]) == 1
    # Same fill/order ids from a different source database or bot are not duplicates,
    # while the identical row is.
    assert store.ingest("v1-key", [v1], [12]) == 0
    other_db = v1_exact("2481938", source_db_id="ffff000011112222")
    assert store.ingest("v1-key", [other_db], [12]) == 1
    other_bot = v1_exact("2481938", bot_name="ok_rsi_sui")
    assert store.ingest("v1-key", [other_bot], [12]) == 1


def test_has_coverage_accepts_legacy_history_at_the_read_limit():
    store = TradeAlerts(sqlite3.connect(":memory:"))
    store.start("v1", V1_ACTIVATION)
    legacy = [v1_legacy(str(n)) for n in range(3)]
    # A saturated window whose oldest row is before activation is covered, even when
    # that row has no exact receipt.
    assert store.has_coverage("v1", legacy, limit=3)


def test_worker_v1_discovery_reads_long_legacy_history_without_alerting(
    tmp_path, monkeypatch
):
    import asyncio
    import time
    from unittest.mock import AsyncMock
    from condor import fleet_telegram as fleet

    source = fleet.BotSource(
        "ok_rsi",
        "OK RSI V1",
        "http://native:8000",
        "reader",
        "test",
        "ok_rsi",
        {"fills": "/trading-visuals/fills?bot=ok_rsi"},
    )
    config = fleet.WorkerConfig(frozenset([12]), (source,), trade_alerts=True)
    bot = type("Bot", (), {"send_message": AsyncMock(return_value=None)})()
    worker = fleet.FleetTelegramWorker(
        config, "unused", str(tmp_path / "state.sqlite"), bot=bot
    )
    # Activation is "now": the freshly started source must not announce old fills.
    activation = time.time()
    worker.state.db.execute("UPDATE trade_sources SET started=?", (activation,))
    worker.state.db.commit()
    payload = {"api_projection": {"bot_name": "ok_rsi"}, "rows": v1_history()}

    async def read(self, selected, command):
        return payload

    monkeypatch.setattr(fleet.NativeReadClient, "get", read)
    asyncio.run(worker.notify_trades())
    assert bot.send_message.await_count == 0
    assert worker.state.get_value("trade_alert_error:" + fleet.source_key(source)) == ""
    # After activation a new exact fill is delivered exactly once.
    fresh = v1_exact(
        "2482000",
        timestamp=time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(activation + 30)),
    )
    payload["rows"] = [fresh, *v1_history()]
    asyncio.run(worker.notify_trades())
    asyncio.run(worker.notify_trades())
    assert bot.send_message.await_count == 1
    assert "OK RSI V1" in bot.send_message.await_args.kwargs["text"]
    worker.state.close()


def test_v1_source_id_commands_and_legacy_fill_view_need_no_v2_naming():
    from condor import fleet_telegram as fleet
    from condor import fleet_telegram_views as telegram_views

    assert fleet.parse_command("/fills ok_rsi") == ("fills", "ok_rsi")
    assert fleet.parse_command("/status@condor_bot OK_RSI") == ("status", "ok_rsi")
    assert telegram_views.parse_callback("fleet:ok_rsi:fills:0") == ("fills", "ok_rsi", 0)
    # The history view shows legacy rows with unavailable economics instead of failing.
    text = telegram_views.records("fills", [v1_legacy(), v1_exact()]).text
    assert "SOL-USDC" in text and "ETH-USDC" in text and "Fee unavailable" in text
