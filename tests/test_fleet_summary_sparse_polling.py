"""Sparse clients must not be kept one poll behind healthy fleet sources."""

import asyncio
from types import SimpleNamespace

import httpx
import pytest
from test_fleet_summary import store  # noqa: F401 - fixture
from test_fleet_summary import (
    NOW_MS,
    SERVER,
    FakeReaders,
    _capability,
    _observed,
    client_for,
    quant_summary,
    sync,
)

from condor.push.live_activity import content_state
from condor.web import fleet_summary as summary
from condor.web.routes import fleet_summary as routes


@pytest.fixture
def healthy_cache(monkeypatch, store):
    clock = {"seconds": NOW_MS / 1000, "monotonic": 0.0}
    started, release = asyncio.Event(), asyncio.Event()
    release.set()

    class HealthyReaders(FakeReaders):
        async def owner(self, bot, path, params):
            started.set()
            await release.wait()
            observed_ms = clock["seconds"] * 1000
            if path == "bootstrap":
                body = _observed(_capability(), observed_ms)
                body["runtime_status"]["bot_name"] = bot
                body["monitoring"]["bot_name"] = bot
                return summary.OwnerRead(body)
            if path == "quant-summary":
                return summary.OwnerRead(quant_summary(bot, observed_ms))
            return await super().owner(bot, path, params)

    client = client_for(monkeypatch, store, readers=HealthyReaders(store))
    monkeypatch.setattr(routes, "CACHE_TTL_SECONDS", 5)
    monkeypatch.setattr(routes, "LAST_KNOWN", summary.LastKnown())
    monkeypatch.setattr(routes, "_cache", {})
    monkeypatch.setattr(routes, "_locks", {})
    monkeypatch.setattr(routes, "_refreshes", {})
    monkeypatch.setattr(routes, "_accepting_refreshes", True)
    monkeypatch.setattr(
        routes,
        "time",
        SimpleNamespace(
            time=lambda: clock["seconds"],
            monotonic=lambda: clock["monotonic"],
        ),
    )
    return clock, started, release, client.app


@pytest.mark.parametrize("view", ["full", "glance"])
@pytest.mark.parametrize("gap_seconds", [30.0, 58.5])
@sync
async def test_sparse_polls_wait_for_new_inputs_after_bot_freshness_expires(
    monkeypatch, healthy_cache, view, gap_seconds
):
    clock, started, release, _ = healthy_cache
    first = await routes.cached_summary(SERVER, admin=True, user_id=7, view=view)
    assert first["bot_counts"]["live_stale_reports"] == 0

    # Three minute-spaced samples can all lag the healthy sources by one poll.
    # Use the retained 58.5 s incident age and the exact 30 s expiry boundary.
    for _ in range(3):
        clock["seconds"] += gap_seconds
        clock["monotonic"] += gap_seconds
        release.clear()
        started.clear()
        request = asyncio.create_task(
            routes.cached_summary(SERVER, admin=True, user_id=7, view=view)
        )
        try:
            await asyncio.wait_for(started.wait(), timeout=1)
            completed, _ = await asyncio.wait({request}, timeout=0.1)
            if completed:
                expired = request.result()
                content = content_state(
                    expired if view == "glance" else summary.glance(expired)
                )
                symptom = (
                    f"source_age_seconds={(clock['seconds'] * 1000 - content['generated_at_ms']) / 1000}, "
                    f"live_stale_reports={expired['bot_counts']['live_stale_reports']}, "
                    f"content_stale={content['stale']}"
                )
            else:
                symptom = "new source read pending"
            assert not completed, (
                "Expired inputs were served while healthy new reads were still in flight; "
                f"sparse polling stays one refresh behind: {symptom}"
            )
        finally:
            release.set()
            await asyncio.gather(request, *routes._refreshes.values())
        body = request.result()
        assert body["sources_read_at_ms"] == int(clock["seconds"] * 1000)
        assert body["bot_counts"]["live_stale_reports"] == 0
        assert body["sections"]["bots"]["status"] in {"ok", "partial"}
        glance = await routes.cached_summary(
            SERVER, admin=True, user_id=7, view="glance"
        )
        state = content_state(glance)
        assert state["generated_at_ms"] == body["sources_read_at_ms"]

    # Waiting after an idle gap retains the existing total deadline. A failed
    # source read must neither renew the old inputs nor cancel the background build.
    clock["seconds"] += gap_seconds
    clock["monotonic"] += gap_seconds
    release.clear()
    monkeypatch.setattr(routes, "TOTAL_TIMEOUT", 0.05)
    fallback = await routes.cached_summary(SERVER, admin=True, user_id=7, view=view)
    assert fallback["sources_read_at_ms"] < int(clock["seconds"] * 1000)
    assert fallback["bot_counts"]["live_stale_reports"] > 0
    release.set()
    await asyncio.gather(*routes._refreshes.values())
    recovered = await routes.cached_summary(SERVER, admin=True, user_id=7, view=view)
    assert recovered["sources_read_at_ms"] == int(clock["seconds"] * 1000)
    assert recovered["bot_counts"]["live_stale_reports"] == 0


@pytest.mark.parametrize("view", ["full", "glance"])
@sync
async def test_deadline_serves_completed_reads_at_response_clock(
    healthy_cache, monkeypatch, view
):
    clock, started, release, app = healthy_cache
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        path = f"/api/v1/servers/{SERVER}/fleet/summary?view={view}"
        # Seed a full read: it must support either response view on fallback.
        await routes.cached_summary(SERVER, admin=True, user_id=7, view="full")
        first = await client.get(path)
        assert first.status_code == 200
        first_body = first.json()
        clock["seconds"] += 31
        clock["monotonic"] += 31
        release.clear()
        started.clear()
        monkeypatch.setattr(routes, "TOTAL_TIMEOUT", 0.03)
        request = asyncio.create_task(
            client.get(path, headers={"If-None-Match": first.headers["ETag"]})
        )
        try:
            await asyncio.wait_for(started.wait(), 1)
            # The response uses the clock after waiting, not the arrival clock.
            clock["seconds"] += 1
            response = await request
            assert response.status_code == 200
            body = response.json()
            assert body["sources_read_at_ms"] == first_body["sources_read_at_ms"]
            assert body["generated_at_ms"] == NOW_MS + 32_000
            assert body["bots"] and {c["bot"] for c in body["bots"]} == {
                c["bot"] for c in first_body["bots"]
            }
            assert all(c["report_stale"] for c in body["bots"] if not c["paper"])
            assert (
                body["bot_counts"]["live_stale_reports"]
                == body["bot_counts"]["live_total"]
            )
            assert body["sections"]["bots"]["status"] == "stale"
            assert response.headers["ETag"] == summary.etag_for(body)
            assert response.headers["ETag"] != first.headers["ETag"]
            tasks = list(routes._refreshes.values())
            assert (
                len(tasks) == 1 and not tasks[0].done()
            ), "deadline must not cancel the rebuild"
        finally:
            release.set()
            await asyncio.gather(
                request, *routes._refreshes.values(), return_exceptions=True
            )
        # The same rebuild completes and the next poll uses its new reads.
        recovered = await client.get(path)
        assert recovered.status_code == 200
        current = recovered.json()
        assert (
            current["sources_read_at_ms"]
            == current["generated_at_ms"]
            == NOW_MS + 32_000
        )
        assert current["bot_counts"]["live_stale_reports"] == 0
        confirmed = await client.get(
            path, headers={"If-None-Match": recovered.headers["ETag"]}
        )
        assert confirmed.status_code == 304


@sync
async def test_deadline_without_completed_reads_returns_504(healthy_cache, monkeypatch):
    _, _, release, app = healthy_cache
    release.clear()
    monkeypatch.setattr(routes, "TOTAL_TIMEOUT", 0.03)
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get(f"/api/v1/servers/{SERVER}/fleet/summary")
        assert response.status_code == 504
        assert (SERVER, True) not in routes._cache
    finally:
        release.set()


@pytest.mark.parametrize("view", ["full", "glance"])
@sync
async def test_foreground_rebuild_before_deadline_returns_current_reads(
    healthy_cache, monkeypatch, view
):
    clock, started, release, app = healthy_cache
    await routes.cached_summary(SERVER, admin=True, user_id=7, view="full")
    clock["seconds"] += 31
    clock["monotonic"] += 31
    started.clear()
    release.clear()
    monkeypatch.setattr(routes, "TOTAL_TIMEOUT", 1)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        request = asyncio.create_task(
            client.get(f"/api/v1/servers/{SERVER}/fleet/summary?view={view}")
        )
        try:
            await asyncio.wait_for(started.wait(), 1)
            assert not request.done()
        finally:
            release.set()
        response = await request
    assert response.status_code == 200
    body = response.json()
    assert body["sources_read_at_ms"] == body["generated_at_ms"] == NOW_MS + 31_000
    assert body["bot_counts"]["live_stale_reports"] == 0
    assert all(not c["report_stale"] for c in body["bots"] if not c["paper"])


@sync
async def test_cold_deadline_rechecks_reads_completed_during_build(
    healthy_cache, monkeypatch
):
    _, _, _, app = healthy_cache
    original = routes._respond
    projections = 0

    async def gated_first_projection(inputs, view):
        nonlocal projections
        projections += 1
        if projections == 1:
            # The read step completed, but the first response missed its deadline.
            await asyncio.Event().wait()
        return await original(inputs, view)

    monkeypatch.setattr(routes, "_respond", gated_first_projection)
    monkeypatch.setattr(routes, "TOTAL_TIMEOUT", 0.1)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get(f"/api/v1/servers/{SERVER}/fleet/summary")
    assert response.status_code == 200
    assert projections == 2
    assert response.json()["sources_read_at_ms"] == NOW_MS
