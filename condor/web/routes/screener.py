"""Authenticated, server-scoped reads from the native market screener."""

from __future__ import annotations

import asyncio
import re

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response

from condor.web.auth import get_current_user
from condor.web.models import WebUser
from config_manager import get_config_manager

router = APIRouter(prefix="/servers/{name}/screener", tags=["market-screener"])

TOTAL_TIMEOUT = 5.0
JSON_MAX_BYTES = 2 * 1024 * 1024
CANDLES_MAX_BYTES = 5 * 1024 * 1024
_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$")
_INSTRUMENT = re.compile(r"^okx:spot:[A-Z0-9]{1,30}-USDC$")
_READ_PATHS = frozenset({"capabilities", "snapshot", "candles", "history", "health"})


def _validated_request(path: str, request: Request) -> tuple[str, list[tuple[str, str]], int]:
    """Map a small set of public suffixes and parameters to native API GETs."""
    params = list(request.query_params.multi_items())
    bots = [value for key, value in params if key == "bot"]
    if path == "capabilities":
        if len(bots) > 1 or (bots and not _IDENTIFIER.fullmatch(bots[0])):
            raise HTTPException(400, "Specify at most one registered bot")
    elif len(bots) != 1 or not _IDENTIFIER.fullmatch(bots[0]):
        raise HTTPException(400, "Specify exactly one registered bot")
    bot = bots[0] if bots else None
    if path not in _READ_PATHS and not path.startswith("instruments/"):
        raise HTTPException(404, "Screener route not found")
    suffix = path
    if path.startswith("instruments/"):
        instrument_id = path.removeprefix("instruments/")
        if not _INSTRUMENT.fullmatch(instrument_id):
            raise HTTPException(404, "Screener instrument not found")
        suffix = "instruments/" + instrument_id
    allowed = {
        "capabilities": {"bot"},
        "snapshot": {"bot", "interval", "screen", "limit", "cursor", "search", "filters", "sort", "direction", "watchlist_ids"},
        "instruments/": {"bot", "snapshot_id"},
        "candles": {"bot", "instrument_id", "interval", "start", "end", "limit", "snapshot_id"},
        "history": {"bot", "instrument_id", "interval", "start", "end", "limit"},
        "health": {"bot"},
    }
    key = "instruments/" if path.startswith("instruments/") else path
    permitted = allowed[key]
    if any(name not in permitted for name, _ in params):
        raise HTTPException(400, "Unsupported screener query parameter")
    for name in {key for key, _ in params} - {"watchlist_ids"}:
        if sum(1 for item, _ in params if item == name) != 1:
            raise HTTPException(400, f"Specify {name} once")
    if sum(1 for name, _ in params if name == "watchlist_ids") > 250:
        raise HTTPException(400, "Watchlist filter exceeds 250 instrument identities")
    if any(not _INSTRUMENT.fullmatch(value) for name, value in params if name == "watchlist_ids"):
        raise HTTPException(400, "Watchlist identities must be qualified OKX spot USDC instruments")
    if "filters" in dict(params) and len(dict(params)["filters"]) > 8192:
        raise HTTPException(413, "Screener filter definition is too large")
    if any(len(value) > 256 for key, value in params if key != "filters"):
        raise HTTPException(400, "Screener query value is too long")
    if sum(len(key) + len(value) for key, value in params) > 16_384:
        raise HTTPException(413, "Screener query is too large")
    if path in {"candles", "history"}:
        instrument_ids = [value for key, value in params if key == "instrument_id"]
        if len(instrument_ids) != 1 or not _INSTRUMENT.fullmatch(instrument_ids[0]):
            raise HTTPException(400, "Specify one qualified OKX spot instrument")
    forwarded = [(key, value) for key, value in params if key != "bot"]
    if bot is not None:
        forwarded.append(("bot", bot))
    return suffix, forwarded, (
        CANDLES_MAX_BYTES if path == "candles" else JSON_MAX_BYTES
    )


@router.get("/{path:path}")
async def read_screener(
    name: str,
    path: str,
    request: Request,
    user: WebUser = Depends(get_current_user),
):
    cm = get_config_manager()
    if not cm.has_server_access(user.id, name):
        raise HTTPException(404, "Screener source not found")
    suffix, params, max_bytes = _validated_request(path, request)
    try:
        async with asyncio.timeout(TOTAL_TIMEOUT):
            client = await cm.get_client(name)
            transport = client.bot_orchestration
            url = f"{transport.base_url}/market-screener/{suffix}"
            async with transport.session.get(
                url, params=params, allow_redirects=False,
                timeout=TOTAL_TIMEOUT,
            ) as upstream:
                if 300 <= upstream.status < 400:
                    raise HTTPException(502, "Native screener returned an unexpected redirect")
                content_type = upstream.headers.get("Content-Type", "application/json").split(";", 1)[0].lower()
                if content_type != "application/json" and not content_type.endswith("+json"):
                    raise HTTPException(502, "Native screener returned a non-JSON response")
                body = bytearray()
                async for chunk in upstream.content.iter_chunked(64 * 1024):
                    if len(body) + len(chunk) > max_bytes:
                        raise HTTPException(502, "Native screener response exceeds the size limit")
                    body.extend(chunk)
                return Response(
                    content=bytes(body),
                    status_code=upstream.status,
                    media_type=upstream.headers.get("Content-Type", "application/json"),
                    headers={
                        "Cache-Control": "no-store",
                        "X-Content-Type-Options": "nosniff",
                    },
                )
    except HTTPException:
        raise
    except TimeoutError:
        raise HTTPException(502, "Native screener exceeded the five-second deadline") from None
    except Exception:
        # Do not reflect transport internals, target URLs, or auth material.
        raise HTTPException(502, "Native screener source unavailable") from None
