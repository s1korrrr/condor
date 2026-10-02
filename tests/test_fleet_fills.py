"""``fleet-fills.v1``: one ordered, bot-labelled fills feed over V1, V2 and V3, and the HTTP route.

The three generations publish the same reporting fill row in different completeness:

* V1 (``ok_rsi``, an older reporting image) carries ``exact_*: null`` beside 6-decimal legacy values and no
  ``receipt_precision`` / ``economics_*`` fields;
* V2 (``rsi_modular_v2``) carries exact receipt strings;
* V3 (``meridian_v3``) carries exact receipts plus execution metadata.
"""

import asyncio
import base64
import copy
import functools
import json
import os
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from condor.web import fleet_fills as ff
from condor.web import fleet_summary as fs
from condor.web.auth import get_current_user
from condor.web.models import WebUser
from condor.web.routes import fleet_fills as route
from condor.web.routes import fleet_summary as summary_route

SERVER = "v2"
T0 = 1_800_000_000_000  # newest instant in the fixtures
BOTS = ["ok_rsi", "rsi_modular_v2", "meridian_v3"]
FIXTURES = Path(__file__).parent / "fixtures" / "fleet_fills"


def sync(test):
    @functools.wraps(test)
    def wrapper(*args, **kwargs):
        return asyncio.run(test(*args, **kwargs))

    return wrapper


def iso(ms):
    from datetime import datetime, timezone

    return (
        datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )


def v1_row(n, ms, *, pair="BNB-USDC", side="buy", **extra):
    """An older reporting image: no exact receipts, no precision/economics fields."""
    row = {
        "fill_id": f"v1-{n}",
        "order_id": f"v1-order-{n}",
        "bot_name": "ok_rsi",
        "source_db_id": "db-v1",
        "connector_name": "okx",
        "pair": pair,
        "side": side,
        "order_type": "MARKET",
        "amount_base": 0.123456,
        "price_quote": 600.5,
        "gross_volume_quote": 74.1,
        "fee_quote": 0.0741,
        "exact_amount": None,
        "exact_price": None,
        "exact_trade_fee_in_quote": None,
        "exact_receipt_source": None,
        "timestamp": iso(ms),
    }
    return row | extra


def v2_row(n, ms, *, pair="ETH-USDC", side="sell", **extra):
    row = {
        "schema_version": 1,
        "fill_id": f"v2-{n}",
        "order_id": f"v2-order-{n}",
        "bot_name": "rsi_modular_v2",
        "source_db_id": "db-v2",
        "connector_name": "okx",
        "pair": pair,
        "side": side,
        "order_type": "LIMIT",
        "exact_amount": "0.0105",
        "exact_price": "2000.50",
        "exact_trade_fee_in_quote": "0.02100525",
        "exact_receipt_source": "okx_fills",
        "value_quote_exact": "21.00525",
        "gross_volume_quote_decimal": "21.00525",
        "amount_base": 0.0105,
        "price_quote": 2000.5,
        "gross_volume_quote": 21.00525,
        "fee_quote": 0.02100525,
        "economics_available": True,
        "economics_status": "AVAILABLE",
        "receipt_precision": {"amount": "exact_decimal"},
        "simulated": False,
        "timestamp": iso(ms),
    }
    return row | extra


def v3_row(n, ms, *, pair="SOL-USDC", side="buy", **extra):
    row = v2_row(n, ms, pair=pair, side=side) | {
        "fill_id": f"v3-{n}",
        "order_id": f"v3-order-{n}",
        "bot_name": "meridian_v3",
        "source_db_id": "db-v3",
        "exact_amount": "1.5",
        "exact_price": "140.25",
        "exact_trade_fee_in_quote": "0.21",
        "value_quote_exact": "210.375",
        "gross_volume_quote_decimal": "210.375",
        "execution_mode": "live",
        "strategy_name": "meridian_v3",
    }
    return v2_row(n, ms) | row | extra


def default_rows():
    return {
        "ok_rsi": [v1_row(1, T0 - 10_000), v1_row(2, T0 - 130_000, side="sell")],
        "rsi_modular_v2": [v2_row(1, T0 - 20_000), v2_row(2, T0 - 70_000, side="buy")],
        "meridian_v3": [v3_row(1, T0 - 5_000), v3_row(2, T0 - 100_000, side="sell")],
    }


class Readers:
    """The feed's reader surface. ``payloads`` maps bot -> rows | OwnerRead | Exception."""

    def __init__(self, payloads=None, registry=BOTS, status=None):
        self.payloads = default_rows() if payloads is None else payloads
        self.registry = registry
        self.status = status
        self.calls = []

    def registered_bots(self, server):
        return list(self.registry) if self.registry is not None else None

    async def bots_status(self, server):
        return self.status

    async def owner(self, bot, path, params):
        self.calls.append((bot, path, dict(params)))
        assert path == "fills"
        value = self.payloads.get(bot, fs.OwnerRead(None, fs.NOT_CONFIGURED))
        if isinstance(value, Exception):
            raise value
        if isinstance(value, fs.OwnerRead):
            return value
        return fs.OwnerRead({"schema_version": 1, "rows": copy.deepcopy(value)})


async def window(readers=None, **kwargs):
    return await ff.read_window(SERVER, readers or Readers(), T0 + 1000, **kwargs)


async def page(readers=None, **query):
    return ff.build_page(await window(readers), **query)


def ids(body):
    return [item["id"] for item in body["items"]]


# ── merge, labels, normalisation ──


@sync
async def test_all_three_generations_merge_newest_first_with_bot_labels():
    body = await page()
    assert body["schema_version"] == "fleet-fills.v1" and body["server"] == SERVER
    assert [(i["bot"], i["fill_id"]) for i in body["items"]] == [
        ("meridian_v3", "v3-1"),
        ("ok_rsi", "v1-1"),
        ("rsi_modular_v2", "v2-1"),
        ("rsi_modular_v2", "v2-2"),
        ("meridian_v3", "v3-2"),
        ("ok_rsi", "v1-2"),
    ]
    assert body["status"] == "ok" and body["partial"] is False and body["reason"] is None
    assert body["matched"] == 6 and body["has_more"] is False and body["next_cursor"] is None
    labels = {i["bot"]: (i["display_name"], i["generation"]) for i in body["items"]}
    assert labels == {
        "ok_rsi": ("V1 · ok_rsi", "V1"),
        "rsi_modular_v2": ("rsi_modular_v2", "V2"),
        "meridian_v3": ("meridian_v3", "V3"),
    }
    assert [b["status"] for b in body["bots"]] == ["ok", "ok", "ok"]


@sync
async def test_v1_rows_without_v2_only_fields_are_kept_and_labelled_not_dropped():
    body = await page(bots=["ok_rsi"])
    first = body["items"][0]
    assert first["receipt"] == "legacy_6dp"
    assert (first["amount"], first["price"], first["volume"], first["fee"]) == (
        "0.123456",
        "600.5",
        "74.1",
        "0.0741",
    )
    assert first["fee_unit"] == "USDC" and first["base"] == "BNB" and first["quote"] == "USDC"
    assert first["missing"] == [] and first["time_ms"] == T0 - 10_000
    assert first["realized_pnl"] is None
    meta = body["bots"][0]
    assert meta["receipts"] == {"exact": 0, "legacy_6dp": 2, "unavailable": 0}
    assert meta["rows_read"] == 2 and meta["rows_accepted"] == 2 and meta["rejected"] == {}


@sync
async def test_exact_receipts_win_over_float_projections_and_stay_exact_strings():
    body = await page(bots=["rsi_modular_v2"])
    item = body["items"][0]
    assert item["receipt"] == "exact"
    assert (item["amount"], item["price"], item["volume"], item["fee"]) == (
        "0.0105",
        "2000.5",
        "21.00525",
        "0.02100525",
    )
    assert item["side"] == "sell" and item["order_type"] == "LIMIT"
    assert item["connector"] == "okx" and item["source_db_id"] == "db-v2"


@sync
async def test_a_row_missing_fields_keeps_what_it_has_and_lists_what_it_lacks():
    bare = {
        "fill_id": "v1-bare",
        "bot_name": "ok_rsi",
        "pair": "BNB/usdc",
        "side": "BUY",
        "timestamp": "2026-09-24T08:26:09",  # no offset: ambiguous, never guessed
    }
    body = await page(Readers({"ok_rsi": [bare]}, registry=["ok_rsi"]))
    item = body["items"][0]
    assert item["pair"] == "BNB-USDC" and item["side"] == "buy"
    assert item["time_ms"] is None and item["receipt"] == "unavailable"
    assert item["missing"] == ["amount", "fee", "price", "time_ms", "volume"]
    assert item["amount"] is None and item["fee"] is None


@sync
async def test_negative_fee_rebate_and_nonpositive_amount_are_handled_honestly():
    rebate = v2_row(1, T0, exact_trade_fee_in_quote="-0.001")
    zero = v2_row(2, T0 - 1, exact_amount="0", amount_base=0)
    body = await page(Readers({"rsi_modular_v2": [rebate, zero]}, registry=["rsi_modular_v2"]))
    assert body["items"][0]["fee"] == "-0.001"
    assert body["items"][1]["amount"] is None and "amount" in body["items"][1]["missing"]


# ── honesty about sources ──


@sync
async def test_a_bot_whose_reader_is_down_is_reported_not_omitted():
    payloads = default_rows() | {"ok_rsi": fs.OwnerRead(None, fs.SOURCE_UNAVAILABLE)}
    body = await page(Readers(payloads))
    assert body["status"] == "partial" and body["partial"] is True
    assert body["reason"] == "PARTIAL_COVERAGE"
    v1 = next(b for b in body["bots"] if b["bot"] == "ok_rsi")
    assert (v1["status"], v1["reason"], v1["rows_read"]) == ("unavailable", fs.SOURCE_UNAVAILABLE, 0)
    assert {i["bot"] for i in body["items"]} == {"rsi_modular_v2", "meridian_v3"}


@sync
async def test_a_reader_that_raises_or_returns_garbage_is_unavailable_with_a_reason():
    payloads = default_rows() | {
        "ok_rsi": OSError("socket closed"),
        "meridian_v3": fs.OwnerRead({"rows": "not a list"}),
    }
    body = await page(Readers(payloads))
    reasons = {b["bot"]: (b["status"], b["reason"]) for b in body["bots"]}
    assert reasons == {
        "ok_rsi": ("unavailable", fs.SOURCE_UNAVAILABLE),
        "rsi_modular_v2": ("ok", None),
        "meridian_v3": ("unavailable", fs.INVALID),
    }
    assert body["partial"] is True and len(body["items"]) == 2


@sync
async def test_every_reader_down_is_missing_not_an_empty_success():
    down = {bot: fs.OwnerRead(None, fs.SOURCE_UNAVAILABLE) for bot in BOTS}
    body = await page(Readers(down))
    assert body["items"] == [] and body["status"] == "missing" and body["partial"] is True
    assert body["reason"] == fs.SOURCE_UNAVAILABLE
    assert [b["status"] for b in body["bots"]] == ["unavailable"] * 3


@sync
async def test_a_bot_without_a_reporting_source_says_not_configured():
    body = await page(Readers({"ok_rsi": default_rows()["ok_rsi"]}))
    v3 = next(b for b in body["bots"] if b["bot"] == "meridian_v3")
    assert (v3["status"], v3["reason"]) == ("unavailable", fs.NOT_CONFIGURED)
    assert body["status"] == "partial"


@sync
async def test_every_bot_ok_and_empty_is_an_honest_empty_success():
    body = await page(Readers({bot: [] for bot in BOTS}))
    assert body["items"] == [] and body["status"] == "ok" and body["partial"] is False


@sync
async def test_no_registry_and_no_bots_status_is_missing_no_registry():
    body = await page(Readers({}, registry=None))
    assert body["status"] == "missing" and body["reason"] == fs.NO_REGISTRY and body["bots"] == []


@sync
async def test_registry_falls_back_to_the_bots_status_and_says_so():
    status = {"data": {"ok_rsi": {"status": "running", "performance": {}}}}
    body = await page(Readers({"ok_rsi": default_rows()["ok_rsi"]}, registry=None, status=status))
    assert [b["bot"] for b in body["bots"]] == ["ok_rsi"]
    assert body["notes"] == [{"reason": fs.REGISTRY_FROM_STATUS}]


@sync
async def test_paper_bots_are_listed_as_excluded_and_never_read():
    readers = Readers(default_rows() | {"ok_rsi_paper": [v1_row(9, T0)]}, registry=BOTS + ["ok_rsi_paper"])
    body = await page(readers)
    paper = next(b for b in body["bots"] if b["bot"] == "ok_rsi_paper")
    assert (paper["status"], paper["reason"], paper["paper"]) == ("excluded", fs.PAPER_EXCLUDED, True)
    assert "ok_rsi_paper" not in {c[0] for c in readers.calls}
    assert body["status"] == "ok", "paper exclusion is not a data gap"
    assert all(i["bot"] != "ok_rsi_paper" for i in body["items"])


# ── identity: no double counting ──


@sync
async def test_duplicates_foreign_rows_and_unidentifiable_rows_are_rejected_and_counted():
    rows = [
        v1_row(1, T0),
        v1_row(1, T0),  # the same identity twice
        v1_row(2, T0 - 1, source_db_id="db-other"),  # same fill id, other source: a different fill
        v1_row(3, T0 - 2, bot_name="rsi_modular_v2"),  # another bot's row
        v1_row(4, T0 - 3, fill_id=None),
        v1_row(5, T0 - 4, fill_id="  "),
        "not an object",
    ]
    body = await page(Readers({"ok_rsi": rows}, registry=["ok_rsi"]))
    assert [i["fill_id"] for i in body["items"]] == ["v1-1", "v1-2"]
    meta = body["bots"][0]
    assert meta["rows_read"] == 7 and meta["rows_accepted"] == 2
    assert meta["rejected"] == {
        "DUPLICATE": 1,
        "FOREIGN_BOT": 1,
        "NOT_AN_OBJECT": 1,
        "NO_FILL_ID": 2,
    }


@sync
async def test_the_same_fill_id_under_two_bots_is_two_fills():
    a = v1_row(1, T0, fill_id="shared")
    b = v2_row(1, T0, fill_id="shared")
    body = await page(Readers({"ok_rsi": [a], "rsi_modular_v2": [b]}, registry=["ok_rsi", "rsi_modular_v2"]))
    assert len(body["items"]) == 2


# ── ordering and pagination ──


@sync
async def test_equal_instants_order_by_bot_source_and_fill_id_and_untimed_rows_sort_last():
    rows = {
        "ok_rsi": [v1_row(1, T0), v1_row(2, T0, source_db_id="a-first"), v1_row(3, T0, timestamp="garbage")],
        "meridian_v3": [v3_row(1, T0)],
        "rsi_modular_v2": [v2_row(1, T0)],
    }
    body = await page(Readers(rows))
    assert [(i["bot"], i["source_db_id"], i["fill_id"]) for i in body["items"]] == [
        ("meridian_v3", "db-v3", "v3-1"),
        ("ok_rsi", "a-first", "v1-2"),
        ("ok_rsi", "db-v1", "v1-1"),
        ("rsi_modular_v2", "db-v2", "v2-1"),
        ("ok_rsi", "db-v1", "v1-3"),
    ]
    assert body["items"][-1]["time_ms"] is None


@sync
async def test_walking_every_cursor_equals_the_unpaged_feed_with_no_repeat_or_skip():
    rows = {
        bot: [row(n, T0 - (n // 3) * 1000) for n in range(9)]  # many equal instants across bots
        for bot, row in (("ok_rsi", v1_row), ("rsi_modular_v2", v2_row), ("meridian_v3", v3_row))
    }
    readers = Readers(rows)
    win = await window(readers)
    everything = ff.build_page(win, limit=ff.MAX_LIMIT)
    assert len(everything["items"]) == 27 and everything["has_more"] is False
    for size in (1, 2, 5, 26, 27):
        seen, cursor, pages = [], None, 0
        while True:
            body = ff.build_page(win, limit=size, before=cursor)
            seen.extend(ids(body))
            pages += 1
            assert pages < 100
            if not body["has_more"]:
                assert body["next_cursor"] is None
                break
            cursor = body["next_cursor"]
            assert cursor
        assert seen == ids(everything), f"limit={size}"
        assert len(set(seen)) == len(seen)


@sync
async def test_a_cursor_keeps_working_after_newer_fills_arrive():
    first = await window(Readers())
    p1 = ff.build_page(first, limit=2)
    newer = default_rows()
    newer["ok_rsi"].insert(0, v1_row(99, T0 + 500))
    second = await window(Readers(newer))
    p2 = ff.build_page(second, limit=2, before=p1["next_cursor"])
    assert ids(p2) == ids(ff.build_page(first, limit=4))[2:]


@sync
async def test_filters_bot_side_pair_and_their_combination():
    win = await window()
    assert {i["bot"] for i in ff.build_page(win, bots=["ok_rsi", "meridian_v3"])["items"]} == {"ok_rsi", "meridian_v3"}
    sells = ff.build_page(win, side="SELL")
    assert sells["items"] and all(i["side"] == "sell" for i in sells["items"])
    eth = ff.build_page(win, pair="eth/usdc")
    assert eth["items"] and all(i["pair"] == "ETH-USDC" for i in eth["items"])
    both = ff.build_page(win, bots=["rsi_modular_v2"], side="buy", pair="ETH-USDC")
    assert [i["fill_id"] for i in both["items"]] == ["v2-2"] and both["matched"] == 1
    # the bots[] account stays about the selected bots
    assert [b["bot"] for b in ff.build_page(win, bots=["ok_rsi"])["bots"]] == ["ok_rsi"]


@pytest.mark.parametrize(
    "query",
    [
        {"limit": 0},
        {"limit": ff.MAX_LIMIT + 1},
        {"side": "hold"},
        {"bots": ["nobody"]},
        {"pair": "  "},
        {"before": "not-a-cursor"},
        {"before": base64.urlsafe_b64encode(b'{"a":1}').decode()},
        {"before": base64.urlsafe_b64encode(b'["x","b",null,"f"]').decode()},
        {"before": "A" * 600},
    ],
)
@sync
async def test_bad_queries_are_rejected_not_ignored(query):
    with pytest.raises(ff.FeedQueryError):
        ff.build_page(await window(), **query)


# ── the window: a full owner read bounds what is known ──


@sync
async def test_a_saturated_bot_ends_the_merged_feed_at_its_horizon():
    rows = {
        # V2's read is full (limit 3): rows older than 4000 ms ago may exist and are unknown.
        "rsi_modular_v2": [v2_row(n, T0 - n * 1000) for n in (1, 2, 4)],
        "ok_rsi": [v1_row(1, T0 - 2500), v1_row(2, T0 - 9000)],  # the older V1 row is below the horizon
    }
    readers = Readers(rows, registry=["ok_rsi", "rsi_modular_v2"])
    win = await window(readers, limit=3)
    assert readers.calls[0][2] == {"limit": "3"}
    body = ff.build_page(win)
    assert win["horizon_ms"] == T0 - 4000
    assert [i["fill_id"] for i in body["items"]] == ["v2-1", "v2-2", "v1-1", "v2-4"]
    assert body["window"] == {"horizon_ms": T0 - 4000, "truncated": True, "owner_limit": ff.OWNER_FILL_LIMIT}
    v2 = next(b for b in body["bots"] if b["bot"] == "rsi_modular_v2")
    assert v2["saturated"] is True and v2["oldest_ms"] == T0 - 4000
    assert next(b for b in body["bots"] if b["bot"] == "ok_rsi")["saturated"] is False


@sync
async def test_an_unsaturated_window_is_not_truncated():
    body = await page()
    assert body["window"]["truncated"] is False and body["window"]["horizon_ms"] is None


# ── the contract document's examples ──


def example_rows():
    rows = default_rows()
    rows["ok_rsi"].append(v1_row(3, T0 - 140_000, fee_quote=None, side="sell"))
    return rows


@sync
async def test_example_payloads_are_the_builders_output():
    """The documented examples (and the iOS decoding fixtures) are real builder output, never hand-edited.

    Regenerate with FLEET_FILLS_WRITE_EXAMPLES=1 after an intentional contract change.
    """
    win = await window(Readers(example_rows()))
    first = ff.build_page(win, limit=4)
    down = Readers(example_rows() | {"meridian_v3": fs.OwnerRead(None, fs.SOURCE_UNAVAILABLE)})
    cases = {
        "page_first.example.json": first,
        "page_second.example.json": ff.build_page(win, limit=4, before=first["next_cursor"]),
        "page_filtered.example.json": ff.build_page(win, bots=["ok_rsi"], side="sell", limit=5),
        "page_partial.example.json": ff.build_page(await window(down), limit=3),
    }
    for name, body in cases.items():
        path = FIXTURES / name
        if os.environ.get("FLEET_FILLS_WRITE_EXAMPLES") == "1":
            FIXTURES.mkdir(exist_ok=True)
            path.write_text(json.dumps(body, indent=1, ensure_ascii=False, sort_keys=True) + "\n")
        assert json.loads(path.read_text()) == body, f"{name} is stale"
    assert first["status"] == "ok" and cases["page_partial.example.json"]["partial"] is True
    assert {i["generation"] for i in first["items"]} == {"V1", "V2", "V3"}


# ── HTTP ──


class Config:
    def has_server_access(self, user_id, name):
        return name == SERVER and user_id == 7

    def is_admin(self, user_id):
        return user_id == 7


def client_for(monkeypatch, readers=None, *, authenticated=True):
    monkeypatch.setattr(route, "get_config_manager", lambda: Config())
    monkeypatch.setattr(summary_route, "READERS", readers or Readers())
    monkeypatch.setattr(route, "CACHE_TTL_SECONDS", 0)
    monkeypatch.setattr(route.time, "time", lambda: (T0 + 1000) / 1000)
    route._cache.clear()
    app = FastAPI()
    app.include_router(route.router, prefix="/api/v1")
    if authenticated:
        app.dependency_overrides[get_current_user] = lambda: WebUser(id=7, role="admin")
    return TestClient(app)


URL = f"/api/v1/servers/{SERVER}/fleet/fills"


def test_route_requires_authentication_and_server_access(monkeypatch):
    readers = Readers()
    assert client_for(monkeypatch, readers, authenticated=False).get(URL).status_code in {401, 403}
    assert client_for(monkeypatch, readers).get("/api/v1/servers/other/fleet/fills").status_code == 404
    assert readers.calls == []


@pytest.mark.parametrize(
    "query",
    [
        "foo=1",
        "limit=abc",
        "limit=0",
        "limit=201",
        "limit=1&limit=2",
        "side=hold",
        "side=buy&side=sell",
        "bot=nobody",
        "before=zzz",
        "schema=fleet-fills.v2",
    ],
)
def test_route_rejects_unsupported_queries(monkeypatch, query):
    assert client_for(monkeypatch).get(f"{URL}?{query}").status_code == 400


def test_route_serves_the_feed_with_a_validator_and_revalidates(monkeypatch):
    client = client_for(monkeypatch)
    response = client.get(URL, params={"limit": 2})
    assert response.status_code == 200
    assert response.headers["X-Fleet-Fills-Schema"] == "fleet-fills.v1"
    assert response.headers["Cache-Control"] == "private, no-cache"
    body = response.json()
    assert body["schema_version"] == "fleet-fills.v1" and len(body["items"]) == 2 and body["has_more"] is True
    tag = response.headers["ETag"]
    again = client.get(URL, params={"limit": 2}, headers={"If-None-Match": tag})
    assert again.status_code == 304 and again.headers["ETag"] == tag and again.content == b""
    other = client.get(URL, params={"limit": 3})
    assert other.headers["ETag"] != tag


def test_route_pages_with_before_and_filters(monkeypatch):
    client = client_for(monkeypatch)
    first = client.get(URL, params={"limit": 4}).json()
    second = client.get(URL, params={"limit": 4, "before": first["next_cursor"]}).json()
    everything = client.get(URL, params={"limit": 200}).json()
    assert [i["id"] for i in first["items"] + second["items"]] == [i["id"] for i in everything["items"]]
    both = client.get(URL, params=[("bot", "ok_rsi"), ("bot", "meridian_v3"), ("side", "buy")]).json()
    assert {i["bot"] for i in both["items"]} == {"ok_rsi", "meridian_v3"}
    assert all(i["side"] == "buy" for i in both["items"])


def test_route_reports_a_down_bot_and_still_serves_the_rest(monkeypatch):
    readers = Readers(default_rows() | {"ok_rsi": fs.OwnerRead(None, fs.SOURCE_UNAVAILABLE)})
    body = client_for(monkeypatch, readers).get(URL).json()
    assert body["partial"] is True and body["status"] == "partial"
    assert [b["status"] for b in body["bots"]] == ["unavailable", "ok", "ok"]


def test_route_shares_one_owner_read_across_a_burst(monkeypatch):
    readers = Readers()
    client = client_for(monkeypatch, readers)
    monkeypatch.setattr(route, "CACHE_TTL_SECONDS", 60)
    for _ in range(3):
        assert client.get(URL).status_code == 200
        assert client.get(URL, params={"side": "buy"}).status_code == 200
    assert len(readers.calls) == 3, "one read per bot for the whole burst"
