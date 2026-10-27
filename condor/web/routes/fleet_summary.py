"""``GET /servers/{name}/fleet/summary``: the one fleet summary every client reads.

Read-only. It never starts an owner, never sends a command and writes no storage. All the
computation is in ``condor.web.fleet_summary``; this module only authorizes, wires the live
readers (stored history, bots status cache, Market Picture gateway, registered reporting
sources) and speaks HTTP (ETag, ``If-None-Match``, no-cache).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
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
from condor.web.portfolio_contract import Analytics
from condor.web.routes import market_picture, trading_visuals
from config_manager import get_config_manager

router = APIRouter(tags=["fleet"])
logger = logging.getLogger(__name__)

OWNER_TIMEOUT = 6.0  # a bootstrap observation is the largest read (about 0.7 MB for a busy V1 bot)
MARKET_TIMEOUT = 4.0
TOTAL_TIMEOUT = 12.0
CACHE_TTL_SECONDS = (
    5.0  # one computation serves a burst of dashboard, phone and watch polls
)
HEADERS = {
    "Cache-Control": "private, no-cache",
    "X-Content-Type-Options": "nosniff",
    "Vary": "Authorization, X-RSIBOT-Wallet-Claims",
}
WALLET_CLAIMS_HEADER = "X-RSIBOT-Wallet-Claims"
NATIVE_ACCOUNT_CLAIMS = "native-account-v1"
ALLOWED_QUERY = {"view", "schema"}
HISTORY_WINDOW = "6h"  # the verdict replays the last six hours of stored breadth

# A full result can serve either view. A glance-only result can serve only a glance; it
# must never be returned as a full payload. Each view coalesces its own builds:
# a slow full read must not consume a glance request's deadline in lock wait.
# At most one full and one glance computation run for a server/principal key.
_cache: dict[tuple[str, bool], dict[str, tuple[float, dict]]] = {}
_locks: dict[tuple[str, bool, str], asyncio.Lock] = {}


class _SummaryPhaseRecorder:
    """Small request-local timing summary; phase keys never contain bot or user IDs."""

    def __init__(self) -> None:
        self._next_token = 0
        self._active: dict[int, tuple[str, float]] = {}
        self._completed: dict[str, dict[str, float | int]] = {}

    def phase_started(self, name: str, started: float) -> int:
        self._next_token += 1
        self._active[self._next_token] = (name, started)
        return self._next_token

    def phase_finished(self, token: int, outcome: str, elapsed: float) -> None:
        active = self._active.pop(token, None)
        if active is None:
            return
        name, _ = active
        row = self._completed.setdefault(
            name,
            {
                "count": 0,
                "complete": 0,
                "unavailable": 0,
                "cancelled": 0,
                "error": 0,
                "total_ms": 0,
                "max_ms": 0,
            },
        )
        elapsed_ms = max(0, round(elapsed * 1000))
        row["count"] += 1
        row[outcome] += 1
        row["total_ms"] += elapsed_ms
        row["max_ms"] = max(row["max_ms"], elapsed_ms)

    def snapshot(self) -> dict[str, Any]:
        now = time.monotonic()
        return {
            "active": [
                {"phase": name, "elapsed_ms": max(0, round((now - started) * 1000))}
                for name, started in sorted(self._active.values())
            ],
            "completed": {
                name: dict(values) for name, values in sorted(self._completed.items())
            },
        }


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
            async with asyncio.timeout(OWNER_TIMEOUT):
                return await get_server_data_service().get_or_fetch(
                    server, ServerDataType.BOTS_STATUS
                )
        except Exception:
            return None

    def performance(self, server: str, bot: str, range_: str, now_s: float) -> dict:
        return history.read(server, bot, range_, now_s)

    async def account(self, server: str, user_id: Any) -> summary.OwnerRead:
        cm = get_config_manager()
        if not cm.has_server_access(user_id, server):
            return summary.OwnerRead(None, summary.FORBIDDEN)
        try:
            async with asyncio.timeout(OWNER_TIMEOUT):
                client = await cm.get_client(server)
                payload = await client.portfolio._get(
                    "portfolio/analytics", params={"range": "1D", "refresh": "false"}
                )
            return summary.OwnerRead(
                Analytics.model_validate(payload).model_dump(by_alias=True)
            )
        except Exception:
            return summary.OwnerRead(None, summary.SOURCE_UNAVAILABLE)

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
                async with summary.phase_span("market.latest"):
                    client = await cm.get_client(server)
                    transport = client.bot_orchestration
                    frame = await read(transport, "latest", {})
        except Exception:
            return summary.MarketRead(reason=summary.FRAME_UNAVAILABLE)
        try:
            async with asyncio.timeout(MARKET_TIMEOUT):
                async with summary.phase_span("market.history"):
                    page = await read(
                        transport,
                        "history",
                        {
                            "snapshot_id": frame["snapshot_id"],
                            "window": HISTORY_WINDOW,
                            "limit": "1500",
                            "resolution": "1m",
                            # The dashboard's Market Pulse replays this projection; a thinned
                            # page would smooth and hold over different points.
                            "projection": "canonical_state",
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
# Last good wallet and trading observations, so one slow or failed read does not blank them.
LAST_KNOWN = summary.LastKnown()


def _tag_matches(header: Optional[str], tag: str) -> bool:
    if not header:
        return False
    candidates = [part.strip() for part in header.split(",")]
    return (
        "*" in candidates
        or tag in candidates
        or any(c.removeprefix("W/") == tag for c in candidates)
    )


def _http_wallet_projection(body: dict, native_claims: bool) -> dict:
    """Keep the canonical cache; old clients must never label a subtotal Equity."""
    wallet = body.get("wallet")
    if (
        not native_claims
        and isinstance(wallet, dict)
        and wallet.get("valuation_complete") is False
    ):
        return {**body, "wallet": None}
    return body


async def cached_summary(
    name: str, *, admin: bool, user_id: Any, view: str = "full"
) -> dict:
    """Build or read one view through the shared micro-cache. Raises TimeoutError."""
    if view not in summary.VIEWS:
        raise ValueError(f"unknown view {view!r}")
    key = (name, admin)
    trace = _SummaryPhaseRecorder()
    started = time.monotonic()
    acquired = False
    cache_status = "pending"
    deadline = asyncio.timeout(TOTAL_TIMEOUT)
    with summary.capture_phase_recorder(trace):
        try:
            async with deadline:
                lock = _locks.setdefault((*key, view), asyncio.Lock())
                async with summary.phase_span("cache.lock_wait"):
                    await lock.acquire()
                acquired = True
                try:
                    now = time.monotonic()
                    entry = _cache.get(key, {})
                    full_hit = entry.get("full")
                    if full_hit is not None and full_hit[0] <= now:
                        full_hit = None
                    view_hit = entry.get(view)
                    if view_hit is not None and view_hit[0] <= now:
                        view_hit = None

                    if view == "full" and full_hit is not None:
                        cache_status = "full_hit"
                        return full_hit[1]
                    if view == "glance":
                        if full_hit is not None:
                            cache_status = "full_hit_projected"
                            return summary.glance(full_hit[1])
                        if view_hit is not None:
                            cache_status = "view_hit"
                            return view_hit[1]

                    cache_status = "miss"
                    async with summary.phase_span("summary.build"):
                        body = await summary.build_fleet_summary(
                            name,
                            view,
                            READERS,
                            time.time() * 1000,
                            is_admin=admin,
                            user_id=user_id,
                            clock_ms=lambda: time.time() * 1000,
                            last_known=LAST_KNOWN,
                        )
                    if CACHE_TTL_SECONDS > 0:
                        expires = time.monotonic() + CACHE_TTL_SECONDS
                        entry = _cache.setdefault(key, {})
                        entry[view] = (expires, body)
                        if view == "full":
                            entry["glance"] = (expires, summary.glance(body))
                    return body
                finally:
                    if acquired:
                        lock.release()
        except TimeoutError:
            kind = "deadline" if deadline.expired() else "source_timeout"
            logger.warning(
                "event=fleet_summary_timeout kind=%s deadline_ms=%d elapsed_ms=%d view=%s cache=%s phases=%s",
                kind,
                round(TOTAL_TIMEOUT * 1000),
                round((time.monotonic() - started) * 1000),
                view,
                cache_status,
                json.dumps(trace.snapshot(), sort_keys=True, separators=(",", ":")),
            )
            raise


async def glance_for(name: str, user_id: Any) -> dict:
    """The glance exactly as ``GET /servers/{name}/fleet/summary?view=glance`` serves it to
    ``user_id``. Raises LookupError when the user has no access to the server, TimeoutError
    when the computation exceeds its deadline."""
    cm = get_config_manager()
    if not cm.has_server_access(user_id, name):
        raise LookupError("server not found")
    return await cached_summary(
        name, admin=bool(cm.is_admin(user_id)), user_id=user_id, view="glance"
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
    try:
        body = await cached_summary(
            name,
            admin=bool(cm.is_admin(user.id)),
            user_id=user.id,
            view=view,
        )
    except TimeoutError:
        raise HTTPException(
            status_code=504, detail="Fleet summary exceeded its deadline"
        ) from None
    body = _http_wallet_projection(
        body, request.headers.get(WALLET_CLAIMS_HEADER) == NATIVE_ACCOUNT_CLAIMS
    )
    tag = summary.etag_for(body)
    headers = {**HEADERS, "ETag": tag, "X-Fleet-Summary-Schema": summary.SCHEMA_VERSION}
    if _tag_matches(request.headers.get("If-None-Match"), tag):
        return Response(status_code=304, headers=headers)
    return Response(
        summary.canonical_json(body), media_type="application/json", headers=headers
    )
