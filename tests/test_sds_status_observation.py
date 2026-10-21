"""Status publication and bounded reporting observation share one native fetch."""

import asyncio
import threading
from unittest.mock import AsyncMock, Mock

import pytest

from condor import paper_performance, performance_history, wallet_observation
from condor.server_data_service import CacheKey, ServerDataService, ServerDataType


def status_service(monkeypatch, fetch):
    service = ServerDataService()
    monkeypatch.setattr(service, "_get_client", AsyncMock(return_value=object()))
    service.register_fetch(ServerDataType.BOTS_STATUS, fetch)
    return service, CacheKey.make("native", ServerDataType.BOTS_STATUS)


@pytest.mark.asyncio
async def test_status_cache_uses_native_fetch_time_after_slow_history(monkeypatch):
    clock = {"now": 100.0}
    monkeypatch.setattr("condor.server_data_service.time.time", lambda: clock["now"])
    entered = threading.Event()
    release = threading.Event()
    recorded = []

    def record(server, body):
        entered.set()
        assert release.wait(5)
        recorded.append((server, body))

    monkeypatch.setattr(performance_history, "history", Mock(record=record))
    monkeypatch.setattr(
        wallet_observation, "observe_runtime", AsyncMock(return_value={})
    )
    service, key = status_service(
        monkeypatch, AsyncMock(return_value=[{"status": "running"}])
    )
    task = asyncio.create_task(service._fetch_and_cache(key))
    try:
        assert await asyncio.to_thread(entered.wait, 5)
        clock["now"] = 111.0
        assert not task.done(), (
            "native history must commit before the status is published"
        )
    finally:
        release.set()
    assert await task == [{"status": "running"}]
    assert recorded == [("native", [{"status": "running"}])]
    assert service.get_entry("native", ServerDataType.BOTS_STATUS).fetched_at == 100.0
    assert service.get("native", ServerDataType.BOTS_STATUS) is None
    service.stop()
    await service.wait_closed()


@pytest.mark.asyncio
async def test_blocked_wallet_reader_cannot_block_native_status_or_shutdown(
    monkeypatch,
):
    entered = asyncio.Event()
    release = asyncio.Event()

    async def blocked_runtime(server):
        entered.set()
        await release.wait()
        return {}

    monkeypatch.setattr(performance_history, "history", Mock())
    monkeypatch.setattr(wallet_observation, "observe_runtime", blocked_runtime)
    service, key = status_service(
        monkeypatch, AsyncMock(return_value=[{"status": "running"}])
    )
    try:
        assert await asyncio.wait_for(service._fetch_and_cache(key), 2) == [
            {"status": "running"}
        ]
        await asyncio.wait_for(entered.wait(), 2)
        assert service.get("native", ServerDataType.BOTS_STATUS) == [
            {"status": "running"}
        ]
        service.stop()
        draining = asyncio.create_task(service.wait_closed())
        await asyncio.sleep(0)
        assert not draining.done(), "shutdown must own the detached wallet observation"
    finally:
        release.set()
    await asyncio.wait_for(draining, 2)


@pytest.mark.asyncio
async def test_wallet_demand_coalesces_only_unstarted_reads_and_preserves_read_bodies(
    monkeypatch,
):
    entered = threading.Event()
    release = threading.Event()
    recorded = []
    reads = []

    async def observe(server):
        body = {"id": "first" if not reads else "second"}
        reads.append(body["id"])
        return body

    def wallet(server, samples):
        if samples["live"] == "first":
            entered.set()
            assert release.wait(5)
        recorded.append(("live", samples["live"]))

    history = Mock()
    history.record.side_effect = lambda server, body: recorded.append(
        ("native", body[0]["sequence"])
    )
    history.record_wallet.side_effect = wallet
    history.record_paper.side_effect = lambda server, samples: recorded.append(
        ("paper", samples["paper"])
    )
    history.record_paper_wallet.side_effect = lambda server, samples: recorded.append(
        ("paper_wallet", samples["paper_wallet"])
    )
    monkeypatch.setattr(performance_history, "history", history)
    monkeypatch.setattr(wallet_observation, "observe_runtime", observe)
    monkeypatch.setattr(
        wallet_observation, "wallet_samples", lambda body: {"live": body["id"]}
    )
    monkeypatch.setattr(
        paper_performance, "paper_samples", lambda body, now: {"paper": body["id"]}
    )
    monkeypatch.setattr(
        wallet_observation,
        "paper_wallet_samples",
        lambda body: {"paper_wallet": body["id"]},
    )
    sequence = iter(range(4))
    service, key = status_service(
        monkeypatch,
        AsyncMock(side_effect=lambda client: [{"sequence": next(sequence)}]),
    )
    try:
        assert await asyncio.wait_for(service._do_fetch_and_cache(key), 2) == [
            {"sequence": 0}
        ]
        assert await asyncio.to_thread(entered.wait, 5)
        for expected in (1, 2, 3):
            assert await asyncio.wait_for(service._do_fetch_and_cache(key), 2) == [
                {"sequence": expected}
            ]
        assert reads == ["first"], (
            "new demands cannot start a second concurrent runtime read"
        )
    finally:
        release.set()
    service.stop()
    await asyncio.wait_for(service.wait_closed(), 2)
    assert reads == ["first", "second"], "only unstarted demands may coalesce"
    assert [row for row in recorded if row[0] == "native"] == [
        ("native", 0),
        ("native", 1),
        ("native", 2),
        ("native", 3),
    ]
    assert [row for row in recorded if row[0] != "native"] == [
        ("live", "first"),
        ("paper", "first"),
        ("paper_wallet", "first"),
        ("live", "second"),
        ("paper", "second"),
        ("paper_wallet", "second"),
    ]


@pytest.mark.asyncio
async def test_stop_rejects_new_work_but_drains_accepted_native_and_wallet(monkeypatch):
    fetch_entered = asyncio.Event()
    release_fetch = asyncio.Event()
    wallet_entered = asyncio.Event()
    release_wallet = asyncio.Event()
    history = Mock()

    async def fetch(client):
        fetch_entered.set()
        await release_fetch.wait()
        return [{"status": "running"}]

    async def observe(server):
        wallet_entered.set()
        await release_wallet.wait()
        return {}

    monkeypatch.setattr(performance_history, "history", history)
    monkeypatch.setattr(wallet_observation, "observe_runtime", observe)
    service, key = status_service(monkeypatch, fetch)
    accepted = asyncio.create_task(service._fetch_and_cache(key))
    await asyncio.wait_for(fetch_entered.wait(), 2)
    service.stop()
    try:
        with pytest.raises(RuntimeError, match="stopping"):
            await asyncio.wait_for(service._fetch_and_cache(key), 0.2)
        with pytest.raises(RuntimeError, match="stopping"):
            await service.subscribe("native", ServerDataType.BOTS_STATUS, "late")
        with pytest.raises(RuntimeError, match="drain"):
            service.start()
        draining = asyncio.create_task(service.wait_closed())
        assert not draining.done()
        release_fetch.set()
        assert await asyncio.wait_for(accepted, 2) == [{"status": "running"}]
        await asyncio.wait_for(wallet_entered.wait(), 2)
        assert not draining.done()
        release_wallet.set()
        await asyncio.wait_for(draining, 2)
        history.record.assert_called_once_with("native", [{"status": "running"}])
        service.start()
        service.stop()
        await service.wait_closed()
    finally:
        release_fetch.set()
        release_wallet.set()


@pytest.mark.asyncio
async def test_cancelled_reader_cannot_cancel_shared_status_or_its_wallet_batch(
    monkeypatch,
):
    fetch_entered = asyncio.Event()
    release_fetch = asyncio.Event()
    wallet_entered = asyncio.Event()
    release_wallet = asyncio.Event()
    history = Mock()

    async def fetch(client):
        fetch_entered.set()
        await release_fetch.wait()
        return [{"status": "running"}]

    async def observe(server):
        wallet_entered.set()
        await release_wallet.wait()
        return {}

    monkeypatch.setattr(performance_history, "history", history)
    monkeypatch.setattr(wallet_observation, "observe_runtime", observe)
    service, key = status_service(monkeypatch, fetch)
    leaving = asyncio.create_task(service._fetch_and_cache(key))
    staying = asyncio.create_task(service._fetch_and_cache(key))
    try:
        await asyncio.wait_for(fetch_entered.wait(), 2)
        leaving.cancel()
        with pytest.raises(asyncio.CancelledError):
            await leaving
        release_fetch.set()
        assert await asyncio.wait_for(staying, 2) == [{"status": "running"}]
        await asyncio.wait_for(wallet_entered.wait(), 2)
        service.stop()
        draining = asyncio.create_task(service.wait_closed())
        await asyncio.sleep(0)
        assert not draining.done()
        release_wallet.set()
        await asyncio.wait_for(draining, 2)
        history.record.assert_called_once_with("native", [{"status": "running"}])
    finally:
        release_fetch.set()
        release_wallet.set()


@pytest.mark.asyncio
async def test_cancelled_shutdown_waiter_still_drains_owned_writer(monkeypatch):
    entered = asyncio.Event()
    release = asyncio.Event()

    async def observe(server):
        entered.set()
        await release.wait()
        return {}

    monkeypatch.setattr(performance_history, "history", Mock())
    monkeypatch.setattr(wallet_observation, "observe_runtime", observe)
    service, key = status_service(
        monkeypatch, AsyncMock(return_value=[{"status": "running"}])
    )
    await service._fetch_and_cache(key)
    await asyncio.wait_for(entered.wait(), 2)
    service.stop()
    draining = asyncio.create_task(service.wait_closed())
    await asyncio.sleep(0)
    draining.cancel()
    await asyncio.sleep(0)
    assert not draining.done(), "cancellation cannot abandon an accepted observation"
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(draining, 2)
    assert not service._wallet_tasks


@pytest.mark.asyncio
async def test_demands_coalesce_before_wallet_task_starts(monkeypatch):
    observe = AsyncMock(return_value={})
    monkeypatch.setattr(wallet_observation, "observe_runtime", observe)
    service = ServerDataService()
    service._request_wallet_observation("native")
    service._request_wallet_observation("native")
    service.stop()
    await service.wait_closed()
    observe.assert_awaited_once_with("native")


@pytest.mark.asyncio
async def test_unexpected_detached_wallet_failure_is_logged(monkeypatch, caplog):
    service = ServerDataService()
    monkeypatch.setattr(
        service,
        "_record_wallet_observation",
        AsyncMock(side_effect=ImportError("missing observer")),
    )
    service._request_wallet_observation("native")
    service.stop()
    await service.wait_closed()
    assert "Wallet and paper observation task failed for native" in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize("failed_domain", ["wallet", "paper"])
async def test_observed_bodies_attempt_each_independent_store_after_one_failure(
    monkeypatch, caplog, failed_domain
):
    attempts = []

    def writer(domain):
        def record(_server, _samples):
            attempts.append(domain)
            if domain == failed_domain:
                raise OSError(f"{domain} store failed")

        return record

    history = Mock(
        record_wallet=writer("wallet"),
        record_paper=writer("paper"),
        record_paper_wallet=writer("paper_wallet"),
    )
    monkeypatch.setattr(performance_history, "history", history)
    monkeypatch.setattr(
        wallet_observation, "observe_runtime", AsyncMock(return_value={"body": True})
    )
    monkeypatch.setattr(wallet_observation, "wallet_samples", lambda _body: {"live": 1})
    monkeypatch.setattr(
        paper_performance, "paper_samples", lambda _body, _now: {"paper": 2}
    )
    monkeypatch.setattr(
        wallet_observation, "paper_wallet_samples", lambda _body: {"paper": 3}
    )

    await ServerDataService()._record_wallet_observation("native")

    assert attempts == ["wallet", "paper", "paper_wallet"]
    assert f"{failed_domain} store failed" in caplog.text
