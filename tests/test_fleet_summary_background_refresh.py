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
import copy
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
    INCIDENTS,
    NOW_MS,
    NOW_S,
    SERVER,
    FakeReaders,
    _capability,
    _observed,
    account_analytics,
    card,
    client_for,
    iso,
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
    starts = [0] + [
        n for n in range(1, len(samples)) if samples[n].owner != samples[n - 1].owner
    ]
    lengths = [b - a for a, b in zip(starts, [*starts[1:], len(samples)])]
    paired_runs = sum(1 for length in lengths if length >= 2)
    assert fleet_pnl._run_deltas(samples) is not None
    # One difference and one running sum per multi-sample run and field, not per sample pair.
    assert len(calls) == 6 * paired_runs


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
    plain = {k: v for k, v in body.items() if k != "_aging"}
    assert "_aging" not in fs.served(body, "full", NOW_MS)
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
    fresh = fs.served(body, "full", NOW_MS)
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


# ── review findings (GPT-6.1-Sol, 2026-10-28) ──


def boundary_samples(rng, count):
    """Admitted samples whose digits span the representability boundary."""
    owner, samples = 0, []
    while len(samples) < count:
        if rng.random() < 0.1:
            owner += 1
        values = []
        for _ in range(2):
            magnitude = Decimal(rng.randint(1, 10 ** rng.randint(1, 38)))
            values.append(magnitude.scaleb(rng.randint(-60, 40)) * rng.choice((1, -1)))
        total = fleet_pnl.exact_sum(values)
        if total is None or any(
            fleet_pnl.decimal_text(v) is None for v in (*values, total)
        ):
            continue
        samples.append(
            fleet_pnl.Sample(
                len(samples) * 60_000.0, total, values[0], values[1], owner
            )
        )
    return samples


def test_run_deltas_keep_the_per_pair_admission_at_the_digit_boundary():
    tiny, one = Decimal("1e-39"), Decimal(1)
    samples = [
        fleet_pnl.Sample(t * 60_000.0, value, value, Decimal(0), 0)
        for t, value in enumerate((tiny, one, tiny))
    ]
    # 1 - 1e-39 needs 39 significant digits: the per-pair sum rejects it, so the window is invalid.
    assert reference_run_deltas(samples) is None
    assert fleet_pnl._run_deltas(samples) is None


@pytest.mark.parametrize("seed", range(60))
def test_run_deltas_equal_the_per_pair_sum_near_the_boundary(seed):
    rng = random.Random(1000 + seed)
    samples = boundary_samples(rng, rng.randint(2, 12))
    assert fleet_pnl._run_deltas(samples) == reference_run_deltas(samples)


@sync
async def test_a_cache_hit_is_aged_at_the_request_clock(monkeypatch, store):
    class OldWallet(FakeReaders):
        async def account(self, server, user_id):
            return fs.OwnerRead(account_analytics(observed_ms=NOW_MS - 119_000))

    client_for(monkeypatch, store, readers=OldWallet(store))
    monkeypatch.setattr(routes, "CACHE_TTL_SECONDS", 60)
    monkeypatch.setattr(routes, "LAST_KNOWN", fs.LastKnown())
    monkeypatch.setattr(routes, "_refreshes", {})
    monkeypatch.setattr(routes, "_locks", {})
    first = await routes.cached_summary(SERVER, admin=True, user_id=7, view="full")
    assert first["wallet"]["stale"] is False
    monkeypatch.setattr(routes.time, "time", lambda: NOW_S + 2)
    hit = await routes.cached_summary(SERVER, admin=True, user_id=7, view="full")
    assert hit["generated_at_ms"] == first["generated_at_ms"], "served from the cache"
    assert hit["wallet"]["stale"] is True
    assert hit["sections"]["wallet"]["status"] == "stale"
    glance = await routes.cached_summary(SERVER, admin=True, user_id=7, view="glance")
    assert glance["wallet"]["stale"] is True


@sync
async def test_a_holdings_cache_hit_is_aged_at_the_request_clock(monkeypatch):
    row = {
        "bot": "a",
        "state": holdings.CURRENT,
        "observed_at_ms": NOW_MS - 29_000,
        "stale_after_ms": 30_000,
    }
    body = {
        "schema": "fleet-holdings.v1",
        "server": "main",
        "generated_at_ms": NOW_MS,
        "bots": [row],
    }
    monkeypatch.setattr(
        holdings_route, "_cache", {"main": (time.monotonic() + 60, body)}
    )
    monkeypatch.setattr(holdings_route.time, "time", lambda: NOW_S + 2)
    served = await holdings_route.cached_holdings("main")
    assert served["bots"][0]["state"] == holdings.STALE
    assert row["state"] == holdings.CURRENT, "the cached body is not changed"


@sync
async def test_incident_freshness_expires_with_the_older_of_store_and_monitor(store):
    payload = copy.deepcopy(INCIDENTS)
    payload["incident_store"].update(
        generated_at=iso(NOW_MS - 1_000),
        monitor={"state": "healthy", "last_cycle_at": iso(NOW_MS - 89_000)},
        incidents=[],
    )
    readers = FakeReaders(store)
    readers.incident_payload = payload
    body = await fs.build_fleet_summary(
        SERVER, "full", readers, NOW_MS, is_admin=True, user_id=7, full_shape=True
    )
    assert body["incidents"]["state"] == "healthy"
    assert fs.aged(body, NOW_MS + 1_000)["incidents"]["state"] == "healthy"
    later = fs.aged(body, NOW_MS + 10_000)
    assert fs.project_incidents(payload, NOW_MS + 10_000)["state"] == "unknown"
    assert later["incidents"]["state"] == "unknown"
    assert later["sections"]["incidents"]["status"] == "stale"
    assert later["sections"]["incidents"]["reason"] == fs.OWNER_NOT_CURRENT
    glance = fs.served(body, "glance", NOW_MS + 10_000)
    assert glance["incidents"]["state"] == "unknown"


@sync
async def test_a_half_verified_capability_still_expires(store):
    capability = _capability(buy="can_trade", sell="unverified")

    class Runtime(FakeReaders):
        async def owner(self, bot, path, params):
            if bot == "ok_rsi" and path == "bootstrap":
                observed = _observed(capability)
                observed["runtime_status"]["bot_name"] = bot
                observed["monitoring"]["bot_name"] = bot
                return fs.OwnerRead(observed)
            return await super().owner(bot, path, params)

    body = await fs.build_fleet_summary(
        SERVER,
        "full",
        Runtime(store),
        NOW_MS,
        is_admin=True,
        user_id=7,
        full_shape=True,
    )
    assert card(body, "ok_rsi")["trading"]["buy"] == "can_trade"
    fresh = fs.project_runtime_view(_observed(capability), "bot", NOW_MS + 31_000)
    assert (fresh["trading"]["buy"], fresh["trading"]["sell"]) == ("unverified",) * 2
    late = card(fs.aged(body, NOW_MS + 31_000), "ok_rsi")["trading"]
    assert (late["buy"], late["sell"]) == ("unverified", "unverified")


@sync
async def test_net_now_falls_back_and_expires_by_each_source_own_bound(
    monkeypatch, store
):
    observed_s = (NOW_MS - 29_000) / 1000
    page = {
        "bots": [
            {
                "bot_name": "ok_rsi",
                "status": "running",
                "num_controllers": 1,
                "controller_count_current": True,
                "status_received_at": observed_s,
                "status_stale_after_seconds": 30,
                "performance_received_at": observed_s,
                "performance_stale_after_seconds": 30,
            }
        ],
        "controllers": [
            {
                "bot_name": "ok_rsi",
                "controller_id": "c",
                "trading_pair": "ETH-USDC",
                "global_pnl_quote": 1.25,
                "realized_pnl_quote": 1.0,
                "unrealized_pnl_quote": 0.25,
            }
        ],
    }
    monkeypatch.setattr(fs, "build_bots_page", lambda raw: copy.deepcopy(page))
    body = await fs.build_fleet_summary(
        SERVER,
        "full",
        FakeReaders(store),
        NOW_MS,
        is_admin=True,
        user_id=7,
        full_shape=True,
    )
    assert card(body, "ok_rsi")["net_now"] == {
        "value": "1.25",
        "unit": "USDC",
        "source": "controller",
    }
    assert fs._controller_net(page, "ok_rsi", NOW_MS + 10_000) is None

    # The newest stored sample (one minute old at build) stands in, as a fresh build chooses it.
    fallback = card(fs.aged(body, NOW_MS + 10_000), "ok_rsi")
    assert fallback["net_now"] == {"value": "4", "unit": "USDC", "source": "history"}
    last_valid = card(fs.aged(body, NOW_MS - 60_000 + 300_000), "ok_rsi")
    assert last_valid["net_now"]["source"] == "history"

    # Past five minutes from that sample nothing current remains: unknown, named as a fresh build would.
    gone = fs.aged(body, NOW_MS - 60_000 + 300_001)
    gone_card = card(gone, "ok_rsi")
    assert gone_card["net_now"] is None
    assert {"field": "net_now", "reason": fleet_pnl.NO_SAMPLES} in gone_card["missing"]
    fields = [gap["field"] for gap in gone_card["missing"]]
    assert fields == sorted(fields, key=fs._CARD_GAP_ORDER.index)
    assert {
        "section": "bots",
        "bot": "ok_rsi",
        "field": "net_now",
        "reason": fleet_pnl.NO_SAMPLES,
    } in gone["missing"]
