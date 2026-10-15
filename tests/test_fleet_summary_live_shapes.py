"""``fleet-summary.v1`` against the response shapes a LIVE deployment publishes (synthesized, not captured).

The first version of the summary was written against fakes of the quant endpoints. A live stack differs:

* a V1 bot (``ok_rsi``) publishes bootstrap, fills and positions only: no ``quant-summary`` / ``quant-cycles``;
* a V3 bot publishes quant projections whose scope is unverified (``operational_label`` ``UNKNOWN``, no pairs, quote
  ``unknown``, no fees) and a runtime report with one controller row per pair that carries no per-pair inventory;
* every bot has a ``bootstrap`` runtime observation (controllers, held positions, active executors) that the Bots
  page reads for inventory and executors.

Each case below states the number a reader should see and the honest null it should not invent.
"""

import asyncio
import copy
import json
from pathlib import Path

import httpx
from fastapi import HTTPException

from condor.web import fleet_summary as fs
from condor.web.routes import fleet_summary as routes
from condor.web.routes import trading_visuals

from tests.test_fleet_summary import (  # noqa: F401  (store is a fixture)
    NOW_MS,
    SERVER,
    FakeReaders,
    card,
    client_for,
    fills,
    iso,
    quant_cycles,
    quant_summary,
    store,
    sync,
)

LIVE_BOTS = ["ok_rsi", "meridian_v3", "rsi_modular_v2"]


def runtime(bot, controllers, *, positions=(), active=(), age_s=4, **extra):
    return {
        "runtime_status": {
            "bot_name": bot,
            "updated_at": iso(NOW_MS - age_s * 1000),
            "controllers": controllers,
            "positions_held": list(positions),
            "active_executors": list(active),
            **extra,
        },
        "monitoring": {"bot_name": bot, "stale_threshold_seconds": 180.0},
    }


def controller(ident, pair, **extra):
    return {
        "controller_id": ident,
        "pair": pair,
        "observation_status": "available",
        "custom_info": {},
        **extra,
    }


def v1_bootstrap():
    return runtime(
        "ok_rsi",
        [
            controller("ok-rsi-bnb", "BNB-USDC"),
            controller("ok-rsi-eth", "ETH-USDC"),
            controller("ok-rsi-sol", "SOL-USDC"),
        ],
        positions=[
            {"controller_id": "ok-rsi-bnb", "pair": "BNB-USDC", "amount_base": 0.7},
            {"controller_id": "ok-rsi-eth", "pair": "ETH-USDC", "amount_base": 0.2},
        ],
    )


def v3_bootstrap():
    shared = {
        "controller_id": "m3-unified",
        "observation_status": "unavailable",
        "pair_projection_source": "native_owner_symbols",
        "custom_info": {},
    }
    executors = [
        {
            "executor_id": f"x{i}",
            "pair": pair,
            "controller_id": "m3-unified",
            "side": "buy",
            "executor_type": "position",
            "remaining_position_amount_base": "0.5",
        }
        for i, pair in enumerate(("BNB-USDC", "ETH-USDC", "SOL-USDC"))
    ]
    return runtime(
        "meridian_v3",
        [dict(shared, pair=p) for p in ("BNB-USDC", "ETH-USDC", "SOL-USDC")],
        active=executors,
    )


def v2_bootstrap():
    return runtime(
        "rsi_modular_v2",
        [
            controller(
                "c1",
                "ETH-USDC",
                custom_info={"episode": {"enabled": True, "base": "1.5"}},
            ),
            controller("c2", "BTC-USDC"),
        ],
    )


def v3_summary():
    body = quant_summary("meridian_v3", NOW_MS - 3_000, pairs=[])
    body["data"]["operational_label"] = "UNKNOWN"
    return body


def v3_cycles():
    body = quant_cycles("meridian_v3")
    body["quote_currency"] = "unknown"
    body["cycle_counts"] = {"open": 3, "closed_scored": 4}
    body["statistics"] = {"fill_count": 22, "fees_quote": None}
    return body


class LiveShapeReaders(FakeReaders):
    def __init__(self, store, **kwargs):
        super().__init__(store, registry=LIVE_BOTS, **kwargs)
        self.ledger_rows = None

    async def owner(self, bot, path, params):
        self.calls.append((bot, path))
        ledger = lambda base: fills(bot, base)  # noqa: E731
        if path == "bootstrap":
            return fs.OwnerRead(
                {
                    "ok_rsi": v1_bootstrap,
                    "meridian_v3": v3_bootstrap,
                    "rsi_modular_v2": v2_bootstrap,
                }[bot]()
            )
        if path == "fills":
            payload = ledger(NOW_MS - 120_000)
            if self.ledger_rows is not None:
                payload["rows"] = payload["rows"][: self.ledger_rows]
            return fs.OwnerRead(payload)
        if bot == "ok_rsi" and path in ("quant-summary", "quant-cycles"):
            return fs.OwnerRead(None, fs.SOURCE_UNAVAILABLE)  # V1 publishes no quant endpoints
        if bot == "meridian_v3" and path == "quant-summary":
            return fs.OwnerRead(v3_summary())
        if bot == "meridian_v3" and path == "quant-cycles":
            return fs.OwnerRead(v3_cycles())
        return await super().owner(bot, path, params)


async def build_live(store, view="full", **kwargs):
    readers = LiveShapeReaders(store, **kwargs)
    return await fs.build_fleet_summary(
        SERVER, view, readers, NOW_MS, is_admin=True, user_id=7
    )


@sync
async def test_v1_without_quant_endpoints_is_filled_from_runtime_and_fill_ledger(store):
    body = await build_live(store)
    v1 = card(body, "ok_rsi")
    assert v1["positions"] == {"held": 2, "registered": 3, "current": True}
    assert (v1["executors"], v1["executors_basis"]) == (0, "runtime_active_executors")
    assert v1["fees"] == {"amount": "0.8", "unit": "USDC"}
    # No lifecycle projection: the 24h cycle counts are unknown, never zero.
    assert v1["trades"] == {"lifetime": 2, "opened_24h": None, "closed_24h": None}
    assert v1["report_at_ms"] == NOW_MS - 4_000 and v1["report_stale"] is False
    assert [g for g in v1["missing"] if g["field"] != "pnl_day"] == []
    assert not [m for m in body["missing"] if m.get("bot") == "ok_rsi" and m.get("section") == "bots" and m["field"] != "pnl_day"]


@sync
async def test_v3_with_unverified_quant_keeps_unknown_inventory_null_but_counts_executors_and_fees(store):
    v3 = card(await build_live(store), "meridian_v3")
    # Per-pair inventory is not in the native runtime report: held is unknown, not zero.
    assert v3["positions"] is None
    assert {"field": "positions", "reason": fs.SOURCE_UNAVAILABLE} in v3["missing"]
    assert (v3["executors"], v3["executors_basis"]) == (3, "runtime_active_executors")
    # Cycles publish no fees and an unknown quote: the fill ledger supplies both.
    assert v3["fees"] == {"amount": "0.8", "unit": "USDC"}
    assert v3["trades"]["lifetime"] == 22 and v3["trades"]["opened_24h"] == 2
    assert not [g for g in v3["missing"] if g["field"] in ("fees", "trades", "executors")]


@sync
async def test_episode_bag_and_flat_pairs_count_held_inventory(store):
    v2 = card(await build_live(store), "rsi_modular_v2")
    assert v2["positions"] == {"held": 1, "registered": 2, "current": True}
    assert v2["fees"] == {"amount": "0.42", "unit": "USDC"}  # cycles stay the first source


@sync
async def test_a_stale_runtime_observation_is_labelled_and_lifecycle_executors_win(store):
    class Stale(LiveShapeReaders):
        async def owner(self, bot, path, params):
            if path == "bootstrap" and bot == "rsi_modular_v2":
                return fs.OwnerRead(
                    runtime(
                        bot, [controller("c1", "ETH-USDC")], age_s=100, active=[]
                    )
                )
            return await super().owner(bot, path, params)

    body = await fs.build_fleet_summary(
        SERVER, "full", Stale(store), NOW_MS, is_admin=True, user_id=7
    )
    v2 = card(body, "rsi_modular_v2")
    assert v2["positions"]["current"] is False
    assert v2["executors_basis"] == "open_lifecycle_cycles"


@sync
async def test_a_runtime_observation_of_another_bot_is_not_admitted(store):
    class Mixed(LiveShapeReaders):
        async def owner(self, bot, path, params):
            if path == "bootstrap" and bot == "ok_rsi":
                return fs.OwnerRead(v3_bootstrap())  # identity mismatch
            return await super().owner(bot, path, params)

    body = await fs.build_fleet_summary(
        SERVER, "full", Mixed(store), NOW_MS, is_admin=True, user_id=7
    )
    v1 = card(body, "ok_rsi")
    assert v1["positions"] is None and v1["executors"] is None
    assert {g["field"] for g in v1["missing"]} >= {"positions", "executors"}


@sync
async def test_a_fill_ledger_cut_at_the_page_limit_is_never_a_lifetime_total(store, monkeypatch):
    monkeypatch.setattr(fs, "OWNER_FILL_LIMIT", 2)  # the synthesized ledger has 2 rows of its own bot
    v1 = card(await build_live(store), "ok_rsi")
    assert v1["fees"] is None and v1["trades"] is None
    assert {"field": "fees", "reason": fs.INVALID} in v1["missing"]
    assert {"field": "trades", "reason": fs.INVALID} in v1["missing"]


@sync
async def test_a_ledger_row_without_a_fee_leaves_fees_null_but_keeps_the_count(store):
    class NoFee(LiveShapeReaders):
        async def owner(self, bot, path, params):
            result = await super().owner(bot, path, params)
            if path == "fills" and bot == "ok_rsi":
                result = fs.OwnerRead(copy.deepcopy(result.payload))
                del result.payload["rows"][0]["exact_trade_fee_in_quote"]
            return result

    body = await fs.build_fleet_summary(
        SERVER, "full", NoFee(store), NOW_MS, is_admin=True, user_id=7
    )
    v1 = card(body, "ok_rsi")
    assert v1["fees"] is None and v1["trades"]["lifetime"] == 2


@sync
async def test_recent_fills_come_from_the_wide_ledger_read_and_exclude_paper(store):
    body = await build_live(store)
    assert body["sections"]["fills"]["status"] == "ok"
    assert len(body["fills"]) == 6  # 2 rows x 3 live bots, newest first, "other" rows dropped
    readers = LiveShapeReaders(store)
    await fs.build_fleet_summary(SERVER, "glance", readers, NOW_MS, is_admin=True, user_id=7)
    assert ("ok_rsi", "bootstrap") in readers.calls and ("ok_rsi", "fills") in readers.calls


# ── the live readers: the same authenticated mechanism the trading-visuals proxy uses ──


SOURCES = {
    "ok_rsi": {
        "server": "v2",
        "url": "http://127.0.0.1:8000/trading-visuals",
        "username_env": "TEST_NATIVE_USER",
        "password_env": "TEST_NATIVE_PASS",
    },
    "rsi_modular_v2": {"server": "v2", "url": "http://127.0.0.1:8000/trading-visuals"},
}


def serve(monkeypatch, handler):
    monkeypatch.setattr(trading_visuals, "_sources", lambda: SOURCES)
    monkeypatch.setattr(
        trading_visuals,
        "_client",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


def test_live_owner_read_sends_the_proxys_basic_auth_path_and_bot_scope(monkeypatch):
    monkeypatch.setenv("TEST_NATIVE_USER", "reader")
    monkeypatch.setenv("TEST_NATIVE_PASS", "not-a-real-secret")
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"rows": []})

    serve(monkeypatch, handler)
    read = asyncio.run(routes.LiveReaders().owner("ok_rsi", "fills", {"limit": "500"}))
    assert read.payload == {"rows": []} and read.reason is None
    request = seen[0]
    assert request.url.path == "/trading-visuals/fills"
    assert dict(request.url.params) == {"bot": "ok_rsi", "limit": "500"}
    assert request.headers["authorization"].startswith("Basic ")


def test_live_owner_read_reasons_are_honest(monkeypatch):
    monkeypatch.setenv("TEST_NATIVE_USER", "reader")
    monkeypatch.setenv("TEST_NATIVE_PASS", "not-a-real-secret")
    serve(
        monkeypatch,
        lambda request: httpx.Response(404 if "quant" in request.url.path else 200, json={}),
    )
    live = routes.LiveReaders()
    assert asyncio.run(live.owner("ok_rsi", "quant-summary", {})).reason == fs.SOURCE_UNAVAILABLE
    assert asyncio.run(live.owner("unregistered", "fills", {})).reason == fs.NOT_CONFIGURED

    def broken():
        raise HTTPException(503, "invalid")

    monkeypatch.setattr(trading_visuals, "_sources", broken)
    assert asyncio.run(live.owner("ok_rsi", "fills", {})).reason == fs.NOT_CONFIGURED


def test_the_proxy_and_the_summary_share_one_credential_helper(monkeypatch):
    monkeypatch.setenv("TEST_NATIVE_USER", "reader")
    monkeypatch.setenv("TEST_NATIVE_PASS", "not-a-real-secret")
    assert trading_visuals.source_auth(SOURCES["rsi_modular_v2"]) is None
    assert isinstance(trading_visuals.source_auth(SOURCES["ok_rsi"]), httpx.BasicAuth)


# ── one computation serves both views ──


def test_glance_and_full_share_one_computation_inside_the_cache_window(monkeypatch, store):
    client = client_for(monkeypatch, store)
    monkeypatch.setattr(routes, "CACHE_TTL_SECONDS", 60)
    readers = routes.READERS
    glance = client.get(f"/api/v1/servers/{SERVER}/fleet/summary?view=glance")
    calls = len(readers.calls)
    full = client.get(f"/api/v1/servers/{SERVER}/fleet/summary")
    assert glance.status_code == full.status_code == 200 and calls > 0
    assert len(readers.calls) == calls  # the full view did not read the owners again
    assert glance.json()["market"] is not None and full.json()["market"] is not None
    assert glance.json()["generated_at_ms"] == full.json()["generated_at_ms"]
    assert glance.headers["ETag"] != full.headers["ETag"]



def _v3_fixture(name):
    return json.loads(
        (Path(__file__).parent / "fixtures" / "fleet_summary" / name).read_text()
    )


def test_owner_coverage_not_the_unknown_label_admits_a_current_v3_summary():
    # Real reporting envelope: the unified controller publishes no per-pair state, so the label stays UNKNOWN
    # while the owner admits the source through `coverage`. Shared with the browser test (quant-roster).
    admitted = _v3_fixture("quant_summary_meridian_v3_admitted.json")
    assert admitted["data"]["operational_label"] == "UNKNOWN"
    clock = fs._instant_ms(admitted["generated_at"]) + 1_000
    view = fs.project_quant_summary(admitted, "meridian_v3", clock)
    assert view["admitted"] is True
    assert [p["pair"] for p in view["pairs"]] == ["BNB-USDC", "BTC-USDC", "ETH-USDC", "SOL-USDC", "XRP-USDC"]
    assert all(p["held"] for p in view["pairs"])
    assert view["open_cycles"] == 10
    stale = fs.project_quant_summary(admitted, "meridian_v3", clock + 120_000)
    assert stale["admitted"] is False and stale["pairs"] == []


def test_an_owner_declared_unverified_scope_stays_unadmitted():
    unverified = _v3_fixture("quant_summary_meridian_v3_unverified.json")
    clock = fs._instant_ms(unverified["generated_at"]) + 1_000
    forged = copy.deepcopy(unverified)
    forged["data"]["operational_label"] = "HOLDING"
    forged["data"]["pairs"] = [{"pair": "ETH-USDC", "units": "1"}]
    for payload in (unverified, forged):
        view = fs.project_quant_summary(payload, "meridian_v3", clock)
        assert view["current"] is True and view["admitted"] is False and view["pairs"] == []
