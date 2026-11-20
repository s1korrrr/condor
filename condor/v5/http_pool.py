"""One shared aiohttp session (and so one connector) per fixed owner client.

``V5Upstream`` and the read bridge used to open a new ``ClientSession`` for every owner read, which paid a new TCP
connect for each one. ``SharedSession`` keeps one session, created on first use in the running event loop and closed
by the app on shutdown. Per-request deadlines are unchanged: callers pass their own ``ClientTimeout`` per request.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

import aiohttp

# The owners are plain uvicorn servers, which close an idle keep-alive socket after 5 s. Dropping our idle sockets
# earlier means a pooled connection is never one the owner has already closed.
KEEPALIVE_SECONDS = 4.0
POOL_LIMIT = 32


class SharedSession:
    def __init__(self, *, keepalive_timeout: float = KEEPALIVE_SECONDS, limit: int = POOL_LIMIT):
        self._keepalive_timeout = keepalive_timeout
        self._limit = limit
        self._session: aiohttp.ClientSession | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self.created = 0  # sessions (and connectors) built so far; a reused session leaves it unchanged

    def get(self) -> aiohttp.ClientSession:
        loop = asyncio.get_running_loop()
        session = self._session
        if session is None or session.closed or self._loop is not loop:
            session = aiohttp.ClientSession(
                connector=aiohttp.TCPConnector(limit=self._limit, keepalive_timeout=self._keepalive_timeout),
                # A fresh session per request kept no cookies; a shared one must not start keeping an owner's.
                cookie_jar=aiohttp.DummyCookieJar(),
            )
            self._session, self._loop = session, loop
            self.created += 1
        return session

    async def close(self) -> None:
        session, self._session = self._session, None
        if session is not None and self._loop is asyncio.get_running_loop():
            await session.close()


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
        yield shared.get(), {"timeout": timeout}
