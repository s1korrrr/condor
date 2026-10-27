"""The consolidated positions projection must distinguish live runtimes from history."""

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from condor.web.auth import get_current_user
from condor.web.models import WebUser
from condor.web.routes import positions as route

CURRENT = {
    "bot_name": "stable-bot-new-generation",
    "status": "running",
    "received_at": 1_798_300_000,
    "performance": {
        "controller": {
            "status": "running",
            "performance": {
                "positions_summary": [
                    {
                        "connector_name": "okx",
                        "trading_pair": "BNB-USDC",
                        "amount": 0.5,
                        "entry_price": 100,
                        "unrealized_pnl_quote": 0.0,
                    }
                ]
            },
        }
    },
}


def _app(
    monkeypatch,
    *,
    bots=None,
    executors=None,
    bot_error=None,
    exec_error=None,
    price_response=None,
    slow_source=None,
):
    async def active_bots():
        if slow_source == "bots":
            await asyncio.Future()
        if bot_error:
            raise bot_error
        return {"data": [CURRENT]} if bots is None else bots

    async def executor_positions():
        if slow_source == "executors":
            await asyncio.Future()
        if exec_error:
            raise exec_error
        return executors if executors is not None else {"positions": []}

    class Client:
        bot_orchestration = SimpleNamespace()
        executors = SimpleNamespace()
        market_data = SimpleNamespace()

    client = Client()
    client.bot_orchestration.get_active_bots_status = active_bots
    client.executors.get_positions_summary = executor_positions

    async def get_prices(**kwargs):
        if slow_source == "prices":
            await asyncio.Future()
        return price_response

    client.market_data.get_prices = get_prices

    class Config:
        def has_server_access(self, user_id, name):
            return user_id == 7 and name == "v2"

        async def get_client(self, name):
            return client

    monkeypatch.setattr(route, "get_config_manager", lambda: Config())
    app = FastAPI()
    app.include_router(route.router, prefix="/api/v1")
    app.dependency_overrides[get_current_user] = lambda: WebUser(id=7, role="user")
    return TestClient(app)


def test_asgi_projection_excludes_stopped_generation_and_keeps_executor_inventory(
    monkeypatch,
):
    historical = {
        **CURRENT,
        "bot_name": "stable-bot-old-generation",
        "status": "stopped",
        "performance": {
            "controller": {
                "status": "running",  # historic controller status is not runtime membership
                "performance": {
                    "positions_summary": [
                        {
                            "connector_name": "okx",
                            "trading_pair": "BNB-USDC",
                            "amount": 0.01,
                            "entry_price": 100,
                        }
                        for _ in range(22)
                    ]
                },
            }
        },
    }
    # The endpoint lists active instances; stopped historical rows are not current.
    api = _app(
        monkeypatch,
        bots={"data": [CURRENT, historical]},
        executors={
            "positions": [
                {
                    "connector_name": "okx",
                    "trading_pair": "BNB-USDC",
                    "amount": 0.2,
                    "entry_price": 100,
                    "unrealized_pnl_quote": 0.0,
                }
            ]
        },
    )

    response = api.get("/api/v1/servers/v2/positions")
    assert response.status_code == 200
    body = response.json()
    assert len(body["bot_positions"]) == 1
    assert body["bot_positions"][0]["amount"] == 0.5
    assert body["bot_positions"][0]["source_instance"] == "stable-bot-new-generation"
    assert body["bot_positions"][0]["reporting_scope"] == "current_runtime"
    assert body["bot_positions"][0]["source_timestamp"] == CURRENT["received_at"]
    assert body["executor_positions"][0]["amount"] == 0.2
    assert body["bot_positions_status"] == "partial"
    assert body["executor_positions_status"] == "partial"
    assert len(body["non_current_bot_positions"]) == 22
    assert (
        body["non_current_bot_positions"][0]["reporting_scope"]
        == "non_current_runtime_observation"
    )
    assert (
        body["non_current_bot_positions"][0]["reconciliation_status"]
        == "not_reconciled"
    )


def test_valid_empty_runtime_list_is_available_empty(monkeypatch):
    response = _app(monkeypatch, bots={"data": []}).get("/api/v1/servers/v2/positions")
    assert response.status_code == 200
    body = response.json()
    assert body["bot_positions"] == []
    assert body["bot_positions_status"] == "available"


def test_unavailable_runtime_read_is_unknown_not_empty(monkeypatch):
    response = _app(monkeypatch, bot_error=RuntimeError("offline")).get(
        "/api/v1/servers/v2/positions"
    )
    body = response.json()
    assert body["bot_positions_status"] == "unavailable"
    assert body["bot_positions"] is None
    assert body["executor_positions_status"] == "available"


def test_malformed_and_partial_runtime_reads_do_not_claim_complete_empty(monkeypatch):
    malformed = (
        _app(monkeypatch, bots={"data": "bad"})
        .get("/api/v1/servers/v2/positions")
        .json()
    )
    assert malformed["bot_positions_status"] == "unavailable"
    assert malformed["bot_positions"] is None

    partial_payload = {"data": [{"bot_name": "unknown-status", "performance": {}}]}
    partial = (
        _app(monkeypatch, bots=partial_payload)
        .get("/api/v1/servers/v2/positions")
        .json()
    )
    assert partial["bot_positions_status"] == "partial"
    assert partial["bot_positions"] == []


def test_running_runtime_with_empty_performance_is_not_authoritative_empty(monkeypatch):
    empty = {**CURRENT, "performance": {}}
    body = (
        _app(monkeypatch, bots={"data": [empty]})
        .get("/api/v1/servers/v2/positions")
        .json()
    )
    assert body["bot_positions_status"] == "partial"
    assert body["bot_positions"] == []


def test_executor_failure_remains_unknown_while_runtime_positions_survive(monkeypatch):
    body = (
        _app(monkeypatch, exec_error=RuntimeError("owner read failed"))
        .get("/api/v1/servers/v2/positions")
        .json()
    )
    assert body["executor_positions_status"] == "unavailable"
    assert body["executor_positions"] is None
    assert body["bot_positions_status"] == "partial"
    assert len(body["bot_positions"]) == 1


def test_missing_economic_values_are_null_and_mark_source_partial(monkeypatch):
    bot = {
        **CURRENT,
        "performance": {
            "controller": {
                "status": "running",
                "performance": {
                    "positions_summary": [
                        {
                            "connector_name": "okx",
                            "trading_pair": "BNB-USDC",
                            "amount": 0.5,
                            "entry_price": 100,
                        }
                    ]
                },
            }
        },
    }
    body = (
        _app(monkeypatch, bots={"data": [bot]})
        .get("/api/v1/servers/v2/positions")
        .json()
    )
    row = body["bot_positions"][0]
    assert body["bot_positions_status"] == "partial"
    assert row["amount"] == 0.5
    assert row["unrealized_pnl"] is None
    assert row["current_price"] is None


def test_missing_instrument_pair_marks_current_source_partial(monkeypatch):
    missing_pair = {
        **CURRENT,
        "performance": {
            "controller": {
                "status": "running",
                "performance": {
                    "positions_summary": [
                        {
                            "connector_name": "okx",
                            "amount": 0.5,
                            "entry_price": 100,
                            "unrealized_pnl_quote": 0,
                        }
                    ]
                },
            }
        },
    }
    response = _app(monkeypatch, bots={"data": [missing_pair]}).get(
        "/api/v1/servers/v2/positions"
    )
    assert response.status_code == 200
    body = response.json()
    assert body["bot_positions_status"] == "partial"
    assert body["bot_positions"][0]["trading_pair"] == ""


@pytest.mark.parametrize("price", ["NaN", "Infinity", -1, 0])
def test_nonfinite_or_nonpositive_enriched_price_stays_unknown_and_partial(
    monkeypatch, price
):
    response = _app(
        monkeypatch,
        bots={"data": []},
        executors={
            "positions": [
                {
                    "connector_name": "okx",
                    "trading_pair": "BNB-USDC",
                    "amount": 0.2,
                    "entry_price": 100,
                    "unrealized_pnl_quote": 0,
                }
            ]
        },
        price_response={"prices": {"BNB-USDC": price}},
    ).get("/api/v1/servers/v2/positions")
    assert response.status_code == 200
    body = response.json()
    assert body["executor_positions_status"] == "partial"
    assert body["executor_positions"][0]["current_price"] is None


def test_native_retained_or_unverified_report_is_not_current(monkeypatch):
    retained = {
        **CURRENT,
        "source": "native_mqtt",
        "identity_verified": True,
        "performance_current": False,
    }
    body = (
        _app(monkeypatch, bots={"data": [retained]})
        .get("/api/v1/servers/v2/positions")
        .json()
    )
    assert body["bot_positions"] == []
    assert body["bot_positions_status"] == "partial"
    assert (
        body["non_current_bot_positions"][0]["reporting_scope"]
        == "non_current_runtime_observation"
    )

    foreign = {
        **CURRENT,
        "source": "native_mqtt",
        "identity_verified": False,
        "performance_current": True,
    }
    body = (
        _app(monkeypatch, bots={"data": [foreign]})
        .get("/api/v1/servers/v2/positions")
        .json()
    )
    assert body["bot_positions"] == []
    assert body["bot_positions_status"] == "partial"
    assert body["non_current_bot_positions"]


def test_duplicate_runtime_identity_is_unknown_not_double_counted(monkeypatch):
    duplicate = {**CURRENT, "bot_name": CURRENT["bot_name"]}
    body = (
        _app(monkeypatch, bots={"data": [CURRENT, duplicate]})
        .get("/api/v1/servers/v2/positions")
        .json()
    )
    assert body["bot_positions"] == []
    assert body["bot_positions_status"] == "partial"


def test_reporting_only_native_row_does_not_make_current_book_partial(monkeypatch):
    retained = {
        **CURRENT,
        "status": "reporting_only",
        "source": "native_mqtt",
        "performance_current": False,
    }
    body = (
        _app(monkeypatch, bots={"data": [retained]})
        .get("/api/v1/servers/v2/positions")
        .json()
    )
    assert body["bot_positions"] == []
    assert body["bot_positions_status"] == "available"


def test_duplicate_position_identity_is_partial_and_never_double_counted(monkeypatch):
    position = {
        "connector_name": "okx",
        "trading_pair": "BNB-USDC",
        "position_side": "LONG",
        "amount": 0.5,
        "entry_price": 100,
        "unrealized_pnl_quote": 0,
    }
    duplicate_controller = {
        **CURRENT,
        "performance": {
            "controller": {
                "status": "running",
                "performance": {"positions_summary": [position, dict(position)]},
            }
        },
    }
    body = (
        _app(monkeypatch, bots={"data": [duplicate_controller]})
        .get("/api/v1/servers/v2/positions")
        .json()
    )
    assert body["bot_positions"] == []
    assert body["bot_positions_status"] == "partial"


def test_distinct_position_sides_remain_separate(monkeypatch):
    long_position = {
        "connector_name": "okx",
        "trading_pair": "BNB-USDC",
        "position_side": "LONG",
        "amount": 0.5,
        "entry_price": 100,
        "unrealized_pnl_quote": 0,
    }
    short_position = {**long_position, "position_side": "SHORT", "amount": -0.2}
    bot = {
        **CURRENT,
        "performance": {
            "controller": {
                "status": "running",
                "performance": {"positions_summary": [long_position, short_position]},
            }
        },
    }
    body = (
        _app(monkeypatch, bots={"data": [bot]})
        .get("/api/v1/servers/v2/positions")
        .json()
    )
    assert body["bot_positions_status"] == "partial"
    assert [row["position_side"] for row in body["bot_positions"]] == ["LONG", "SHORT"]


def test_registry_key_conflict_is_not_rewritten_as_runtime_identity(monkeypatch):
    conflicting = {**CURRENT, "bot_name": "foreign-runtime"}
    body = (
        _app(monkeypatch, bots={"data": {"stable-bot-new-generation": conflicting}})
        .get("/api/v1/servers/v2/positions")
        .json()
    )
    assert body["bot_positions_status"] == "partial"
    assert body["bot_positions"] == []


@pytest.mark.parametrize("status", ["starting", "stopping"])
def test_transitional_runtime_positions_are_not_current_complete_metrics(
    monkeypatch, status
):
    transitional = {**CURRENT, "status": status}
    body = (
        _app(monkeypatch, bots={"data": [transitional]})
        .get("/api/v1/servers/v2/positions")
        .json()
    )
    assert body["bot_positions_status"] == "partial"
    assert body["bot_positions"] == []
    assert (
        body["non_current_bot_positions"][0]["reporting_scope"]
        == "non_current_runtime_observation"
    )


def test_position_notional_uses_current_mark_and_unknown_mark_is_partial(monkeypatch):
    position = {
        "connector_name": "okx",
        "trading_pair": "BNB-USDC",
        "amount": 0.5,
        "entry_price": 100,
        "unrealized_pnl_quote": 0,
    }
    mark = (
        _app(
            monkeypatch,
            bots={"data": []},
            executors={"positions": [position]},
            price_response={"prices": {"BNB-USDC": 120}},
        )
        .get("/api/v1/servers/v2/positions")
        .json()
    )
    assert mark["executor_positions"][0]["notional_value"] == 60
    assert mark["executor_positions"][0]["current_price"] == 120

    missing = (
        _app(
            monkeypatch,
            bots={"data": []},
            executors={"positions": [position]},
            price_response={"prices": {}},
        )
        .get("/api/v1/servers/v2/positions")
        .json()
    )
    assert missing["executor_positions_status"] == "partial"
    assert missing["executor_positions"][0]["notional_value"] is None


@pytest.mark.parametrize("slow_source", ["executors", "bots", "prices"])
def test_owner_and_price_reads_are_bounded_and_preserve_other_source(
    monkeypatch, slow_source
):
    monkeypatch.setattr(route, "POSITION_READ_TIMEOUT", 0.01, raising=False)
    position = {
        "connector_name": "okx",
        "trading_pair": "BNB-USDC",
        "amount": 0.5,
        "entry_price": 100,
        "unrealized_pnl_quote": 0,
    }
    _app(
        monkeypatch,
        bots={"data": [CURRENT]},
        executors={"positions": [position]},
        price_response=(
            None if slow_source == "prices" else {"prices": {"BNB-USDC": 120}}
        ),
        slow_source=slow_source,
    )
    body = asyncio.run(
        asyncio.wait_for(
            route.get_consolidated_positions("v2", WebUser(id=7, role="user")),
            timeout=0.1,
        )
    )
    if slow_source == "executors":
        assert body["executor_positions"] is None
        assert body["executor_positions_status"] == "unavailable"
        assert len(body["bot_positions"]) == 1
        assert body["bot_positions_status"] == "partial"
    elif slow_source == "bots":
        assert body["bot_positions"] is None
        assert body["bot_positions_status"] == "unavailable"
        assert len(body["executor_positions"]) == 1
        assert body["executor_positions_status"] == "partial"
    else:
        assert body["executor_positions_status"] == "partial"
        assert body["executor_positions"][0]["current_price"] is None


@pytest.mark.parametrize("status", ["starting", "stopping"])
def test_transitional_controller_positions_are_not_current_metrics(monkeypatch, status):
    controller = {
        **CURRENT,
        "performance": {
            "controller": {
                "status": status,
                "performance": {
                    "positions_summary": CURRENT["performance"]["controller"][
                        "performance"
                    ]["positions_summary"]
                },
            }
        },
    }
    body = (
        _app(monkeypatch, bots={"data": [controller]})
        .get("/api/v1/servers/v2/positions")
        .json()
    )
    assert body["bot_positions_status"] == "partial"
    assert body["bot_positions"] == []
    assert len(body["non_current_bot_positions"]) == 1


@pytest.mark.parametrize(
    "bad_value",
    [True, float("nan"), float("inf"), "not-a-number"],
)
def test_malformed_position_economics_are_partial_and_never_coerced_to_zero(
    monkeypatch, bad_value
):
    malformed = {
        **CURRENT,
        "performance": {
            "controller": {
                "status": "running",
                "performance": {
                    "positions_summary": [
                        {
                            "connector_name": "okx",
                            "trading_pair": "BNB-USDC",
                            "amount": bad_value,
                            "entry_price": 100,
                            "unrealized_pnl_quote": 1,
                        }
                    ]
                },
            }
        },
    }
    body = (
        _app(monkeypatch, bots={"data": [malformed]})
        .get("/api/v1/servers/v2/positions")
        .json()
    )
    assert body["bot_positions_status"] == "partial"
    assert body["bot_positions"][0]["amount"] is None
    assert body["bot_positions"][0]["notional_value"] is None


def test_finite_inputs_with_overflowing_notional_are_partial(monkeypatch):
    overflow = {
        **CURRENT,
        "performance": {
            "controller": {
                "status": "running",
                "performance": {
                    "positions_summary": [
                        {
                            "connector_name": "okx",
                            "trading_pair": "BNB-USDC",
                            "amount": 1e308,
                            "entry_price": 1e308,
                            "unrealized_pnl_quote": 0,
                        }
                    ]
                },
            }
        },
    }
    body = (
        _app(monkeypatch, bots={"data": [overflow]})
        .get("/api/v1/servers/v2/positions")
        .json()
    )
    assert body["bot_positions_status"] == "partial"
    assert body["bot_positions"][0]["notional_value"] is None


@pytest.mark.parametrize("raw_mark", [float("nan"), float("inf"), -1, True])
def test_invalid_raw_mark_keeps_known_quantity_and_cost_unknown_mark(
    monkeypatch, raw_mark
):
    position = {
        "connector_name": "okx",
        "trading_pair": "BNB-USDC",
        "amount": 0.5,
        "entry_price": 100,
        "current_price": raw_mark,
        "unrealized_pnl_quote": 0,
    }
    body = (
        _app(
            monkeypatch,
            bots={"data": []},
            executors={"positions": [position]},
            price_response={"prices": {}},
        )
        .get("/api/v1/servers/v2/positions")
        .json()
    )
    assert body["executor_positions_status"] == "partial"
    row = body["executor_positions"][0]
    assert row["amount"] == 0.5 and row["cost_basis_value"] == 50
    assert row["current_price"] is None and row["notional_value"] is None
