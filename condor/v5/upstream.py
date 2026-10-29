"""Fixed, bounded HTTP client for the V5 observation and advisory APIs."""

from __future__ import annotations

import asyncio
import json
import re
from urllib.parse import parse_qsl, urlsplit
from typing import Any

import aiohttp

from .config import Settings, read_secret_file

MAX_RESPONSE_BYTES = 256_000
MAX_REQUEST_BYTES = 2_048


class UpstreamError(RuntimeError):
    def __init__(
        self, code: str, *, http_status: int = 503, body: dict[str, Any] | None = None
    ):
        super().__init__(code)
        self.code = code
        self.http_status = http_status
        self.body = body or {}


class V5Upstream:
    def __init__(self, settings: Settings, *, session_factory=aiohttp.ClientSession):
        self.settings = settings
        self.session_factory = session_factory

    async def _request(
        self,
        base_url: str,
        path: str,
        token_file,
        *,
        method: str = "GET",
        payload=None,
        timeout_sec: float = 5.0,
    ):
        token = read_secret_file(token_file)
        if not 32 <= len(token) <= 256:
            raise UpstreamError("upstream_auth_unavailable")
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
        data = None
        if payload is not None:
            data = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode()
            if len(data) > MAX_REQUEST_BYTES:
                raise UpstreamError("request_too_large", http_status=400)
            headers["Content-Type"] = "application/json"
        try:
            async with asyncio.timeout(timeout_sec):
                timeout = aiohttp.ClientTimeout(total=timeout_sec)
                async with self.session_factory(timeout=timeout) as session:
                    async with session.request(
                        method,
                        base_url + path,
                        headers=headers,
                        data=data,
                        allow_redirects=False,
                    ) as response:
                        # read(n) may return one fragment; read through EOF
                        # under the request timeout, stopping at the bound.
                        body = bytearray()
                        while True:
                            chunk = await response.content.read(
                                MAX_RESPONSE_BYTES + 1 - len(body)
                            )
                            if not chunk:
                                break
                            body.extend(chunk)
                            if len(body) > MAX_RESPONSE_BYTES:
                                raise UpstreamError("upstream_response_too_large")
                        raw = bytes(body)
                        try:
                            result = json.loads(raw)
                        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                            raise UpstreamError("upstream_invalid_response") from exc
                        if not isinstance(result, dict):
                            raise UpstreamError("upstream_invalid_response")
                        if response.status >= 400:
                            code = (
                                "task_refused"
                                if response.status == 409
                                else "upstream_unavailable"
                            )
                            raise UpstreamError(
                                code,
                                http_status=response.status,
                                body=_safe_refusal(result),
                            )
                        return result
        except (asyncio.TimeoutError, TimeoutError) as exc:
            raise UpstreamError("upstream_timeout") from exc
        except aiohttp.ClientError as exc:
            raise UpstreamError("upstream_unavailable") from exc

    async def observation(self, path: str) -> dict[str, Any]:
        allowed = {
            "/v1/context",
            "/v1/source/status",
            "/v1/identity",
            "/v1/advice/status",
            "/v1/advice/history",
            "/v1/advice/latest",
            "/v1/advice/latest?task_id=market_context",
            "/v1/advice/latest?task_id=source_quality",
            "/v1/advice/latest?task_id=decision_review",
            "/v1/tasks",
        }
        parts = urlsplit(path)
        paper_route = parts.path in {
            f"/v1/paper/{section}"
            for section in (
                "status",
                "wallet",
                "fills",
                "positions",
                "executors",
                "risk",
                "decisions",
                "history",
                "operations",
                "accounting",
            )
        }
        if paper_route:
            params = parse_qsl(parts.query, keep_blank_values=True)
            paper_route = (
                not parts.scheme
                and not parts.netloc
                and not parts.fragment
                and len(params) == len(dict(params))
                and len(path) <= 2048
                and all(
                    (
                        key == "limit"
                        and value.isascii()
                        and value.isdigit()
                        and 1 <= int(value) <= 1000
                    )
                    or (
                        key in {"start_ms", "end_ms"}
                        and value.isascii()
                        and value.isdigit()
                        and 0 <= int(value) <= 10**14
                    )
                    or (
                        key == "cursor"
                        and re.fullmatch(r"[A-Za-z0-9_.:=-]{1,1024}", value)
                    )
                    or (
                        key == "snapshot_id"
                        and re.fullmatch(r"[A-Za-z0-9_.:-]{1,160}", value)
                    )
                    for key, value in params
                )
            )
        if path not in allowed and not paper_route:
            raise UpstreamError("operation_not_allowed", http_status=403)
        base_url = (
            self.settings.advisor_control_base_url
            if path == "/v1/tasks"
            else self.settings.observation_base_url
        )
        token_file = self.settings.observation_read_token_file
        return await self._request(
            base_url,
            path,
            token_file,
        )

    async def task_profiles(self) -> dict[str, Any]:
        return await self.observation("/v1/tasks")

    async def latest_task_report(self, task_id: str) -> dict[str, Any]:
        if task_id not in {"market_context", "source_quality", "decision_review"}:
            raise UpstreamError("task_not_allowed", http_status=403)
        return await self.observation(f"/v1/advice/latest?task_id={task_id}")

    async def request_report(self, task_id: str, snapshot_id: str) -> dict[str, Any]:
        if task_id not in {"market_context", "source_quality", "decision_review"}:
            raise UpstreamError("task_not_allowed", http_status=403)
        if not snapshot_id or len(snapshot_id) > 128:
            raise UpstreamError("snapshot_id_required", http_status=400)
        return await self._request(
            self.settings.advisor_control_base_url,
            "/v1/assessments",
            self.settings.advisor_request_token_file,
            method="POST",
            payload={"task_id": task_id, "snapshot_id": snapshot_id},
            timeout_sec=12.0,
        )


def _safe_refusal(value: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key in ("status", "reason", "effect", "task_id", "request_id"):
        item = value.get(key)
        if isinstance(item, (str, bool)) or item is None:
            result[key] = item
    if result.get("effect") not in ("NONE", None):
        result["effect"] = "NONE"
    return result
