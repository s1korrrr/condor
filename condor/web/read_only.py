"""Private monitoring boundary with independent, explicit mutation exceptions."""

import re

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send


class ReadOnlyWeb:
    def __init__(
        self,
        app: ASGIApp,
        *,
        allow_account_management: bool = False,
        allow_native_lifecycle: bool = False,
    ):
        self.app = app
        self.allow_account_management = allow_account_management
        self.allow_native_lifecycle = allow_native_lifecycle

    async def __call__(self, scope: Scope, receive: Receive, send: Send):
        if scope["type"] == "websocket" and scope["path"] != "/api/v1/ws":
            await send({"type": "websocket.close", "code": 1008})
            return
        if scope["type"] == "http":
            auth = scope["method"] == "POST" and scope["path"] in {
                "/api/v1/auth/tailscale",
                "/api/v1/auth/token-login",
            }
            account_setup = self.allow_account_management and (
                (
                    scope["method"] == "POST"
                    and scope["path"] == "/api/v1/settings/credentials"
                )
                or (
                    scope["method"] == "DELETE"
                    and re.fullmatch(
                        r"/api/v1/settings/credentials/[A-Za-z0-9][A-Za-z0-9_-]{0,99}",
                        scope["path"],
                    )
                    is not None
                )
            )
            native_lifecycle = (
                self.allow_native_lifecycle
                and scope["method"] == "POST"
                and re.fullmatch(
                    r"/api/v1/servers/[A-Za-z0-9][A-Za-z0-9_-]{0,99}"
                    r"/bots/[A-Za-z0-9][A-Za-z0-9_-]{0,99}/native/(start|stop)",
                    scope["path"],
                )
                is not None
            )
            if (
                scope["method"] not in {"GET", "HEAD", "OPTIONS"}
                and not auth
                and not account_setup
                and not native_lifecycle
            ):
                response = JSONResponse(
                    {
                        "detail": "This action is unavailable in the private monitoring deployment"
                    },
                    status_code=403,
                    headers={"Cache-Control": "no-store"},
                )
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)
