"""``GET /servers/{name}/fleet/fills``: every bot's fills in one ordered, bot-labelled, cursor-paged feed.

Read-only, like ``fleet/summary``: it reuses that route's live readers (same registered reporting sources,
same authenticated owner reads), never starts an owner, sends no command and writes no storage. All the
merging is in ``condor.web.fleet_fills``; this module authorizes, validates the query, shares one owner
read across a burst of requests and speaks HTTP (ETag, ``If-None-Match``, no-cache).
"""

from __future__ import annotations

import asyncio
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response

from condor.web import fleet_fills as feed
from condor.web.auth import get_current_user
from condor.web.fleet_summary import canonical_json, etag_for
from condor.web.models import WebUser
from condor.web.routes import fleet_summary as summary_route
from config_manager import get_config_manager

router = APIRouter(tags=["fleet"])

TOTAL_TIMEOUT = 12.0
CACHE_TTL_SECONDS = 5.0  # one owner read serves a burst of dashboard, phone and watch pages
HEADERS = {
    "Cache-Control": "private, no-cache",
    "X-Content-Type-Options": "nosniff",
    "Vary": "Authorization",
}
ALLOWED_QUERY = {"limit", "before", "bot", "side", "pair", "schema"}
SINGLE_VALUED = ALLOWED_QUERY - {"bot"}

# The window does not depend on the user, only on the server: filters and the cursor apply per request.
_cache: dict[str, tuple[float, dict]] = {}
_locks: dict[str, asyncio.Lock] = {}


def _readers():
    # Looked up at call time so the summary route's readers (and its test seams) stay the one source.
    return summary_route.READERS


async def _window(server: str) -> dict:
    async with _locks.setdefault(server, asyncio.Lock()):
        hit = _cache.get(server)
        if hit is None or hit[0] <= time.monotonic():
            try:
                async with asyncio.timeout(TOTAL_TIMEOUT):
                    window = await feed.read_window(server, _readers(), time.time() * 1000)
            except TimeoutError:
                raise HTTPException(
                    status_code=504, detail="Fleet fills exceeded their deadline"
                ) from None
            hit = (time.monotonic() + CACHE_TTL_SECONDS, window)
            if CACHE_TTL_SECONDS > 0:
                _cache[server] = hit
    return hit[1]


@router.get("/servers/{name}/fleet/fills")
async def fleet_fills(
    name: str, request: Request, user: WebUser = Depends(get_current_user)
):
    cm = get_config_manager()
    if not cm.has_server_access(user.id, name):
        raise HTTPException(status_code=404, detail="Server not found")
    pairs = request.query_params.multi_items()
    params: dict[str, list[str]] = {}
    for key, value in pairs:
        params.setdefault(key, []).append(value)
    if set(params) - ALLOWED_QUERY or any(
        len(params[key]) > 1 for key in SINGLE_VALUED if key in params
    ):
        raise HTTPException(
            status_code=400, detail="Unsupported or repeated fleet fills parameter"
        )
    if params.get("schema", [feed.SCHEMA_VERSION])[0] != feed.SCHEMA_VERSION:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported schema; this server speaks {feed.SCHEMA_VERSION}",
        )
    try:
        limit = (
            int(params["limit"][0]) if "limit" in params else feed.DEFAULT_LIMIT
        )
    except ValueError:
        raise HTTPException(status_code=400, detail="limit must be an integer") from None
    window = await _window(name)
    try:
        body = feed.build_page(
            window,
            limit=limit,
            before=params["before"][0] if "before" in params else None,
            bots=params.get("bot"),
            side=params["side"][0] if "side" in params else None,
            pair=params["pair"][0] if "pair" in params else None,
        )
    except feed.FeedQueryError as error:
        raise HTTPException(status_code=400, detail=str(error)) from None
    tag = etag_for(body)
    headers = {**HEADERS, "ETag": tag, "X-Fleet-Fills-Schema": feed.SCHEMA_VERSION}
    if summary_route._tag_matches(request.headers.get("If-None-Match"), tag):
        return Response(status_code=304, headers=headers)
    return Response(canonical_json(body), media_type="application/json", headers=headers)
