"""Gzip on the wire for text-like responses only.

Chart, summary and bundle responses are JSON or text and compress 5-15x; the phone's background
refresh and the dashboard both read them over Tailscale. Binary bodies (documents, archives, audio)
are already compressed or are downloads whose exact ``Content-Length`` a client may rely on, so they
pass through untouched, as do event streams and responses that already carry an encoding. Byte-range
requests and partial (206) responses are never compressed: their offsets describe the identity bytes.
A request that does not accept gzip (absent, or refused with ``q=0``) is not touched at all.
"""

from starlette.datastructures import Headers, MutableHeaders
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


def accepts_gzip(header: str) -> bool:
    """RFC 9110 content coding negotiation for gzip: listed (or ``*``) with a non-zero quality."""
    explicit = wildcard = None
    for item in header.split(","):
        name, _, params = item.strip().partition(";")
        name = name.strip().lower()
        if name not in ("gzip", "x-gzip", "*"):
            continue
        quality = 1.0
        for param in params.split(";"):
            key, _, value = param.strip().partition("=")
            if key.strip().lower() == "q":
                try:
                    quality = float(value)
                except ValueError:
                    quality = 0.0
        if name == "*":
            wildcard = quality
        else:
            explicit = quality if explicit is None else max(explicit, quality)
    chosen = explicit if explicit is not None else wildcard
    return chosen is not None and chosen > 0


def _compressible(content_type: str) -> bool:
    media = content_type.split(";", 1)[0].strip().lower()
    return media in COMPRESSIBLE_TYPES or media.endswith("+json")


class _SelectiveGZipResponder(GZipResponder):
    async def send_with_compression(self, message: Message) -> None:
        await super().send_with_compression(message)
        if message["type"] == "http.response.start":
            # The responder holds the start message until the first body chunk; mark every
            # non-text body as excluded so it is sent as is, with its own Content-Length.
            headers = Headers(raw=message["headers"])
            self.content_type_is_excluded = (
                self.content_type_is_excluded
                or not _compressible(headers.get("content-type", ""))
                or message.get("status") == 206
                or "content-range" in headers
            )
            etag = headers.get("etag", "")
            if (not self.content_type_is_excluded and "bytes" in headers.get("accept-ranges", "").lower()
                    and etag and not etag.startswith("W/")):
                # A range-capable body (a file) sent gzip-encoded has different bytes from its identity form:
                # a weak validator keeps If-None-Match working but fails If-Range, so a client can never
                # resume a compressed copy with identity ranges. API routes serve no ranges and keep theirs.
                MutableHeaders(raw=message["headers"])["etag"] = "W/" + etag


class SelectiveGZipMiddleware:
    def __init__(self, app: ASGIApp, minimum_size: int = 1024, compresslevel: int = 5) -> None:
        self.app = app
        self.minimum_size = minimum_size
        self.compresslevel = compresslevel

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":  # lifespan and websocket scopes carry no response to encode
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        if "range" in headers or not accepts_gzip(headers.get("accept-encoding", "")):
            await self.app(scope, receive, send)
            return
        responder = _SelectiveGZipResponder(self.app, self.minimum_size, compresslevel=self.compresslevel)
        await responder(scope, receive, send)
