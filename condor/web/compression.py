"""Gzip on the wire for text-like responses only.

Chart, summary and bundle responses are JSON or text and compress 5-15x; the phone's background
refresh and the dashboard both read them over Tailscale. Binary bodies (documents, archives, audio)
are already compressed or are downloads whose exact ``Content-Length`` a client may rely on, so they
pass through untouched, as do event streams and responses that already carry an encoding. A request
without ``Accept-Encoding: gzip`` is not touched at all.
"""

from starlette.datastructures import Headers
from starlette.middleware.gzip import GZipResponder
from starlette.types import ASGIApp, Message, Receive, Scope, Send

COMPRESSIBLE_TYPES = frozenset(
    {
        "application/json",
        "application/javascript",
        "text/javascript",
        "text/css",
        "text/html",
        "text/plain",
        "image/svg+xml",
    }
)


def _compressible(content_type: str) -> bool:
    media = content_type.split(";", 1)[0].strip().lower()
    return media in COMPRESSIBLE_TYPES or media.endswith("+json")


class _SelectiveGZipResponder(GZipResponder):
    async def send_with_compression(self, message: Message) -> None:
        await super().send_with_compression(message)
        if message["type"] == "http.response.start":
            # The responder holds the start message until the first body chunk; mark every
            # non-text body as excluded so it is sent as is, with its own Content-Length.
            content_type = Headers(raw=message["headers"]).get("content-type", "")
            self.content_type_is_excluded = self.content_type_is_excluded or not _compressible(content_type)


class SelectiveGZipMiddleware:
    def __init__(self, app: ASGIApp, minimum_size: int = 1024, compresslevel: int = 5) -> None:
        self.app = app
        self.minimum_size = minimum_size
        self.compresslevel = compresslevel

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or "gzip" not in Headers(scope=scope).get("accept-encoding", ""):
            await self.app(scope, receive, send)
            return
        responder = _SelectiveGZipResponder(self.app, self.minimum_size, compresslevel=self.compresslevel)
        await responder(scope, receive, send)
