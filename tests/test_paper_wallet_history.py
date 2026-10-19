"""Paper bots: simulated wallet history recorded from reporting, kept apart from the live wallet."""

import copy
import sqlite3
from datetime import datetime, timezone

import pytest

from condor import wallet_observation as observation
from condor.performance_history import PerformanceHistory
from condor.wallet_observation import project_wallet, wallet_samples
from condor.web import fleet_summary

NOW = 1_800_000_000.0
PAPER = "meridian_v4_paper"
LIVE = "meridian_v3"


def iso(seconds):
    return datetime.fromtimestamp(seconds, tz=timezone.utc).isoformat()


def body(bot=PAPER, *, at=NOW - 5, scope=None, simulated=None, value="200000.207615"):
    """The reporting runtime-status shape (fields as served for meridian_v4_paper on 2026-10-15)."""
    paper = scope is None and "paper" in bot
    scope = scope or ("paper_simulated_wallet" if paper else "account_wallet")
    flag = paper if simulated is None else simulated
    return {
        "schema_version": 1,
        "simulated": flag,
        "runtime_status": {
            "bot_name": bot,
            "updated_at": iso(at),
            "simulated": flag,
            "balances": [
                {
                    "asset": "USDC",
                    "available_balance": 199290.5949878946,
                    "total_balance": 199290.5949878946,
                    "value_quote": 199290.594988,
                    "simulated": flag,
                },
                # A working sell order locks the whole lot: the owner publishes no available amount.
                {
                    "asset": "BTC",
                    "available_balance": None,
                    "total_balance": 0.00247042,
                    "value_quote": 200.356744,
                    "simulated": flag,
                },
                {
                    "asset": "SOL",
                    "available_balance": 1.94512,
                    "total_balance": 1.94512,
                    "value_quote": 509.255883,
                    "simulated": flag,
                },
            ],
            "summary": {
                "balance_value_currency": "USDC",
                "balance_value_quote": float(value),
                "balance_value_scope": scope,
                "balance_value_status": "AVAILABLE",
                "simulated": flag,
            },
        },
    }


def test_a_paper_runtime_status_projects_to_a_simulated_wallet_sample():
    sample = project_wallet(body(), PAPER)
    assert sample["simulated"] is True
    assert sample["currency"] == "USDC" and sample["value_quote"] == "200000.207615"
    assert sample["timestamp"] == NOW - 5
    assert [row["asset"] for row in sample["balances"]] == ["USDC", "BTC", "SOL"]
    assert (
        sample["balances"][1]["available"] is None
    ), "a null available amount (working order) is kept as null"


def test_a_live_runtime_status_still_projects_without_a_simulated_flag():
    sample = project_wallet(body(LIVE, value="200000.207615"), LIVE)
    assert "simulated" not in sample
    assert sample["value_quote"] == "200000.207615"


@pytest.mark.parametrize(
    "payload,bot",
    [
        (body(scope="account_wallet"), PAPER),  # account scope on a paper bot
        (body(LIVE, scope="paper_simulated_wallet"), LIVE),  # paper scope on a live bot
        (body(simulated=False), PAPER),  # a paper bot declaring a real wallet
        (body(LIVE, simulated=True), LIVE),  # a live bot declaring a simulated wallet
        (body(scope="strategy"), PAPER),
    ],
)
def test_the_wallet_scope_must_match_the_bot_identity(payload, bot):
    with pytest.raises(ValueError):
        project_wallet(payload, bot)


def test_paper_and_live_samples_are_split_by_identity():
    bodies = {PAPER: body(), "meridian_v4_d2h_paper": None, LIVE: body(LIVE)}
    live = wallet_samples(bodies)
    paper = observation.paper_wallet_samples(bodies)
    assert set(live) == {LIVE} and "simulated" not in live[LIVE]
    assert set(paper) == {PAPER, "meridian_v4_d2h_paper"}
    assert paper[PAPER]["simulated"] is True and paper["meridian_v4_d2h_paper"] is None


def test_paper_wallet_samples_are_stored_apart_and_read_back_as_simulated(tmp_path):
    path = tmp_path / "native-performance.sqlite3"
    store = PerformanceHistory(path)
    live_sample = project_wallet(body(LIVE, at=NOW - 120, value="200000.207615"), LIVE)
    store.record_wallet("v2", {LIVE: live_sample}, NOW - 120)
    for offset in (65, 5):
        store.record_paper_wallet(
            "v2",
            observation.paper_wallet_samples(
                {PAPER: body(at=NOW - offset), LIVE: body(LIVE)}
            ),
            NOW - offset + 1,
        )

    paper = store.read_wallet("v2", PAPER, "1D", NOW)
    assert paper["simulated"] is True and paper["source"] == "reporting_paper_runtime"
    assert [p["timestamp"] for p in paper["points"]] == [NOW - 65, NOW - 5]
    assert all(p["valuation_complete"] is True for p in paper["points"])
    assert (
        paper["latest"]["value_quote"] == "200000.207615"
        and paper["latest"]["balances"][1]["available"] is None
    )

    live = store.read_wallet("v2", LIVE, "1D", NOW)
    assert "simulated" not in live and live["source"] == "reporting_wallet_observer"
    assert [p["timestamp"] for p in live["points"]] == [
        NOW - 120
    ], "a paper sample never enters the live wallet"

    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT DISTINCT bot FROM wallet_points").fetchall() == [
            (LIVE,)
        ]
        assert conn.execute(
            "SELECT DISTINCT bot FROM paper_wallet_points"
        ).fetchall() == [(PAPER,)]
        assert conn.execute("SELECT bot FROM wallet_cursors").fetchall() == [(LIVE,)]


def test_the_live_wallet_store_never_takes_a_paper_or_simulated_sample(tmp_path):
    store = PerformanceHistory(tmp_path / "native-performance.sqlite3")
    paper_sample = project_wallet(body(), PAPER)
    store.record_wallet("v2", {PAPER: paper_sample}, NOW)
    store.record_wallet("v2", {LIVE: {**copy.deepcopy(paper_sample)}}, NOW)
    assert store.read_wallet("v2", PAPER, "1D", NOW)["points"] == []
    assert store.read_wallet("v2", LIVE, "1D", NOW)["points"] == []
    # And the paper store never takes a live bot or an undeclared sample.
    live_sample = project_wallet(body(LIVE), LIVE)
    store.record_paper_wallet("v2", {LIVE: paper_sample, PAPER: live_sample}, NOW)
    assert store.read_wallet("v2", LIVE, "1D", NOW)["points"] == []
    assert store.read_wallet("v2", PAPER, "1D", NOW)["points"] == []


def test_a_failed_paper_read_starts_after_a_gap(tmp_path):
    store = PerformanceHistory(tmp_path / "native-performance.sqlite3")
    store.record_paper_wallet(
        "v2", {PAPER: project_wallet(body(at=NOW - 100), PAPER)}, NOW - 99
    )
    store.record_paper_wallet(
        "v2", {PAPER: project_wallet(body(at=NOW - 80), PAPER)}, NOW - 79
    )
    store.record_paper_wallet("v2", {PAPER: None}, NOW - 70)
    store.record_paper_wallet(
        "v2", {PAPER: project_wallet(body(at=NOW - 60), PAPER)}, NOW - 59
    )
    points = store.read_wallet("v2", PAPER, "1D", NOW)["points"]
    assert [p["timestamp"] for p in points] == [
        NOW - 100,
        NOW - 60,
    ], "per-minute sampling; a failed read restarts it"


def test_the_fleet_wallet_never_takes_a_paper_or_simulated_read():
    paper_read = {
        "simulated": True,
        "latest": {
            "timestamp": NOW,
            "currency": "USDC",
            "value_quote": "200000",
            "valuation_complete": True,
        },
    }
    live_read = {
        "latest": {
            "timestamp": NOW - 30,
            "currency": "USDT",
            "value_quote": "20239.31",
            "valuation_complete": True,
        }
    }
    wallet, _ = fleet_summary._wallet_section(
        fleet_summary.OwnerRead({PAPER: paper_read, LIVE: live_read}), NOW * 1000, []
    )
    assert wallet is None, "bot observers are not a full-account valuation"
    missing = []
    wallet, _ = fleet_summary._wallet_section(
        fleet_summary.OwnerRead({"rsi_modular_v2": paper_read}), NOW * 1000, missing
    )
    assert wallet is None and missing, "a simulated read is not a fleet wallet"


@pytest.mark.asyncio
async def test_the_status_tick_records_live_and_paper_wallets_apart(monkeypatch):
    from unittest.mock import AsyncMock, Mock

    from condor import performance_history, wallet_observation
    from condor.server_data_service import CacheKey, ServerDataService, ServerDataType

    observer = Mock()
    monkeypatch.setattr(performance_history, "history", observer)
    reads = AsyncMock(
        return_value={PAPER: body(at=NOW - 5), LIVE: body(LIVE, at=NOW - 5)}
    )
    monkeypatch.setattr(wallet_observation, "observe_runtime", reads)
    monkeypatch.setattr("condor.server_data_service.time.time", lambda: NOW)
    sds = ServerDataService()
    monkeypatch.setattr(sds, "_get_client", AsyncMock(return_value=object()))
    sds.register_fetch(ServerDataType.BOTS_STATUS, AsyncMock(return_value=[]))
    await sds._do_fetch_and_cache(CacheKey.make("v2", ServerDataType.BOTS_STATUS))
    reads.assert_awaited_once_with("v2")
    (server, live), _ = observer.record_wallet.call_args
    assert server == "v2" and set(live) == {LIVE} and "simulated" not in live[LIVE]
    (server, paper), _ = observer.record_paper_wallet.call_args
    assert (
        server == "v2" and set(paper) == {PAPER} and paper[PAPER]["simulated"] is True
    )


def test_the_wallet_route_serves_a_paper_bot_its_simulated_history(
    monkeypatch, tmp_path
):
    import time
    from types import SimpleNamespace

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from condor.web.auth import get_current_user
    from condor.web.models import WebUser
    from condor.web.routes import performance_history as route

    recent = time.time() - 30
    store = PerformanceHistory(tmp_path / "read.db")
    store.record_paper_wallet(
        "local", {PAPER: project_wallet(body(at=recent), PAPER)}, recent + 1
    )
    monkeypatch.setattr(
        route,
        "get_config_manager",
        lambda: SimpleNamespace(has_server_access=lambda *_: True),
    )
    monkeypatch.setattr(route, "history", store)
    app = FastAPI()
    app.include_router(route.router)
    app.dependency_overrides[get_current_user] = lambda: WebUser(
        id=1, username="owner", role="admin"
    )
    payload = (
        TestClient(app)
        .get(f"/servers/local/bots/{PAPER}/wallet-history?range=1D")
        .json()
    )
    assert (
        payload["simulated"] is True and payload["source"] == "reporting_paper_runtime"
    )
    assert (
        payload["points"][0]["value_quote"] == "200000.207615"
        and payload["points"][0]["currency"] == "USDC"
    )
