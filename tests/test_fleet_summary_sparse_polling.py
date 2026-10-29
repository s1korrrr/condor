"""Sparse clients must not be kept one poll behind healthy fleet sources."""

import asyncio
from types import SimpleNamespace

import pytest
from test_fleet_summary import store  # noqa: F401 - fixture
from test_fleet_summary import (
    NOW_MS,
    SERVER,
    FakeReaders,
    _capability,
    _observed,
    quant_summary,
    sync,
)

from condor.push.live_activity import content_state
from condor.web import fleet_summary as summary
from condor.web.routes import fleet_summary as routes


@pytest.mark.parametrize("view", ["full", "glance"])
@pytest.mark.parametrize("gap_seconds", [30.0, 58.5])
@sync
async def test_sparse_polls_wait_for_new_inputs_after_bot_freshness_expires(
    monkeypatch, store, view, gap_seconds
):
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

    monkeypatch.setattr(routes, "READERS", HealthyReaders(store))
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
    # source read must neither renew the old inputs nor poison the next build.
    clock["seconds"] += gap_seconds
    clock["monotonic"] += gap_seconds
    release.clear()
    monkeypatch.setattr(routes, "TOTAL_TIMEOUT", 0.05)
    with pytest.raises(TimeoutError):
        await routes.cached_summary(SERVER, admin=True, user_id=7, view=view)
    release.set()
    recovered = await routes.cached_summary(SERVER, admin=True, user_id=7, view=view)
    assert recovered["sources_read_at_ms"] == int(clock["seconds"] * 1000)
    assert recovered["bot_counts"]["live_stale_reports"] == 0
