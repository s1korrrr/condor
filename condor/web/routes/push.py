"""Device registry and settings for native push alerts.

Everything here is about *where alerts go*, never about trading: a registered
device can receive notifications and nothing else. There is no route that
forwards anything to a native bot, and the only mutations are the caller's own
device rows and a request for a test alert. The push worker (a separate process
that holds the APNs key) does the sending; this module only talks to the shared
SQLite registry.
"""

from __future__ import annotations

import os
import re
import time
from functools import lru_cache
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, StrictBool

from condor.push import live_activity as la
from condor.push.config import bundle_allowed
from condor.push.events import ALERT_CLASSES
from condor.push.heartbeat import evaluate_heartbeat
from condor.push.store import (
    SERVER_NAME,
    Registry,
    RegistryError,
    normalize_classes,
    normalize_quiet,
)
from condor.web import live_activity_market, live_activity_publisher
from condor.web.auth import get_current_user
from condor.web.models import WebUser
from condor.web.routes import fleet_summary as fleet_summary_routes
from config_manager import get_config_manager

router = APIRouter(prefix="/push", tags=["push"])

ENV_REGISTRY = "CONDOR_PUSH_REGISTRY"
ENV_BUNDLE = "CONDOR_PUSH_BUNDLE_ID"
ENV_ENVIRONMENT = "CONDOR_PUSH_ENVIRONMENT"
_DEVICE_ID = re.compile(r"[0-9a-f]{32}")
_REQUEST_ID = re.compile(r"[0-9a-f]{24}")
_NO_STORE = {"Cache-Control": "no-store"}
_clock = time.time


class QuietHours(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: StrictBool = False
    start: str = "22:00"
    end: str = "07:00"
    tz: str = "UTC"
    bypass_critical: StrictBool = True


class DeviceRegistration(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: str = Field(max_length=256)
    platform: Literal["iphone", "watch"]
    bundle_id: str = Field(max_length=155)
    environment: Literal["sandbox", "production"]
    app_version: str = Field(default="", max_length=32)
    classes: dict[str, StrictBool] | None = None
    quiet_hours: QuietHours | None = None


class LiveActivityRegistration(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["update", "start"]
    token: str = Field(max_length=256)
    environment: Literal["sandbox", "production"]
    bundle_id: str = Field(max_length=155)
    device_id: str = Field(max_length=32)
    server: str = Field(max_length=100)
    activity_id: str | None = Field(default=None, max_length=64)


class AlertTestRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    device_id: str | None = Field(default=None, max_length=32)


@lru_cache(maxsize=4)
def _registry_at(path: str) -> Registry:
    return Registry(path)


def _server() -> tuple[Registry, str, tuple[str, ...]]:
    """The shared registry and what this server accepts; 503 when push is not configured."""
    path, bundle = os.environ.get(ENV_REGISTRY), os.environ.get(ENV_BUNDLE)
    environment = os.environ.get(ENV_ENVIRONMENT, "")
    if not path or not bundle or environment not in {"sandbox", "production", "both"}:
        raise HTTPException(
            503, "Push alerts are not configured on this server", headers=_NO_STORE
        )
    environments = (
        ("sandbox", "production") if environment == "both" else (environment,)
    )
    try:
        return _registry_at(path), bundle, environments
    except OSError:
        raise HTTPException(
            503, "The push registry is unavailable", headers=_NO_STORE
        ) from None


def _json(payload: Any, status: int = 200):
    from fastapi.responses import JSONResponse

    return JSONResponse(payload, status_code=status, headers=_NO_STORE)


@router.post("/devices")
def register_device(
    body: DeviceRegistration, user: WebUser = Depends(get_current_user)
):
    """Register this device's APNs token, or update its settings (same token)."""
    registry, bundle, environments = _server()
    if not bundle_allowed(bundle, body.bundle_id):
        raise HTTPException(422, "This server does not send to that bundle identifier")
    if body.environment not in environments:
        raise HTTPException(
            422, f"This server sends to {' and '.join(environments)} devices only"
        )
    try:
        device = registry.upsert_device(
            user_id=user.id,
            token=body.token,
            platform=body.platform,
            bundle_id=body.bundle_id,
            environment=body.environment,
            app_version=body.app_version,
            classes=None if body.classes is None else normalize_classes(body.classes),
            quiet=(
                None
                if body.quiet_hours is None
                else normalize_quiet(body.quiet_hours.model_dump())
            ),
            now=_clock(),
        )
    except RegistryError as exc:
        raise HTTPException(422, str(exc)) from None
    return _json(
        {
            "device": device.public(),
            "server": {"bundle_id": bundle, "environments": list(environments)},
        }
    )


@router.delete("/devices/{device_id}")
def unregister_device(device_id: str, user: WebUser = Depends(get_current_user)):
    registry, _, _ = _server()
    if not _DEVICE_ID.fullmatch(device_id) or not registry.delete_device(
        user.id, device_id
    ):
        raise HTTPException(404, "Device not found")
    return _json({"deleted": device_id})


@router.post("/live-activities")
def register_live_activity(
    body: LiveActivityRegistration, user: WebUser = Depends(get_current_user)
):
    """Register an ActivityKit push token (an activity's update token or the device's
    push-to-start token) for one of the caller's registered iPhones. The same token is
    idempotent: it keeps its id."""
    registry, bundle, environments = _server()
    if not _DEVICE_ID.fullmatch(body.device_id):
        raise HTTPException(404, "Device not found")
    if not SERVER_NAME.fullmatch(
        body.server
    ) or not get_config_manager().has_server_access(user.id, body.server):
        raise HTTPException(404, "Server not found")
    if not bundle_allowed(bundle, body.bundle_id):
        raise HTTPException(422, "This server does not send to that bundle identifier")
    if body.environment not in environments:
        raise HTTPException(
            422, f"This server sends to {' and '.join(environments)} devices only"
        )
    try:
        token = registry.upsert_live_activity(
            user_id=user.id,
            device_id=body.device_id,
            server=body.server,
            kind=body.kind,
            token=body.token,
            environment=body.environment,
            bundle_id=body.bundle_id,
            activity_id=body.activity_id,
            now=_clock(),
        )
    except LookupError:
        raise HTTPException(404, "Device not found") from None
    except RegistryError as exc:
        raise HTTPException(422, str(exc)) from None
    return _json({"id": token.id}, 201)


@router.get("/live-activities/content")
async def live_activity_content(
    server: str = Query(max_length=100), user: WebUser = Depends(get_current_user)
):
    """The Live Activity content state for the caller and server: exactly what the push
    worker sends, built from the same cached glance as ``/fleet/summary?view=glance``. The app
    starts and locally updates its activity with it, so it never computes content itself.
    """
    if not SERVER_NAME.fullmatch(server):
        raise HTTPException(404, "Server not found")
    try:
        glance = await fleet_summary_routes.glance_for(server, user.id)
    except LookupError:
        raise HTTPException(404, "Server not found") from None
    except TimeoutError:
        raise HTTPException(504, "Fleet summary exceeded its deadline") from None
    state = la.content_state(glance)
    # The Market index the publisher last built for this server, when published within two
    # intervals (``stale`` recomputed for its age); never built here.
    index = live_activity_market.published_index(
        server,
        max_age_seconds=2.0 * live_activity_publisher.configured_interval(),
        now=_clock(),
    )
    if index is not None:
        state["market_index"] = index
    return _json(state)


@router.delete("/live-activities/{live_id}")
def unregister_live_activity(live_id: str, user: WebUser = Depends(get_current_user)):
    """The app ends an activity (or turns the Live Activity off): forget its token."""
    from fastapi.responses import Response

    registry, _, _ = _server()
    if not _DEVICE_ID.fullmatch(live_id) or not registry.delete_live_activity(
        user.id, live_id
    ):
        raise HTTPException(404, "Live Activity not found")
    return Response(status_code=204, headers=_NO_STORE)


@router.get("/settings")
def settings(user: WebUser = Depends(get_current_user)):
    registry, bundle, environments = _server()
    return _json(
        {
            "enabled": True,
            "server": {"bundle_id": bundle, "environments": list(environments)},
            "classes": [
                {
                    "id": c.id,
                    "label": c.label,
                    "description": c.description,
                    "default": c.default_enabled,
                }
                for c in ALERT_CLASSES.values()
                if c.id != "test"
            ],
            "devices": [d.public() for d in registry.devices_for_user(user.id)],
            "heartbeat": evaluate_heartbeat(
                registry.get_meta("worker_heartbeat"), _clock()
            ),
            "read_only": True,
        }
    )


@router.post("/test")
def request_test(
    body: AlertTestRequest | None = None, user: WebUser = Depends(get_current_user)
):
    """Ask the push worker to send a test alert to the caller's own device(s)."""
    registry, _, _ = _server()
    active = [d for d in registry.devices_for_user(user.id) if d.active]
    wanted = body.device_id if body else None
    if wanted is not None:
        active = [d for d in active if d.device_id == wanted]
        if not active:
            raise HTTPException(404, "Device not found")
    if not active:
        raise HTTPException(409, "Register a device first")
    try:
        request_id = registry.add_test_request(
            user.id, [d.device_id for d in active] if wanted else [], now=_clock()
        )
    except RegistryError as exc:
        raise HTTPException(429, str(exc)) from None
    beat = evaluate_heartbeat(registry.get_meta("worker_heartbeat"), _clock())
    return _json(
        {"request_id": request_id, "devices": len(active), "worker": beat["state"]}, 202
    )


@router.get("/test/{request_id}")
def get_test_result(request_id: str, user: WebUser = Depends(get_current_user)):
    registry, _, _ = _server()
    record = _REQUEST_ID.fullmatch(request_id) and registry.get_request(
        user.id, request_id
    )
    if not record:
        raise HTTPException(404, "Test request not found")
    return _json(
        {"request_id": request_id, "state": record["state"], "result": record["result"]}
    )


@router.get("/heartbeat")
def heartbeat(user: WebUser = Depends(get_current_user)):
    """Freshness of the push sender. The app raises its own alarm when this is stale."""
    registry, _, _ = _server()
    return _json(
        {
            "configured": True,
            **evaluate_heartbeat(registry.get_meta("worker_heartbeat"), _clock()),
        }
    )
