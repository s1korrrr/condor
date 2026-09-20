"""Admin-only registered native entry commands, without a second policy engine."""

import re
import time

from aiohttp import ClientError, ClientTimeout
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from condor.web.auth import get_current_user
from condor.web.models import WebUser
from config_manager import get_config_manager

router = APIRouter()
ACTIONS = frozenset({"pause", "resume", "acknowledge-daily-loss"})


class EntryCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")
    command_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$")


async def transport_for(name, bot_name, user):
    cm = get_config_manager()
    if not cm.has_server_access(user.id, name):
        raise HTTPException(404, "Native source not found")
    if not cm.is_admin(user.id):
        raise HTTPException(403, "Native entry controls require administrator access")
    if not all(
        re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}", value)
        for value in (name, bot_name)
    ):
        raise HTTPException(422, "Invalid native source identity")
    try:
        client = await cm.get_client(name)
        transport = client.bot_orchestration
        async with transport.session.get(
            f"{transport.base_url}/health",
            allow_redirects=False,
            timeout=ClientTimeout(total=5),
        ) as response:
            if response.status != 200:
                raise HTTPException(503, "Current native capabilities unavailable")
            health = await response.json()
        owner = health.get("native_bots", {}).get(bot_name, {})
        if (
            health.get("status") != "ok"
            or health.get("profile") != "native"
            or owner.get("controller_name") != "rsi_modular"
            or owner.get("profile") not in {"ok_rsi", "rsi_v5"}
            or owner.get("execution_mode") != "live"
            or owner.get("entry_controls") is not True
        ):
            raise HTTPException(
                409, "Registered owner does not permit native entry controls"
            )
        return transport
    except (ClientError, TimeoutError, ValueError, AttributeError, TypeError):
        raise HTTPException(503, "Current native capabilities unavailable") from None


@router.get("/servers/{name}/bots/{bot_name}/native/entries/status")
async def status(
    name: str,
    bot_name: str,
    request: Request,
    user: WebUser = Depends(get_current_user),
):
    transport = await transport_for(name, bot_name, user)
    try:
        async with transport.session.get(
            f"{transport.base_url}/mobile-controls/rsi/bots/{bot_name}/status",
            allow_redirects=False,
            timeout=ClientTimeout(total=5),
        ) as response:
            if 300 <= response.status < 400:
                raise ValueError("Redirect refused")
            payload = await response.json()
            if not isinstance(payload, dict):
                raise ValueError("Invalid native status")
            if (
                response.status == 200
                and (payload.get("data") or {}).get("bot_name") != bot_name
            ):
                raise ValueError("Native owner mismatch")
            if response.status == 200:
                payload = dict(
                    payload,
                    verified_at=time.time(),
                    command_allowed=getattr(request.state, "deployment_policy", {}).get(
                        "native_entry"
                    )
                    is True,
                )
            return JSONResponse(
                payload,
                status_code=response.status,
                headers={"Cache-Control": "no-store"},
            )
    except (ClientError, TimeoutError, ValueError, AttributeError):
        raise HTTPException(502, "Native entry state unavailable") from None


@router.post("/servers/{name}/bots/{bot_name}/native/entries/{action}")
async def command(
    name: str,
    bot_name: str,
    action: str,
    body: EntryCommand,
    user: WebUser = Depends(get_current_user),
):
    if action not in ACTIONS:
        raise HTTPException(404, "Unsupported entry operation")
    transport = await transport_for(name, bot_name, user)
    try:
        async with transport.session.post(
            f"{transport.base_url}/mobile-controls/rsi/bots/{bot_name}/{action}",
            json={
                "command_id": body.command_id,
                "requested_by": f"condor-web:{user.id}",
            },
            allow_redirects=False,
            timeout=ClientTimeout(total=15),
        ) as response:
            if 300 <= response.status < 400:
                raise ValueError("Redirect refused")
            payload = await response.json()
            if not isinstance(payload, dict):
                raise ValueError("Invalid native response")
            return JSONResponse(
                payload,
                status_code=response.status,
                headers={"Cache-Control": "no-store"},
            )
    except (ClientError, TimeoutError, ValueError):
        return JSONResponse(
            {
                "status": "unknown",
                "command_id": body.command_id,
                "execution_verified": False,
                "message": "Publication outcome unknown. Inspect native state before retrying.",
            },
            status_code=202,
            headers={"Cache-Control": "no-store"},
        )
