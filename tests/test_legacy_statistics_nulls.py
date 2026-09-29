from condor.web.models import BotInfo, ControllerPerformanceSnapshot
from condor.web.routes.bots import _parse_bot
from condor.web.routes.controller_performance import _parse_bot_run, _parse_snapshot


def test_missing_controller_performance_remains_unavailable():
    snapshot = _parse_snapshot({"bot_name": "legacy"})
    run = _parse_bot_run({"bot_name": "legacy"})
    bot = _parse_bot({"bot_name": "legacy"})

    assert isinstance(snapshot, ControllerPerformanceSnapshot)
    assert snapshot.realized_pnl_quote is None
    assert snapshot.global_pnl_quote is None
    assert run.realized_pnl_quote is None
    assert run.unrealized_pnl_quote is None
    assert run.global_pnl_quote is None
    assert run.volume_traded is None
    assert isinstance(bot, BotInfo)
    assert bot.pnl is None


def test_explicit_zero_performance_is_preserved_as_observed_zero():
    snapshot = _parse_snapshot({"performance": {
        "realized_pnl_quote": 0,
        "unrealized_pnl_quote": 0,
        "global_pnl_quote": 0,
        "global_pnl_pct": 0,
        "volume_traded": 0,
    }})
    run = _parse_bot_run({"bot_name": "legacy"}, {"legacy": {
        "realized_pnl_quote": 0,
        "unrealized_pnl_quote": 0,
        "volume_traded": 0,
    }})
    bot = _parse_bot({"bot_name": "legacy", "pnl": 0, "performance": {"ctrl": {
        "realized_pnl_quote": 5,
        "unrealized_pnl_quote": 3,
    }}})

    assert snapshot.realized_pnl_quote == 0
    assert snapshot.global_pnl_quote == 0
    assert snapshot.volume_traded == 0
    assert run.realized_pnl_quote == 0
    assert run.global_pnl_quote == 0
    assert run.volume_traded == 0
    assert bot.pnl == 0


def test_incomplete_performance_does_not_become_partial_or_zero_total():
    snapshot = _parse_snapshot({"performance": {"realized_pnl_quote": 2}})
    run = _parse_bot_run({"bot_name": "legacy"}, {"legacy": {"realized_pnl_quote": 2}})
    bot = _parse_bot({"bot_name": "legacy", "performance": {"ctrl": {"realized_pnl_quote": 2}}})

    assert snapshot.realized_pnl_quote == 2
    assert snapshot.unrealized_pnl_quote is None
    assert run.realized_pnl_quote == 2
    assert run.unrealized_pnl_quote is None
    assert run.global_pnl_quote is None
    assert bot.pnl is None


def test_invalid_non_finite_performance_is_unavailable():
    snapshot = _parse_snapshot({"performance": {"realized_pnl_quote": "NaN", "volume_traded": "inf"}})

    assert snapshot.realized_pnl_quote is None
    assert snapshot.volume_traded is None
