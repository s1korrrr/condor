"""``fleet-holdings.v1``: the one inventory projection the dashboard, fleet summary and phone render.

Inputs are owner ``rsibot.quant_ops.v1`` envelopes in the shapes the live V1/V2/V3 reporting
owners publish (read 2026-10-25, key names and types only). Every expected value below is written
from the contract rules, not copied from the implementation's output.
"""

from __future__ import annotations

import asyncio
import copy
import json
from decimal import Decimal as D
from pathlib import Path

import httpx
import pytest

from condor.web import holdings as h

NOW_MS = 1_761_436_800_000  # 2025-10-26T00:00:00Z
FIXTURES = Path(__file__).parent / "fixtures" / "fleet_holdings"
EXAMPLE = FIXTURES / "holdings.example.json"


def iso(ms: int) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()


def pair(name, controller, **fields):
    row = {
        "pair": name,
        "controller_id": controller,
        "state": "HOLDING",
        "units": "0",
        "entry_cost": None,
        "breakeven_price": None,
        "mark": None,
        "mark_availability": "not_applicable",
        "mark_source": None,
        "marked_value": "0",
        "unrealized": None,
        "realized": None,
        "fees": None,
        "running_executors": 0,
        "pending_sell_requests": 0,
    }
    row.update(fields)
    return row


def envelope(
    bot,
    pairs,
    *,
    age_s=4,
    mode="live",
    coverage=None,
    last_known=None,
    boot=None,
    quote="USDC",
    generated_ms=None,
):
    observed = iso(NOW_MS - age_s * 1000)
    return {
        "schema_version": "rsibot.quant_ops.v1",
        "execution_authorized": False,
        "generated_at": iso(
            generated_ms if generated_ms is not None else NOW_MS - 1000
        ),
        "snapshot_id": f"{bot}:{observed}",
        "scope": {
            "bot_key": bot,
            "execution_mode": mode,
            "quote_currency": quote,
            "owner_boot_id": boot,
        },
        "coverage": (
            coverage
            if coverage is not None
            else {"applicable": 1, "ready": 1, "reasons": []}
        ),
        "source_times": {"runtime_status": observed},
        "data": {
            "bot_id": bot,
            "heartbeat": observed,
            "pairs": pairs,
            "last_known": last_known,
        },
    }


BNB = pair(
    "BNB-USDC",
    "ok-rsi-bnb",
    units="4",
    entry_cost="2114",
    breakeven_price="530",
    mark="600",
    mark_availability="available",
    marked_value="2400",
    unrealized="280",
    realized="12.5",
    fees="6",
)
XRP_DUST = pair(
    "XRP-USDC",
    "ok-rsi-xrp",
    units="0.2",
    entry_cost="0.6",
    breakeven_price="3",
    mark="2.5",
    mark_availability="available",
    marked_value="0.5",
    unrealized="-0.1",
    realized="0",
    fees="0",
)
BTC_FLAT = pair("BTC-USDC", "ok-rsi-btc", state="FLAT")
V1 = envelope("ok_rsi", [BNB, XRP_DUST, BTC_FLAT])

V3_ID = "modular_spot_meridian_v3_unified_live"
# BTC holds a running executor's inventory on top of its retained row: the owner attributes it and
# leaves cost/breakeven unknown, because executor inventory has no retained cost.
V3 = envelope(
    "meridian_v3",
    [
        pair(
            "BTC-USDC",
            V3_ID,
            units="0.003",
            mark="100000",
            mark_availability="available",
            mark_source="native_position_summary_mid",
            marked_value="300",
            unrealized="9",
            running_executors=1,
        ),
        pair(
            "ETH-USDC",
            V3_ID,
            units="0.0001",
            entry_cost="0.35",
            breakeven_price="3500",
            mark="4000",
            mark_availability="available",
            mark_source="native_position_summary_mid",
            marked_value="0.4",
            unrealized="0.05",
            realized="0",
            fees="0",
        ),
    ],
)


def project(payload, bot, now=NOW_MS):
    return h.project_bot(payload, bot, now)


def by_pair(bot_view):
    return {row["pair"]: row for row in bot_view["pairs"]}


def test_current_v1_book_with_a_small_holding_and_a_flat_pair():
    view = project(V1, "ok_rsi")
    assert view["state"] == "current" and view["reason"] is None
    assert view["inventory_complete"] and view["value_complete"]
    assert view["registered_pair_count"] == 3
    assert view["held_pair_count"] == 2  # BTC is flat
    assert view["totals"] == {
        "marked_value_quote": "2400.5",
        "known_marked_value_quote": "2400.5",
        "unrealized_pnl_quote": "279.9",
        "entry_cost_quote": "2114.6",
    }
    pairs = by_pair(view)
    assert pairs["XRP-USDC"]["small"] is True
    assert pairs["BNB-USDC"]["small"] is False
    assert pairs["BTC-USDC"]["small"] is False  # nothing held
    assert pairs["BNB-USDC"]["breakeven_price"] == "530"
    assert view["stale_after_ms"] == 30_000
    assert view["observed_at_ms"] == NOW_MS - 4000


def test_v3_in_flight_inventory_is_counted_and_its_unknown_cost_keeps_cost_totals_unknown():
    view = project(V3, "meridian_v3")
    pairs = by_pair(view)
    assert pairs["BTC-USDC"]["units"] == "0.003"
    assert pairs["BTC-USDC"]["running_executor_count"] == 1
    assert pairs["BTC-USDC"]["entry_cost_quote"] is None
    # ETH is below one USDC with no running executor; BTC has one and is never grouped small.
    assert pairs["ETH-USDC"]["small"] is True
    assert view["held_pair_count"] == 2
    assert view["totals"]["marked_value_quote"] == "300.4"
    assert view["totals"]["entry_cost_quote"] is None


def test_a_running_executor_is_never_grouped_as_a_small_holding():
    tiny = envelope(
        "ok_rsi",
        [
            pair(
                "XRP-USDC",
                "x",
                units="0.1",
                mark="2.5",
                mark_availability="available",
                marked_value="0.25",
                running_executors=1,
            )
        ],
    )
    assert by_pair(project(tiny, "ok_rsi"))["XRP-USDC"]["small"] is False
    trailing = envelope(
        "ok_rsi",
        [
            pair(
                "XRP-USDC",
                "x",
                state="TRAILING",
                units="0.1",
                mark="2.5",
                mark_availability="available",
                marked_value="0.25",
            )
        ],
    )
    assert by_pair(project(trailing, "ok_rsi"))["XRP-USDC"]["small"] is False
    pending_sell = envelope(
        "ok_rsi",
        [
            pair(
                "XRP-USDC",
                "x",
                units="0.1",
                mark="2.5",
                mark_availability="available",
                marked_value="0.25",
                pending_sell_requests=1,
            )
        ],
    )
    assert by_pair(project(pending_sell, "ok_rsi"))["XRP-USDC"]["small"] is False
    assert (
        by_pair(project(pending_sell, "ok_rsi"))["XRP-USDC"]["pending_sell_count"] == 1
    )
    older_owner = copy.deepcopy(tiny)
    older_owner["data"]["pairs"][0].pop("running_executors")
    older_owner["data"]["pairs"][0]["marked_value"] = "0.25"
    assert by_pair(project(older_owner, "ok_rsi"))["XRP-USDC"]["small"] is False


def test_observation_older_than_30_seconds_is_stale_even_when_the_owner_threshold_is_180():
    # D-1: the phone used to treat this as current (age < 180 s); the dashboard did not.
    stale = envelope("ok_rsi", [BNB], age_s=45)
    view = project(stale, "ok_rsi")
    assert view["state"] == "stale"
    assert by_pair(view)["BNB-USDC"]["units"] == "4"  # last known, labelled stale
    assert project(envelope("ok_rsi", [BNB], age_s=29), "ok_rsi")["state"] == "current"
    assert project(envelope("ok_rsi", [BNB], age_s=30), "ok_rsi")["state"] == "stale"


def test_owner_last_known_block_is_rendered_as_stale():
    payload = envelope(
        "ok_rsi",
        [],
        age_s=90,
        coverage={"applicable": 1, "ready": 0, "reasons": ["RUNTIME_NOT_CURRENT"]},
        last_known={
            "observed_at": iso(NOW_MS - 90_000),
            "quote_currency": "USDC",
            "pairs": [BNB],
        },
    )
    view = project(payload, "ok_rsi")
    assert view["state"] == "stale"
    assert view["observed_at_ms"] == NOW_MS - 90_000
    assert view["held_pair_count"] == 1


def test_published_but_malformed_mark_is_invalid_not_merely_unknown():
    payload = envelope(
        "ok_rsi",
        [
            BNB,
            pair(
                "ETH-USDC",
                "e",
                units="1",
                mark="-3",
                mark_availability="available",
                marked_value=None,
            ),
        ],
    )
    view = project(payload, "ok_rsi")
    assert view["incomplete_reasons"][0] == "PAIR_FIELD_INVALID"
    assert by_pair(view)["ETH-USDC"]["mark_price"] is None
    assert view["totals"]["marked_value_quote"] is None


def test_unknown_units_keep_counts_and_totals_unknown_but_known_value_visible():
    payload = envelope(
        "ok_rsi", [BNB, pair("ETH-USDC", "e", units=None, marked_value=None)]
    )
    view = project(payload, "ok_rsi")
    assert view["state"] == "current"
    assert not view["inventory_complete"] and not view["value_complete"]
    assert view["incomplete_reasons"] == ["PAIR_QUANTITY_UNKNOWN"]
    assert view["held_pair_count"] is None
    assert view["totals"]["marked_value_quote"] is None
    assert view["totals"]["known_marked_value_quote"] == "2400"
    assert view["totals"]["unrealized_pnl_quote"] is None


def test_unpriced_holding_keeps_count_but_not_value():
    payload = envelope(
        "ok_rsi",
        [
            BNB,
            pair(
                "ETH-USDC",
                "e",
                units="1",
                marked_value=None,
                mark_availability="unavailable",
            ),
        ],
    )
    view = project(payload, "ok_rsi")
    assert view["inventory_complete"] and not view["value_complete"]
    assert view["incomplete_reasons"] == ["VALUE_UNKNOWN"]
    assert view["held_pair_count"] == 2
    assert view["totals"]["marked_value_quote"] is None
    assert view["totals"]["known_marked_value_quote"] == "2400"


def test_duplicate_owner_identity_has_no_quantity():
    payload = envelope("ok_rsi", [BNB, copy.deepcopy(BNB)])
    view = project(payload, "ok_rsi")
    assert "PAIR_DUPLICATE" in view["incomplete_reasons"]
    assert [row["units"] for row in view["pairs"]] == [None, None]
    assert view["held_pair_count"] is None


def test_confirmed_empty_book_is_zero_not_unknown():
    view = project(envelope("ok_rsi", [BTC_FLAT]), "ok_rsi")
    assert (
        view["state"] == "current"
        and view["inventory_complete"]
        and view["value_complete"]
    )
    assert view["held_pair_count"] == 0
    assert view["totals"]["marked_value_quote"] == "0"


@pytest.mark.parametrize(
    "mutate, reason",
    [
        (lambda e: e["scope"].update(bot_key="other"), "IDENTITY_MISMATCH"),
        (lambda e: e["data"].update(bot_id="other"), "IDENTITY_MISMATCH"),
        (
            lambda e: e.update(schema_version="rsibot.quant_ops.v0"),
            "OWNER_SCHEMA_UNSUPPORTED",
        ),
        (lambda e: e.update(execution_authorized=True), "OWNER_SCHEMA_UNSUPPORTED"),
        (
            lambda e: e.update(generated_at="2025-10-26T00:00:00"),
            "OBSERVATION_TIME_INVALID",
        ),
        (lambda e: e.update(generated_at=iso(NOW_MS + 6000)), "CLOCK_SKEW"),
        (lambda e: e["scope"].update(execution_mode="unknown"), "MODE_UNVERIFIED"),
        (lambda e: e["scope"].update(quote_currency="unknown"), "QUOTE_UNVERIFIED"),
        (
            lambda e: e.update(
                coverage={
                    "applicable": 1,
                    "ready": 0,
                    "reasons": ["SOURCE_SCOPE_UNVERIFIED"],
                }
            ),
            "SOURCE_SCOPE_UNVERIFIED",
        ),
        (lambda e: e["data"].update(pairs=None), "PAIRS_INVALID"),
        (lambda e: e["data"]["pairs"][0].update(pair="BNBUSDC"), "PAIRS_INVALID"),
    ],
)
def test_unadmitted_observation_is_unavailable_never_an_empty_book(mutate, reason):
    payload = copy.deepcopy(V1)
    mutate(payload)
    view = project(payload, "ok_rsi")
    assert view["state"] == "unavailable"
    assert view["reason"] == reason
    assert (
        view["pairs"] == []
        and view["held_pair_count"] is None
        and view["totals"] is None
    )


def test_paper_lane_is_labelled_and_owner_boot_id_passes_through():
    view = project(
        envelope("meridian_v4_paper", [BNB], mode="paper", boot="boot-7"),
        "meridian_v4_paper",
    )
    assert view["paper"] is True
    assert view["owner_boot_id"] == "boot-7"
    assert project(V1, "ok_rsi")["owner_boot_id"] is None


def test_exact_decimals_survive_and_malformed_numbers_are_unknown():
    payload = envelope(
        "ok_rsi",
        [
            pair(
                "BNB-USDC",
                "b",
                units="0.0000005224",
                mark="785.6",
                mark_availability="available",
                marked_value="0.00041039744",
            )
        ],
    )
    row = by_pair(project(payload, "ok_rsi"))["BNB-USDC"]
    assert row["units"] == "0.0000005224" and D(row["marked_value_quote"]) == D(
        "0.0000005224"
    ) * D("785.6")
    for bad in ("NaN", "Infinity", True, "1e400000", "-1"):
        payload["data"]["pairs"][0]["units"] = bad
        view = project(payload, "ok_rsi")
        assert by_pair(view)["BNB-USDC"]["units"] is None
        assert (
            "PAIR_FIELD_INVALID" in view["incomplete_reasons"]
            and view["held_pair_count"] is None
        )


def example_reads():
    return {
        "ok_rsi": V1,
        "meridian_v3": V3,
        "rsi_modular_v2": envelope("rsi_modular_v2", [BNB], age_s=45),
        "meridian_v4_paper": envelope("meridian_v4_paper", [BNB], mode="paper"),
        "partial_bot": envelope(
            "partial_bot", [BNB, pair("ETH-USDC", "e", units=None, marked_value=None)]
        ),
        "offline_bot": h.SOURCE_UNAVAILABLE,
    }


def test_example_payload_is_the_builders_output():
    body = h.build_holdings("main", example_reads(), NOW_MS)
    assert json.loads(EXAMPLE.read_text()) == json.loads(
        json.dumps(body)
    ), "refresh with: python -m tests.test_fleet_holdings (then copy to the phone fixtures)"


# ── HTTP ──


class FakeReaders:
    def __init__(self, reads):
        self.reads, self.calls = reads, []

    def registered_bots(self, server):
        return list(self.reads) if server == "main" else None

    async def owner(self, bot, path, params):
        from condor.web.fleet_summary import OwnerRead

        self.calls.append((bot, path))
        read = self.reads[bot]
        return (
            OwnerRead(None, read)
            if isinstance(read, str)
            else OwnerRead(copy.deepcopy(read))
        )


@pytest.fixture
def client(monkeypatch):
    from fastapi import FastAPI

    from condor.web.auth import get_current_user
    from condor.web.routes import fleet_holdings as route
    from condor.web.routes import fleet_summary as summary_route

    readers = FakeReaders(example_reads())
    monkeypatch.setattr(summary_route, "READERS", readers)
    monkeypatch.setattr(route, "_cache", {})
    monkeypatch.setattr(route.time, "time", lambda: NOW_MS / 1000)

    class Access:
        def has_server_access(self, user, server):
            return server == "main"

    monkeypatch.setattr(route, "get_config_manager", lambda: Access())
    app = FastAPI()
    app.include_router(route.router, prefix="/api/v1")
    app.dependency_overrides[get_current_user] = lambda: type("U", (), {"id": 1})()
    transport = httpx.ASGITransport(app=app)
    return readers, httpx.AsyncClient(transport=transport, base_url="http://test")


def run(coro):
    return asyncio.run(coro)


def test_route_serves_every_registered_bot_from_its_quant_summary(client):
    readers, http = client
    response = run(http.get("/api/v1/servers/main/fleet/holdings"))
    assert response.status_code == 200
    body = response.json()
    assert body["schema"] == "fleet-holdings.v1" and body["served_at_ms"] == NOW_MS
    assert [b["bot"] for b in body["bots"]] == list(example_reads())
    assert {path for _, path in readers.calls} == {"quant-summary"}
    assert response.headers["cache-control"] == "private, no-store"
    offline = next(b for b in body["bots"] if b["bot"] == "offline_bot")
    assert (
        offline["state"] == "unavailable" and offline["reason"] == "SOURCE_UNAVAILABLE"
    )


def test_route_filters_one_bot_and_rejects_bad_queries(client):
    _, http = client
    one = run(
        http.get("/api/v1/servers/main/fleet/holdings", params={"bot": "meridian_v3"})
    ).json()
    assert [b["bot"] for b in one["bots"]] == ["meridian_v3"]
    assert (
        run(
            http.get("/api/v1/servers/main/fleet/holdings", params={"bot": "nope"})
        ).status_code
        == 404
    )
    assert (
        run(http.get("/api/v1/servers/main/fleet/holdings?bot=a&bot=b")).status_code
        == 400
    )
    assert (
        run(
            http.get("/api/v1/servers/main/fleet/holdings", params={"limit": "1"})
        ).status_code
        == 400
    )
    assert (
        run(
            http.get(
                "/api/v1/servers/main/fleet/holdings",
                params={"schema": "fleet-holdings.v0"},
            )
        ).status_code
        == 400
    )
    assert run(http.get("/api/v1/servers/other/fleet/holdings")).status_code == 404


if __name__ == "__main__":
    FIXTURES.mkdir(parents=True, exist_ok=True)
    EXAMPLE.write_text(
        json.dumps(
            h.build_holdings("main", example_reads(), NOW_MS), indent=2, sort_keys=True
        )
        + "\n"
    )
    print(f"wrote {EXAMPLE}")
