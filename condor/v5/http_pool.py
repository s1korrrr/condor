"""One shared aiohttp session per event loop for each fixed owner client.

``V5Upstream`` and the read bridge used to open a new ``ClientSession`` for every owner read, which paid a new TCP
connect for each one. ``SharedSession`` opens each loop's session on first use and bounds cleanup on shutdown.
Per-request deadlines are unchanged: callers pass their own ``ClientTimeout`` per request.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncGenerator
from concurrent.futures import Future
from contextlib import asynccontextmanager
from threading import Lock, Thread

import aiohttp

logger = logging.getLogger(__name__)
KEEPALIVE_SECONDS = 2.0
POOL_LIMIT = 32
POOL_LIMIT_PER_HOST = 16
CLOSE_TIMEOUT_SECONDS = 0.25


def _queue_close(
    loop: asyncio.AbstractEventLoop,
    cleanup: AsyncGenerator[aiohttp.ClientSession, None],
) -> Future[BaseException | None]:
    result: Future[BaseException | None] = Future()

    def finished(task: asyncio.Task[None]) -> None:
        if task.cancelled():
            result.cancel()
        else:
            error = task.exception()
            if result.set_running_or_notify_cancel():
                result.set_result(error)

    async def close_if_waiting() -> None:
        if not result.cancelled():
            await cleanup.aclose()

    def enqueue_close() -> None:
        # Create the aclose awaitable only once the owner actually runs it.
        if not result.cancelled():
            loop.create_task(close_if_waiting()).add_done_callback(finished)

    def drain_stopped_loop() -> None:
        try:
            loop.run_until_complete(asyncio.wrap_future(result, loop=loop))
        except (RuntimeError, asyncio.CancelledError):
            # The owner can resume or close the loop. The caller still has its deadline.
            pass

    running = loop.is_running()
    try:
        loop.call_soon_threadsafe(enqueue_close)
    except RuntimeError as error:
        result.set_result(error)
        return result
    if not running:
        # A blocked owner callback must not hold up the caller's executor shutdown.
        try:
            Thread(target=drain_stopped_loop, daemon=True).start()
        except RuntimeError:
            # If the worker cannot start, the caller will still report an open session.
            pass
    return result


class SharedSession:
    def __init__(
        self, *, owner: str = "upstream", keepalive_timeout: float = KEEPALIVE_SECONDS, limit: int = POOL_LIMIT,
    ):
        self._owner = owner
        self._keepalive_timeout = keepalive_timeout
        self._limit = limit
        self._sessions: dict[
            asyncio.AbstractEventLoop,
            tuple[aiohttp.ClientSession, AsyncGenerator[aiohttp.ClientSession, None]],
        ] = {}
        self._closing: dict[asyncio.AbstractEventLoop, Future[BaseException | None]] | None = None
        self._close_deadline = 0.0
        self._lock = Lock()
        self.created = 0  # sessions (and connectors) built so far; a reused session leaves it unchanged

    async def _open(self) -> AsyncGenerator[aiohttp.ClientSession, None]:
        """Register for loop shutdown; the first advance yields without suspending."""
        session = aiohttp.ClientSession(
            connector=aiohttp.TCPConnector(
                limit=self._limit,
                limit_per_host=POOL_LIMIT_PER_HOST,
                keepalive_timeout=self._keepalive_timeout,
                ttl_dns_cache=10,  # Keep aiohttp's short default for fixed owner hostnames.
            ),
            # A fresh session per request kept no cookies; a shared one must not start keeping an owner's.
            cookie_jar=aiohttp.DummyCookieJar(),
        )
        try:
            yield session
        finally:
            await session.close()

    async def get(self) -> aiohttp.ClientSession:
        loop = asyncio.get_running_loop()
        with self._lock:
            if self._closing is not None:
                raise RuntimeError("shared owner session pool is closed")
            existing = self._sessions.get(loop)
            if existing is not None and not existing[0].closed:
                return existing[0]
            cleanup = self._open()
            session = await anext(cleanup)
            self._sessions[loop] = session, cleanup
            self.created += 1
            return session

    async def close(self) -> None:
        """Stop new leases and share one bounded cleanup attempt across callers."""
        with self._lock:
            if self._closing is None:
                self._close_deadline = time.monotonic() + CLOSE_TIMEOUT_SECONDS
                self._closing = {
                    loop: _queue_close(loop, cleanup)
                    for loop, (session, cleanup) in self._sessions.items()
                    if not session.closed
                }
            pending = tuple(self._closing.values())
        if pending:
            # Each caller waits on the same results and deadline, even across event loops.
            await asyncio.wait(
                [asyncio.wrap_future(result) for result in pending],
                timeout=max(0.0, self._close_deadline - time.monotonic()),
            )
        with self._lock:
            for loop, result in self._closing.items():
                error = result.result() if result.done() and not result.cancelled() else None
                # Disarm callbacks still queued on an owner that has stopped.
                result.cancel()
                if not self._sessions[loop][0].closed:
                    logger.error(
                        "Could not close shared owner session for %s (loop %#x)",
                        self._owner,
                        id(loop),
                        exc_info=error,
                    )
            self._sessions.clear()
            self._closing.clear()


@asynccontextmanager
async def lease(shared: SharedSession | None, factory, timeout: aiohttp.ClientTimeout):
    """Yield ``(session, request_kwargs)``.

    Without ``shared`` the caller's ``factory`` builds a session for this one request, as before. With it, the shared
    session is reused (never closed here) and the request carries its own ``timeout``.
    """
    if shared is None:
        async with factory(timeout=timeout) as session:
            yield session, {}
    else:
        yield await shared.get(), {"timeout": timeout}
