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
# How long after generation a completed body serves while it rebuilds.
STALE_SERVE_SECONDS = 60.0
HEADERS = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Vary": "Authorization",
}
ALLOWED_QUERY = {"bot", "schema"}

_cache: dict[str, tuple[float, dict]] = {}
_locks: dict[str, asyncio.Lock] = {}
_refreshes: dict[str, asyncio.Task] = {}  # at most one background rebuild per server


async def _read_all(server: str) -> dict:
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
    return holdings.build_holdings(server, dict(zip(unique, reads)), time.time() * 1000)


async def cached_holdings(server: str) -> dict:
    """Holdings through the shared cache, served without waiting on a rebuild when it can be.

    Every response is re-judged at the request's clock (``holdings.aged``), cache hits included. Past
    its cache life, the last completed body is served for up to ``STALE_SERVE_SECONDS`` after it was
    generated while exactly one background rebuild runs. Only with nothing completed in that
    window does a request wait for a build, and then a 504 is possible at the deadline.
    """
    hit = _cache.get(server)
    if hit is not None:
        expires, body = hit
        now_ms = time.time() * 1000
        if expires > time.monotonic():
            return holdings.aged(body, now_ms)
        if 0 <= now_ms - body["generated_at_ms"] <= STALE_SERVE_SECONDS * 1000:
            _refresh(server)
            return holdings.aged(body, now_ms)
    return holdings.aged(await _build(server), time.time() * 1000)


def _refresh(server: str) -> None:
    task = _refreshes.get(server)
    loop = asyncio.get_running_loop()
    if task is not None and not task.done() and task.get_loop() is loop:
        return

    async def rebuild() -> None:
        try:
            await _build(server)
        except HTTPException as exc:
            # A deadline or an empty registry: the completed body keeps serving.
            logger.warning(
                "event=fleet_holdings_refresh_failed status=%d", exc.status_code
            )
        except Exception:
            logger.exception("event=fleet_holdings_refresh_failed")
        finally:
            if _refreshes.get(server) is asyncio.current_task():
                del _refreshes[server]

    _refreshes[server] = asyncio.create_task(rebuild())


async def _build(server: str) -> dict:
    async with _locks.setdefault(server, asyncio.Lock()):
        hit = _cache.get(server)
        if hit is None or hit[0] <= time.monotonic():
            try:
                async with asyncio.timeout(TOTAL_TIMEOUT):
                    body = await _read_all(server)
            except TimeoutError:
                raise HTTPException(
                    status_code=504, detail="Fleet holdings exceeded their deadline"
                ) from None
            hit = (time.monotonic() + CACHE_TTL_SECONDS, body)
            if CACHE_TTL_SECONDS > 0:
                _cache[server] = hit
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
