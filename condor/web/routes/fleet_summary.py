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
MARKET_TIMEOUT = 4.0  # the frame and its history share one budget of twice this
# Local history waits for the status read (OWNER_TIMEOUT) first; together they stay inside the deadline.
HISTORY_TIMEOUT = 4.0
# Shutdown waits this long for history reads still running in their worker threads.
HISTORY_DRAIN_SECONDS = 10.0
TOTAL_TIMEOUT = 12.0
# A successful owner body is shared by the summary views and holdings for this long. The body keeps its
# own observation times, so every consumer still judges currency against its own clock.
OWNER_REUSE_SECONDS = 4.0
CACHE_TTL_SECONDS = (
    5.0  # one computation serves a burst of dashboard, phone and watch polls
)
# Past their cache life completed reads still serve, projected at each request's clock, while one
# background rebuild runs, for at most this long after they were read. A build is bounded by
# TOTAL_TIMEOUT, so a working source always lands newer reads well inside this window.
STALE_SERVE_SECONDS = 60.0
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
# Entries hold what a build read (``FleetInputs``), never a judged body, with the monotonic instant
# their cache life ends. Every response projects them at its own clock.
_cache: dict[tuple[str, bool], dict[str, tuple[float, dict]]] = {}
_locks: dict[tuple[str, bool, str], asyncio.Lock] = {}
# At most one background rebuild per server/principal key and view, owned by the app lifespan.
_refreshes: dict[tuple[str, bool, str], asyncio.Task] = {}
_accepting_refreshes = True


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
                "held": 0,
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

    def __init__(self) -> None:
        # One upstream read per (bot, path, params): concurrent identical reads share it, and a successful
        # raw body is reused for OWNER_REUSE_SECONDS. Each consumer parses its own copy.
        self._owner_inflight: dict[tuple, asyncio.Task] = {}
        self._owner_bodies: dict[tuple, tuple[float, bytes]] = {}

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
                # Schema validation of a ~1 MB frame or a 1500-row history page takes about a second of
                # CPU; on the event loop it stalled every other request and fired their timers late.
                return await asyncio.to_thread(validate_response, path, raw)

        # One budget for the frame and its history: a slow frame leaves the history less time, never more.
        deadline = asyncio.get_running_loop().time() + MARKET_TIMEOUT * 2
        try:
            async with asyncio.timeout_at(deadline):
                async with summary.phase_span("market.latest"):
                    client = await cm.get_client(server)
                    transport = client.bot_orchestration
                    frame = await read(transport, "latest", {})
        except Exception:
            return summary.MarketRead(reason=summary.FRAME_UNAVAILABLE)
        try:
            async with asyncio.timeout_at(deadline):
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
        key = (bot, path, tuple(sorted(params.items())))
        reused = self._owner_bodies.get(key)
        if (
            reused is not None
            and 0 <= time.monotonic() - reused[0] < OWNER_REUSE_SECONDS
        ):
            fetched = reused[1]
        else:
            task = self._owner_inflight.get(key)
            if task is not None and task.get_loop() is not asyncio.get_running_loop():
                task = None  # left by a loop that has since closed
            if task is None:
                task = asyncio.create_task(self._fetch_owner(source, bot, path, params))
                self._owner_inflight[key] = task
                task.add_done_callback(
                    lambda done, key=key: self._owner_settled(key, done)
                )
            # A caller that gives up (its own deadline) must not cancel the read other callers share.
            fetched = await asyncio.shield(task)
        if fetched is None:
            return summary.OwnerRead(None, summary.SOURCE_UNAVAILABLE)
        content, read_at_ms = fetched
        try:
            # A reused body keeps the time it was fetched: its source clock never renews.
            return summary.OwnerRead(json.loads(content), read_at_ms=read_at_ms)
        except ValueError:
            return summary.OwnerRead(None, summary.SOURCE_UNAVAILABLE)

    def _owner_settled(self, key: tuple, task: asyncio.Task) -> None:
        if self._owner_inflight.get(key) is task:
            del self._owner_inflight[key]
        if (
            not task.cancelled()
            and task.exception() is None
            and task.result() is not None
        ):
            self._owner_bodies[key] = (time.monotonic(), task.result())
        else:
            self._owner_bodies.pop(key, None)

    async def _fetch_owner(
        self, source: dict, bot: str, path: str, params: dict
    ) -> Optional[tuple[bytes, float]]:
        """One bounded upstream read: ``(raw body, epoch ms it arrived)``, or None when it failed or
        was refused."""
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
                return None
            return response.content, time.time() * 1000
        except (httpx.HTTPError, ValueError, KeyError, TimeoutError, OSError):
            return None


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


def _completed(
    key: tuple, view: str, now: float
) -> Optional[tuple[bool, summary.FleetInputs]]:
    """``(fresh, inputs)`` for the newest completed read set that can serve ``view``, else None.

    A full read set serves either view; a glance read set (smaller) serves only a glance.
    """
    entry = _cache.get(key, {})
    rows = [entry.get("full")] + ([entry.get("glance")] if view == "glance" else [])
    rows = [row for row in rows if row is not None]
    if not rows:
        return None
    expires, inputs = max(rows, key=lambda row: row[1].read_at_ms)
    return expires > now, inputs


def _project(inputs: summary.FleetInputs, view: str, now_ms: float) -> dict:
    body = summary.project_fleet_summary(inputs, now_ms)
    return summary.glance(body) if view == "glance" else body


async def _respond(inputs: summary.FleetInputs, view: str) -> dict:
    """The response a read set gives now: the build's own projection at this request's clock, so a
    cached read set answers exactly as a fresh build from identical reads would.

    The clock is taken here, when the request is answered; the projection (history windows over every
    stored sample) runs in a worker thread so it never holds the event loop. It is pure, so
    concurrent projections of one read set are safe."""
    now_ms = time.time() * 1000
    return await asyncio.to_thread(_project, inputs, view, now_ms)


async def cached_summary(
    name: str, *, admin: bool, user_id: Any, view: str = "full"
) -> dict:
    """One view through the shared cache. Raises TimeoutError only when nothing completed can serve.

    The cache keeps what a build read, never a judged body: every response projects the reads at its
    own clock. Within ``CACHE_TTL_SECONDS`` of the reads they are served as they are. Past that, they
    serve for up to ``STALE_SERVE_SECONDS`` after they were read while exactly one background rebuild
    runs. Only with nothing read in that window does a request wait for a build.
    """
    if view not in summary.VIEWS:
        raise ValueError(f"unknown view {view!r}")
    key = (name, admin)
    done = _completed(key, view, time.monotonic())
    if done is not None:
        fresh, inputs = done
        if fresh:
            return await _respond(inputs, view)
        if 0 <= time.time() * 1000 - inputs.read_at_ms <= STALE_SERVE_SECONDS * 1000:
            _refresh(key, view, user_id)
            return await _respond(inputs, view)
    return await _build(key, view, user_id)


def accept_refreshes() -> None:
    """App start: background rebuilds may run."""
    global _accepting_refreshes
    _accepting_refreshes = True


async def stop_refreshes(history_drain_seconds: float = HISTORY_DRAIN_SECONDS) -> None:
    """App shutdown: accept no new background rebuild, then cancel and await the rebuilds running and
    the shared owner reads they own (both cooperative asyncio work).

    History reads run in worker threads that cannot be interrupted. They are drained, not
    cancelled: shutdown waits up to ``history_drain_seconds`` for them, and a read still running
    stays registered until its thread really ends, so a restarted app joins it rather than starting
    a second worker for the same key.
    """
    global _accepting_refreshes
    _accepting_refreshes = False
    owned = list(_refreshes.values())
    owned += list(getattr(READERS, "_owner_inflight", {}).values())
    loop = asyncio.get_running_loop()
    owned = [task for task in owned if not task.done() and task.get_loop() is loop]
    for task in owned:
        task.cancel()
    await asyncio.gather(*owned, return_exceptions=True)
    reads = [job for job in LAST_KNOWN.history_jobs.values() if not job.done()]
    if reads:
        waiters = [asyncio.wrap_future(job) for job in reads]
        _, running = await asyncio.wait(waiters, timeout=history_drain_seconds)
        for waiter in running:
            # Only this loop's waiter: a running worker cannot be cancelled and stays registered.
            waiter.cancel()
        if running:
            logger.warning(
                "event=fleet_history_drain_incomplete running=%d", len(running)
            )


def _refresh(key: tuple, view: str, user_id: Any) -> None:
    """Start the background rebuild of ``view`` unless one (or a full one, which serves both) runs."""
    if not _accepting_refreshes:
        return  # shutting down: the completed reads still serve, nothing new starts
    loop = asyncio.get_running_loop()
    for running_view in {view, "full"}:
        task = _refreshes.get((*key, running_view))
        if task is not None and not task.done() and task.get_loop() is loop:
            return
    refresh_key = (*key, view)

    async def rebuild() -> None:
        try:
            await _build(key, view, user_id, cache_status="refresh")
        except TimeoutError:
            pass  # logged by _build with its phases; the completed reads keep serving
        except Exception:
            logger.exception("event=fleet_summary_refresh_failed view=%s", view)
        finally:
            if _refreshes.get(refresh_key) is asyncio.current_task():
                del _refreshes[refresh_key]

    _refreshes[refresh_key] = asyncio.create_task(rebuild())


async def _build(
    key: tuple, view: str, user_id: Any, *, cache_status: str = "pending"
) -> dict:
    """Read one view under its lock and the total deadline, or serve reads completed while waiting."""
    name, admin = key
    trace = _SummaryPhaseRecorder()
    started = time.monotonic()
    acquired = False
    deadline = asyncio.timeout(TOTAL_TIMEOUT)
    with summary.capture_phase_recorder(trace):
        try:
            async with deadline:
                lock = _locks.setdefault((*key, view), asyncio.Lock())
                async with summary.phase_span("cache.lock_wait"):
                    await lock.acquire()
                acquired = True
                try:
                    done = _completed(key, view, time.monotonic())
                    if done is not None and done[0]:
                        cache_status = "hit"
                        return await _respond(done[1], view)

                    if cache_status != "refresh":
                        cache_status = "miss"
                    async with summary.phase_span("summary.build"):
                        inputs = await summary.gather_fleet_inputs(
                            name,
                            view,
                            READERS,
                            time.time() * 1000,
                            is_admin=admin,
                            user_id=user_id,
                            clock_ms=lambda: time.time() * 1000,
                            last_known=LAST_KNOWN,
                            history_timeout=HISTORY_TIMEOUT,
                        )
                    if CACHE_TTL_SECONDS > 0:
                        expires = time.monotonic() + CACHE_TTL_SECONDS
                        _cache.setdefault(key, {})[view] = (expires, inputs)
                    return await _respond(inputs, view)
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
