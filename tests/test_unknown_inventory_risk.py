"""Unknown current inventory restricts new risk without disabling owner reductions."""

import asyncio

import pytest

from condor.agents.journal import JournalManager
from condor.agents.risk import RiskEngine, RiskState, auto_approve_with_risk_check

OPTIONS = [{"kind": "allow_once", "optionId": "allow"}]


def test_unknown_inventory_blocks_creates_and_deploys_but_allows_stops():
    state = RiskState(
        total_exposure=None, executor_count=None, current_book_status="unavailable"
    )
    permission = auto_approve_with_risk_check(RiskEngine(), state)
    calls = [
        (
            "manage_executors",
            {
                "action": "create",
                "executor_config": {"controller_id": "mine", "total_amount_quote": 10},
            },
            "cancelled",
        ),
        (
            "manage_bots",
            {"action": "deploy", "bot_name": "mine", "max_global_drawdown_quote": 10},
            "cancelled",
        ),
        ("manage_executors", {"action": "stop", "executor_id": "existing"}, "selected"),
        ("manage_bots", {"action": "stop_bot", "bot_name": "mine"}, "selected"),
    ]

    async def drive():
        return [
            await permission(
                {"tool": f"mcp__mcp-hummingbot__{tool}", "input": args}, OPTIONS
            )
            for tool, args, _ in calls
        ]

    results = asyncio.run(drive())
    assert [result["outcome"]["outcome"] for result in results] == [
        want for _, _, want in calls
    ]
    assert state.total_exposure is None and state.executor_count is None


def test_unknown_risk_snapshot_is_written_without_zero_or_format_error(tmp_path):
    journal = JournalManager("fixture-owner", session_dir=tmp_path)
    path = journal.save_full_snapshot(
        tick=1,
        timestamp="2026-10-25T12:00:00Z",
        system_prompt="fixture",
        response_text="fixture",
        tool_calls=[],
        executors_data="Current inventory unavailable",
        risk_state=RiskState(
            total_exposure=None, executor_count=None, current_book_status="unavailable"
        ).to_dict(),
        duration=0.01,
    )
    text = path.read_text()
    assert "Position Size: unavailable" in text
    assert "Open Executors: unavailable" in text
    assert "Position Size: $0.00" not in text


def test_current_book_updates_preserve_independent_rails_and_unknowns():
    state = RiskState(is_blocked=True, block_reason="existing drawdown rail")
    state.apply_current_book(
        {
            "current_book_status": "unavailable",
            "executors": None,
            "total_exposure": None,
        }
    )
    assert state.total_exposure is None and state.executor_count is None
    assert state.is_blocked and state.block_reason == "existing drawdown rail"
    for bad in (None, True, float("nan"), float("inf"), 10**400, -1):
        state.apply_current_book(
            {"current_book_status": "available", "executors": [], "total_exposure": bad}
        )
        assert (
            state.current_book_status == "unavailable" and state.total_exposure is None
        )
    state.apply_current_book(
        {"current_book_status": "available", "executors": [], "total_exposure": 0}
    )
    assert state.executor_count == 0 and state.total_exposure == 0
    assert state.is_blocked and state.block_reason == "existing drawdown rail"


@pytest.mark.parametrize("pending_adoption", [False, True])
def test_unknown_inventory_tick_can_manage_existing_work_without_recording_zero(
    tmp_path, monkeypatch, pending_adoption
):
    from condor.agents import strategy as strategy_module
    from condor.agents.agent import Agent
    from condor.agents.engine import TickEngine
    from condor.agents.providers.base import ProviderResult
    from condor.agents.strategy import Strategy

    monkeypatch.setattr(strategy_module, "_DATA_ROOT", tmp_path)
    strategy = Strategy(agent_slug="fixture", name="Inventory")
    strategy.dir.mkdir(parents=True, exist_ok=True)
    engine = TickEngine(
        agent=Agent(slug="fixture", name="Fixture"),
        strategy=strategy,
        config={"execution_mode": "loop", "bot_name": "fixture-inventory"},
        chat_id=1,
        user_id=1,
    )
    engine._session_report = None
    engine._nudge = None
    states = []

    class OfflineACP:
        async def start(self):
            return None

        async def stop(self):
            return None

    async def get_client():
        from types import SimpleNamespace

        async def active():
            return {
                "data": {
                    "fixture-inventory-alpha": {"status": "running"},
                    "fixture-inventory-beta": {"status": "starting"},
                }
            }

        return SimpleNamespace(
            bot_orchestration=SimpleNamespace(get_active_bots_status=active)
        )

    async def adopt(_client):
        engine._adoption_done = True

    async def providers(*_args, **_kwargs):
        return {
            "executors": ProviderResult(
                name="executors",
                summary="Current inventory unavailable",
                data={
                    "current_book_status": (
                        "available" if pending_adoption else "unavailable"
                    ),
                    "executors": [] if pending_adoption else None,
                    "total_exposure": 0 if pending_adoption else None,
                    "total_pnl": 0 if pending_adoption else None,
                    "unrealized_pnl": 0 if pending_adoption else None,
                    "total_volume": 10,
                },
            )
        }

    async def acp(state):
        states.append(state)
        return OfflineACP()

    async def stream(*_args):
        return
        yield

    monkeypatch.setattr(engine, "_get_client", get_client)
    if not pending_adoption:
        monkeypatch.setattr(engine, "_adopt_running_bots", adopt)
    monkeypatch.setattr(engine.provider_registry, "run_core_providers", providers)
    monkeypatch.setattr(engine, "_create_client", acp)
    monkeypatch.setattr(engine, "_collect_stream", stream)
    asyncio.run(engine._tick())

    if pending_adoption:
        assert not engine._adoption_done
        permission = auto_approve_with_risk_check(
            engine.risk, states[0], ledger=engine.ledger
        )
        outcome = asyncio.run(
            permission(
                {
                    "tool": "mcp__mcp-hummingbot__manage_executors",
                    "input": {
                        "action": "create",
                        "executor_config": {
                            "controller_id": engine.agent_id,
                            "total_amount_quote": 10,
                        },
                    },
                },
                OPTIONS,
            )
        )
        assert outcome["outcome"]["outcome"] == "cancelled"
    assert len(states) == 1 and not states[0].is_blocked
    assert states[0].total_exposure is None and states[0].executor_count is None
    info = engine.get_info()
    assert info["open_executors"] is None and info["total_exposure"] is None
    assert info["current_book_status"] == "unavailable"
    text = engine.journal.read_full()
    assert "financial snapshot not recorded" in text
    assert "exposure=$0.00" not in text


def test_provider_labels_unknown_inventory_as_unavailable_not_none_running(monkeypatch):
    from condor.agents import performance
    from condor.agents.performance import AgentPerformance
    from condor.agents.providers.executors import ExecutorsProvider

    async def unavailable(*_args, **_kwargs):
        return AgentPerformance(agent_id="fixture", current_book_status="unavailable")

    monkeypatch.setattr(performance, "fetch_agent_performance", unavailable)
    result = asyncio.run(ExecutorsProvider().execute(object(), {}, agent_id="fixture"))
    assert result.data["executors"] is None and result.data["total_exposure"] is None
    assert "none running" not in result.summary
    assert "Active Executors: unavailable" in result.summary
