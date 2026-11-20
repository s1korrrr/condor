"""One shared aiohttp session per event loop for each fixed owner client.

``V5Upstream`` and the read bridge used to open a new ``ClientSession`` for every owner read, which paid a new TCP
connect for each one. ``SharedSession`` opens each loop's session on first use and closes all of them on shutdown.
Per-request deadlines are unchanged: callers pass their own ``ClientTimeout`` per request.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from threading import Lock

import aiohttp

KEEPALIVE_SECONDS = 2.0
POOL_LIMIT = 32
POOL_LIMIT_PER_HOST = 16


async def _close_on_owner(
    loop: asyncio.AbstractEventLoop,
    cleanup: AsyncGenerator[aiohttp.ClientSession, None],
) -> None:
    if loop is asyncio.get_running_loop():
        await cleanup.aclose()
    elif loop.is_running():
        await asyncio.wrap_future(asyncio.run_coroutine_threadsafe(cleanup.aclose(), loop))
    else:
        await asyncio.to_thread(loop.run_until_complete, cleanup.aclose())


class SharedSession:
    def __init__(self, *, keepalive_timeout: float = KEEPALIVE_SECONDS, limit: int = POOL_LIMIT):
        self._keepalive_timeout = keepalive_timeout
        self._limit = limit
        self._sessions: dict[
            asyncio.AbstractEventLoop,
            tuple[aiohttp.ClientSession, AsyncGenerator[aiohttp.ClientSession, None]],
        ] = {}
        self._closed = False
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
            if self._closed:
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
        with self._lock:
            self._closed = True
            sessions, self._sessions = self._sessions, {}
        await asyncio.gather(*(
            _close_on_owner(loop, cleanup)
            for loop, (session, cleanup) in sessions.items()
            if not session.closed
        ))


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
