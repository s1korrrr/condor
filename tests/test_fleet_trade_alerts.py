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
    key = fleet.source_key(source)
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
