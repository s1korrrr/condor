"""Untrusted owner fields must not crash a fleet read or invent current evidence."""

import asyncio
import copy

import pytest

from condor.performance_history import PerformanceHistory
from condor.web import fleet_summary as fs
from condor.web.fleet_fills import normalize_fill
from condor.web.fleet_fills import build_page, read_window
from test_fleet_summary import (
    FakeReaders,
    NOW_MS,
    SERVER,
    card,
    bots_status,
    client_for,
    seed,
    iso,
)


@pytest.mark.parametrize("value", [10**400, -(10**400), True, "NaN", "Infinity"])
def test_nonrepresentable_owner_number_is_unavailable(value):
    assert fs._num(value) is None


@pytest.mark.parametrize(
    "timestamp",
    ["0001-01-01T00:00:00+23:59", "9999-12-31T23:59:59-23:59"],
)
def test_out_of_range_utc_fill_keeps_identity_with_missing_time(timestamp):
    row, reason = normalize_fill(
        {"fill_id": "fill", "bot_name": "bot", "timestamp": timestamp}, "bot"
    )
    assert reason is None
    assert row["fill_id"] == "fill"
    assert row["time_ms"] is None
    assert "time_ms" in row["missing"]


def wallet(timestamp):
    return {
        "latest": {
            "timestamp": timestamp,
            "value_quote": "100",
            "currency": "USDC",
            "valuation_complete": True,
        }
    }


@pytest.mark.parametrize("lead", [5.001, 3600, 1e308])
def test_future_wallet_is_not_current(lead):
    missing = []
    value, section = fs._wallet_section(
        {"ok_rsi": wallet(NOW_MS / 1000 + lead)}, NOW_MS, missing
    )
    assert value is None
    assert section["status"] == "missing"
    assert section["reason"] == fs.INVALID
    assert missing == [{"section": "wallet", "reason": fs.INVALID}]


def test_wallet_admits_small_skew_and_falls_back_from_invalid_newer_source():
    value, section = fs._wallet_section(
        {"ok_rsi": wallet(NOW_MS / 1000 + 5)}, NOW_MS, []
    )
    assert value["observed_at_ms"] == NOW_MS + 5000
    assert section["status"] == "ok"
    value, section = fs._wallet_section(
        {
            "ok_rsi": wallet(NOW_MS / 1000 + 3600),
            "rsi_modular_v2": wallet(NOW_MS / 1000 - 10),
        },
        NOW_MS,
        [],
    )
    assert value["source_bot"] == "rsi_modular_v2"
    assert section["status"] == "ok"


@pytest.mark.parametrize("view", ["full", "glance"])
def test_owner_bad_quantity_does_not_break_http_or_invent_empty_inventory(
    monkeypatch, tmp_path, view
):
    store = PerformanceHistory(tmp_path / "observer.sqlite3")
    seed(store)

    class BadQuantity(FakeReaders):
        async def owner(self, bot, path, params):
            read = await super().owner(bot, path, params)
            if bot == "ok_rsi" and path == "quant-summary":
                read.payload = copy.deepcopy(read.payload)
                read.payload["data"]["pairs"][0]["units"] = 10**400
            return read

    response = client_for(monkeypatch, store, readers=BadQuantity(store)).get(
        f"/api/v1/servers/{SERVER}/fleet/summary?view={view}"
    )
    assert response.status_code == 200
    body = response.json()
    assert body["wallet"]["equity"] == "1000"
    bot = card(body, "ok_rsi")
    if view == "full":
        assert bot["positions"] is None
        assert {"field": "positions", "reason": fs.INVALID} in bot["missing"]
    else:
        assert "positions" not in bot  # compact view carries the missing reason
        assert any(
            item.get("bot") == "ok_rsi"
            and item.get("field") == "positions"
            and item.get("reason") == fs.INVALID
            for item in body["missing"]
        )


@pytest.mark.parametrize("received_at", [1e308, NOW_MS / 1000 + 3600])
def test_invalid_performance_clock_cannot_crash_or_establish_freshness(
    monkeypatch, tmp_path, received_at
):
    store = PerformanceHistory(tmp_path / "observer.sqlite3")
    seed(store)

    class BadClock(FakeReaders):
        async def bots_status(self, server):
            payload = bots_status()
            for bot in payload["data"].values():
                bot.update(
                    source="native_mqtt",
                    performance_current=True,
                    received_at=received_at,
                    stale_after_seconds=30,
                )
            return payload

    response = client_for(
        monkeypatch, store, readers=BadClock(store, owners=False)
    ).get(f"/api/v1/servers/{SERVER}/fleet/summary")
    assert response.status_code == 200
    result = card(response.json(), "ok_rsi")
    assert result["report_at_ms"] is None
    assert result["report_stale"] is True


def test_future_receipt_keeps_amount_and_identity_with_unknown_time(
    monkeypatch, tmp_path
):
    store = PerformanceHistory(tmp_path / "observer.sqlite3")
    seed(store)

    class FutureFill(FakeReaders):
        async def owner(self, bot, path, params):
            read = await super().owner(bot, path, params)
            if bot == "ok_rsi" and path == "fills":
                read.payload = copy.deepcopy(read.payload)
                read.payload["rows"][0]["timestamp"] = iso(NOW_MS + 3_600_000)
            return read

    readers = FutureFill(store)
    response = client_for(monkeypatch, store, readers=readers).get(
        f"/api/v1/servers/{SERVER}/fleet/summary"
    )
    assert response.status_code == 200
    summary_fill = next(
        row for row in response.json()["fills"] if row["fill_id"] == "ok_rsi-1"
    )
    assert summary_fill["amount"] == "0.1"
    assert summary_fill["time_ms"] is None
    feed = build_page(asyncio.run(read_window(SERVER, readers, NOW_MS)))
    feed_fill = next(row for row in feed["items"] if row["fill_id"] == "ok_rsi-1")
    assert feed_fill["amount"] == "0.1"
    assert feed_fill["id"].endswith("|ETH-USDC|ok_rsi-1")
    assert feed_fill["time_ms"] is None
    assert "time_ms" in feed_fill["missing"]
