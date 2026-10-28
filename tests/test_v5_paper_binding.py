"""Read-only V5 paper-bot binding: fail-closed status reads and fixed projections.

Fixtures follow hummingbot ``scripts/component_paper_runtime.py``
``PaperRuntime.status()`` (schema_version 1, native_component_paper_runtime_v1).
No network, no order path, no paid call.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from test_v5_dashboard_bridge import (
    ORIGIN,
    SERVER,
    TOKEN,
    NoNetworkUpstream,
    make_settings,
)

from condor.v5.app import create_app
from condor.v5.config import ConfigurationError, Settings
from condor.v5.dashboard import dashboard_profile, read_compatibility_path
from condor.v5.paper import MAX_STATUS_BYTES, STALE_AFTER_SECONDS, read_paper_status

NOW = 1_800_000_000.0
BOT = "meridian_v5_paper"
BOOT = "ab" * 16
PAIRS = ("BNB-USDC", "BTC-USDC", "ETH-USDC", "SOL-USDC", "XRP-USDC")


def controller_id(pair: str) -> str:
    return "meridian_v5_" + pair.replace("-", "_")


def controller_row(pair: str) -> dict:
    return {
        "id": controller_id(pair),
        "controller_name": "meridian_v5",
        "pair": pair,
        "execution_mode": "paper",
        "custom_info": {
            "modular_status": "hold",
            "candle_open": 1_799_999_940,
            "execution_enabled": True,
            "bag": {
                "reason": "hold",
                "held_amount": "0.1",
                "breakeven_price": "600.5",
                "trail_armed": False,
                "trail_peak": None,
                "release": None,
            },
        },
    }


def report(pair: str) -> dict:
    return {
        "executors": [
            {
                "id": f"ex-{pair}",
                "timestamp": NOW - 60,
                "type": "position_executor",
                "status": 2,
                "config": {
                    "type": "position_executor",
                    "trading_pair": pair,
                    "connector_name": "okx",
                    "side": 1,
                    "amount": "0.1",
                },
                "net_pnl_pct": "0.001",
                "net_pnl_quote": "0.06",
                "cum_fees_quote": "0.06",
                "filled_amount_quote": "60.05",
                "is_active": True,
                "is_trading": True,
                "custom_info": {},
                "close_timestamp": None,
                "close_type": None,
                "controller_id": controller_id(pair),
            }
        ],
        "positions": [
            {
                "connector_name": "okx",
                "trading_pair": pair,
                "volume_traded_quote": "60.05",
                "side": 1,
                "amount": "0.1",
                "breakeven_price": "600.5",
                "unrealized_pnl_quote": "0.25",
                "realized_pnl_quote": "0",
                "cum_fees_quote": "0.06",
            }
        ],
        "performance": {
            "pnl_available": True,
            "pnl_unavailable_reason": None,
            "wallet_sales": [],
            "realized_pnl_quote": "1.5",
            "unrealized_pnl_quote": "0.25",
            "unrealized_pnl_pct": "0",
            "realized_pnl_pct": "0",
            "global_pnl_quote": "1.75",
            "global_pnl_pct": "0.01",
            "volume_traded": "120.1",
            "positions_summary": [],
            "close_type_counts": {"TAKE_PROFIT": 2},
        },
    }


def status(**changes) -> dict:
    value = {
        "schema_version": 1,
        "paper_runtime_schema": "native_component_paper_runtime_v1",
        "bot_name": BOT,
        "timestamp": NOW - 1,
        "generated_at": NOW - 1,
        "execution_mode": "paper",
        "controller_kind": "meridian_v5",
        "twin_divergence": {},
        "process_boot_id": BOOT,
        "process_pid": 7,
        "source_sha256": "c" * 64,
        "restored": False,
        "decision_journal": {"failures": 0, "last_error": None},
        "ready": True,
        "reasons": [],
        "failure": None,
        "steps": 120,
        "actions": 4,
        "public_liquidity": {"messages": 10},
        "candle_transport": {"sessions": 1, "failures": 0},
        "controllers": [controller_row(pair) for pair in PAIRS],
        "native_reports": {controller_id(pair): report(pair) for pair in PAIRS},
        "report_observed_at": NOW - 1,
        "unavailable_controller_ids": [],
        "retained_reports": {},
        "retained_marks": {},
        "retained_reports_observed_at": None,
        "simulation_assumptions": {
            "quote": "5000",
            "trade_participation": "0.1",
            "book_depth": 5,
            "queue_priority_verified": False,
        },
    }
    value.update(changes)
    return value


def write_status(tmp_path: Path, payload, *, name=f"{BOT}.status.json") -> Path:
    directory = tmp_path / "runtime_status"
    directory.mkdir(exist_ok=True)
    path = directory / name
    path.write_text(payload if isinstance(payload, str) else json.dumps(payload))
    return path


def observe(tmp_path, payload=None, now=NOW, **kwargs):
    return read_paper_status(
        write_status(tmp_path, status() if payload is None else payload, **kwargs),
        now=now,
    )


# --- reader -------------------------------------------------------------------


def test_fresh_valid_status_binds_the_paper_owner(tmp_path):
    observation = observe(tmp_path)
    assert observation.state == "FRESH" and observation.bound
    assert observation.bot_name == BOT and observation.reason == "PAPER_STATUS_FRESH"


def test_stale_status_is_explicitly_stale_not_bound(tmp_path):
    observation = observe(tmp_path, status(generated_at=NOW - STALE_AFTER_SECONDS - 1))
    assert observation.state == "STALE" and not observation.bound


@pytest.mark.parametrize(
    "payload,reason",
    [
        ("not json", "PAPER_STATUS_MALFORMED"),
        ('{"schema_version": 1, "schema_version": 1}', "PAPER_STATUS_MALFORMED"),
        ("[]", "PAPER_STATUS_MALFORMED"),
        (status(schema_version=2), "PAPER_STATUS_SCHEMA"),
        (status(paper_runtime_schema="other"), "PAPER_STATUS_SCHEMA"),
        (status(execution_mode="live"), "PAPER_STATUS_SCHEMA"),
        (status(bot_name="other_bot"), "PAPER_STATUS_SCHEMA"),
        (status(generated_at="yesterday"), "PAPER_STATUS_SCHEMA"),
        (status(generated_at=NOW + 60), "PAPER_STATUS_CLOCK_SKEW"),
        (status(process_boot_id="x"), "PAPER_STATUS_SCHEMA"),
        (status(ready="yes"), "PAPER_STATUS_SCHEMA"),
        (status(controllers=[{"id": "../x"}]), "PAPER_STATUS_SCHEMA"),
        (status(controllers=[controller_row("BNB-USDC")] * 65), "PAPER_STATUS_SCHEMA"),
        (status(native_reports=[]), "PAPER_STATUS_SCHEMA"),
    ],
)
def test_malformed_status_is_unavailable_with_a_reason(tmp_path, payload, reason):
    observation = observe(tmp_path, payload)
    assert (
        observation.state == "UNAVAILABLE"
        and observation.reason == reason
        and observation.status is None
    )


def test_oversized_status_is_unavailable(tmp_path):
    payload = status(public_liquidity={"padding": "x" * MAX_STATUS_BYTES})
    observation = observe(tmp_path, payload)
    assert (
        observation.state == "UNAVAILABLE"
        and observation.reason == "PAPER_STATUS_CAPACITY"
    )


def test_missing_symlinked_fifo_and_non_canonical_status_paths_are_unavailable(
    tmp_path,
):
    missing = read_paper_status(
        tmp_path / "runtime_status" / f"{BOT}.status.json", now=NOW
    )
    assert missing.state == "UNAVAILABLE" and missing.reason == "PAPER_STATUS_MISSING"
    target = write_status(tmp_path, status(), name="real.status.json")
    link = target.with_name(f"{BOT}.status.json")
    link.symlink_to(target)
    assert read_paper_status(link, now=NOW).reason == "PAPER_STATUS_NOT_REGULAR"
    linked_dir = tmp_path / "linked"
    linked_dir.symlink_to(target.parent)
    write_status(tmp_path, status(bot_name="real"), name="real.status.json")
    assert (
        read_paper_status(linked_dir / "real.status.json", now=NOW).reason
        == "PAPER_STATUS_PATH"
    )
    fifo = tmp_path / "runtime_status" / "fifo.status.json"
    os.mkfifo(fifo)
    assert read_paper_status(fifo, now=NOW).reason == "PAPER_STATUS_NOT_REGULAR"


def test_settings_accept_only_an_absolute_status_file_path(tmp_path):
    env = {
        "V5_RUNTIME_ROOT": str(tmp_path / "runtime"),
        "V5_DASHBOARD_TOKEN_FILE": str(tmp_path / "dashboard.token"),
        "V5_DASHBOARD_ORIGIN": ORIGIN,
        "V5_OBSERVATION_BASE_URL": "http://observation:8080",
        "V5_OBSERVATION_TOKEN_FILE": str(tmp_path / "observation.token"),
        "V5_ADVISOR_CONTROL_BASE_URL": "http://advisor:8081",
        "V5_ADVISORY_REQUEST_TOKEN_FILE": str(tmp_path / "request.token"),
    }
    for name, value in (
        ("dashboard.token", "d"),
        ("observation.token", "o"),
        ("request.token", "q"),
    ):
        (tmp_path / name).write_text(value * 48)
    assert Settings.from_env(env).paper_status_file is None
    configured = Settings.from_env(
        {**env, "V5_PAPER_STATUS_FILE": f"/run/v5-paper/{BOT}.status.json"}
    )
    assert configured.paper_status_file == Path(f"/run/v5-paper/{BOT}.status.json")
    for bad in (
        "relative/meridian.status.json",
        "/run/v5-paper/meridian.json",
        "/run/v5-paper/../x.status.json",
    ):
        with pytest.raises(ConfigurationError):
            Settings.from_env({**env, "V5_PAPER_STATUS_FILE": bad})


# --- pure projections -----------------------------------------------------------


def test_unconfigured_projections_are_identical_to_the_unbound_release():
    assert dashboard_profile(None) == dashboard_profile()
    for path in (
        f"/api/v1/servers/{SERVER}/status",
        f"/api/v1/servers/{SERVER}/bots",
        "/api/v1/trading-visuals/sources",
    ):
        assert read_compatibility_path(path, None) == read_compatibility_path(path)


def test_profile_binds_only_a_fresh_status(tmp_path):
    fresh = dashboard_profile(observe(tmp_path))["readiness"]
    assert fresh["native_owner"] == "PAPER_BOUND"
    assert fresh["paper_owner"]["execution"] == "SIMULATED_WALLET_ONLY"
    assert fresh["account_owner"] == "UNBOUND"
    stale = dashboard_profile(observe(tmp_path, status(generated_at=NOW - 120)))[
        "readiness"
    ]
    assert (
        stale["native_owner"] == "STALE"
        and "stale" in stale["native_owner_reason"].lower()
    )
    missing = dashboard_profile(
        read_paper_status(tmp_path / "none" / f"{BOT}.status.json", now=NOW)
    )["readiness"]
    assert (
        missing["native_owner"] == "UNAVAILABLE"
        and "PAPER_STATUS_MISSING" in missing["native_owner_reason"]
    )


def test_status_projection_stays_read_only_when_bound(tmp_path):
    value = read_compatibility_path(
        f"/api/v1/servers/{SERVER}/status", observe(tmp_path)
    )
    assert (
        value["native_owner"] == "PAPER_BOUND" and value["execution_enabled"] is False
    )
    assert (
        value["paper_owner"]["mode"] == "PAPER"
        and value["paper_owner"]["ready"] is True
    )
    assert value["capabilities"]["native_status"] is True
    assert all(
        value["capabilities"][key] is False
        for key in value["capabilities"]
        if key != "native_status"
    )


def test_bots_projection_shows_paper_controllers_with_pnl_and_bag(tmp_path):
    page = read_compatibility_path(f"/api/v1/servers/{SERVER}/bots", observe(tmp_path))
    assert page["native_owner"] == "PAPER_BOUND" and page["metrics_available"] is True
    (bot,) = page["bots"]
    assert (
        bot["bot_name"] == BOT
        and bot["status"] == "running"
        and bot["execution_mode"] == "PAPER"
    )
    assert bot["num_controllers"] == 5 and bot["controller_count_current"] is True
    assert (
        bot["status_received_at"] == NOW - 1
        and bot["status_stale_after_seconds"] == STALE_AFTER_SECONDS
    )
    rows = {row["controller_id"]: row for row in page["controllers"]}
    row = rows["meridian_v5_BNB_USDC"]
    assert (
        row["trading_pair"] == "BNB-USDC"
        and row["connector"] == "simulated_paper_wallet"
    )
    assert row["global_pnl_quote"] == 1.75 and row["volume_traded"] == 120.1
    assert row["custom_info"]["bag"]["held_amount"] == "0.1" and row["config"] == {}
    assert page["total_pnl"] == pytest.approx(1.75 * 5)


def test_bots_projection_withholds_metrics_for_unavailable_reports(tmp_path):
    payload = status(unavailable_controller_ids=["meridian_v5_ETH_USDC"])
    del payload["native_reports"]["meridian_v5_ETH_USDC"]
    page = read_compatibility_path(
        f"/api/v1/servers/{SERVER}/bots", observe(tmp_path, payload)
    )
    assert page["metrics_available"] is False and page["total_pnl"] is None
    eth = next(
        row
        for row in page["controllers"]
        if row["controller_id"] == "meridian_v5_ETH_USDC"
    )
    assert eth["global_pnl_quote"] is None and eth["status"] == "report_unavailable"


def test_not_ready_and_failed_runtimes_report_their_reasons(tmp_path):
    warming = read_compatibility_path(
        f"/api/v1/servers/{SERVER}/bots",
        observe(tmp_path, status(ready=False, reasons=["BNB-USDC:candles_warming"])),
    )
    assert warming["bots"][0]["ready"] is False and warming["bots"][0][
        "readiness_reasons"
    ] == ["BNB-USDC:candles_warming"]
    failed = read_compatibility_path(
        f"/api/v1/servers/{SERVER}/bots",
        observe(
            tmp_path,
            status(
                ready=False,
                failure="RuntimeError",
                reasons=["native_session_failure_requires_reconciliation"],
                native_reports={},
            ),
        ),
    )
    assert (
        failed["bots"][0]["status"] == "failed"
        and failed["bots"][0]["failure"] == "RuntimeError"
    )
    assert failed["metrics_available"] is False


def test_stale_status_never_projects_controllers_or_metrics(tmp_path):
    page = read_compatibility_path(
        f"/api/v1/servers/{SERVER}/bots",
        observe(tmp_path, status(generated_at=NOW - 120)),
    )
    assert (
        page["native_owner"] == "STALE"
        and page["controllers"] == []
        and page["total_pnl"] is None
    )
    assert (
        page["bots"][0]["status"] == "stale"
        and page["bots"][0]["controller_count_current"] is False
    )


def test_unavailable_status_keeps_bots_unbound(tmp_path):
    page = read_compatibility_path(
        f"/api/v1/servers/{SERVER}/bots", observe(tmp_path, "not json")
    )
    assert (
        page["bots"] == []
        and page["controllers"] == []
        and page["native_owner"] == "UNAVAILABLE"
    )
    assert read_compatibility_path(
        "/api/v1/trading-visuals/sources", observe(tmp_path, "not json")
    ) == {"sources": []}


def test_trading_visuals_list_the_paper_bot_and_its_bootstrap(tmp_path):
    observation = observe(tmp_path)
    assert read_compatibility_path("/api/v1/trading-visuals/sources", observation) == {
        "sources": [{"bot": BOT, "server": SERVER}]
    }
    boot = read_compatibility_path(
        f"/api/v1/trading-visuals/bootstrap?bot={BOT}", observation
    )
    runtime = boot["runtime_status"]
    assert boot["monitoring"] == {
        "bot_name": BOT,
        "stale_threshold_seconds": STALE_AFTER_SECONDS,
    }
    assert (
        runtime["bot_name"] == BOT
        and runtime["updated_at"].endswith("Z")
        and runtime["execution_mode"] == "paper"
    )
    assert {row["pair"] for row in runtime["controllers"]} == set(PAIRS)
    bnb = next(row for row in runtime["active_executors"] if row["pair"] == "BNB-USDC")
    assert bnb == {
        "executor_id": "ex-BNB-USDC",
        "pair": "BNB-USDC",
        "controller_id": "meridian_v5_BNB_USDC",
        "type": "position_executor",
        "side": "BUY",
        "filled_amount_quote": "60.05",
        "net_pnl_quote": "0.06",
        "is_trading": True,
    }
    held = next(row for row in runtime["positions_held"] if row["pair"] == "BNB-USDC")
    assert (
        held["amount"] == "0.1"
        and held["side"] == "BUY"
        and held["controller_id"] == "meridian_v5_BNB_USDC"
    )
    with pytest.raises(Exception) as other:
        read_compatibility_path(
            "/api/v1/trading-visuals/bootstrap?bot=ok_rsi", observation
        )
    assert other.value.status_code == 404
    with pytest.raises(Exception) as unbound:
        read_compatibility_path(f"/api/v1/trading-visuals/bootstrap?bot={BOT}", None)
    assert unbound.value.status_code == 503


def test_multi_pair_controller_rows_are_owner_symbol_projections(tmp_path):
    row = dict(controller_row("BNB-USDC"), id="meridian_v5_portfolio", pair=list(PAIRS))
    payload = status(controllers=[row], native_reports={})
    runtime = read_compatibility_path(
        f"/api/v1/trading-visuals/bootstrap?bot={BOT}", observe(tmp_path, payload)
    )["runtime_status"]
    assert [r["pair"] for r in runtime["controllers"]] == list(PAIRS)
    assert {r["pair_projection_source"] for r in runtime["controllers"]} == {
        "native_owner_symbols"
    }


def test_account_execution_and_control_reads_stay_unbound_when_paper_is_bound(tmp_path):
    observation = observe(tmp_path)
    for path in (
        f"/api/v1/servers/{SERVER}/portfolio",
        f"/api/v1/servers/{SERVER}/account-balances",
        f"/api/v1/servers/{SERVER}/fleet/holdings",
        f"/api/v1/servers/{SERVER}/executors",
        "/api/v1/trading-visuals/quant-summary?bot=" + BOT,
        "/api/v1/operations",
    ):
        with pytest.raises(Exception) as exc:
            read_compatibility_path(path, observation)
        assert exc.value.status_code == 503, path


# --- app wiring and decision reviewer gate -----------------------------------------


class ReviewUpstream(NoNetworkUpstream):
    def __init__(self, enabled: bool):
        super().__init__()
        self.enabled = enabled

    async def observation(self, path):
        self.calls.append(("GET", path))
        if path == "/v1/context":
            return {"snapshot_id": "source-1", "available_at_ms": 1}
        return {"records": []} if path == "/v1/advice/history" else {}

    async def task_profiles(self):
        self.calls.append(("GET", "/v1/tasks"))
        return {
            "tasks": [
                {"task_id": "market_context", "model": "m", "enabled": True},
                {"task_id": "source_quality", "model": "q", "enabled": True},
                {
                    "task_id": "decision_review",
                    "model": "claude-haiku-5-5",
                    "enabled": self.enabled,
                    "reason": None if self.enabled else "PAID_REPORTS_DISABLED",
                },
            ],
            "credential_status": "READY",
        }

    async def latest_task_report(self, task_id):
        self.calls.append(("GET", f"latest:{task_id}"))
        return {"status": "UNAVAILABLE", "effect": "NONE", "record": None}

    async def request_report(self, task_id, snapshot_id):
        self.calls.append(("POST", task_id, snapshot_id))
        return {
            "status": "ACCEPTED",
            "effect": "NONE",
            "advice": {"summary": "consistent", "evidence_refs": ["decision.a01"]},
        }


def client_for(tmp_path, upstream, *, payload=None, configured=True, clock_s=NOW):
    tmp_path.mkdir(parents=True, exist_ok=True)
    settings = make_settings(tmp_path)
    if configured:
        path = write_status(tmp_path, status() if payload is None else payload)
        settings = Settings(**{**settings.__dict__, "paper_status_file": path})
    app = create_app(
        settings=settings,
        upstream=upstream,
        static_dir=tmp_path / "dist",
        clock=lambda: int(clock_s * 1000),
    )
    client = TestClient(app)
    assert (
        client.post(
            "/api/v5/auth/login", json={"token": TOKEN}, headers={"Origin": ORIGIN}
        ).status_code
        == 200
    )
    return client


def reviewer(client):
    return next(
        agent
        for agent in client.get("/api/v5/workspace").json()["agents"]
        if agent["id"] == "decision_reviewer"
    )


def test_reviewer_is_ready_only_when_task_enabled_and_paper_bound(tmp_path):
    with client_for(tmp_path / "a", ReviewUpstream(True)) as client:
        agent = reviewer(client)
        assert (
            agent["task_id"] == "decision_review"
            and agent["status"] == "ready"
            and agent["blockers"] == []
        )
        assert agent["model"] == "claude-haiku-5-5"
    with client_for(tmp_path / "b", ReviewUpstream(False)) as client:
        assert reviewer(client)["blockers"] == ["PAID_REPORTS_DISABLED"]
    with client_for(
        tmp_path / "c", ReviewUpstream(True), payload=status(generated_at=NOW - 120)
    ) as client:
        agent = reviewer(client)
        assert agent["status"] == "blocked" and agent["blockers"] == [
            "paper_owner_stale"
        ]
    with client_for(tmp_path / "d", ReviewUpstream(True), configured=False) as client:
        assert reviewer(client)["blockers"] == ["paper_owner_unbound"]
    with client_for(
        tmp_path / "e", ReviewUpstream(False), payload="not json"
    ) as client:
        assert reviewer(client)["blockers"] == [
            "paper_owner_unavailable:PAPER_STATUS_MALFORMED",
            "PAID_REPORTS_DISABLED",
        ]


def test_blocked_reviewer_report_records_the_precise_reason_without_calling(tmp_path):
    upstream = ReviewUpstream(True)
    with client_for(tmp_path, upstream, configured=False) as client:
        session = client.post(
            "/api/v5/agents/decision_reviewer/report", headers={"Origin": ORIGIN}
        ).json()
    assert (
        session["status"] == "BLOCKED"
        and session["ticks"][0]["error"] == "paper_owner_unbound"
    )
    assert not any(call[0] == "POST" for call in upstream.calls)


def test_bound_and_enabled_reviewer_requests_only_its_fixed_task(tmp_path):
    upstream = ReviewUpstream(True)
    with client_for(tmp_path, upstream) as client:
        session = client.post(
            "/api/v5/agents/decision_reviewer/report", headers={"Origin": ORIGIN}
        ).json()
        inspected = client.post(
            "/api/v5/agents/decision_reviewer/inspect", headers={"Origin": ORIGIN}
        ).json()
    assert session["status"] == "COMPLETED"
    assert [call for call in upstream.calls if call[0] == "POST"] == [
        ("POST", "decision_review", "source-1")
    ]
    assert inspected["status"] == "COMPLETED" and inspected["ticks"][0][
        "evidence_refs"
    ] == [f"paper:{BOT}:{BOOT}"]


def test_app_profile_and_bots_read_the_configured_status(tmp_path):
    with client_for(tmp_path, NoNetworkUpstream()) as client:
        profile = client.get("/api/v5/dashboard/profile").json()
        bots = client.get(
            "/api/v5/dashboard/read", params={"path": f"/api/v1/servers/{SERVER}/bots"}
        ).json()
        boot = client.get(
            "/api/v5/dashboard/read",
            params={"path": f"/api/v1/trading-visuals/bootstrap?bot={BOT}"},
        )
    assert profile["readiness"]["native_owner"] == "PAPER_BOUND"
    assert bots["bots"][0]["bot_name"] == BOT
    assert boot.status_code == 200
