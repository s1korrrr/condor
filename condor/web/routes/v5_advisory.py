"""Read-only proxy for the isolated V5 observation and advisory projection."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response

from condor.web.auth import get_current_user
from condor.web.models import WebUser

router = APIRouter(prefix="/v5-advisory", tags=["v5-advisory"])
TIMEOUT_SECONDS = 5.0
MAX_RESPONSE_BYTES = 128 * 1024
ALLOWED_PATHS = frozenset(
    {"v1/context", "v1/advice/status", "v1/advice/latest", "v1/advice/history"}
)
_HEADERS = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Context-Authority": "observation-only",
}


def _settings() -> tuple[str, str]:
    base_url = os.environ.get("V5_OBSERVATION_URL", "").strip()
    token_path = os.environ.get("V5_OBSERVATION_TOKEN_FILE", "").strip()
    parsed = urlsplit(base_url)
    if (
        not base_url
        or parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
        or not token_path
    ):
        raise HTTPException(503, "V5 advisory observation is not configured")
    try:
        token = Path(token_path).read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise HTTPException(503, "V5 advisory observation is unavailable") from exc
    if (
        not token
        or len(token) > 4096
        or any(ord(char) < 33 or ord(char) > 126 for char in token)
    ):
        raise HTTPException(503, "V5 advisory observation is unavailable")
    return base_url.rstrip("/"), token


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=TIMEOUT_SECONDS, follow_redirects=False, trust_env=False
    )


@router.get("/{path:path}")
async def read_v5_advisory(
    path: str,
    request: Request,
    _user: WebUser = Depends(get_current_user),
):
    if path not in ALLOWED_PATHS:
        raise HTTPException(404, "V5 advisory projection not found")
    if request.query_params:
        raise HTTPException(400, "V5 advisory reads do not accept query parameters")
    base_url, token = _settings()
    try:
        async with asyncio.timeout(TIMEOUT_SECONDS):
            async with _client() as client:
                async with client.stream(
                    "GET",
                    f"{base_url}/{path}",
                    headers={"Authorization": f"Bearer {token}"},
                ) as upstream:
                    if upstream.status_code != 200:
                        raise HTTPException(
                            503, "V5 advisory observation is unavailable"
                        )
                    if (
                        upstream.headers.get("content-type", "")
                        .split(";", 1)[0]
                        .lower()
                        != "application/json"
                    ):
                        raise HTTPException(
                            502, "V5 advisory returned an invalid projection"
                        )
                    content_length = upstream.headers.get("content-length")
                    if content_length and content_length.isdecimal():
                        if (
                            len(content_length) > 10
                            or int(content_length) > MAX_RESPONSE_BYTES
                        ):
                            raise HTTPException(
                                502, "V5 advisory projection exceeds the size limit"
                            )
                    body = bytearray()
                    async for chunk in upstream.aiter_bytes(16 * 1024):
                        if len(body) + len(chunk) > MAX_RESPONSE_BYTES:
                            raise HTTPException(
                                502, "V5 advisory projection exceeds the size limit"
                            )
                        body.extend(chunk)
    except (httpx.HTTPError, TimeoutError) as exc:
        raise HTTPException(503, "V5 advisory observation is unavailable") from exc
    try:
        value = json.loads(body)
    except (ValueError, TypeError) as exc:
        raise HTTPException(502, "V5 advisory returned an invalid projection") from exc
    if type(value) is not dict:
        raise HTTPException(502, "V5 advisory returned an invalid projection")
    return Response(
        bytes(body),
        media_type="application/json",
        headers=_HEADERS,
    )
