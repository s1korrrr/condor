"""Condor web publishes the fleet Live Activity content; the push worker only sends it.

Every ``push.live_activity.interval_seconds`` the publisher reads the distinct (owner, server)
pairs among active Live Activity tokens in the shared push registry, builds each pair's glance
through the same cached code path as ``GET /servers/{name}/fleet/summary?view=glance``, and
stores ``content_state(glance)`` with its build time (``condor.push.live_activity``). Nothing
runs unless the deployment passes an enabled ``live_activity`` section; with no active token it
builds nothing. A failure is logged and retried next interval; it never stops the web app.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Any, Awaitable, Callable

from condor.push import live_activity as la
from condor.push.config import LiveActivityConfig, PushConfigError, parse_live_activity
from condor.push.store import Registry
from condor.web import live_activity_market as market

logger = logging.getLogger("condor.web.live_activity")

# The validated ``push.live_activity`` section as JSON, passed by the deployment beside the
# registry path (CONDOR_PUSH_REGISTRY). Absent means the publisher stays off.
ENV_LIVE_ACTIVITY = "CONDOR_PUSH_LIVE_ACTIVITY"
ENV_REGISTRY = "CONDOR_PUSH_REGISTRY"

GlanceFor = Callable[[str, int], Awaitable[dict]]
# The Market index object for one server (``live_activity_market.build_market_index``).
MarketIndexFor = Callable[[str], Awaitable[dict]]


def configured_interval() -> int:
    """``push.live_activity.interval_seconds`` from the deployment, or the section's default."""
    raw = os.environ.get(ENV_LIVE_ACTIVITY)
    try:
        return parse_live_activity(json.loads(raw) if raw else {}).interval_seconds
    except (ValueError, PushConfigError):
        return LiveActivityConfig().interval_seconds


def configured_stale_after() -> int:
    """The same configured global lifetime used by the sender and local content route."""
    raw = os.environ.get(ENV_LIVE_ACTIVITY)
    try:
        return parse_live_activity(json.loads(raw) if raw else {}).stale_after_seconds
    except (ValueError, PushConfigError):
        return LiveActivityConfig().stale_after_seconds


def publisher_settings() -> tuple[Registry, LiveActivityConfig] | None:
    """The registry and the section when publishing is configured and enabled, else None."""
    raw, path = os.environ.get(ENV_LIVE_ACTIVITY), os.environ.get(ENV_REGISTRY)
    if not raw or not path:
        return None
    try:
        config = parse_live_activity(json.loads(raw))
    except (ValueError, PushConfigError) as exc:
        logger.error("live activity publisher off: invalid configuration (%s)", exc)
        return None
    if not config.enabled:
        return None
    try:
        return Registry(path), config
    except Exception as exc:  # noqa: BLE001 - a broken registry never stops the web app
        logger.error(
            "live activity publisher off: registry unavailable (%s)",
            exc.__class__.__name__,
        )
        return None


INDEX_BUDGET_MAX_SECONDS = 35.0


def index_budget(config: LiveActivityConfig) -> float:
    """How long one pass waits for the Market index: min(35 s, half the interval)."""
    return min(INDEX_BUDGET_MAX_SECONDS, 0.5 * config.interval_seconds)


async def _index_within(
    market_index: MarketIndexFor, server: str, budget: float
) -> dict:
    async with asyncio.timeout(budget):
        return await market_index(server)


def _reason(exc: BaseException) -> str:
    if isinstance(exc, TimeoutError):
        return "exceeded the pass budget"
    return str(exc)[:120] or exc.__class__.__name__


async def publish_once(
    registry: Registry,
    glance_for: GlanceFor,
    *,
    market_index: MarketIndexFor,
    index_budget_seconds: float = INDEX_BUDGET_MAX_SECONDS,
    stale_after_seconds: int = 600,
    clock: Callable[[], float] = time.time,
) -> int:
    """Build and store the content for every (owner, server) with an active token, at most
    ``MAX_PUBLISHED_PAIRS``; the pass's counts go to the registry for the worker heartbeat.

    The summary never waits on the Market index: each server's index build starts first and
    runs concurrently (bounded by ``index_budget_seconds``) while the glance content is built
    and published as before, carrying the last good index while it is still reusable. When a
    fresh index arrives, that server's owners are published again with it. A failed build
    keeps the last good index for up to 180 s (``stale`` recomputed), then omits it.
    """
    pairs = await asyncio.to_thread(registry.live_activity_owners)
    if not pairs:
        return 0
    kept = pairs[: la.MAX_PUBLISHED_PAIRS]
    dropped = len(pairs) - len(kept)
    if dropped:
        logger.warning(
            "live activity publisher dropped %d of %d owner/server pairs (limit %d)",
            dropped,
            len(pairs),
            la.MAX_PUBLISHED_PAIRS,
        )
    servers = list(dict.fromkeys(server for _, server in kept))
    tasks = {
        server: asyncio.create_task(
            _index_within(market_index, server, index_budget_seconds)
        )
        for server in servers
    }
    written = failed = 0
    published: dict[tuple[int, str], dict] = {}
    try:
        for user_id, server in kept:
            try:
                state = la.content_state(
                    await glance_for(server, user_id),
                    stale_after_seconds=stale_after_seconds,
                )
            except LookupError:
                failed += 1
                logger.warning(
                    "live activity content skipped: user %s has no access to server %s",
                    user_id,
                    server,
                )
                continue
            except Exception as exc:  # noqa: BLE001 - one pair never stops the others
                failed += 1
                logger.warning(
                    "live activity content for server %s failed error=%s",
                    server,
                    exc.__class__.__name__,
                )
                continue
            published[(user_id, server)] = state
            reused = market.reusable_index(server, now=clock())
            await asyncio.to_thread(
                la.publish_content,
                registry,
                user_id,
                server,
                {**state, "market_index": reused} if reused else state,
                built_at=clock(),
            )
            written += 1
        results = await asyncio.gather(*tasks.values(), return_exceptions=True)
    finally:
        for task in tasks.values():
            task.cancel()
    index_failed: dict[str, str] = {}
    for server, result in zip(tasks, results):
        if isinstance(result, BaseException):
            index_failed[server] = _reason(result)
            continue
        market.remember_index(server, result, now=clock())
        for (user_id, owner_server), state in published.items():
            if owner_server == server:
                await asyncio.to_thread(
                    la.publish_content,
                    registry,
                    user_id,
                    server,
                    {**state, "market_index": result},
                    built_at=clock(),
                )
    if index_failed:
        logger.warning(
            "live activity market index not refreshed for %d server(s): %s",
            len(index_failed),
            "; ".join(
                f"{server}: {reason}" for server, reason in sorted(index_failed.items())
            ),
        )
    await asyncio.to_thread(
        registry.set_meta,
        la.PUBLISHER_META_KEY,
        {
            "built_at": clock(),
            "pairs": len(pairs),
            "published": written,
            "failed": failed,
            "dropped_pairs": dropped,
            "index_failed": len(index_failed),
        },
    )
    return written


async def run_publisher(
    registry: Registry,
    config: LiveActivityConfig,
    glance_for: GlanceFor,
    *,
    market_index: MarketIndexFor,
    clock: Callable[[], float] = time.time,
    sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
) -> None:
    """Publish every interval until cancelled."""
    while True:
        try:
            await publish_once(
                registry,
                glance_for,
                market_index=market_index,
                index_budget_seconds=index_budget(config),
                stale_after_seconds=config.stale_after_seconds,
                clock=clock,
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - the web app outlives a failed pass
            logger.warning(
                "live activity publish pass failed error=%s", exc.__class__.__name__
            )
        await sleep(float(config.interval_seconds))


def start_publisher(
    glance_for: GlanceFor, market_index: MarketIndexFor
) -> asyncio.Task | None:
    """Start the background publisher when configured; None when it stays off."""
    settings = publisher_settings()
    if settings is None:
        return None
    registry, config = settings
    logger.info("live activity publisher started interval=%ss", config.interval_seconds)
    return asyncio.create_task(
        run_publisher(registry, config, glance_for, market_index=market_index),
        name="live-activity-publisher",
    )


async def stop_publisher(task: asyncio.Task | None) -> None:
    if task is None:
        return
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    except Exception as exc:  # noqa: BLE001 - shutdown must finish
        logger.warning(
            "live activity publisher ended with error=%s", exc.__class__.__name__
        )
