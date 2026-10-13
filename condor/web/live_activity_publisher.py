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


async def _market_indexes(
    servers: list[str], market_index: MarketIndexFor
) -> tuple[dict[str, dict], dict[str, str]]:
    """One index per server per pass, shared by every owner of that server."""
    built: dict[str, dict] = {}
    failed: dict[str, str] = {}
    for server in servers:
        try:
            built[server] = await market_index(server)
        except Exception as exc:  # noqa: BLE001 - the summary content never waits on it
            failed[server] = str(exc)[:120] or exc.__class__.__name__
    if failed:
        logger.warning(
            "live activity market index omitted for %d server(s): %s",
            len(failed),
            "; ".join(
                f"{server}: {reason}" for server, reason in sorted(failed.items())
            ),
        )
    return built, failed


async def publish_once(
    registry: Registry,
    glance_for: GlanceFor,
    *,
    market_index: MarketIndexFor,
    clock: Callable[[], float] = time.time,
) -> int:
    """Build and store the content for every (owner, server) with an active token, at most
    ``MAX_PUBLISHED_PAIRS``; the pass's counts go to the registry for the worker heartbeat.
    The Market index is built once per server and added as ``market_index``; when it cannot
    be built the content goes out without it.
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
    indexes, index_failed = await _market_indexes(
        list(dict.fromkeys(server for _, server in kept)), market_index
    )
    written = failed = 0
    for user_id, server in kept:
        try:
            state = la.content_state(await glance_for(server, user_id))
            if server in indexes:
                state["market_index"] = indexes[server]
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
        await asyncio.to_thread(
            la.publish_content, registry, user_id, server, state, built_at=clock()
        )
        written += 1
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
                registry, glance_for, market_index=market_index, clock=clock
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
