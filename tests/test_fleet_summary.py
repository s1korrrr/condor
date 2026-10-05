"""``fleet-summary.v1``: assembly, honest-null semantics, glance budget, ETag and the HTTP route."""

import asyncio
import copy
import functools
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from condor.performance_history import PerformanceHistory
from condor.web import fleet_summary as fs
from condor.web import market_verdict as mv
from condor.web.auth import get_current_user
from condor.web.models import WebUser
from condor.web.routes import fleet_summary as routes

FRAME = json.loads(
    (Path(__file__).parent / "fixtures" / "market-picture.240.fixture.json").read_text()
)
CUTOFF = FRAME["cutoff_ms"]
NOW_MS = CUTOFF + 30_000
NOW_S = NOW_MS / 1000
SERVER = "v2"
BOTS = ["ok_rsi", "rsi_modular_v2", "ok_rsi_paper"]


def sync(test):
    """Run an async test on its own loop (this suite has no async plugin)."""

    @functools.wraps(test)
    def wrapper(*args, **kwargs):
        return asyncio.run(test(*args, **kwargs))

    return wrapper


def iso(ms):
    return (
        datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )


def seed(store, bots=("ok_rsi", "rsi_modular_v2")):
    rows = {
        "ok_rsi": [(1439, 1, 0.5), (600, 2, 1), (1, 4, 2)],
        "rsi_modular_v2": [(300, 0, 0), (1, 1.5, 1.0)],
        "ok_rsi_paper": [(60, 5, 2), (1, 9, 4)],
    }
    with store._connect() as conn:
        for bot in bots:
            for minutes, total, realized in rows.get(bot, [(300, 0, 0), (1, 1, 0.5)]):
                conn.execute(
                    "INSERT INTO points VALUES (?,?,?,?,?,?,?,?,?)",
                    (
                        SERVER,
                        bot,
                        NOW_S - minutes * 60,
                        f"boot-{bot}",
                        f"seg-{bot}",
                        "USDC",
                        str(realized),
                        str(round(total - realized, 10)),
                        str(total),
                    ),
                )
    store.record_wallet(
        SERVER,
        {
            "ok_rsi": {
                "timestamp": NOW_S - 30,
                "currency": "USDC",
                "value_quote": "1000",
                "balances": [
                    {
                        "asset": "USDC",
                        "total": "600",
                        "available": "600",
                        "value": "600",
                    },
                    {
                        "asset": "ETH",
                        "total": "0.2",
                        "available": "0.2",
                        "value": "400",
                    },
                ],
            }
        },
        now=NOW_S,
    )


def quant_summary(bot, heartbeat_ms, pairs=None, open_cycles=2):
    return {
        "schema_version": "rsibot.quant_ops.v1",
        "execution_authorized": False,
        "generated_at": iso(NOW_MS - 1000),
        "scope": {"bot_key": bot, "execution_mode": "live"},
        "data": {
            "bot_id": bot,
            "heartbeat": iso(heartbeat_ms),
            "operational_label": "RUNNING",
            "pairs": (
                pairs
                if pairs is not None
                else [
                    {"pair": "ETH-USDC", "units": "1.2"},
                    {"pair": "BTC-USDC", "units": "0"},
                    {"pair": "SOL-USDC", "units": "3"},
                ]
            ),
            "cycle_counts": {"open": open_cycles},
        },
    }


def quant_cycles(bot):
    return {
        "bot_id": bot,
        "execution_authorized": False,
        "source": "executor_lifecycle",
        "quote_currency": "USDC",
        "cycle_counts": {"open": 1, "closed_scored": 3},
        "statistics": {"fill_count": 12, "fees_quote": "0.4200"},
        "cycles": [
            {
                "cycle_id": "c1",
                "outcome": "closed",
                "first_fill_at": iso(NOW_MS - 3600_000),
                "closed_at": iso(NOW_MS - 1800_000),
                "fill_count": 2,
            },
            {
                "cycle_id": "c2",
                "outcome": "closed",
                "first_fill_at": iso(NOW_MS - 3 * 86_400_000),
                "closed_at": iso(NOW_MS - 2 * 86_400_000),
                "fill_count": 2,
            },
            {
                "cycle_id": "c3",
                "outcome": "open",
                "first_fill_at": iso(NOW_MS - 600_000),
                "closed_at": None,
                "fill_count": 1,
            },
        ],
    }


def fills(bot, base):
    return {
        "rows": [
            {
                "fill_id": f"{bot}-1",
                "bot_name": bot,
                "pair": "ETH-USDC",
                "side": "BUY",
                "exact_amount": "0.1",
                "exact_price": "2000.5",
                "value_quote_exact": "200.05",
                "exact_trade_fee_in_quote": "0.2",
                # As reporting emits an admitted receipt (sqlite_reader._normalized_fills).
                "exact_receipt_source": "order_filled_event_v1",
                "receipt_precision": {"amount": "exact_decimal", "price": "exact_decimal", "fee_quote": "exact_decimal"},
                "timestamp": iso(base),
            },
            {
                "fill_id": f"{bot}-2",
                "bot_name": bot,
                "pair": "BTC-USDC",
                "side": "SELL",
                "amount_base": 0.01,
                "price_quote": 60000,
                "gross_volume_quote": 600,
                "fee_quote": 0.6,
                "receipt_precision": {"amount": "legacy_6dp", "price": "legacy_6dp", "fee_quote": "legacy_6dp"},
                "timestamp": iso(base - 60_000),
            },
            {
                "fill_id": "other",
                "bot_name": "someone_else",
                "pair": "X-Y",
                "timestamp": iso(base),
            },
        ]
    }


INCIDENTS = {
    "incident_store": {
        "state": "available",
        "generated_at": iso(NOW_MS - 5000),
        "detail": "ok",
        "monitor": {"state": "healthy", "last_cycle_at": iso(NOW_MS - 5000)},
        "incidents": [
            {"id": "1", "state": "open", "severity": "critical"},
            {"id": "2", "state": "open", "severity": "warning"},
            {"id": "3", "state": "resolved", "severity": "warning"},
        ],
    }
}


def market_items():
    return [
        {
            "cutoff_ms": CUTOFF - k * 60_000,
            "gap_before": False,
            "snapshot_id": "ab" * 32,
            "breadth": {h: {"pressure": "-0.4"} for h in mv.HORIZONS},
        }
        for k in range(60, 0, -1)
    ]


def bots_status():
    def bot(pnl):
        return {
            "status": "running",
            "performance": {
                "rsi_okx_ETH-USDC": {
                    "status": "running",
                    "performance": {
                        "realized_pnl_quote": pnl / 2,
                        "unrealized_pnl_quote": pnl / 2,
                        "global_pnl_quote": pnl,
                        "volume_traded": 10,
                    },
                }
            },
        }

    return {
        "data": {"ok_rsi": bot(3.5), "rsi_modular_v2": bot(1.5), "ok_rsi_paper": bot(9)}
    }


class FakeReaders:
    def __init__(
        self,
        store,
        *,
        registry=BOTS,
        status=True,
        market=True,
        owners=True,
        wallet=True,
    ):
        (
            self.store,
            self.registry,
            self.status,
            self.with_market,
            self.with_owners,
            self.with_wallet,
        ) = (store, registry, status, market, owners, wallet)
        self.calls = []

    def registered_bots(self, server):
        return list(self.registry) if self.registry is not None else None

    async def bots_status(self, server):
        return bots_status() if self.status else None

    def performance(self, server, bot, range_, now_s):
        return self.store.read(server, bot, range_, now_s)

    def wallet(self, server, bot, range_, now_s):
        if not self.with_wallet:
            raise OSError("wallet store unavailable")
        return self.store.read_wallet(server, bot, range_, now_s)

    async def market(self, server, user_id):
        if not self.with_market:
            return fs.MarketRead(reason=fs.FRAME_UNAVAILABLE)
        return fs.MarketRead(frame=copy.deepcopy(FRAME), history=market_items())

    async def owner(self, bot, path, params):
        self.calls.append((bot, path))
        if not self.with_owners:
            return fs.OwnerRead(None, fs.SOURCE_UNAVAILABLE)
        if path == "quant-summary":
            return fs.OwnerRead(
                quant_summary(
                    bot, NOW_MS - (60_000 if bot == "rsi_modular_v2" else 5_000)
                )
            )
        if path == "quant-cycles":
            return fs.OwnerRead(quant_cycles(bot))
        if path == "fills":
            return fs.OwnerRead(
                fills(bot, NOW_MS - (7 * 60_000 if bot == "ok_rsi" else 2 * 60_000))
            )
        if path == "operations":
            return fs.OwnerRead(INCIDENTS)
        raise AssertionError(path)


@pytest.fixture
def store(tmp_path):
    store = PerformanceHistory(tmp_path / "native-performance.sqlite3")
    seed(store, ("ok_rsi", "rsi_modular_v2", "ok_rsi_paper"))
    return store


async def build(store, view="full", *, admin=True, now_ms=NOW_MS, **kwargs):
    return await fs.build_fleet_summary(
        SERVER, view, FakeReaders(store, **kwargs), now_ms, is_admin=admin, user_id=7
    )


def card(body, bot):
    return next(c for c in body["bots"] if c["bot"] == bot)


@sync
async def test_full_summary_golden_numbers(store):
    body = await build(store)
    assert (
        body["schema_version"] == "fleet-summary.v1"
        and body["view"] == "full"
        and body["server"] == SERVER
    )
    assert body["generated_at_ms"] == NOW_MS

    assert body["wallet"] == {
        "equity": "1000",
        "unit": "USDC",
        "observed_at_ms": NOW_MS - 30_000,
        "source_bot": "ok_rsi",
        "valuation_complete": True,
        "stale": False,
    }

    pnl = body["pnl"]
    # ok_rsi day 1->4 = 3 (full 24h coverage); rsi_modular_v2 day 0->1.5 (starts 5h ago: partial). The paper bot is not capital.
    assert pnl["unit"] == "USDC"
    assert (
        pnl["day"]["total"] == "4.5"
        and pnl["day"]["realized"] == "2.5"
        and pnl["day"]["unrealized"] == "2"
    )
    assert (
        pnl["day"]["counted"] == 2
        and pnl["day"]["expected"] == 2
        and pnl["day"]["partial"] is True
        and pnl["day"]["missing"] == []
    )
    assert (
        pnl["week"]["total"] == "4.5"
        and pnl["month"]["total"] == "4.5"
        and pnl["all"]["total"] == "4.5"
    )
    assert [b["bot"] for b in pnl["day"]["bots"]] == ["ok_rsi", "rsi_modular_v2"]
    assert (
        pnl["day"]["since_ms"] == NOW_MS - 1439 * 60_000
        and pnl["day"]["latest_at_ms"] == NOW_MS - 60_000
    )

    # The verdict is the browser rule on the stored frame and history.
    expected = mv.market_verdict(
        mv.frame_from_raw(FRAME),
        "60",
        history=mv.history_from_items(market_items(), CUTOFF),
    )
    assert body["market"]["verdict"] == expected and expected["horizon_label"] == "1h"
    assert (
        body["market"]["frame"]["freshness"] == "fresh"
        and body["market"]["frame"]["cutoff_ms"] == CUTOFF
    )
    assert body["market"]["history_points"] == 60

    ok, v2, paper = (
        card(body, "ok_rsi"),
        card(body, "rsi_modular_v2"),
        card(body, "ok_rsi_paper"),
    )
    assert (
        ok["display_name"],
        ok["generation"],
        v2["display_name"],
        v2["generation"],
        paper["generation"],
    ) == ("V1 · ok_rsi", "V1", "rsi_modular_v2", "V2", None)
    assert ok["status"] == "running" and ok["controllers"] == 1
    assert ok["positions"] == {"held": 2, "registered": 3, "current": True}
    assert ok["executors"] == 1 and ok["executors_basis"] == "open_lifecycle_cycles"
    assert ok["report_at_ms"] == NOW_MS - 5000 and ok["report_stale"] is False
    assert (
        v2["report_stale"] is True
    )  # heartbeat 60s old: older than the 30s owner currency window
    assert ok["pnl_day"] == {
        "change": "3",
        "unit": "USDC",
        "partial": False,
        "stale": False,
    }
    assert v2["pnl_day"]["partial"] is True
    assert ok["net_now"] == {"value": "3.5", "unit": "USDC", "source": "controller"}
    assert ok["fees"] == {"amount": "0.42", "unit": "USDC"}
    assert ok["trades"] == {"lifetime": 12, "opened_24h": 2, "closed_24h": 1}
    assert (
        paper["paper"] is True
        and paper["pnl_day"] is None
        and {"field": "pnl_day", "reason": fs.PAPER_EXCLUDED} in paper["missing"]
    )
    assert all(
        m.get("bot") != "ok_rsi_paper" or m["field"] != "pnl_day"
        for m in body["missing"]
    ), "paper exclusion is not a data gap"

    assert [(f["bot"], f["fill_id"]) for f in body["fills"]][:3] == [
        ("rsi_modular_v2", "rsi_modular_v2-1"),
        ("rsi_modular_v2", "rsi_modular_v2-2"),
        ("ok_rsi", "ok_rsi-1"),
    ]
    assert (
        body["fills"][0]["price"] == "2000.5"
        and body["fills"][1]["volume"] == "600"
        and len(body["fills"]) == 4
        and all(f["fill_id"] != "other" for f in body["fills"])
    )

    assert (
        body["incidents"]["open"] == 2
        and body["incidents"]["critical"] == 1
        and body["incidents"]["state"] == "critical"
    )

    assert {name: s["status"] for name, s in body["sections"].items()} == {
        "wallet": "ok",
        "pnl": "partial",
        "market": "ok",
        "bots": "stale",
        "fills": "ok",
        "incidents": "ok",
    }
    assert body["sections"]["pnl"]["observed_at_ms"] == NOW_MS - 60_000
    assert body["sections"]["market"]["observed_at_ms"] == CUTOFF
    json.dumps(body, allow_nan=False)


@sync
async def test_nothing_is_invented_when_every_source_fails(store):
    body = await build(store, status=False, market=False, owners=False, wallet=False)
    assert (
        body["wallet"] is None
        and body["market"] is None
        and body["fills"] is None
        and body["incidents"] is None
    )
    assert (
        body["sections"]["wallet"]["status"] == "missing"
        and body["sections"]["market"]["reason"] == fs.FRAME_UNAVAILABLE
    )
    # PnL still comes from the stored history, which needs no live owner.
    assert body["pnl"]["day"]["total"] == "4.5"
    for c in body["bots"]:
        assert (
            c["status"] is None
            and c["positions"] is None
            and c["executors"] is None
            and c["fees"] is None
            and c["trades"] is None
        )
        assert {"field": "fees", "reason": fs.SOURCE_UNAVAILABLE} in c["missing"]
    reasons = {(m["section"], m.get("field"), m["reason"]) for m in body["missing"]}
    assert ("market", None, fs.FRAME_UNAVAILABLE) in reasons and (
        "wallet",
        None,
        fs.NO_REGISTRY,
    ) not in reasons
    assert ("fills", None, fs.SOURCE_UNAVAILABLE) in reasons and (
        "incidents",
        None,
        fs.SOURCE_UNAVAILABLE,
    ) in reasons
    assert "navailable" not in json.dumps(body).replace(
        "SOURCE_UNAVAILABLE", ""
    ).replace("FRAME_UNAVAILABLE", "").replace("HISTORY_UNAVAILABLE", "")


@sync
async def test_no_registry_falls_back_to_status_and_says_so(store):
    body = await build(store, registry=None)
    assert [c["bot"] for c in body["bots"]] == [
        "ok_rsi",
        "rsi_modular_v2",
        "ok_rsi_paper",
    ]
    assert {"section": "bots", "reason": fs.REGISTRY_FROM_STATUS} in body["missing"]
    empty = await build(store, registry=None, status=False)
    assert (
        empty["bots"] == []
        and empty["pnl"] is None
        and empty["sections"]["bots"]["reason"] == fs.NO_REGISTRY
        and empty["sections"]["pnl"]["reason"] == fs.NO_REGISTRY
    )


@sync
async def test_incidents_are_admin_only(store):
    readers = FakeReaders(store)
    body = await fs.build_fleet_summary(
        SERVER, "full", readers, NOW_MS, is_admin=False, user_id=7
    )
    assert (
        body["incidents"] is None
        and body["sections"]["incidents"]["reason"] == fs.FORBIDDEN
    )
    assert not [
        call for call in readers.calls if call[1] == "operations"
    ], "a non-admin never triggers the operations read"


@sync
async def test_staleness_is_flagged_not_hidden(store):
    body = await build(store, now_ms=NOW_MS + 10 * 60_000)
    assert (
        body["wallet"]["stale"] is True
        and body["sections"]["wallet"]["status"] == "stale"
    )
    assert (
        body["pnl"]["day"]["stale"] is True
        and body["sections"]["pnl"]["status"] == "stale"
    )
    assert (
        body["market"]["frame"]["freshness"] == "stale"
        and body["sections"]["market"]["status"] == "stale"
    )
    assert (
        body["wallet"]["equity"] == "1000"
    ), "the last known value stays visible next to its stale flag"


@sync
async def test_market_history_failure_degrades_the_verdict_honestly(store):
    class NoHistory(FakeReaders):
        async def market(self, server, user_id):
            return fs.MarketRead(
                frame=copy.deepcopy(FRAME), history_reason=fs.HISTORY_UNAVAILABLE
            )

    body = await fs.build_fleet_summary(
        SERVER, "full", NoHistory(store), NOW_MS, is_admin=True
    )
    assert (
        body["market"]["history_points"] is None
        and body["market"]["verdict"]["smoothed"] is False
    )
    assert {
        "section": "market",
        "field": "history",
        "reason": fs.HISTORY_UNAVAILABLE,
    } in body["missing"]
    assert body["sections"]["market"]["status"] == "partial"


@sync
async def test_unusable_frame_gives_a_null_market_with_a_reason(store):
    class Warming(FakeReaders):
        async def market(self, server, user_id):
            warming = json.loads(
                (
                    Path(__file__).parent / "fixtures" / "market-picture.v1.json"
                ).read_text()
            )
            return fs.MarketRead(frame=warming, history=[])

    body = await fs.build_fleet_summary(
        SERVER, "full", Warming(store), NOW_MS, is_admin=True
    )
    assert (
        body["market"] is None
        and body["sections"]["market"]["reason"] == fs.NO_COMPONENTS
    )
    assert {
        "section": "market",
        "field": "verdict",
        "reason": fs.NO_COMPONENTS,
    } in body["missing"]


@sync
async def test_glance_is_a_consistent_compact_projection(store):
    full, glance = await build(store), await build(store, "glance")
    assert (
        glance["view"] == "glance"
        and glance["schema_version"] == full["schema_version"]
    )
    assert glance["wallet"] == full["wallet"] and glance["sections"] == full["sections"]
    for name in ("day", "week", "month", "all"):
        assert glance["pnl"][name] == {
            k: full["pnl"][name][k]
            for k in ("total", "partial", "counted", "expected", "stale", "uncovered_ms")
        }
    verdict = full["market"]["verdict"]
    assert (
        glance["market"]["state"] == verdict["state"]
        and glance["market"]["score"] == verdict["score"]
    )
    assert len(glance["fills"]) == 3 and [f["fill_id"] for f in full["fills"][:3]] == [
        f"{f['bot']}-{n}" for f, n in zip(full["fills"][:3], (1, 2, 1))
    ]
    assert glance["incidents"] == {"state": "critical", "open": 2, "critical": 1}
    assert [b["bot"] for b in glance["bots"]] == [b["bot"] for b in full["bots"]]


@sync
async def test_glance_stays_under_the_watch_budget_even_with_many_bots(store):
    names = [f"bot_v2_{n:02d}" for n in range(38)] + ["ok_rsi", "ok_rsi_paper"]
    seed(store, names[:12])
    # Worst case for size: every owner read fails, so `missing` is as long as it can get.
    body = await build(
        store, "glance", registry=names, owners=False, market=False, wallet=False
    )
    size = len(fs.canonical_json(body))
    assert size < 8192, size
    assert len(body["bots"]) == fs.GLANCE_MAX_BOTS and body["bots_total"] == 40
    assert (
        len(body["missing"]) == fs.GLANCE_MAX_MISSING
        and body["missing_total"] > fs.GLANCE_MAX_MISSING
    )
    # With the Watch-sized fleet and everything healthy the payload is far below the budget.
    healthy = await build(store, "glance")
    assert len(fs.canonical_json(healthy)) < 4096 and healthy["bots_total"] == 3


@sync
async def test_etag_tracks_data_not_the_clock(store):
    first, again = await build(store), await build(store, now_ms=NOW_MS + 1000)
    assert first["generated_at_ms"] != again["generated_at_ms"]
    assert fs.etag_for(first) == fs.etag_for(again)
    changed = copy.deepcopy(first)
    changed["pnl"]["day"]["total"] = "5"
    assert fs.etag_for(changed) != fs.etag_for(first)
    assert fs.etag_for(first).startswith('"') and len(fs.etag_for(first)) == 66


@sync
async def test_example_payloads_are_the_builders_output(store):
    """The documented examples (and the frontend client test's inputs) are real builder output, never hand-edited.

    Regenerate with FLEET_SUMMARY_WRITE_EXAMPLES=1 after an intentional contract change.
    """
    for view in ("full", "glance"):
        body = await build(store, view)
        path = (
            Path(__file__).parent
            / "fixtures"
            / "fleet_summary"
            / f"summary_{view}.example.json"
        )
        if os.environ.get("FLEET_SUMMARY_WRITE_EXAMPLES") == "1":
            path.write_text(json.dumps(body, indent=1, ensure_ascii=False) + "\n")
        assert json.loads(path.read_text()) == body, f"{path.name} is stale"


def test_names_and_generations():
    assert (
        fs.display_name("ok_rsi") == "V1 · ok_rsi"
        and fs.display_name("rsi_v5") == "RSI v5"
        and fs.display_name("meridian_v3") == "meridian_v3"
    )
    assert [
        fs.generation(b)
        for b in ("ok_rsi", "rsi_v5", "rsi_modular_v2", "meridian_v3", "mystery")
    ] == ["V1", "V1", "V2", "V3", None]
    assert (
        fs.is_paper("ok_rsi_paper")
        and fs.is_paper("paper-v2")
        and not fs.is_paper("papermill")
    )


# ── HTTP ──


class Config:
    def has_server_access(self, user_id, name):
        return name == SERVER and user_id == 7

    def is_admin(self, user_id):
        return user_id == 7


def client_for(monkeypatch, store, *, authenticated=True):
    monkeypatch.setattr(routes, "get_config_manager", lambda: Config())
    monkeypatch.setattr(routes, "READERS", FakeReaders(store))
    monkeypatch.setattr(routes, "CACHE_TTL_SECONDS", 0)
    monkeypatch.setattr(routes.time, "time", lambda: NOW_S)
    routes._cache.clear()
    app = FastAPI()
    app.include_router(routes.router, prefix="/api/v1")
    if authenticated:
        app.dependency_overrides[get_current_user] = lambda: WebUser(id=7, role="admin")
    return TestClient(app)


def test_route_requires_authentication_and_server_access(monkeypatch, store):
    anonymous = client_for(monkeypatch, store, authenticated=False)
    assert anonymous.get(f"/api/v1/servers/{SERVER}/fleet/summary").status_code in {
        401,
        403,
    }
    client = client_for(monkeypatch, store)
    assert client.get("/api/v1/servers/other/fleet/summary").status_code == 404
    assert FakeReaders(store).calls == []


@pytest.mark.parametrize(
    "query", ["view=huge", "view=full&view=glance", "foo=1", "schema=fleet-summary.v2"]
)
def test_route_rejects_unsupported_queries(monkeypatch, store, query):
    assert (
        client_for(monkeypatch, store)
        .get(f"/api/v1/servers/{SERVER}/fleet/summary?{query}")
        .status_code
        == 400
    )


def test_route_serves_full_and_glance_with_a_validator(monkeypatch, store):
    client = client_for(monkeypatch, store)
    response = client.get(f"/api/v1/servers/{SERVER}/fleet/summary")
    assert response.status_code == 200
    assert response.headers["X-Fleet-Summary-Schema"] == "fleet-summary.v1"
    assert response.headers[
        "Cache-Control"
    ] == "private, no-cache" and response.headers["ETag"].startswith('"')
    body = response.json()
    assert (
        body["view"] == "full"
        and body["pnl"]["day"]["total"] == "4.5"
        and body["incidents"]["open"] == 2
    )

    again = client.get(
        f"/api/v1/servers/{SERVER}/fleet/summary",
        headers={"If-None-Match": response.headers["ETag"]},
    )
    assert (
        again.status_code == 304
        and again.content == b""
        and again.headers["ETag"] == response.headers["ETag"]
    )
    stale = client.get(
        f"/api/v1/servers/{SERVER}/fleet/summary", headers={"If-None-Match": '"nope"'}
    )
    assert stale.status_code == 200

    glance = client.get(
        f"/api/v1/servers/{SERVER}/fleet/summary?view=glance&schema=fleet-summary.v1"
    )
    assert (
        glance.status_code == 200
        and glance.json()["view"] == "glance"
        and len(glance.content) < 8192
    )
    assert glance.headers["ETag"] != response.headers["ETag"]


def test_route_micro_cache_serves_a_burst_from_one_computation(monkeypatch, store):
    client = client_for(monkeypatch, store)
    monkeypatch.setattr(routes, "CACHE_TTL_SECONDS", 60)
    readers = routes.READERS
    first = client.get(f"/api/v1/servers/{SERVER}/fleet/summary?view=glance")
    calls = len(readers.calls)
    second = client.get(f"/api/v1/servers/{SERVER}/fleet/summary?view=glance")
    assert first.content == second.content and len(readers.calls) == calls and calls > 0


@sync
async def test_a_recording_gap_makes_pnl_incomplete_even_with_full_coverage(tmp_path):
    # Contract (fleet-summary-v1.md `gaps`): a window with an unrecorded stretch is incomplete. Every bot
    # covers every window here, so only the 5 h day gap can make the section partial.
    store = PerformanceHistory(tmp_path / "gapped.sqlite3")
    rows = []
    for bot in BOTS:
        for minutes in range(41 * 1440, 0, -1):
            if bot == "rsi_modular_v2" and 300 <= minutes <= 600:
                continue
            total = 1 + minutes / 1e5
            rows.append((SERVER, bot, NOW_S - minutes * 60, f"boot-{bot}", f"seg-{bot}", "USDC",
                         str(total / 2), str(total / 2), str(total)))
    with store._connect() as conn:
        conn.executemany("INSERT INTO points VALUES (?,?,?,?,?,?,?,?,?)", rows)
    body = await build(store)
    day = body["pnl"]["day"]
    assert day["counted"] == day["expected"] == 2 and day["partial"] is False, "both live bots cover the day (paper is not in fleet PnL)"
    assert [gap["bot"] for gap in day["gaps"]] == ["rsi_modular_v2"]
    assert all(
        body["pnl"][name]["counted"] == 2 and not body["pnl"][name]["partial"] for name in ("week", "month")
    ), "every window is fully covered; only the unrecorded stretch is incomplete"
    assert body["sections"]["pnl"]["status"] == "partial"
    assert day["uncovered_ms"] == day["gaps"][0]["uncovered_ms"] > 0
    glance = await build(store, "glance")
    assert glance["sections"]["pnl"]["status"] == "partial"
    # The glance carries no `gaps` list: each window's own unrecorded total is what the Watch can show.
    assert glance["pnl"]["day"]["uncovered_ms"] == day["uncovered_ms"]


@sync
async def test_an_older_gap_leaves_the_current_day_complete(tmp_path):
    # A gap two days ago is incomplete for the week, month and all windows only; the day is fully observed.
    store = PerformanceHistory(tmp_path / "old-gap.sqlite3")
    rows = []
    for bot in BOTS:
        for minutes in range(41 * 1440, 0, -1):
            if bot == "rsi_modular_v2" and 2 * 1440 <= minutes <= 2 * 1440 + 300:
                continue
            total = 1 + minutes / 1e5
            rows.append((SERVER, bot, NOW_S - minutes * 60, f"boot-{bot}", f"seg-{bot}", "USDC",
                         str(total / 2), str(total / 2), str(total)))
    with store._connect() as conn:
        conn.executemany("INSERT INTO points VALUES (?,?,?,?,?,?,?,?,?)", rows)
    for view in ("full", "glance"):
        pnl = (await build(store, view))["pnl"]
        assert pnl["day"]["uncovered_ms"] == 0 and not pnl["day"]["partial"], view
        assert all(pnl[name]["uncovered_ms"] > 0 for name in ("week", "month", "all")), view
