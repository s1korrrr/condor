"""Regressions from the pre-merge audit of the V5 workspace (PR #73)."""

from __future__ import annotations

import asyncio

import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

from condor.v5.app import _safe_task_latest
from condor.v5.state import _bounded_report
from condor.v5.upstream import MAX_RESPONSE_BYTES, UpstreamError, V5Upstream


async def _serve(handler, tmp_path, call):
    token = tmp_path / "token"
    token.write_text("r" * 48)
    application = web.Application()
    application.router.add_get("/v1/context", handler)
    async with TestServer(application) as server:
        return await call(
            V5Upstream(None), str(server.make_url("/")).rstrip("/"), token
        )


@pytest.mark.asyncio
async def test_valid_fragmented_json_is_accepted(tmp_path):
    async def fragmented(request):
        response = web.StreamResponse(headers={"Content-Type": "application/json"})
        await response.prepare(request)
        await response.write(b'{"status":')
        await asyncio.sleep(0.05)
        await response.write(b'"AVAILABLE"}')
        await response.write_eof()
        return response

    result = await _serve(
        fragmented,
        tmp_path,
        lambda client, base, token: client._request(base, "/v1/context", token),
    )
    assert result == {"status": "AVAILABLE"}


@pytest.mark.asyncio
async def test_streamed_oversized_body_is_rejected(tmp_path):
    async def oversized(request):
        response = web.StreamResponse(headers={"Content-Type": "application/json"})
        await response.prepare(request)
        for _ in range(MAX_RESPONSE_BYTES // 4096 + 2):
            await response.write(b" " * 4096)
        await response.write_eof()
        return response

    with pytest.raises(UpstreamError, match="upstream_response_too_large"):
        await _serve(
            oversized,
            tmp_path,
            lambda client, base, token: client._request(base, "/v1/context", token),
        )


def test_new_api_diagnostics_are_kept_and_bounded():
    payload = {
        "status": "HISTORICAL_REPORT",
        "validity_watermark": {
            "watermark_ms": 100,
            "reason": "CHANGED:configuration_files",
        },
        "record": {
            "input": {"task_id": "market_context"},
            "result": {
                "task_id": "market_context",
                "status": "REJECTED",
                "rejection": "schema:evidence_refs:too_long",
            },
        },
    }
    projected = _safe_task_latest("market_context", payload)
    assert projected["validity_watermark"] == payload["validity_watermark"]
    assert projected["record"]["result"]["rejection"] == "schema:evidence_refs:too_long"
    hostile = dict(
        payload, validity_watermark={"watermark_ms": True, "reason": "<script>" * 100}
    )
    hostile["record"] = {
        "input": {"task_id": "market_context"},
        "result": {"task_id": "market_context", "rejection": "x" * 5000},
    }
    projected = _safe_task_latest("market_context", hostile)
    assert "validity_watermark" not in projected
    assert len(projected["record"]["result"]["rejection"]) == 300


def test_session_report_keeps_rejection():
    assert (
        _bounded_report({"status": "REJECTED", "rejection": "schema_invalid"})[
            "rejection"
        ]
        == "schema_invalid"
    )
    assert (
        len(
            _bounded_report({"status": "REJECTED", "rejection": "y" * 5000})[
                "rejection"
            ]
        )
        == 300
    )
