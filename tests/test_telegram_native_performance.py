import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from handlers.bots import menu


def preview(monkeypatch, performances, *, detail=False, current=True, bot_fields=None):
    client = SimpleNamespace(
        controllers=SimpleNamespace(
            get_bot_controller_configs=AsyncMock(return_value=[])
        )
    )
    monkeypatch.setattr(
        menu, "get_bots_client", AsyncMock(return_value=(client, "fixture"))
    )
    message = SimpleNamespace(edit_text=AsyncMock(), photo=None, message_id=1)
    update = SimpleNamespace(
        callback_query=SimpleNamespace(message=message, answer=AsyncMock()),
        effective_chat=SimpleNamespace(id=1),
    )
    bot = {
        "source": "native_mqtt",
        "performance_current": current,
        "status": "running",
        "performance": {
            name: {"status": "running", "performance": perf}
            for name, perf in performances.items()
        },
    }
    bot.update(bot_fields or {})
    context = SimpleNamespace(
        user_data={
            "active_bots_data": {"data": {"fixture": bot}},
            "current_bot_name": "fixture",
            "current_bot_info": bot,
            "current_controllers": list(performances),
        }
    )
    if detail:
        asyncio.run(menu.show_controller_detail(update, context, 0))
    else:
        asyncio.run(menu.show_bot_detail(update, context, "fixture"))
    message.edit_text.assert_awaited_once()
    return message.edit_text.await_args.args[0].replace("\\", "")


@pytest.mark.parametrize("detail", [False, True])
@pytest.mark.parametrize("value", [None, float("nan"), float("inf"), True, "bad"])
def test_unavailable_native_metrics_are_not_reported_as_zero(
    monkeypatch, detail, value
):
    text = preview(
        monkeypatch,
        {
            "modular_spot_fixture": {
                "realized_pnl_quote": value,
                "unrealized_pnl_quote": value,
                "volume_traded": value,
            }
        },
        detail=detail,
    )
    assert "UNAVAILABLE" in text
    assert "+0.00" not in text
    assert "nan" not in text and "inf" not in text


@pytest.mark.parametrize("detail", [False, True])
def test_explicit_native_zero_remains_available(monkeypatch, detail):
    text = preview(
        monkeypatch,
        {
            "modular_spot_fixture": {
                "realized_pnl_quote": 0,
                "unrealized_pnl_quote": "0",
                "volume_traded": 0,
            }
        },
        detail=detail,
    )
    assert "+0.00" in text
    assert "UNAVAILABLE" not in text


@pytest.mark.parametrize("detail", [False, True])
def test_stale_native_metrics_do_not_become_current_on_preview(monkeypatch, detail):
    text = preview(
        monkeypatch,
        {
            "modular_spot_fixture": {
                "realized_pnl_quote": 123,
                "unrealized_pnl_quote": 456,
                "volume_traded": 789,
            }
        },
        detail=detail,
        current=False,
    )
    assert "UNAVAILABLE" in text
    assert "+579.00" not in text


def test_incomplete_controller_total_is_unavailable(monkeypatch):
    text = preview(
        monkeypatch,
        {
            "known": {
                "realized_pnl_quote": 10,
                "unrealized_pnl_quote": -2,
                "volume_traded": 20,
            },
            "unknown": {
                "realized_pnl_quote": None,
                "unrealized_pnl_quote": 1,
                "volume_traded": None,
            },
        },
    )
    row = next(line for line in text.splitlines() if line.startswith("TOTAL"))
    assert row.count("UNAVAILABLE") == 2
    assert "+9.00" not in row


def test_unknown_position_basis_is_not_zero_valued(monkeypatch):
    text = preview(
        monkeypatch,
        {
            "fixture": {
                "realized_pnl_quote": 0,
                "unrealized_pnl_quote": None,
                "volume_traded": 1,
                "positions_summary": [
                    {
                        "amount": 1,
                        "breakeven_price": None,
                        "unrealized_pnl_quote": None,
                        "side": "BUY",
                    }
                ],
            }
        },
    )
    row = next(line for line in text.splitlines() if "📍" in line)
    assert row.count("UNAVAILABLE") == 3


@pytest.mark.parametrize("scope", ["bot", "controller", "position"])
def test_explicit_unavailable_position_metrics_are_honored(monkeypatch, scope):
    position = {
        "amount": 1,
        "breakeven_price": 100,
        "unrealized_pnl_quote": 10,
        "side": "BUY",
    }
    perf = {
        "realized_pnl_quote": 1,
        "unrealized_pnl_quote": 10,
        "volume_traded": 100,
        "positions_summary": [position],
    }
    if scope == "controller":
        perf["pnl_available"] = False
    if scope == "position":
        position["pnl_available"] = False
    text = preview(
        monkeypatch,
        {"fixture": perf},
        bot_fields={"metrics_available": False} if scope == "bot" else {},
    )
    row = next(line for line in text.splitlines() if "📍" in line)
    assert row.count("UNAVAILABLE") == 3
    assert "100.00" not in row and "+10.00" not in row


@pytest.mark.parametrize("positions", [[None], ["bad"], "bad", {}])
def test_malformed_positions_do_not_hide_the_preview(monkeypatch, positions):
    text = preview(
        monkeypatch,
        {
            "fixture": {
                "realized_pnl_quote": 0,
                "unrealized_pnl_quote": 0,
                "volume_traded": 0,
                "positions_summary": positions,
            }
        },
    )
    assert "Position data UNAVAILABLE" in text
    assert "+0.00" in text


@pytest.mark.parametrize(
    "side,marker",
    [
        (1, "🟢L"),
        (2, "🔴S"),
        ("1", "🟢L"),
        ("2", "🔴S"),
        ("BUY", "🟢L"),
        ("SELL", "🔴S"),
        ("TradeType.BUY", "🟢L"),
        ("TradeType.SELL", "🔴S"),
        (None, "⚪?"),
        (True, "⚪?"),
        ("unknown", "⚪?"),
        ("notBUY", "⚪?"),
        (3, "⚪?"),
    ],
)
def test_position_side_matches_native_enum_and_does_not_guess(
    monkeypatch, side, marker
):
    text = preview(
        monkeypatch,
        {
            "fixture": {
                "realized_pnl_quote": 0,
                "unrealized_pnl_quote": 0,
                "volume_traded": 10,
                "positions_summary": [
                    {
                        "side": side,
                        "amount": 1,
                        "breakeven_price": 10,
                        "unrealized_pnl_quote": 0,
                    }
                ],
            }
        },
    )
    row = next(line for line in text.splitlines() if "📍" in line)
    assert marker in row


def test_malformed_controller_cannot_make_a_partial_total_complete(monkeypatch):
    text = preview(
        monkeypatch,
        {},
        bot_fields={
            "performance": {
                "known": {
                    "status": "running",
                    "performance": {
                        "realized_pnl_quote": 10,
                        "unrealized_pnl_quote": 0,
                        "volume_traded": 20,
                    },
                },
                "malformed": None,
            }
        },
    )
    row = next(line for line in text.splitlines() if line.startswith("TOTAL"))
    assert row.count("UNAVAILABLE") == 2
    assert "Controller performance UNAVAILABLE" in text
