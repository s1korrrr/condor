"""A poll never waits for a rebuild it does not need, and a body served late never claims to be current.

Regressions from 2026-10-28 (rsibot-stack-v2), after the summary stopped 504ing:

* the cache lived 5 s and the phone polls every 10 s, so nearly every poll found it expired and waited
  for a whole build (11-17 s);
* the build's fleet windows summed every adjacent sample pair with exact decimal checks on the event
  loop (about a million decimal formats per build), and the Market Picture frame and history were
  schema-validated on the loop; together they stalled every request for seconds (up to 9.7 s measured)
  and fired other requests' timers late;
* the runtime observer read the five owners one after another with an 8 s bound, below reporting's
  honest 1-12 s snapshot rebuild, so a slow owner cost the others their read.
"""

import asyncio
import random
import threading
import time
from decimal import Decimal

import pytest

from condor import wallet_observation
from condor.web import fleet_pnl
from condor.web import fleet_summary as fs
from condor.web import holdings
from condor.web.routes import fleet_holdings as holdings_route
from condor.web.routes import fleet_summary as routes
from test_fleet_summary import (  # noqa: F401  (store is a pytest fixture)
    NOW_MS,
    SERVER,
    FakeReaders,
    card,
    client_for,
    store,
    sync,
)

# ── the fleet windows ──


def reference_run_deltas(samples):
    """The per-pair accumulation the windows used before 2026-10-28."""
    totals = [Decimal(0), Decimal(0), Decimal(0)]
    restarts = 0
    for a, b in zip(samples, samples[1:]):
        if a.owner != b.owner:
            restarts += 1
            continue
        for index, key in enumerate(("total", "realized", "unrealized")):
            delta = fleet_pnl.exact_difference(getattr(b, key), getattr(a, key))
            updated = (
                fleet_pnl.exact_sum([totals[index], delta])
                if delta is not None
                else None
            )
            if updated is None:
                return None
            totals[index] = updated
    return totals[0], totals[1], totals[2], restarts


def random_samples(rng, count):
    owner, samples = 0, []
    for n in range(count):
        if rng.random() < 0.05:
            owner += 1  # an owner restart: never bridged
        realized = Decimal(rng.randint(-(10**8), 10**8)).scaleb(-rng.randint(0, 8))
        unrealized = Decimal(rng.randint(-(10**8), 10**8)).scaleb(-rng.randint(0, 8))
        samples.append(
            fleet_pnl.Sample(
                n * 60_000.0, realized + unrealized, realized, unrealized, owner
            )
        )
    return samples


@pytest.mark.parametrize("seed", range(25))
def test_run_deltas_equal_the_per_pair_sum(seed):
    rng = random.Random(seed)
    samples = random_samples(rng, rng.randint(0, 120))
    assert fleet_pnl._run_deltas(samples) == reference_run_deltas(samples)


def test_run_deltas_cost_follows_owner_runs_not_sample_pairs(monkeypatch):
    calls = []
    original = fleet_pnl.exact_sum

    def counted(values, **kwargs):
        calls.append(1)
        return original(values, **kwargs)

    monkeypatch.setattr(fleet_pnl, "exact_sum", counted)
    samples = random_samples(random.Random(7), 3000)
    runs = 1 + sum(a.owner != b.owner for a, b in zip(samples, samples[1:]))
    assert fleet_pnl._run_deltas(samples) is not None
    assert (
        len(calls) == 6 * runs
    ), "one difference and one running sum per run and field"


def test_an_unrepresentable_run_delta_is_still_rejected():
    big = Decimal("9" * 38 + "0" * 90)
    samples = [
        fleet_pnl.Sample(0.0, -big, -big, Decimal(0), 0),
        fleet_pnl.Sample(60_000.0, big, big, Decimal(0), 0),
    ]
    assert fleet_pnl._run_deltas(samples) is None


# ── Market Picture validation stays off the event loop ──


@sync
async def test_market_picture_validation_runs_off_the_event_loop(monkeypatch):
    from types import SimpleNamespace

    threads = []

    class Upstream:
        status = 200

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

    class Session:
        def get(self, url, params=None, **kwargs):
            return Upstream()

    transport = SimpleNamespace(session=Session(), base_url="http://owner")

    class Manager:
        async def get_client(self, server):
            return SimpleNamespace(bot_orchestration=transport)

    async def body(upstream, limit):
        return b"{}"

    def validate(path, raw):
        threads.append(threading.current_thread() is threading.main_thread())
        return {"snapshot_id": "s" * 64, "items": []}

    monkeypatch.setattr(routes, "get_config_manager", lambda: Manager())
    monkeypatch.setattr(routes.market_picture, "_body", body)
    monkeypatch.setattr(routes, "validate_response", validate)
    read = await routes.LiveReaders().market(SERVER, 7)
    assert read.frame is not None and read.history == []
    assert threads == [
        False,
        False,
    ], "frame and history are validated in a worker thread"


# ── a completed body serves while exactly one rebuild runs ──


@pytest.fixture
def refreshing(monkeypatch, store):
    readers = FakeReaders(store)
    client_for(monkeypatch, store, readers=readers)
    monkeypatch.setattr(routes, "CACHE_TTL_SECONDS", 0.05)
    monkeypatch.setattr(routes, "LAST_KNOWN", fs.LastKnown())
    monkeypatch.setattr(routes, "_refreshes", {})
    monkeypatch.setattr(routes, "_locks", {})
    gate = {"event": None, "calls": []}
    original = fs.build_fleet_summary

    async def gated(server, view, *args, **kwargs):
        gate["calls"].append(view)
        if gate["event"] is not None:
            await gate["event"].wait()
        return await original(server, view, *args, **kwargs)

    monkeypatch.setattr(fs, "build_fleet_summary", gated)
    return gate


@sync
async def test_an_expired_summary_is_served_while_one_rebuild_runs(refreshing):
    first = await routes.cached_summary(SERVER, admin=True, user_id=7, view="full")
    await asyncio.sleep(0.06)  # past the cache life
    refreshing["event"] = asyncio.Event()
    refreshing["calls"].clear()

    full = await asyncio.wait_for(
        routes.cached_summary(SERVER, admin=True, user_id=7, view="full"), 0.5
    )
    glance = await asyncio.wait_for(
        routes.cached_summary(SERVER, admin=True, user_id=7, view="glance"), 0.5
    )
    again = await asyncio.wait_for(
        routes.cached_summary(SERVER, admin=True, user_id=7, view="full"), 0.5
    )
    assert (
        full == first and again == first
    ), "the completed body, re-judged at the same clock"
    assert glance == fs.glance(first)
    assert "_aging" not in full
    await asyncio.sleep(0.02)
    assert refreshing["calls"] == ["full"], "one rebuild serves both views"

    refreshing["event"].set()
    await asyncio.gather(*routes._refreshes.values())
    assert routes._cache[(SERVER, True)]["full"][0] > time.monotonic()
    refreshing["calls"].clear()
    await routes.cached_summary(SERVER, admin=True, user_id=7, view="full")
    assert refreshing["calls"] == [], "the rebuilt body is served from the cache"


@sync
async def test_a_body_past_the_stale_window_is_not_served(refreshing, monkeypatch):
    await routes.cached_summary(SERVER, admin=True, user_id=7, view="full")
    await asyncio.sleep(0.06)
    monkeypatch.setattr(
        routes.time, "time", lambda: NOW_MS / 1000 + routes.STALE_SERVE_SECONDS + 1
    )
    refreshing["event"] = asyncio.Event()
    waiting = asyncio.create_task(
        routes.cached_summary(SERVER, admin=True, user_id=7, view="full")
    )
    await asyncio.sleep(0.05)
    assert (
        not waiting.done()
    ), "the request waits for a build rather than serve a body that old"
    refreshing["event"].set()
    body = await waiting
    assert body["generated_at_ms"] == int(
        (NOW_MS / 1000 + routes.STALE_SERVE_SECONDS + 1) * 1000
    )


# ── a late body is re-judged and never claims to be current ──


@sync
async def test_a_body_served_at_its_generation_time_is_unchanged(store):
    body = await fs.build_fleet_summary(
        SERVER,
        "full",
        FakeReaders(store),
        NOW_MS,
        is_admin=True,
        user_id=7,
        full_shape=True,
    )
    plain = fs.served(body, "full")
    assert "_aging" not in plain
    assert fs.served(body, "full", NOW_MS) == plain
    assert fs.served(body, "glance", NOW_MS) == fs.glance(plain)


@sync
async def test_a_late_body_ages_every_current_claim_by_its_own_rule(store):
    body = await fs.build_fleet_summary(
        SERVER,
        "full",
        FakeReaders(store),
        NOW_MS,
        is_admin=True,
        user_id=7,
        full_shape=True,
    )
    fresh = fs.served(body, "full")
    assert (
        fresh["sections"]["wallet"]["status"] == "ok"
        and fresh["wallet"]["stale"] is False
    )
    assert card(fresh, "ok_rsi")["report_stale"] is False
    assert fresh["market"]["frame"]["freshness"] == "fresh"

    lagging = fs.served(body, "full", NOW_MS + 70_000)
    assert lagging["market"]["frame"]["freshness"] == "lagging"
    assert lagging["sections"]["market"] == {
        **fresh["sections"]["market"],
        "status": "partial",
        "reason": "FRAME_LAGGING",
    }
    assert (
        lagging["sections"]["wallet"]["status"] == "ok"
    ), "the wallet is 100 s old: still current"
    # The owner report was 5 s old and current for 30 s.
    assert card(lagging, "ok_rsi")["report_stale"] is True
    assert lagging["bot_counts"]["live_stale_reports"] == 2
    assert lagging["sections"]["bots"]["status"] == "stale"
    assert lagging["sections"]["bots"]["reason"] == fs.OWNER_NOT_CURRENT

    late = fs.served(body, "full", NOW_MS + 100_000)
    assert late["market"]["frame"]["freshness"] == "stale"
    assert late["sections"]["market"]["status"] == "stale"
    assert late["wallet"]["stale"] is True
    assert late["sections"]["wallet"] == {
        **fresh["sections"]["wallet"],
        "status": "stale",
        "reason": fs.OWNER_NOT_CURRENT,
    }

    # Ten minutes on, the day and week windows have no current sample; the month window's spacing is wider.
    hours = fs.served(body, "full", NOW_MS + 600_000)
    assert (
        hours["pnl"]["day"]["stale"] is True and hours["pnl"]["week"]["stale"] is True
    )
    assert hours["pnl"]["month"]["stale"] is False
    assert all(row["stale"] for row in hours["pnl"]["day"]["bots"])
    assert hours["sections"]["pnl"]["status"] == "stale"
    # Values never change: only flags age.
    assert hours["pnl"]["day"]["total"] == fresh["pnl"]["day"]["total"]
    assert hours["wallet"]["equity"] == fresh["wallet"]["equity"]
    assert hours["generated_at_ms"] == fresh["generated_at_ms"]
    glance = fs.served(body, "glance", NOW_MS + 600_000)
    assert glance == fs.glance(hours)


def test_card_claims_age_at_their_own_instants_and_never_return():
    trading = {
        "buy": "can_trade",
        "sell": "can_trade",
        "coverage": "complete",
        "restrictions": [],
        "restrictions_total": 0,
        "observed_ms": NOW_MS,
        "held": False,
        "reason": None,
    }
    body = {
        "sections": {
            "bots": {
                "status": "ok",
                "observed_at_ms": NOW_MS,
                "stale_after_ms": 30_000,
                "reason": None,
            }
        },
        "bots": [
            {
                "bot": "b",
                "paper": False,
                "report_at_ms": NOW_MS,
                "report_stale": False,
                "positions": {"held": 1, "registered": 2, "current": True},
                "pnl_day": {
                    "change": "1",
                    "unit": "USDC",
                    "partial": False,
                    "stale": False,
                    "uncovered_ms": 0,
                },
                "trading": trading,
            },
            {
                "bot": "old",
                "paper": False,
                "report_at_ms": NOW_MS - 60_000,
                "report_stale": True,
                "positions": None,
                "pnl_day": None,
                "trading": None,
            },
        ],
        "bot_counts": {"live_stale_reports": 1},
        "_aging": {
            "cards": {
                "b": {
                    "report_until_ms": NOW_MS + 30_000,
                    "positions_until_ms": NOW_MS + 40_000,
                    "pnl_day_until_ms": NOW_MS + 50_000,
                    "trading_until_ms": NOW_MS + 20_000,
                },
                # A claim already stale stays stale, whatever expiry is recorded.
                "old": {"report_until_ms": NOW_MS + 10**9},
            }
        },
    }

    def at(offset):
        out = fs.aged(body, NOW_MS + offset)
        return out["bots"][0], out

    b, out = at(19_999)
    assert (b["trading"]["buy"], b["report_stale"], b["positions"]["current"]) == (
        "can_trade",
        False,
        True,
    )
    assert (
        out["bots"][1]["report_stale"] is True
        and out["bot_counts"]["live_stale_reports"] == 1
    )
    b, _ = at(20_000)
    assert (b["trading"]["buy"], b["trading"]["sell"]) == ("unverified", "unverified")
    assert b["trading"]["restrictions"] == [] and b["trading"]["observed_ms"] == NOW_MS
    b, out = at(30_000)
    assert b["report_stale"] is True and out["sections"]["bots"]["status"] == "stale"
    assert out["bot_counts"]["live_stale_reports"] == 2
    b, _ = at(40_000)
    assert b["positions"]["current"] is False
    b, _ = at(50_000)
    assert (
        b["pnl_day"]["stale"] is False
    ), "a day sample is stale only past its bound, as bot_window"
    b, _ = at(50_001)
    assert b["pnl_day"]["stale"] is True
    assert (
        body["bots"][0]["report_stale"] is False
    ), "aging copies; the cached body is unchanged"


# ── holdings ──


def test_holdings_rows_age_to_stale_as_admission_would():
    body = {
        "schema": "fleet-holdings.v1",
        "server": "main",
        "generated_at_ms": NOW_MS,
        "bots": [
            {
                "bot": "a",
                "state": holdings.CURRENT,
                "observed_at_ms": NOW_MS - 10_000,
                "stale_after_ms": 30_000,
            },
            {
                "bot": "b",
                "state": holdings.STALE,
                "observed_at_ms": NOW_MS - 90_000,
                "stale_after_ms": 30_000,
            },
            {"bot": "c", "state": holdings.UNAVAILABLE, "observed_at_ms": None},
        ],
    }
    assert holdings.aged(body, NOW_MS) == body
    late = holdings.aged(body, NOW_MS + 20_000)
    assert [row["state"] for row in late["bots"]] == [
        holdings.STALE,
        holdings.STALE,
        holdings.UNAVAILABLE,
    ]
    assert body["bots"][0]["state"] == holdings.CURRENT


@sync
async def test_expired_holdings_are_served_while_one_rebuild_runs(monkeypatch):
    gate = asyncio.Event()
    calls = []

    class Owners:
        def registered_bots(self, server):
            return ["bot_a", "bot_b"]

        async def owner(self, bot, path, params):
            calls.append(bot)
            if len(calls) > 2:
                await gate.wait()
            return fs.OwnerRead(None, fs.SOURCE_UNAVAILABLE)

    monkeypatch.setattr(routes, "READERS", Owners())
    monkeypatch.setattr(holdings_route, "_cache", {})
    monkeypatch.setattr(holdings_route, "_refreshes", {})
    monkeypatch.setattr(holdings_route, "_locks", {})
    monkeypatch.setattr(holdings_route, "CACHE_TTL_SECONDS", 0.05)
    first = await holdings_route.cached_holdings("main")
    await asyncio.sleep(0.06)
    served = await asyncio.wait_for(holdings_route.cached_holdings("main"), 0.5)
    again = await asyncio.wait_for(holdings_route.cached_holdings("main"), 0.5)
    assert served == first == again
    await asyncio.sleep(0.02)
    assert len(calls) == 4, "one rebuild reads each bot once"
    gate.set()
    await asyncio.gather(*holdings_route._refreshes.values())
    assert holdings_route._cache["main"][0] > time.monotonic()


# ── the runtime observer ──


@sync
async def test_runtime_owners_are_read_at_once_each_on_its_own_bound(monkeypatch):
    async def slow_read(client, source, bot):
        await asyncio.sleep(0.3)
        return {"bot": bot}

    monkeypatch.setattr(wallet_observation, "_read", slow_read)
    sources = {
        f"bot_{n}": {"server": "v2", "url": "http://127.0.0.1:8000/trading-visuals"}
        for n in range(4)
    }
    started = time.monotonic()
    bodies = await wallet_observation.observe_runtime("v2", sources)
    elapsed = time.monotonic() - started
    assert bodies == {bot: {"bot": bot} for bot in sources}
    assert elapsed < 0.9, f"four 0.3 s reads took {elapsed:.2f} s"
