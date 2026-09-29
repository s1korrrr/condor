"""Authenticated, bounded stored reads. This gateway never starts a producer."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response

from condor.web.auth import get_current_user
from condor.web.market_picture_contract import validate_response
from condor.web.models import WebUser
from config_manager import get_config_manager

router = APIRouter(prefix="/servers/{name}/market-picture", tags=["market-picture"])
TIMEOUT = 5.0
MAX_BYTES = 2 * 1024 * 1024
_HASH = re.compile(r"^[0-9a-f]{64}$")
_TAG = re.compile(r'^"[0-9a-f]{64}"$')
_INSTRUMENT = re.compile(r"^okx:spot:[A-Z0-9]{1,30}-[A-Z0-9]{1,12}$")
_HEADERS = {
    "Cache-Control": "private, no-cache",
    "X-Content-Type-Options": "nosniff",
    "X-Context-Authority": "observation-only",
}
_REASONS = frozenset(
    {
        "SOURCE_UNAVAILABLE",
        "SOURCE_DISABLED",
        "STORE_UNAVAILABLE",
        "CONTEXT_UNAVAILABLE",
        "RETENTION_EXPIRED",
        "CAPACITY_EXCEEDED",
        "EXPIRED_SNAPSHOT",
        "HASH_MISMATCH",
        "SOURCE_IDENTITY_MISMATCH",
        "INVALID_QUERY",
    }
)


def _query(path: str, request: Request) -> list[tuple[str, str]]:
    family = path.split("/", 1)[0]
    if family in {"snapshots", "assets"}:
        identity = path.removeprefix(family + "/")
        pattern = _HASH if family == "snapshots" else _INSTRUMENT
        if not pattern.fullmatch(identity):
            raise HTTPException(404, "Market Picture record not found")
    elif path not in {"status", "latest", "history", "correlations", "events"}:
        raise HTTPException(404, "Market Picture route not found")
    common = {"universe", "definition"}
    allowed = {
        "status": set(),
        "latest": set(),
        "snapshots": common,
        "history": common
        | {
            "start_ms",
            "end_ms",
            "window",
            "resolution",
            "limit",
            "cursor",
            "snapshot_id",
        },
        "assets": common | {"snapshot_id"},
        "correlations": common
        | {
            "snapshot_id",
            "benchmark",
            "matrix",
            "limit",
            "cursor",
            "row_offset",
            "column_offset",
            "page_size",
        },
        "events": common | {"snapshot_id", "event_type", "limit", "cursor"},
    }[family]
    params = list(request.query_params.multi_items())
    if len({key for key, _ in params}) != len(params) or any(
        key not in allowed for key, _ in params
    ):
        raise HTTPException(400, "Unsupported or repeated Market Picture parameter")
    if sum(len(key) + len(value) for key, value in params) > 8192:
        raise HTTPException(413, "Market Picture query exceeds the size limit")
    for key, value in params:
        if not value or len(value) > (4096 if key == "cursor" else 128):
            raise HTTPException(400, "Invalid Market Picture parameter")
        if key == "snapshot_id" and not _HASH.fullmatch(value):
            raise HTTPException(400, "Invalid snapshot identity")
        if key == "limit" and (
            not value.isascii() or not value.isdecimal() or not 1 <= int(value) <= 1500
        ):
            raise HTTPException(400, "Invalid read limit")
        if key in {"start_ms", "end_ms"} and (
            not value.isascii()
            or not value.isdecimal()
            or int(value) > 9_007_199_254_740_991
        ):
            raise HTTPException(400, "Invalid observation time")
        if key in {"row_offset", "column_offset", "page_size"}:
            lower, upper = (1, 16) if key == "page_size" else (0, 299)
            if (
                not value.isascii()
                or not value.isdecimal()
                or not lower <= int(value) <= upper
            ):
                raise HTTPException(400, "Invalid relationship page")
    return params


async def _body(upstream, limit: int) -> bytes:
    body = bytearray()
    async for chunk in upstream.content.iter_chunked(64 * 1024):
        if len(body) + len(chunk) > limit:
            raise HTTPException(502, "Market Picture response exceeds the size limit")
        body.extend(chunk)
    return bytes(body)


@router.get("/{path:path}")
async def read_market_picture(
    name: str, path: str, request: Request, user: WebUser = Depends(get_current_user)
):
    cm = get_config_manager()
    if not cm.has_server_access(user.id, name):
        raise HTTPException(404, "Market Picture source not found")
    params = _query(path, request)
    tag = request.headers.get("If-None-Match")
    if tag is not None and not _TAG.fullmatch(tag):
        raise HTTPException(400, "Invalid revalidation tag")
    try:
        async with asyncio.timeout(TIMEOUT):
            client = await cm.get_client(name)
            transport = client.bot_orchestration
            async with transport.session.get(
                f"{transport.base_url}/screener/market-picture/v1/{path}",
                params=params,
                headers={
                    "X-Market-Picture-Principal": f"condor:{hashlib.sha256(name.encode()).hexdigest()}:{user.id}",
                    **({"If-None-Match": tag} if tag else {}),
                },
                allow_redirects=False,
                timeout=TIMEOUT,
            ) as upstream:
                response_tag = upstream.headers.get("ETag")
                if upstream.status == 304:
                    if tag is None or response_tag != tag:
                        raise HTTPException(502, "Invalid Market Picture revalidation")
                    return Response(status_code=304, headers={**_HEADERS, "ETag": tag})
                if upstream.status in {400, 404, 409, 410, 413, 422, 503}:
                    reason = (
                        "RETENTION_EXPIRED"
                        if upstream.status == 410
                        else "SOURCE_UNAVAILABLE"
                    )
                    try:
                        error = json.loads(await _body(upstream, 16 * 1024))
                        reasons = error.get("detail", {}).get("reasons", [])
                        if isinstance(reasons, list):
                            reason = next(
                                (
                                    item
                                    for item in reasons
                                    if isinstance(item, str) and item in _REASONS
                                ),
                                reason,
                            )
                    except (ValueError, TypeError, AttributeError):
                        pass
                    return Response(
                        json.dumps({"detail": {"reasons": [reason]}}),
                        status_code=upstream.status,
                        media_type="application/json",
                        headers=_HEADERS,
                    )
                if upstream.status != 200:
                    raise HTTPException(502, "Market Picture source returned an error")
                content_type = (
                    upstream.headers.get("Content-Type", "").split(";", 1)[0].lower()
                )
                if content_type != "application/json" and not content_type.endswith(
                    "+json"
                ):
                    raise HTTPException(
                        502, "Market Picture source returned a non-JSON response"
                    )
                raw = await _body(upstream, MAX_BYTES)
                payload = validate_response(path, raw)
                requested_id = (
                    path.removeprefix("snapshots/")
                    if path.startswith("snapshots/")
                    else dict(params).get("snapshot_id")
                )
                if (
                    requested_id is not None
                    and payload.get("snapshot_id") != requested_id
                ):
                    raise HTTPException(
                        502, "Market Picture source returned a different snapshot"
                    )
                if path.startswith("assets/") and payload["asset"][
                    "instrument_id"
                ] != path.removeprefix("assets/"):
                    raise HTTPException(
                        502, "Market Picture source returned a different instrument"
                    )
                headers = dict(_HEADERS)
                if response_tag is not None:
                    if not _TAG.fullmatch(response_tag):
                        raise HTTPException(502, "Invalid Market Picture response tag")
                    headers["ETag"] = response_tag
                return Response(raw, media_type="application/json", headers=headers)
    except HTTPException:
        raise
    except TimeoutError:
        raise HTTPException(
            502, "Market Picture source exceeded the five-second deadline"
        ) from None
    except Exception:
        raise HTTPException(
            502, "Market Picture source unavailable or invalid"
        ) from None
