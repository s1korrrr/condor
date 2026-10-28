"""Paper bots keep their own simulated statistics, and slow owners never fail the whole fleet read.

Regressions from 2026-10-28 (rsibot-stack-v2):

* the paper owners' runtime-status detail body grew to 2.6 MB, past the observer's 2 MiB limit, so no
  paper PnL or wallet sample was recorded and the phone showed "No history yet";
* paper rejections were silent, so the stop had no named cause;
* a paper card had no ``report_at_ms`` whenever the owner reads failed ("No report");
* one slow source (local history, or the market frame plus its history) held the whole summary past
  its 12 s deadline, so the response was 504 and nothing was cached for the next poll;
* the holdings route queued five owner reads behind a gate of four, stacking two owner timeouts onto
  its 12 s deadline, and repeated the summary's own quant-summary reads.
"""

import asyncio
import json
import logging
import threading
import time
from datetime import datetime, timezone
from types import SimpleNamespace

import httpx
import pytest

from condor import paper_performance, wallet_observation
from condor.web import fleet_pnl
from condor.web import fleet_summary as fs
from condor.web.routes import fleet_holdings as holdings_route
from condor.web.routes import fleet_summary as routes
from test_fleet_summary import (
    NOW_MS,
    NOW_S,
    SERVER,
    FakeReaders,
    card,
    client_for,
    store,  # noqa: F401  (pytest fixture)
    sync,
)

PAPER = "meridian_v4_paper"


def iso(seconds):
    return datetime.fromtimestamp(seconds, tz=timezone.utc).isoformat()


def paper_runtime(at):
    return {
        "simulated": True,
        "runtime_status": {
            "bot_name": PAPER,
            "updated_at": iso(at),
            "simulated": True,
            "source_runtime_status_id": "paper-src",
            "controllers": [{"controller_id": "c_btc", "pair": "BTC-USDC"}],
            "balances": [
                {"asset": "USDC", "total_balance": 1000.0, "value_quote": 1000.0}
            ],
            "summary": {
                "pnl_available": True,
                "realized_pnl_quote": 12.5,
                "unrealized_pnl_quote": -2.5,
                "fees_quote": 1.0,
                "net_pnl_quote": 10.0,
                "fees_included_in_pnl": True,
                "simulated": True,
                "balance_value_quote": 1000.0,
                "balance_value_scope": "paper_simulated_wallet",
                "balance_value_currency": "USDC",
            },
        },
    }


# ── the paper runtime observer ──


def test_the_runtime_reader_asks_for_the_bounded_monitor_view():
    """The detail body of a busy paper owner exceeds MAX_BYTES; the monitor view is the owner's bounded
    monitoring transport and still carries everything the wallet and paper projections read.
    """
    requests = []
    small = json.dumps(paper_runtime(NOW_S - 5)).encode()
    oversized = (
        b'{"runtime_status": {"lifecycle_executors": "'
        + b"x" * (wallet_observation.MAX_BYTES + 1)
        + b'"}}'
    )

    def handler(request):
        requests.append(dict(request.url.params))
        monitor = request.url.params.get("view") == "monitor"
        return httpx.Response(200, content=small if monitor else oversized)

    async def read():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await wallet_observation._read(
                client, {"url": "http://127.0.0.1:8000/trading-visuals"}, PAPER
            )

    body = asyncio.run(read())
    assert requests == [{"bot": PAPER, "view": "monitor"}]
    assert (
        paper_performance.project_paper(body, PAPER, NOW_S)["total_pnl_quote"] == "10.0"
    )
    assert wallet_observation.project_wallet(body, PAPER)["simulated"] is True


@pytest.mark.asyncio
async def test_a_paper_observation_is_aged_when_read_not_after_other_samples_are_stored(
    monkeypatch,
):
    from unittest.mock import AsyncMock, Mock

    from condor import performance_history
    from condor.server_data_service import ServerDataService

    clock = [NOW_S]
    monkeypatch.setattr("condor.server_data_service.time.time", lambda: clock[0])

    async def observe(server):
        return {PAPER: paper_runtime(NOW_S - 5), "rsi_modular_v2": None}

    def slow_wallet_store(server, samples):
        clock[0] = NOW_S + 200  # the live wallet write waited on the store

    observer = Mock()
    observer.record_wallet.side_effect = slow_wallet_store
    monkeypatch.setattr(performance_history, "history", observer)
    monkeypatch.setattr(
        wallet_observation, "observe_runtime", AsyncMock(side_effect=observe)
    )

    await ServerDataService()._record_wallet_observation("v2")

    (_, samples), _ = observer.record_paper.call_args
    assert samples[PAPER] is not None, "a 5 s old report is current when it was read"
    assert samples[PAPER]["total_pnl_quote"] == "10.0"


def test_a_rejected_paper_report_names_its_reason_once_and_its_recovery(caplog):
    paper_performance._rejections.clear()
    caplog.set_level(logging.INFO, logger="condor.paper_performance")
    stale = paper_runtime(NOW_S - 600)
    paper_performance.paper_samples({PAPER: stale}, NOW_S)
    paper_performance.paper_samples({PAPER: stale}, NOW_S)
    paper_performance.paper_samples(
        {PAPER: None}, NOW_S
    )  # a failed read is the reader's to name
    paper_performance.paper_samples({PAPER: paper_runtime(NOW_S - 5)}, NOW_S)
    messages = [r.getMessage() for r in caplog.records]
    rejected = [m for m in messages if m.startswith("event=paper_sample_rejected")]
    assert len(rejected) == 1 and f"bot={PAPER}" in rejected[0]
    assert "Expired paper observation" in rejected[0]
    assert messages[-1] == f"event=paper_sample_recovered bot={PAPER}"


@pytest.mark.asyncio
async def test_a_failed_runtime_read_names_its_reason_once_and_its_recovery(
    monkeypatch, caplog
):
    wallet_observation._read_failures.clear()
    caplog.set_level(logging.INFO, logger="condor.wallet_observation")
    answers = iter(["too big", "too big", None])

    async def fake_read(client, source, bot):
        answer = next(answers)
        if answer:
            raise ValueError("Reporting runtime status exceeds the size limit")
        return paper_runtime(NOW_S)

    monkeypatch.setattr(wallet_observation, "_read", fake_read)
    sources = {PAPER: {"server": "v2", "url": "http://127.0.0.1:8000/trading-visuals"}}
    for _ in range(3):
        await wallet_observation.observe_runtime("v2", sources)
    messages = [r.getMessage() for r in caplog.records]
    failed = [m for m in messages if m.startswith("event=runtime_status_unavailable")]
    assert len(failed) == 1 and "exceeds the size limit" in failed[0]
    assert messages[-1] == f"event=runtime_status_recovered server=v2 bot={PAPER}"


# ── paper cards ──


@sync
async def test_a_paper_card_reports_its_recorded_owner_report_when_owner_reads_fail(
    store,
):
    body = await fs.build_fleet_summary(
        SERVER,
        "full",
        FakeReaders(store, owners=False),
        NOW_MS,
        is_admin=True,
        user_id=7,
    )
    paper = card(body, "ok_rsi_paper")
    # The newest recorded simulated sample (seeded one minute ago) is the paper owner's own report.
    assert paper["report_at_ms"] == NOW_MS - 60_000
    assert paper["report_stale"] is True
    assert all(m["field"] != "report_at_ms" for m in paper["missing"])
    assert (
        paper["pnl_day"]["simulated"] is True and paper["net_now"]["simulated"] is True
    )
    live = card(body, "ok_rsi")
    assert (
        live["report_at_ms"] is None
    ), "a live card never borrows a history sample as a report"
    assert body["bot_counts"]["live_stale_reports"] == 2


# ── a slow source never fails the whole summary ──


@pytest.fixture
def fresh_last_known(monkeypatch):
    last_known = fs.LastKnown()
    monkeypatch.setattr(routes, "LAST_KNOWN", last_known)
    return last_known


def slow_history(readers, delay):
    original = readers.performance
    release = threading.Event()

    def performance(server, bot, range_, now_s):
        release.wait(delay)
        return original(server, bot, range_, now_s)

    readers.performance = performance
    return release


@sync
async def test_a_slow_local_history_read_does_not_fail_the_summary(
    monkeypatch, store, fresh_last_known
):
    readers = FakeReaders(store)
    client_for(monkeypatch, store, readers=readers)
    monkeypatch.setattr(routes, "TOTAL_TIMEOUT", 1.0)
    monkeypatch.setattr(routes, "HISTORY_TIMEOUT", 0.1)
    release = slow_history(readers, 5)
    try:
        body = await routes.cached_summary(SERVER, admin=True, user_id=7, view="full")
    finally:
        release.set()
    # The history source is missing for this build; every other section is still served.
    assert all(body["pnl"][w]["total"] is None for w in ("day", "week", "month", "all"))
    assert body["sections"]["pnl"]["status"] == "missing"
    assert body["sections"]["pnl"]["reason"] == fleet_pnl.HISTORY_READ_FAILED
    assert body["wallet"] is not None and body["market"] is not None
    assert card(body, "ok_rsi_paper")["pnl_day"] is None


@sync
async def test_a_slow_history_read_is_shared_and_its_last_result_is_held(
    monkeypatch, store, fresh_last_known
):
    readers = FakeReaders(store)
    client_for(monkeypatch, store, readers=readers)
    monkeypatch.setattr(routes, "TOTAL_TIMEOUT", 10.0)
    fresh = await routes.cached_summary(SERVER, admin=True, user_id=7, view="full")
    assert fresh["pnl"]["day"]["total"] is not None

    monkeypatch.setattr(routes, "HISTORY_TIMEOUT", 0.2)
    release = slow_history(readers, 5)
    readers.performance_calls.clear()
    try:
        first = await routes.cached_summary(SERVER, admin=True, user_id=7, view="full")
        second = await routes.cached_summary(
            SERVER, admin=True, user_id=7, view="glance"
        )
        reads_while_slow = len(readers.performance_calls)
    finally:
        release.set()
    # The completed read's samples stand in, with their own times; the slow read runs once, not per build.
    assert first["pnl"] == fresh["pnl"]
    assert (
        card(first, "ok_rsi_paper")["pnl_day"] == card(fresh, "ok_rsi_paper")["pnl_day"]
    )
    assert second["pnl"]["day"]["total"] == fresh["pnl"]["day"]["total"]
    assert reads_while_slow <= 1, "one history read is in flight for both builds"


@sync
async def test_the_market_frame_and_history_share_one_budget(monkeypatch):
    monkeypatch.setattr(routes, "MARKET_TIMEOUT", 1.0)  # the shared budget is 2 s

    class Upstream:
        status = 200

        def __init__(self, path):
            self.path = path

        async def __aenter__(self):
            await asyncio.sleep(1.6 if self.path == "latest" else 0.6)
            return self

        async def __aexit__(self, *exc):
            return False

    class Session:
        def get(self, url, params=None, **kwargs):
            return Upstream(url.rsplit("/", 1)[1])

    transport = SimpleNamespace(session=Session(), base_url="http://owner")

    class Manager:
        async def get_client(self, server):
            return SimpleNamespace(bot_orchestration=transport)

    async def body(upstream, limit):
        return {}

    monkeypatch.setattr(routes, "get_config_manager", lambda: Manager())
    monkeypatch.setattr(routes.market_picture, "_body", body)
    monkeypatch.setattr(
        routes,
        "validate_response",
        lambda path, raw: {"snapshot_id": "s" * 64, "items": []},
    )
    started = time.monotonic()
    read = await routes.LiveReaders().market(SERVER, 7)
    elapsed = time.monotonic() - started
    assert read.frame is not None
    assert read.history is None and read.history_reason == fs.HISTORY_UNAVAILABLE
    assert elapsed < 2.3, elapsed


# ── one owner read serves every consumer ──


@pytest.fixture
def owner_source(monkeypatch):
    requests = []
    state = {"status": 200, "delay": 0.05}

    async def handler(request):
        requests.append((request.url.path, dict(request.url.params)))
        await asyncio.sleep(state["delay"])
        return httpx.Response(
            state["status"], json={"bot": request.url.params["bot"], "n": len(requests)}
        )

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
    return requests, state


@sync
async def test_concurrent_identical_owner_reads_share_one_upstream_request(
    owner_source,
):
    requests, _ = owner_source
    readers = routes.LiveReaders()
    first, second = await asyncio.gather(
        readers.owner("ok_rsi", "quant-summary", {}),
        readers.owner("ok_rsi", "quant-summary", {}),
    )
    assert len(requests) == 1
    assert first.payload == second.payload and first.payload is not second.payload
    first.payload["mutated"] = True
    reused = await readers.owner("ok_rsi", "quant-summary", {})
    assert (
        len(requests) == 1 and "mutated" not in reused.payload
    ), "each consumer parses its own copy"
    other = await readers.owner("ok_rsi", "fills", {"limit": "500"})
    assert len(requests) == 2 and other.payload["n"] == 2


@sync
async def test_a_failed_owner_read_is_not_reused(owner_source, monkeypatch):
    requests, state = owner_source
    readers = routes.LiveReaders()
    state["status"] = 503
    failed = await readers.owner("ok_rsi", "bootstrap", {})
    assert failed.payload is None and failed.reason == fs.SOURCE_UNAVAILABLE
    state["status"] = 200
    recovered = await readers.owner("ok_rsi", "bootstrap", {})
    assert recovered.payload is not None and len(requests) == 2


@sync
async def test_a_reused_owner_body_expires(owner_source, monkeypatch):
    requests, _ = owner_source
    readers = routes.LiveReaders()
    await readers.owner("ok_rsi", "quant-summary", {})
    monkeypatch.setattr(routes, "OWNER_REUSE_SECONDS", 0)
    await readers.owner("ok_rsi", "quant-summary", {})
    assert len(requests) == 2


@sync
async def test_a_caller_that_gives_up_does_not_cancel_the_shared_owner_read(
    owner_source,
):
    requests, state = owner_source
    state["delay"] = 0.2
    readers = routes.LiveReaders()
    impatient = asyncio.create_task(readers.owner("ok_rsi", "quant-summary", {}))
    patient = asyncio.create_task(readers.owner("ok_rsi", "quant-summary", {}))
    await asyncio.sleep(0.05)
    impatient.cancel()
    read = await patient
    assert read.payload is not None and len(requests) == 1


# ── holdings ──


@sync
async def test_holdings_read_every_bot_within_one_owner_timeout(monkeypatch):
    bots = [f"bot_v2_{n}" for n in range(6)]

    class SlowOwners:
        def registered_bots(self, server):
            return list(bots)

        async def owner(self, bot, path, params):
            await asyncio.sleep(0.3)
            return fs.OwnerRead(None, fs.SOURCE_UNAVAILABLE)

    monkeypatch.setattr(routes, "READERS", SlowOwners())
    monkeypatch.setattr(holdings_route, "_cache", {})
    monkeypatch.setattr(holdings_route, "TOTAL_TIMEOUT", 0.5)
    body = await holdings_route.cached_holdings("main")
    assert [row["bot"] for row in body["bots"]] == bots
    assert all(row["reason"] == fs.SOURCE_UNAVAILABLE for row in body["bots"])
