"""``GET /servers/{name}/fleet/holdings``: current native inventory, one projection for every client.

Read-only. All computation is in ``condor.web.holdings``; this module authorizes, reads each
registered bot's owner ``quant-summary`` through the fleet summary's owner reader, caches one
build briefly and speaks HTTP. ``served_at_ms`` is stamped per response, outside the cache, so a
client ages an observation from the moment it was served, not from when the body was built.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response

from condor.web import holdings
from condor.web.auth import get_current_user
from condor.web.models import WebUser
from condor.web.routes import fleet_summary as summary_route
from config_manager import get_config_manager

router = APIRouter(tags=["fleet"])
logger = logging.getLogger(__name__)

TOTAL_TIMEOUT = 12.0
CACHE_TTL_SECONDS = (
    5.0  # one owner read serves a burst of dashboard, phone and widget polls
)
# How long after they were read completed reads serve while they rebuild.
STALE_SERVE_SECONDS = 60.0
HEADERS = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Vary": "Authorization",
}
ALLOWED_QUERY = {"bot", "schema"}

# Entries hold what a build read, ``(read_at_ms, reads)``, never a judged body.
_cache: dict[str, tuple[float, tuple[float, dict]]] = {}
_locks: dict[str, asyncio.Lock] = {}
_refreshes: dict[str, asyncio.Task] = {}  # at most one background rebuild per server
_accepting_refreshes = True


async def _read_all(server: str) -> tuple[float, dict]:
    """``(read_at_ms, reads)``: each registered bot's owner quant-summary, or its reason code."""
    readers = summary_route.READERS
    bots = readers.registered_bots(server)
    if not bots:
        raise HTTPException(
            status_code=503, detail="No registered reporting sources for this server"
        )

    # Every bot is read at once, as the summary reads them: each read is bounded by the owner timeout
    # and fails into its own reason, so the build ends within one owner timeout. Queuing the reads
    # behind a smaller gate stacked those timeouts past the deadline. The owner reader shares an
    # in-flight or just-completed quant-summary with the summary build.
    async def one(bot: str):
        try:
            read = await readers.owner(bot, "quant-summary", {})
        except Exception:  # a reader that raises is a reader that is down
            return holdings.SOURCE_UNAVAILABLE
        return (
            read.payload
            if read.payload is not None
            else read.reason or holdings.SOURCE_UNAVAILABLE
        )

    unique = list(dict.fromkeys(bots))
    reads = await asyncio.gather(*(one(bot) for bot in unique))
    return time.time() * 1000, dict(zip(unique, reads))


def _respond(server: str, read: tuple[float, dict]) -> dict:
    """The body a read set gives now: the holdings projection at this request's clock, so cached
    reads answer exactly as a fresh build from identical reads would."""
    read_at_ms, reads = read
    return {
        **holdings.build_holdings(server, reads, time.time() * 1000),
        "sources_read_at_ms": int(read_at_ms),
    }


async def cached_holdings(server: str) -> dict:
    """Holdings through the shared cache, served without waiting on a rebuild when it can be.

    The cache keeps what a build read, never a judged body: every response projects the reads at its
    own clock. Past their cache life the reads serve for up to ``STALE_SERVE_SECONDS`` after they were
    read while exactly one background rebuild runs. Only with nothing read in that window does a
    request wait for a build, and then a 504 is possible at the deadline.
    """
    hit = _cache.get(server)
    if hit is not None:
        expires, read = hit
        if expires > time.monotonic():
            return _respond(server, read)
        if 0 <= time.time() * 1000 - read[0] <= STALE_SERVE_SECONDS * 1000:
            _refresh(server)
            return _respond(server, read)
    return _respond(server, await _build(server))


def accept_refreshes() -> None:
    """App start: background rebuilds may run."""
    global _accepting_refreshes
    _accepting_refreshes = True


async def stop_refreshes() -> None:
    """App shutdown: accept no new background rebuild, then cancel and await the running ones."""
    global _accepting_refreshes
    _accepting_refreshes = False
    loop = asyncio.get_running_loop()
    owned = [
        task
        for task in _refreshes.values()
        if not task.done() and task.get_loop() is loop
    ]
    for task in owned:
        task.cancel()
    await asyncio.gather(*owned, return_exceptions=True)


def _refresh(server: str) -> None:
    if not _accepting_refreshes:
        return  # shutting down: the completed reads still serve, nothing new starts
    task = _refreshes.get(server)
    loop = asyncio.get_running_loop()
    if task is not None and not task.done() and task.get_loop() is loop:
        return

    async def rebuild() -> None:
        try:
            await _build(server)
        except HTTPException as exc:
            # A deadline or an empty registry: the completed reads keep serving.
            logger.warning(
                "event=fleet_holdings_refresh_failed status=%d", exc.status_code
            )
        except Exception:
            logger.exception("event=fleet_holdings_refresh_failed")
        finally:
            if _refreshes.get(server) is asyncio.current_task():
                del _refreshes[server]

    _refreshes[server] = asyncio.create_task(rebuild())


async def _build(server: str) -> tuple[float, dict]:
    """Read under the server's lock. One absolute deadline covers waiting for the lock, the cache
    decision and the reads, so a request queued behind a slow build is bounded end to end.
    """
    try:
        async with asyncio.timeout(TOTAL_TIMEOUT):
            async with _locks.setdefault(server, asyncio.Lock()):
                hit = _cache.get(server)
                if hit is None or hit[0] <= time.monotonic():
                    read = await _read_all(server)
                    hit = (time.monotonic() + CACHE_TTL_SECONDS, read)
                    if CACHE_TTL_SECONDS > 0:
                        _cache[server] = hit
    except TimeoutError:
        raise HTTPException(
            status_code=504, detail="Fleet holdings exceeded their deadline"
        ) from None
    return hit[1]


@router.get("/servers/{name}/fleet/holdings")
async def fleet_holdings(
    name: str, request: Request, user: WebUser = Depends(get_current_user)
):
    cm = get_config_manager()
    if not cm.has_server_access(user.id, name):
        raise HTTPException(status_code=404, detail="Server not found")
    pairs = request.query_params.multi_items()
    params = dict(pairs)
    if set(params) - ALLOWED_QUERY or len(pairs) != len(params):
        raise HTTPException(
            status_code=400, detail="Unsupported or repeated fleet holdings parameter"
        )
    if params.get("schema", holdings.SCHEMA_VERSION) != holdings.SCHEMA_VERSION:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported schema; this server speaks {holdings.SCHEMA_VERSION}",
        )
    body = await cached_holdings(name)
    if "bot" in params:
        selected = [row for row in body["bots"] if row["bot"] == params["bot"]]
        if not selected:
            raise HTTPException(
                status_code=404, detail="Bot not registered on this server"
            )
        body = {**body, "bots": selected}
    body = {**body, "served_at_ms": int(time.time() * 1000)}
    return Response(
        json.dumps(body, sort_keys=True, separators=(",", ":")).encode(),
        media_type="application/json",
        headers={**HEADERS, "X-Fleet-Holdings-Schema": holdings.SCHEMA_VERSION},
    )
