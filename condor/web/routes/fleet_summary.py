"""``GET /servers/{name}/fleet/summary``: the one fleet summary every client reads.

Read-only. It never starts an owner, never sends a command and writes no storage. All the
computation is in ``condor.web.fleet_summary``; this module only authorizes, wires the live
readers (stored history, bots status cache, Market Picture gateway, registered reporting
sources) and speaks HTTP (ETag, ``If-None-Match``, no-cache).
"""

from __future__ import annotations

import asyncio
import hashlib
import time
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response

from condor.performance_history import history
from condor.web import fleet_summary as summary
from condor.web.auth import get_current_user
from condor.web.market_picture_contract import validate_response
from condor.web.models import WebUser
from condor.web.routes import market_picture, trading_visuals
from config_manager import get_config_manager

router = APIRouter(tags=["fleet"])

OWNER_TIMEOUT = 6.0  # a bootstrap observation is the largest read (about 0.7 MB for a busy V1 bot)
MARKET_TIMEOUT = 4.0
TOTAL_TIMEOUT = 12.0
CACHE_TTL_SECONDS = (
    5.0  # one computation serves a burst of dashboard, phone and watch polls
)
HEADERS = {
    "Cache-Control": "private, no-cache",
    "X-Content-Type-Options": "nosniff",
    "Vary": "Authorization",
}
ALLOWED_QUERY = {"view", "schema"}
HISTORY_WINDOW = "6h"  # the verdict replays the last six hours of stored breadth

# One computation per (server, admin) serves both views: the glance is a projection of the full body, and
# the market frame and every owner read behind it are shared inside the cache window.
_cache: dict[tuple[str, bool], tuple[float, dict]] = {}
_locks: dict[tuple[str, bool], asyncio.Lock] = {}


class LiveReaders:
    """Readers over the existing backend: nothing here owns storage."""

    def registered_bots(self, server: str) -> Optional[list[str]]:
        try:
            sources = trading_visuals._sources()
        except HTTPException:
            return None
        return [
            bot for bot, source in sources.items() if source.get("server") == server
        ] or None

    async def bots_status(self, server: str) -> Any:
        from condor.server_data_service import ServerDataType, get_server_data_service

        try:
            return await get_server_data_service().get_or_fetch(
                server, ServerDataType.BOTS_STATUS
            )
        except Exception:
            return None

    def performance(self, server: str, bot: str, range_: str, now_s: float) -> dict:
        return history.read(server, bot, range_, now_s)

    def wallet(self, server: str, bot: str, range_: str, now_s: float) -> dict:
        return history.read_wallet(server, bot, range_, now_s)

    async def market(self, server: str, user_id: Any) -> summary.MarketRead:
        cm = get_config_manager()
        principal = f"condor:{hashlib.sha256(server.encode()).hexdigest()}:{user_id}"

        async def read(transport, path: str, params: dict) -> dict:
            async with transport.session.get(
                f"{transport.base_url}/screener/market-picture/v1/{path}",
                params=params,
                headers={"X-Market-Picture-Principal": principal},
                allow_redirects=False,
                timeout=MARKET_TIMEOUT,
            ) as upstream:
                if upstream.status != 200:
                    raise LookupError(str(upstream.status))
                raw = await market_picture._body(upstream, market_picture.MAX_BYTES)
                return validate_response(path, raw)

        try:
            async with asyncio.timeout(MARKET_TIMEOUT * 2):
                client = await cm.get_client(server)
                transport = client.bot_orchestration
                frame = await read(transport, "latest", {})
        except Exception:
            return summary.MarketRead(reason=summary.FRAME_UNAVAILABLE)
        try:
            async with asyncio.timeout(MARKET_TIMEOUT):
                page = await read(
                    transport,
                    "history",
                    {
                        "snapshot_id": frame["snapshot_id"],
                        "window": HISTORY_WINDOW,
                        "limit": "1500",
                        "resolution": "1m",
                    },
                )
            if page.get("snapshot_id") != frame["snapshot_id"]:
                raise ValueError("history is bound to a different frame")
            return summary.MarketRead(frame=frame, history=page["items"])
        except Exception:
            return summary.MarketRead(
                frame=frame, history_reason=summary.HISTORY_UNAVAILABLE
            )

    async def owner(self, bot: str, path: str, params: dict) -> summary.OwnerRead:
        try:
            source = trading_visuals._sources().get(bot)
        except HTTPException:
            return summary.OwnerRead(None, summary.NOT_CONFIGURED)
        if source is None:
            return summary.OwnerRead(None, summary.NOT_CONFIGURED)
        try:
            auth = trading_visuals.source_auth(source)
            async with asyncio.timeout(OWNER_TIMEOUT):
                async with trading_visuals._client() as client:
                    response = await client.get(
                        source["url"].rstrip("/") + "/" + path,
                        params={"bot": bot, **params},
                        auth=auth,
                    )
            if (
                response.status_code != 200
                or len(response.content) > trading_visuals.REPORTING_MAX_BYTES
            ):
                return summary.OwnerRead(None, summary.SOURCE_UNAVAILABLE)
            return summary.OwnerRead(response.json())
        except (httpx.HTTPError, ValueError, KeyError, TimeoutError, OSError):
            return summary.OwnerRead(None, summary.SOURCE_UNAVAILABLE)


READERS = LiveReaders()


def _tag_matches(header: Optional[str], tag: str) -> bool:
    if not header:
        return False
    candidates = [part.strip() for part in header.split(",")]
    return (
        "*" in candidates
        or tag in candidates
        or any(c.removeprefix("W/") == tag for c in candidates)
    )


@router.get("/servers/{name}/fleet/summary")
async def fleet_summary(
    name: str, request: Request, user: WebUser = Depends(get_current_user)
):
    cm = get_config_manager()
    if not cm.has_server_access(user.id, name):
        raise HTTPException(status_code=404, detail="Server not found")
    pairs = request.query_params.multi_items()
    params = dict(pairs)
    if set(params) - ALLOWED_QUERY or len(pairs) != len(params):
        raise HTTPException(
            status_code=400, detail="Unsupported or repeated fleet summary parameter"
        )
    view = params.get("view", "full")
    if view not in summary.VIEWS:
        raise HTTPException(status_code=400, detail="view must be 'full' or 'glance'")
    if params.get("schema", summary.SCHEMA_VERSION) != summary.SCHEMA_VERSION:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported schema; this server speaks {summary.SCHEMA_VERSION}",
        )
    admin = bool(cm.is_admin(user.id))
    key = (name, admin)
    async with _locks.setdefault(key, asyncio.Lock()):
        hit = _cache.get(key)
        if hit is None or hit[0] <= time.monotonic():
            try:
                async with asyncio.timeout(TOTAL_TIMEOUT):
                    full = await summary.build_fleet_summary(
                        name,
                        "full",
                        READERS,
                        time.time() * 1000,
                        is_admin=admin,
                        user_id=user.id,
                    )
            except TimeoutError:
                raise HTTPException(
                    status_code=504, detail="Fleet summary exceeded its deadline"
                ) from None
            hit = (time.monotonic() + CACHE_TTL_SECONDS, full)
            if CACHE_TTL_SECONDS > 0:
                _cache[key] = hit
    body = hit[1] if view == "full" else summary.glance(hit[1])
    tag = summary.etag_for(body)
    headers = {**HEADERS, "ETag": tag, "X-Fleet-Summary-Schema": summary.SCHEMA_VERSION}
    if _tag_matches(request.headers.get("If-None-Match"), tag):
        return Response(status_code=304, headers=headers)
    return Response(
        summary.canonical_json(body), media_type="application/json", headers=headers
    )
