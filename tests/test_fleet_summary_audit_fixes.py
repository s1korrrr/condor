"""End-to-end audit of the fleet summary after #74/#75 (2026-10-28), one regression per finding.

1. The fills section claimed ``ok`` from the newest fill's event time without applying its threshold
   (live: an observation 16,959,966 ms old against ``stale_after_ms`` 120 000). The section clock is
   now the feed's: when the fill ledgers were read. Each fill keeps its own event time.
2. A cache hit ran the whole projection on the event loop (155.6 ms for 16 bots and a year of
   history). It now runs in a worker thread with the response clock taken first.
3. A holdings request queued behind a slow build waited for the lock outside its 12 s deadline.
4. Background summary and holdings rebuilds outlived app shutdown.
"""

import asyncio
import copy
import time
from types import SimpleNamespace

import httpx
import pytest

from condor.web import fleet_summary as fs
from condor.web.routes import fleet_holdings as holdings_route
from condor.web.routes import fleet_summary as routes
from test_fleet_summary import (  # noqa: F401  (store is a pytest fixture)
    NOW_MS,
    NOW_S,
    SERVER,
    FakeReaders,
    client_for,
    fills,
    store,
    sync,
)

# ── 1. fills freshness is the feed's ──


class LedgerReaders(FakeReaders):
    """Fill ledgers whose newest fill is hours old, read (fetched) at ``read_at_ms``."""

    def __init__(self, store, *, read_at_ms, newest_fill_ms):
        super().__init__(store)
        self.read_at_ms, self.newest_fill_ms = read_at_ms, newest_fill_ms

    async def owner(self, bot, path, params):
        if path == "fills":
            return fs.OwnerRead(
                fills(bot, self.newest_fill_ms), read_at_ms=self.read_at_ms
            )
        return await super().owner(bot, path, params)


@sync
async def test_a_quiet_ledger_read_now_is_a_current_feed(store):
    old_fill = NOW_MS - 16_959_966  # the live case: the newest fill 4.7 h old
    readers = LedgerReaders(store, read_at_ms=NOW_MS - 1_000, newest_fill_ms=old_fill)
    body = await fs.build_fleet_summary(
        SERVER, "full", readers, NOW_MS, is_admin=True, user_id=7
    )
    section = body["sections"]["fills"]
    assert section["observed_at_ms"] == NOW_MS - 1_000, "when the feed was read"
    assert section["status"] == "ok"
    assert body["fills"][0]["time_ms"] == old_fill, "each fill keeps its event time"


@sync
async def test_the_fills_section_is_never_ok_past_its_threshold(store):
    readers = LedgerReaders(
        store, read_at_ms=NOW_MS - 1_000, newest_fill_ms=NOW_MS - 3_600_000
    )
    inputs = await fs.gather_fleet_inputs(
        SERVER, "full", readers, NOW_MS, is_admin=True, user_id=7
    )
    for seconds in (0, 60, 119, 121, 300):
        clock = NOW_MS + seconds * 1000
        section = fs.project_fleet_summary(inputs, clock)["sections"]["fills"]
        age = clock - section["observed_at_ms"]
        expected = "stale" if age > section["stale_after_ms"] else "ok"
        assert section["status"] == expected, f"+{seconds} s, age {age} ms"
    late = fs.project_fleet_summary(inputs, NOW_MS + 121_000)["sections"]["fills"]
    assert late["reason"] == fs.OWNER_NOT_CURRENT


@pytest.fixture
def owner_source(monkeypatch):
    requests = []

    async def handler(request):
        requests.append(request.url.path)
        return httpx.Response(200, json={"rows": [], "schema_version": 1})

    monkeypatch.setattr(
        routes.trading_visuals,
        "_sources",
        lambda: {
            "ok_rsi": {"server": SERVER, "url": "http://127.0.0.1:8000/trading-visuals"}
        },
    )
    monkeypatch.setattr(routes.trading_visuals, "source_auth", lambda source: None)
    monkeypatch.setattr(
        routes.trading_visuals,
        "_client",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    return requests


@sync
async def test_an_owner_read_carries_its_fetch_time_and_a_reused_body_keeps_it(
    owner_source, monkeypatch
):
    clock = [NOW_S]
    monkeypatch.setattr(routes.time, "time", lambda: clock[0])
    readers = routes.LiveReaders()
    first = await readers.owner("ok_rsi", "fills", {"limit": "500"})
    clock[0] = NOW_S + 3  # within the 4 s reuse
    reused = await readers.owner("ok_rsi", "fills", {"limit": "500"})
    assert len(owner_source) == 1
    assert (
        first.read_at_ms == reused.read_at_ms == NOW_MS
    ), "a reused body is not renewed"


# ── 2. a projection never holds the event loop ──


@sync
async def test_a_cache_hit_projection_never_holds_the_event_loop(monkeypatch, store):
    client_for(monkeypatch, store, readers=FakeReaders(store))
    monkeypatch.setattr(routes, "CACHE_TTL_SECONDS", 60)
    monkeypatch.setattr(routes, "LAST_KNOWN", fs.LastKnown())
    monkeypatch.setattr(routes, "_refreshes", {})
    monkeypatch.setattr(routes, "_locks", {})
    await routes.cached_summary(SERVER, admin=True, user_id=7, view="full")

    original = fs.project_fleet_summary

    def heavy(inputs, now_ms):  # a year of history for many bots: CPU-bound pure Python
        end = time.perf_counter() + 0.4
        while time.perf_counter() < end:
            pass
        return original(inputs, now_ms)

    monkeypatch.setattr(fs, "project_fleet_summary", heavy)
    gaps, stop = [], asyncio.Event()

    async def ticker():
        last = time.perf_counter()
        while not stop.is_set():
            await asyncio.sleep(0.01)
            now = time.perf_counter()
            gaps.append(now - last)
            last = now

    tick = asyncio.create_task(ticker())
    await asyncio.sleep(0.05)
    body = await routes.cached_summary(SERVER, admin=True, user_id=7, view="full")
    stop.set()
    await tick
    assert body["view"] == "full"
    assert max(gaps) < 0.2, f"the loop stalled {max(gaps):.3f} s"


@sync
async def test_the_response_clock_is_taken_when_the_request_is_answered(
    monkeypatch, store
):
    client_for(monkeypatch, store, readers=FakeReaders(store))
    monkeypatch.setattr(routes, "CACHE_TTL_SECONDS", 60)
    monkeypatch.setattr(routes, "LAST_KNOWN", fs.LastKnown())
    await routes.cached_summary(SERVER, admin=True, user_id=7, view="full")
    clocks = []
    original = fs.project_fleet_summary

    def recording(inputs, now_ms):
        clocks.append(now_ms)
        return original(inputs, now_ms)

    monkeypatch.setattr(fs, "project_fleet_summary", recording)
    monkeypatch.setattr(routes.time, "time", lambda: NOW_S + 7)
    body = await routes.cached_summary(SERVER, admin=True, user_id=7, view="full")
    assert clocks == [NOW_MS + 7_000] and body["generated_at_ms"] == NOW_MS + 7_000


# ── 3. a holdings request is bounded end to end ──


@sync
async def test_a_queued_holdings_request_keeps_its_own_deadline(monkeypatch):
    class HangingOwners:
        def registered_bots(self, server):
            return ["bot_a", "bot_b"]

        async def owner(self, bot, path, params):
            await asyncio.Event().wait()  # an owner read that never answers

    monkeypatch.setattr(routes, "READERS", HangingOwners())
    monkeypatch.setattr(holdings_route, "_cache", {})
    monkeypatch.setattr(holdings_route, "_locks", {})
    monkeypatch.setattr(holdings_route, "_refreshes", {})
    monkeypatch.setattr(holdings_route, "TOTAL_TIMEOUT", 0.3)

    async def timed():
        started = time.monotonic()
        with pytest.raises(holdings_route.HTTPException) as failure:
            await holdings_route.cached_holdings("main")
        return failure.value.status_code, time.monotonic() - started

    first, second = await asyncio.gather(timed(), timed())
    assert first[0] == second[0] == 504
    assert second[1] < 0.5, f"the queued request took {second[1]:.2f} s"


# ── 4. background rebuilds belong to the app lifespan ──


@sync
async def test_shutdown_stops_and_awaits_background_rebuilds(monkeypatch, store):
    client_for(monkeypatch, store, readers=FakeReaders(store))
    monkeypatch.setattr(routes, "CACHE_TTL_SECONDS", 0.05)
    monkeypatch.setattr(routes, "LAST_KNOWN", fs.LastKnown())
    monkeypatch.setattr(routes, "_refreshes", {})
    monkeypatch.setattr(routes, "_locks", {})
    routes.accept_refreshes()
    await routes.cached_summary(SERVER, admin=True, user_id=7, view="full")
    await asyncio.sleep(0.06)

    async def never(*args, **kwargs):
        await asyncio.Event().wait()

    monkeypatch.setattr(fs, "gather_fleet_inputs", never)
    await routes.cached_summary(SERVER, admin=True, user_id=7, view="full")
    (rebuild,) = routes._refreshes.values()
    await asyncio.sleep(0.01)
    assert not rebuild.done()

    await asyncio.wait_for(routes.stop_refreshes(), 1.0)
    assert rebuild.done()
    # Shutting down, a stale read set still serves, but no new rebuild starts.
    body = await routes.cached_summary(SERVER, admin=True, user_id=7, view="full")
    assert body["view"] == "full"
    assert not [t for t in routes._refreshes.values() if not t.done()]
    routes.accept_refreshes()


@sync
async def test_holdings_shutdown_stops_and_awaits_background_rebuilds(monkeypatch):
    calls = []

    class Owners:
        def registered_bots(self, server):
            return ["bot_a"]

        async def owner(self, bot, path, params):
            calls.append(bot)
            if len(calls) > 1:
                await asyncio.Event().wait()
            return fs.OwnerRead(None, fs.SOURCE_UNAVAILABLE)

    monkeypatch.setattr(routes, "READERS", Owners())
    monkeypatch.setattr(holdings_route, "_cache", {})
    monkeypatch.setattr(holdings_route, "_locks", {})
    monkeypatch.setattr(holdings_route, "_refreshes", {})
    monkeypatch.setattr(holdings_route, "CACHE_TTL_SECONDS", 0.05)
    holdings_route.accept_refreshes()
    await holdings_route.cached_holdings("main")
    await asyncio.sleep(0.06)
    await holdings_route.cached_holdings("main")  # starts the background rebuild
    (rebuild,) = holdings_route._refreshes.values()
    await asyncio.sleep(0.01)
    await asyncio.wait_for(holdings_route.stop_refreshes(), 1.0)
    assert rebuild.done()
    await holdings_route.cached_holdings("main")
    assert not [t for t in holdings_route._refreshes.values() if not t.done()]
    holdings_route.accept_refreshes()


def test_the_web_lifespan_owns_the_background_rebuilds(monkeypatch):
    import config_manager
    from condor import server_data_service
    from condor.web import app as web_app
    from condor.web import live_activity_publisher as publisher

    class Service:
        is_running, has_subscriptions = False, False

        def start(self):
            pass

        def stop(self):
            pass

        async def wait_closed(self):
            pass

        async def subscribe(self, *args):
            pass

        def unsubscribe_all(self, subscriber):
            pass

    async def stop_publisher(task):
        pass

    monkeypatch.setattr(server_data_service, "get_server_data_service", Service)
    monkeypatch.setattr(
        config_manager,
        "get_config_manager",
        lambda: SimpleNamespace(list_servers=lambda: {}),
    )
    monkeypatch.setattr(publisher, "start_publisher", lambda *args: None)
    monkeypatch.setattr(publisher, "stop_publisher", stop_publisher)
    monkeypatch.setattr(routes, "_refreshes", {})
    monkeypatch.setattr(holdings_route, "_refreshes", {})
    app = web_app.create_app()
    owned = {}

    async def lifespan():
        async with app.router.lifespan_context(app):
            assert routes._accepting_refreshes and holdings_route._accepting_refreshes
            owned["summary"] = asyncio.create_task(asyncio.Event().wait())
            owned["holdings"] = asyncio.create_task(asyncio.Event().wait())
            routes._refreshes[(SERVER, True, "full")] = owned["summary"]
            holdings_route._refreshes["main"] = owned["holdings"]
        assert all(task.cancelled() for task in owned.values())
        assert (
            not routes._accepting_refreshes and not holdings_route._accepting_refreshes
        )

    asyncio.run(lifespan())
    routes.accept_refreshes()
    holdings_route.accept_refreshes()


# ── review of 5e19fc8c ──


def test_shutdown_keeps_a_running_history_read_joinable_across_a_restart(
    monkeypatch, store
):
    """A history worker still running at shutdown stays registered until its thread ends, so the
    restarted app (a new event loop) joins it instead of starting a second worker for the key.
    """
    import threading

    started, release, calls = threading.Event(), threading.Event(), []
    original = fs._sync_reads

    def blocking(*args):
        calls.append(1)
        started.set()
        release.wait(5)
        return original(*args)

    monkeypatch.setattr(fs, "_sync_reads", blocking)
    monkeypatch.setattr(routes, "LAST_KNOWN", fs.LastKnown())
    readers = FakeReaders(store)

    async def gather(timeout):
        return await fs.gather_fleet_inputs(
            SERVER,
            "full",
            readers,
            NOW_MS,
            is_admin=True,
            user_id=7,
            last_known=routes.LAST_KNOWN,
            history_timeout=timeout,
        )

    async def first_lifespan():
        inputs = await gather(0.05)  # gives up waiting; the worker keeps running
        assert started.is_set() and isinstance(inputs.sync_result, TimeoutError)
        await routes.stop_refreshes(history_drain_seconds=0.05)
        (job,) = routes.LAST_KNOWN.history_jobs.values()
        assert not job.done(), "still registered while its thread runs"

    async def restarted_lifespan():
        routes.accept_refreshes()
        threading.Timer(0.1, release.set).start()
        inputs = await gather(5)
        histories, _ = inputs.sync_result
        assert histories["1D"], "the restarted app joined the running read"

    try:
        asyncio.run(first_lifespan())
        asyncio.run(restarted_lifespan())
    finally:
        release.set()
        routes.accept_refreshes()
    assert len(calls) == 1, f"{len(calls)} history workers ran for one key"
    assert (
        not routes.LAST_KNOWN.history_jobs
    ), "the job leaves the registry when its thread ends"


@sync
async def test_the_fills_read_clock_never_changes_the_validator(store):
    async def body_read_at(read_at_ms, newest_fill_ms=NOW_MS - 3_600_000):
        readers = LedgerReaders(
            store, read_at_ms=read_at_ms, newest_fill_ms=newest_fill_ms
        )
        return await fs.build_fleet_summary(
            SERVER, "full", readers, NOW_MS, is_admin=True, user_id=7
        )

    first = await body_read_at(NOW_MS - 16_000)
    later = await body_read_at(NOW_MS - 1_000)  # the same ledgers, fetched 15 s later
    assert (
        first["sections"]["fills"]["observed_at_ms"]
        != later["sections"]["fills"]["observed_at_ms"]
    )
    assert fs.etag_for(first) == fs.etag_for(later)
    assert fs.etag_for(fs.glance(first)) == fs.etag_for(fs.glance(later))
    changed = await body_read_at(NOW_MS - 1_000, newest_fill_ms=NOW_MS - 60_000)
    assert fs.etag_for(changed) != fs.etag_for(later), "changed fills are a change"
    stale = copy.deepcopy(later)
    stale["sections"]["fills"]["status"] = "stale"
    assert fs.etag_for(stale) != fs.etag_for(later), "a freshness verdict is a change"
