"""A poll never waits for a rebuild it does not need, and a cached answer equals a fresh one.

Regressions from 2026-10-28 (rsibot-stack-v2), after the summary stopped 504ing:

* the cache lived 5 s and the phone polls every 10 s, so nearly every poll found it expired and waited
  for a whole build (11-17 s);
* the build's fleet windows summed every adjacent sample pair with exact decimal checks on the event
  loop (about a million decimal formats per build), and the Market Picture frame and history were
  schema-validated on the loop; together they stalled every request for seconds (up to 9.7 s measured)
  and fired other requests' timers late;
* the runtime observer read the five owners one after another with an 8 s bound, below reporting's
  honest 1-12 s snapshot rebuild, so a slow owner cost the others their read.

The cache keeps what a build read and projects it at every response's clock. The equivalence tests
below compare a cached response with a fresh build from identical reads at many clocks, for the full
view, the glance and holdings; the named regressions are the review findings of 2026-10-28.
"""

import asyncio
import copy
import json
import random
import threading
import time
from decimal import Decimal
from pathlib import Path

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
    original = fs.gather_fleet_inputs

    async def gated(server, view, *args, **kwargs):
        gate["calls"].append(view)
        if gate["event"] is not None:
            await gate["event"].wait()
        return await original(server, view, *args, **kwargs)

    monkeypatch.setattr(fs, "gather_fleet_inputs", gated)
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
    assert full == first and again == first, "the completed reads, at the same clock"
    assert glance == fs.glance(first)
    await asyncio.sleep(0.02)
    assert refreshing["calls"] == ["full"], "one rebuild serves both views"

    refreshing["event"].set()
    await asyncio.gather(*routes._refreshes.values())
    assert routes._cache[(SERVER, True)]["full"][0] > time.monotonic()
    refreshing["calls"].clear()
    await routes.cached_summary(SERVER, admin=True, user_id=7, view="full")
    assert refreshing["calls"] == [], "the rebuilt reads are served from the cache"


@sync
async def test_reads_past_the_stale_window_are_not_served(refreshing, monkeypatch):
    await routes.cached_summary(SERVER, admin=True, user_id=7, view="full")
    await asyncio.sleep(0.06)
    later_s = NOW_MS / 1000 + routes.STALE_SERVE_SECONDS + 1
    monkeypatch.setattr(routes.time, "time", lambda: later_s)
    refreshing["event"] = asyncio.Event()
    waiting = asyncio.create_task(
        routes.cached_summary(SERVER, admin=True, user_id=7, view="full")
    )
    await asyncio.sleep(0.05)
    assert (
        not waiting.done()
    ), "the request waits for a build rather than serve reads that old"
    refreshing["event"].set()
    body = await waiting
    assert body["sources_read_at_ms"] == int(later_s * 1000)


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
    monkeypatch.setattr(holdings_route.time, "time", lambda: NOW_S)
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


# ── a cached answer equals a fresh build from identical reads ──

# Seconds after the reads at which a cached answer is compared with a fresh build: either side of
# every bound the fixtures sit near (owner currency 30 s, holdings 30 s, wallet 120 s, incidents 90 s,
# market lag 90 s and expiry 120 s, day samples 180 s), within the 60 s the cache serves.
CLOCKS_S = (0, 1, 2, 9, 10, 11, 29, 30, 31, 45, 59, 60)


def scenario_readers(store, monkeypatch):
    """One fleet whose reads sit just inside the bounds the reviews probed."""
    observed_s = (NOW_MS - 29_000) / 1000
    native = {
        "status": "running",
        "source": "native_mqtt",
        "performance_current": True,
        "identity_verified": True,
        "received_at": observed_s,
        "stale_after_seconds": 30,
        "lifecycle": {
            "valid": True,
            "observation": {
                "received_at": observed_s,
                "payload": {"generated_at": observed_s},
            },
        },
        "heartbeat": {"received_at": observed_s, "source_timestamp": observed_s * 1e6},
        "performance": {
            "c": {
                "status": "running",
                "custom_info": {"pair": "ETH-USDC"},
                "performance": {
                    "realized_pnl_quote": 1.0,
                    "unrealized_pnl_quote": 0.25,
                    "global_pnl_quote": 1.25,
                    "volume_traded": 10,
                },
            }
        },
    }
    incidents = copy.deepcopy(INCIDENTS)
    incidents["incident_store"].update(
        generated_at=iso(NOW_MS - 1_000),
        monitor={"state": "healthy", "last_cycle_at": iso(NOW_MS - 89_000)},
        incidents=[],
    )

    class Scenario(FakeReaders):
        async def bots_status(self, server):
            # rsi_modular_v2: a verified native performance observation 29 s old, one controller.
            status = copy.deepcopy(super_status())
            status["data"]["rsi_modular_v2"] = copy.deepcopy(native)
            return status

        async def account(self, server, user_id):
            return fs.OwnerRead(account_analytics(observed_ms=NOW_MS - 119_000))

        async def owner(self, bot, path, params):
            if bot == "ok_rsi" and path == "bootstrap":
                # 29 s old, no active executors, buy verified and sell unverified.
                body = _observed(
                    _capability(buy="can_trade", sell="unverified"), NOW_MS - 29_000
                )
                body["runtime_status"]["bot_name"] = bot
                body["monitoring"]["bot_name"] = bot
                return fs.OwnerRead(body)
            return await super().owner(bot, path, params)

    from test_fleet_summary import bots_status as super_status

    readers = Scenario(store)
    readers.incident_payload = incidents
    return readers


def strip_read_time(body):
    return {k: v for k, v in body.items() if k != "sources_read_at_ms"}


@pytest.mark.parametrize("view", ["full", "glance"])
@sync
async def test_a_cached_summary_equals_a_fresh_build_at_every_clock(
    view, monkeypatch, store
):
    readers = scenario_readers(store, monkeypatch)
    client_for(monkeypatch, store, readers=readers)
    monkeypatch.setattr(routes, "CACHE_TTL_SECONDS", 60)
    monkeypatch.setattr(routes, "LAST_KNOWN", fs.LastKnown())
    monkeypatch.setattr(routes, "_refreshes", {})
    monkeypatch.setattr(routes, "_locks", {})
    await routes.cached_summary(SERVER, admin=True, user_id=7, view=view)
    for seconds in CLOCKS_S:
        clock_ms = NOW_MS + seconds * 1000
        monkeypatch.setattr(routes.time, "time", lambda c=clock_ms: c / 1000)
        cached = await routes.cached_summary(SERVER, admin=True, user_id=7, view=view)
        fresh = await fs.build_fleet_summary(
            SERVER,
            view,
            readers,
            clock_ms,
            is_admin=True,
            user_id=7,
            clock_ms=lambda c=clock_ms: c,
            last_known=fs.LastKnown(),
        )
        assert cached["sources_read_at_ms"] == NOW_MS, "served from the cached reads"
        assert strip_read_time(cached) == strip_read_time(fresh), f"+{seconds} s"


@sync
async def test_projecting_cached_reads_equals_a_fresh_build_well_past_the_cache(
    monkeypatch, store
):
    """The projection itself, at clocks up to ten minutes after the reads (beyond every bound)."""
    readers = scenario_readers(store, monkeypatch)
    inputs = await fs.gather_fleet_inputs(
        SERVER, "full", readers, NOW_MS, is_admin=True, user_id=7
    )
    snapshot = copy.deepcopy(inputs)
    for seconds in (0, 31, 89, 91, 119, 121, 179, 181, 240, 241, 300, 600):
        clock_ms = NOW_MS + seconds * 1000
        projected = fs.project_fleet_summary(inputs, clock_ms)
        fresh = await fs.build_fleet_summary(
            SERVER, "full", readers, clock_ms, is_admin=True, user_id=7
        )
        assert strip_read_time(projected) == strip_read_time(fresh), f"+{seconds} s"
        assert fs.glance(projected) == {
            **fs.glance(fresh),
            "sources_read_at_ms": NOW_MS,
        }
    assert inputs == snapshot, "projection never changes the cached reads"


@sync
async def test_cached_holdings_equal_a_fresh_build_at_every_clock(monkeypatch):
    from test_fleet_holdings import NOW_MS as HOLDINGS_NOW_MS
    from test_fleet_holdings import FakeReaders as HoldingReaders
    from test_fleet_holdings import example_reads

    reads = example_reads()
    monkeypatch.setattr(routes, "READERS", HoldingReaders(reads))
    monkeypatch.setattr(holdings_route, "_cache", {})
    monkeypatch.setattr(holdings_route, "_refreshes", {})
    monkeypatch.setattr(holdings_route, "_locks", {})
    monkeypatch.setattr(holdings_route, "CACHE_TTL_SECONDS", 60)
    monkeypatch.setattr(holdings_route.time, "time", lambda: HOLDINGS_NOW_MS / 1000)
    await holdings_route.cached_holdings("main")
    states = set()
    for seconds in CLOCKS_S:
        clock_ms = HOLDINGS_NOW_MS + seconds * 1000
        monkeypatch.setattr(holdings_route.time, "time", lambda c=clock_ms: c / 1000)
        cached = await holdings_route.cached_holdings("main")
        fresh = holdings.build_holdings("main", copy.deepcopy(reads), clock_ms)
        assert strip_read_time(cached) == fresh, f"+{seconds} s"
        states |= {row["state"] for row in cached["bots"]}
    assert holdings.STALE in states, "the clocks cross a holdings currency bound"


# ── the review findings, one each ──


async def cached_and_fresh(monkeypatch, store, seconds, view="full"):
    readers = scenario_readers(store, monkeypatch)
    inputs = await fs.gather_fleet_inputs(
        SERVER, view, readers, NOW_MS, is_admin=True, user_id=7
    )
    clock_ms = NOW_MS + seconds * 1000
    cached = fs.project_fleet_summary(inputs, clock_ms)
    fresh = await fs.build_fleet_summary(
        SERVER, "full", readers, clock_ms, is_admin=True, user_id=7
    )
    return cached, fresh


@sync
async def test_finding_a_cache_hit_is_judged_at_the_request_clock(monkeypatch, store):
    cached, _ = await cached_and_fresh(monkeypatch, store, 0)
    assert cached["wallet"]["stale"] is False
    cached, fresh = await cached_and_fresh(monkeypatch, store, 2)
    assert cached["wallet"]["stale"] is True and fresh["wallet"]["stale"] is True


@sync
async def test_finding_incident_freshness_expires(monkeypatch, store):
    cached, _ = await cached_and_fresh(monkeypatch, store, 0)
    assert cached["incidents"]["state"] == "healthy"
    cached, _ = await cached_and_fresh(monkeypatch, store, 10)
    assert cached["incidents"]["state"] == "unknown"
    assert cached["sections"]["incidents"]["status"] == "stale"


@sync
async def test_finding_a_half_verified_capability_expires(monkeypatch, store):
    cached, _ = await cached_and_fresh(monkeypatch, store, 0)
    assert card(cached, "ok_rsi")["trading"]["buy"] == "can_trade"
    cached, _ = await cached_and_fresh(monkeypatch, store, 2)
    trading = card(cached, "ok_rsi")["trading"]
    assert (trading["buy"], trading["sell"]) == ("unverified", "unverified")


@sync
async def test_finding_controller_net_now_expires_to_its_history_fallback(
    monkeypatch, store
):
    cached, _ = await cached_and_fresh(monkeypatch, store, 0)
    assert card(cached, "rsi_modular_v2")["net_now"]["source"] == "controller"
    cached, _ = await cached_and_fresh(monkeypatch, store, 2)
    assert card(cached, "rsi_modular_v2")["net_now"]["source"] == "history"


@sync
async def test_finding_runtime_executors_reselect_their_basis(monkeypatch, store):
    cached, _ = await cached_and_fresh(monkeypatch, store, 0)
    ok = card(cached, "ok_rsi")
    assert (ok["executors"], ok["executors_basis"]) == (0, "runtime_active_executors")
    cached, _ = await cached_and_fresh(monkeypatch, store, 2)
    ok = card(cached, "ok_rsi")
    assert (ok["executors"], ok["executors_basis"]) == (1, "open_lifecycle_cycles")
    assert ok["report_stale"] is False, "the newer quant heartbeat is still current"


@sync
async def test_finding_native_controller_count_is_withdrawn(monkeypatch, store):
    cached, _ = await cached_and_fresh(monkeypatch, store, 0)
    assert card(cached, "rsi_modular_v2")["controllers"] == 1
    cached, _ = await cached_and_fresh(monkeypatch, store, 2)
    assert card(cached, "rsi_modular_v2")["controllers"] == 0


@sync
async def test_finding_a_stale_day_change_is_withheld_from_the_glance(tmp_path):
    from condor.performance_history import PerformanceHistory
    from test_fleet_summary import seed

    store = PerformanceHistory(tmp_path / "native-performance.sqlite3")
    seed(store, ("ok_rsi", "rsi_modular_v2", "ok_rsi_paper"))
    # ok_rsi's newest day sample is 174 s old (windows judge at now + 5 s and are stale past 180 s);
    # rsi_modular_v2's is fresher, so the fleet day window stays current.
    with store._connect() as conn:
        conn.execute(
            "DELETE FROM points WHERE bot='ok_rsi' AND timestamp > ?", (NOW_S - 600,)
        )
        conn.execute(
            "INSERT INTO points VALUES (?,?,?,?,?,?,?,?,?)",
            (
                SERVER,
                "ok_rsi",
                NOW_S - 174,
                "boot-ok_rsi",
                "seg-ok_rsi",
                "USDC",
                "2",
                "0",
                "2",
            ),
        )
    readers = FakeReaders(store)
    inputs = await fs.gather_fleet_inputs(
        SERVER, "glance", readers, NOW_MS, is_admin=True, user_id=7
    )
    now = fs.glance(fs.project_fleet_summary(inputs, NOW_MS))
    later = fs.glance(fs.project_fleet_summary(inputs, NOW_MS + 2_000))
    ok_now = next(b for b in now["bots"] if b["bot"] == "ok_rsi")
    ok_later = next(b for b in later["bots"] if b["bot"] == "ok_rsi")
    assert ok_now["pnl_day"] == "1" and "pnl_day_stale" not in ok_now
    assert (ok_later["pnl_day"], ok_later["pnl_day_stale"]) == (None, True)
    v2 = next(b for b in later["bots"] if b["bot"] == "rsi_modular_v2")
    assert v2["pnl_day"] is not None and "pnl_day_stale" not in v2


# ── fleet windows near the representability boundary ──


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


# ── last known evidence never rolls backward (review of 9852e765) ──


class ScriptedReaders(FakeReaders):
    """Account and ok_rsi runtime reads that a test changes between builds."""

    def __init__(self, store):
        super().__init__(store)
        self.account_read = fs.OwnerRead(None, fs.SOURCE_UNAVAILABLE)
        self.runtime_read = None

    async def account(self, server, user_id):
        return copy.deepcopy(self.account_read)

    async def owner(self, bot, path, params):
        if bot == "ok_rsi" and path == "bootstrap" and self.runtime_read is not None:
            return copy.deepcopy(self.runtime_read)
        return await super().owner(bot, path, params)


def runtime_read(bot, observed_ms, updated_ms):
    body = _observed(
        _capability(buy="can_trade", sell="can_trade", observed_at=iso(observed_ms)),
        updated_ms,
    )
    body["runtime_status"]["bot_name"] = body["monitoring"]["bot_name"] = bot
    return fs.OwnerRead(body)


async def gather_at(readers, view, clock_ms):
    return await fs.gather_fleet_inputs(
        SERVER,
        view,
        readers,
        clock_ms,
        is_admin=True,
        user_id=7,
        clock_ms=lambda: clock_ms,
        last_known=routes.LAST_KNOWN,
    )


@sync
async def test_serving_older_cached_reads_never_rolls_last_known_evidence_back(
    monkeypatch, store
):
    """Full and glance read sets share one LastKnown; an older one served later must not win."""
    readers = ScriptedReaders(store)
    monkeypatch.setattr(routes, "LAST_KNOWN", fs.LastKnown())
    clock = {"s": NOW_S}
    monkeypatch.setattr(routes.time, "time", lambda: clock["s"])

    # T: the full view reads a wallet observed 119 s earlier.
    readers.account_read = fs.OwnerRead(
        account_analytics(observed_ms=NOW_MS - 119_000, amount="1000")
    )
    old_full = await gather_at(readers, "full", NOW_MS)
    # T+6 s: a glance reads a newer wallet.
    readers.account_read = fs.OwnerRead(
        account_analytics(observed_ms=NOW_MS + 6_000, amount="1100")
    )
    await gather_at(readers, "glance", NOW_MS + 6_000)
    # T+7 s: the older cached full read set is served.
    clock["s"] = NOW_S + 7
    served = routes._respond(old_full, "full")
    assert served["wallet"]["equity"] == "1000", "it still shows its own read"
    # T+8 s: a glance whose account read failed stands on the newest admitted wallet.
    readers.account_read = fs.OwnerRead(None, fs.SOURCE_UNAVAILABLE)
    failed = await gather_at(readers, "glance", NOW_MS + 8_000)
    clock["s"] = NOW_S + 8
    glance = routes._respond(failed, "glance")
    assert glance["wallet"]["equity"] == "1100"
    assert glance["wallet"]["held"] is True


@sync
async def test_serving_older_cached_reads_never_rolls_a_trading_capability_back(
    monkeypatch, store
):
    readers = ScriptedReaders(store)
    monkeypatch.setattr(routes, "LAST_KNOWN", fs.LastKnown())
    clock = {"s": NOW_S}
    monkeypatch.setattr(routes.time, "time", lambda: clock["s"])
    readers.runtime_read = runtime_read("ok_rsi", NOW_MS - 50_000, NOW_MS - 1_000)
    old_full = await gather_at(readers, "full", NOW_MS)
    readers.runtime_read = runtime_read("ok_rsi", NOW_MS + 5_000, NOW_MS + 5_000)
    await gather_at(readers, "glance", NOW_MS + 6_000)
    clock["s"] = NOW_S + 7
    routes._respond(old_full, "full")
    readers.runtime_read = fs.OwnerRead(None, fs.SOURCE_UNAVAILABLE)
    failed = await gather_at(readers, "full", NOW_MS + 8_000)
    clock["s"] = NOW_S + 8
    trading = card(routes._respond(failed, "full"), "ok_rsi")["trading"]
    assert trading["held"] is True
    assert trading["observed_ms"] == NOW_MS + 5_000, "the newest admitted capability"


@sync
async def test_an_older_read_completing_later_is_not_admitted(monkeypatch, store):
    readers = ScriptedReaders(store)
    monkeypatch.setattr(routes, "LAST_KNOWN", fs.LastKnown())
    readers.account_read = fs.OwnerRead(
        account_analytics(observed_ms=NOW_MS - 5_000, amount="1100")
    )
    await gather_at(readers, "glance", NOW_MS)
    readers.account_read = fs.OwnerRead(
        account_analytics(observed_ms=NOW_MS - 60_000, amount="1000")
    )
    await gather_at(
        readers, "full", NOW_MS + 1_000
    )  # a slower read, of an older observation
    stored = routes.LAST_KNOWN.wallet[SERVER]
    assert stored["current"]["priced_total"] == "1100"


@sync
async def test_projection_writes_no_last_known_state(monkeypatch, store):
    readers = ScriptedReaders(store)
    monkeypatch.setattr(routes, "LAST_KNOWN", fs.LastKnown())
    readers.account_read = fs.OwnerRead(account_analytics(observed_ms=NOW_MS - 10_000))
    readers.runtime_read = runtime_read("ok_rsi", NOW_MS - 2_000, NOW_MS - 1_000)
    inputs = await gather_at(readers, "full", NOW_MS)
    # Newer evidence admitted by a later read set.
    readers.account_read = fs.OwnerRead(account_analytics(observed_ms=NOW_MS + 5_000))
    await gather_at(readers, "glance", NOW_MS + 5_000)
    before = copy.deepcopy((routes.LAST_KNOWN.wallet, routes.LAST_KNOWN.trading))
    for seconds in (6, 10, 200, 400):
        monkeypatch.setattr(routes.time, "time", lambda s=seconds: NOW_S + s)
        for view in ("full", "glance"):
            routes._respond(inputs, view)  # what every cached response does
    assert (routes.LAST_KNOWN.wallet, routes.LAST_KNOWN.trading) == before


# ── the Live Activity counts its lifetime from the source read (review of 9852e765) ──


def activity_glance(read_at_ms, served_at_ms):
    from condor.push import (
        live_activity as la,
    )  # noqa: F401  (imported for the module under test)

    glance = json.loads(
        (
            Path(__file__).parent
            / "fixtures"
            / "fleet_summary"
            / "summary_glance.example.json"
        ).read_text()
    )
    glance["generated_at_ms"] = served_at_ms
    glance["sources_read_at_ms"] = read_at_ms
    glance["market"] = (
        None  # no market verdict: the global lifetime alone bounds the content
    )
    glance["sections"]["market"] = {
        "status": "missing",
        "observed_at_ms": None,
        "stale_after_ms": 90_000,
        "reason": "FRAME_UNAVAILABLE",
    }
    return glance


def test_a_cached_glance_does_not_extend_the_activity_lifetime():
    from condor.push import live_activity as la

    read_at = NOW_MS
    state = la.content_state(
        activity_glance(read_at, read_at + 59_000), stale_after_seconds=120
    )
    assert state["generated_at_ms"] == read_at, "the data time, not the serving time"
    payload = la.build_update_payload(
        state, now=(read_at + 59_000) / 1000, stale_after_seconds=120
    )
    assert payload["aps"]["stale-date"] == (read_at + 120_000) // 1000
    # The app's global expiry (now - generated >= stale_after) is reached at T+120 s, not T+179 s.
    assert (read_at + 121_000) - state["generated_at_ms"] >= state["stale_after_ms"]


def test_an_older_summary_without_a_read_time_keeps_its_generation_time():
    from condor.push import live_activity as la

    glance = activity_glance(NOW_MS, NOW_MS)
    del glance["sources_read_at_ms"]
    assert la.content_state(glance)["generated_at_ms"] == NOW_MS


def test_a_market_index_the_app_would_reject_is_left_out():
    from condor.push import live_activity as la

    state = la.content_state(activity_glance(NOW_MS, NOW_MS + 30_000))
    admissible = {"as_of_ms": NOW_MS + 5_000, "value": "1"}
    ahead = {"as_of_ms": NOW_MS + 5_001, "value": "1"}
    assert la.with_market_index(state, admissible)["market_index"] == admissible
    assert "market_index" not in la.with_market_index(state, ahead)
    assert la.with_market_index(state, None) == state
