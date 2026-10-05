"""Tests for PERF-059: ServerDataService in-flight fetch coalescing.

Concurrent ``get_or_fetch`` calls for the same cold key must trigger exactly
one backend fetch (single-flight); the outcome — success or failure — is
shared by all coalesced waiters, and a failed fetch never poisons subsequent
fetches for the key.
"""

import asyncio

from condor.server_data_service import ServerDataService, ServerDataType


def _make_sds(fetch_func):
    """Fresh (non-singleton) SDS with a fake client and a registered fetcher."""
    sds = ServerDataService()

    async def _fake_get_client(server_name):
        return object()

    sds._get_client = _fake_get_client
    sds.register_fetch(ServerDataType.PORTFOLIO, fetch_func)
    return sds


def test_concurrent_get_or_fetch_coalesces_to_single_fetch():
    """Two concurrent get_or_fetch calls on a cold key fetch exactly once."""
    calls = {"count": 0}

    async def counting_fetcher(client, **params):
        calls["count"] += 1
        await asyncio.sleep(0.05)  # keep the fetch in flight while others join
        return {"value": calls["count"]}

    async def _drive():
        sds = _make_sds(counting_fetcher)
        results = await asyncio.gather(
            sds.get_or_fetch("srv", ServerDataType.PORTFOLIO),
            sds.get_or_fetch("srv", ServerDataType.PORTFOLIO),
        )
        return sds, results

    sds, results = asyncio.run(_drive())

    assert calls["count"] == 1, "concurrent cold reads must coalesce to one fetch"
    assert results[0] == results[1] == {"value": 1}
    assert sds._inflight == {}, "in-flight map must be cleared once settled"


def test_fetch_failure_shared_by_waiters_and_does_not_poison_next_fetch():
    """All coalesced waiters see the failure; the next fetch starts clean."""
    calls = {"count": 0}
    fail = {"on": True}

    async def flaky_fetcher(client, **params):
        calls["count"] += 1
        await asyncio.sleep(0.05)
        if fail["on"]:
            raise RuntimeError("backend down")
        return {"ok": True}

    async def _drive():
        sds = _make_sds(flaky_fetcher)

        # Both waiters coalesce onto the single failing fetch (no value cached)
        failed = await asyncio.gather(
            sds.get_or_fetch("srv", ServerDataType.PORTFOLIO),
            sds.get_or_fetch("srv", ServerDataType.PORTFOLIO),
        )
        assert failed == [None, None]
        assert calls["count"] == 1
        assert sds._inflight == {}

        # Failure must not poison the key: a later fetch runs and succeeds
        fail["on"] = False
        recovered = await sds.get_or_fetch("srv", ServerDataType.PORTFOLIO)
        assert recovered == {"ok": True}
        assert calls["count"] == 2
        assert sds._inflight == {}

    asyncio.run(_drive())


def test_cancelled_waiter_does_not_cancel_the_shared_fetch():
    """A client that disconnects mid-fetch must not fail the other coalesced readers or abort the fetch.

    Live 2026-10-05: closing a browser tab cancelled ``list_bots`` while ``fleet_summary`` was coalesced onto
    the same BOTS_STATUS fetch; both raised CancelledError and the tick's history persistence was skipped.
    """
    completed = {"count": 0}

    async def slow_fetcher(client, **params):
        await asyncio.sleep(0.05)
        completed["count"] += 1
        return {"value": 1}

    async def _drive():
        sds = _make_sds(slow_fetcher)
        leaving = asyncio.ensure_future(
            sds.get_or_fetch("srv", ServerDataType.PORTFOLIO)
        )
        staying = asyncio.ensure_future(
            sds.get_or_fetch("srv", ServerDataType.PORTFOLIO)
        )
        await asyncio.sleep(0.01)
        leaving.cancel()
        result = await staying
        try:
            await leaving
        except asyncio.CancelledError:
            pass
        else:
            raise AssertionError(
                "the cancelled waiter must observe its own cancellation"
            )
        return sds, result

    sds, result = asyncio.run(_drive())
    assert result == {"value": 1}
    assert completed["count"] == 1, "the shared fetch must run to completion"
    assert sds.get("srv", ServerDataType.PORTFOLIO) == {"value": 1}
    assert sds._inflight == {}
