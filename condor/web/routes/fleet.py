"""Read-only Fleet catalogue proxy. Never starts owners or sends commands."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from condor.fetchers.fleet import catalogue_from_api_payload
from condor.web.auth import get_current_user
from condor.web.models import WebUser
from config_manager import get_config_manager

router = APIRouter(tags=["fleet"])


async def _read_fleet_path(client, path: str) -> dict | None:
    session = getattr(client, "_session", None)
    if session is None:
        return None
    url = f"{client.base_url}{path}"
    try:
        async with session.get(url, auth=getattr(client, "auth", None), allow_redirects=False) as response:
            if response.status == 404:
                return {"items": [], "reason_code": "catalogue_unavailable"}
            if response.status >= 400:
                return {"items": [], "reason_code": "source_unavailable"}
            payload = await response.json()
            return payload if isinstance(payload, dict) else None
    except TypeError:
        async with session.get(url, auth=getattr(client, "auth", None)) as response:
            if response.status in {301, 302, 303, 307, 308}:
                return {"items": [], "reason_code": "source_unavailable"}
            if response.status == 404:
                return {"items": [], "reason_code": "catalogue_unavailable"}
            if response.status >= 400:
                return {"items": [], "reason_code": "source_unavailable"}
            payload = await response.json()
            return payload if isinstance(payload, dict) else None
    except Exception:
        return {"items": [], "reason_code": "source_unavailable"}


@router.get("/servers/{name}/fleet/bots")
async def list_fleet(name: str, user: WebUser = Depends(get_current_user)):
    cm = get_config_manager()
    if not cm.has_server_access(user.id, name):
        raise HTTPException(status_code=404, detail="Server not found")
    try:
        client = await cm.get_client(name)
    except Exception:
        return catalogue_from_api_payload(None)
    payload = await _read_fleet_path(client, "/fleet/v1/bots")
    return catalogue_from_api_payload(payload)


@router.get("/servers/{name}/fleet/bots/{bot_key}")
async def fleet_bot(name: str, bot_key: str, user: WebUser = Depends(get_current_user)):
    cm = get_config_manager()
    if not cm.has_server_access(user.id, name):
        raise HTTPException(status_code=404, detail="Server not found")
    try:
        client = await cm.get_client(name)
    except Exception:
        return {"reason_code": "catalogue_unavailable", "command_available": False, "identity_verified": False}
    payload = await _read_fleet_path(client, f"/fleet/v1/bots/{bot_key}/snapshot")
    if payload is None or payload.get("reason_code") in {"catalogue_unavailable", "source_unavailable"}:
        return {
            "bot_key": bot_key,
            "reason_code": (payload or {}).get("reason_code") or "catalogue_unavailable",
            "command_available": False,
            "identity_verified": False,
        }
    payload["command_available"] = False
    return payload
