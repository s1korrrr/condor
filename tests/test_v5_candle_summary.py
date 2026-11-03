"""Combined `summary` read: one owner pass for overview + symbols, owner error codes, and the older-owner fallback."""

import json
import tempfile
from pathlib import Path

import pytest
from aiohttp import web

from condor.v5.candles import (
    CandleOwner,
    OwnerUnavailable,
    owner_error_code,
    validate_payload,
    validate_query,
)

TILE = {
    "lane": "okx__spot",
    "venue": "okx",
    "segment": "spot",
    "health": "green",
    "health_rules": [{"level": "green", "rule": "service", "detail": "ok"}],
    "partition_errors": [],
    "available": True,
    "gaps_7d": 0,
}
ROW = {
    "lane": "okx__spot",
    "venue": "okx",
    "segment": "spot",
    "pair": "BTC-USDT",
    "health": "green",
    "health_rules": [],
    "last_minute": 60,
    "coverage_1h": 1,
}
OVERVIEW = {"now": 120, "status_age_s": 2, "status_error": None, "tiles": [TILE]}
SUMMARY = {**OVERVIEW, "rows": [ROW], "generation": 7, "compute_ms": 3.1}


def test_summary_query_takes_no_parameters():
    assert validate_query("summary", []) == {}
    with pytest.raises(ValueError):
        validate_query("summary", [("full", "1")])


def test_summary_payload_is_overview_plus_rows():
    safe = validate_payload("summary", SUMMARY)
    assert safe["tiles"] == validate_payload("overview", OVERVIEW)["tiles"]
    assert (
        safe["rows"] == validate_payload("symbols", {"now": 120, "rows": [ROW]})["rows"]
    )
    assert set(safe) == {"now", "status_age_s", "status_error", "tiles", "rows"}


@pytest.mark.parametrize(
    "edit",
    [
        lambda p: p.pop("rows"),
        lambda p: p.update(rows=[{**ROW, "lane": "../x"}]),
        lambda p: p.update(tiles=[{**TILE, "health": "blue"}]),
        lambda p: p.update(rows=[{**ROW, "last_minute": 600}]),
    ],
)
def test_summary_payload_rejects_what_either_view_rejects(edit):
    payload = json.loads(json.dumps(SUMMARY))
    edit(payload)
    with pytest.raises(OwnerUnavailable):
        validate_payload("summary", payload)


@pytest.mark.parametrize(
    "status,body,code",
    [
        (404, b"", "owner_view_unavailable"),
        (503, b'{"error":"owner_warming"}', "owner_warming"),
        (503, b'{"error":"owner_warm_unavailable"}', "owner_warm_unavailable"),
        (503, b'{"error":"owner_busy"}', "owner_busy"),
        (503, b'{"error":"owner_compute_timeout"}', "owner_compute_timeout"),
        (503, b'{"error":"something /home/rsi/secret"}', "owner_http_error"),
        (503, b"not json", "owner_http_error"),
        (503, b'["owner_warming"]', "owner_http_error"),
        (500, b'{"error":"owner_warming"' + b" " * 5000 + b"}", "owner_http_error"),
    ],
)
def test_owner_error_codes_are_allowlisted_and_bounded(status, body, code):
    assert owner_error_code(status, body) == code


async def _serve(routes):
    app = web.Application()
    for path, handler in routes.items():
        app.router.add_get(path, handler)
    runner = web.AppRunner(app)
    await runner.setup()
    path = str(Path(tempfile.mkdtemp(prefix="uds-")) / "owner.sock")
    await web.UnixSite(runner, path).start()
    return runner, path


@pytest.mark.asyncio
async def test_summary_reads_one_owner_pass():
    calls = []

    async def summary(request):
        calls.append("summary")
        return web.json_response(SUMMARY)

    runner, path = await _serve({"/api/summary": summary})
    try:
        data = await CandleOwner(path).read_summary()
    finally:
        await runner.cleanup()
    assert calls == ["summary"] and data["rows"][0]["pair"] == "BTC-USDT"


@pytest.mark.asyncio
async def test_older_owner_without_summary_is_read_view_by_view():
    calls = []

    async def overview(request):
        calls.append("overview")
        return web.json_response(OVERVIEW)

    async def symbols(request):
        calls.append("symbols")
        return web.json_response({"now": 121, "rows": [ROW]})

    runner, path = await _serve({"/api/overview": overview, "/api/symbols": symbols})
    try:
        data = await CandleOwner(path).read_summary()
    finally:
        await runner.cleanup()
    assert calls == ["overview", "symbols"]
    assert data["now"] == 120 and data["tiles"][0]["lane"] == "okx__spot"
    assert data["rows"][0]["pair"] == "BTC-USDT"


@pytest.mark.asyncio
async def test_warming_owner_is_reported_with_its_code_not_as_fallback():
    calls = []

    async def summary(request):
        calls.append("summary")
        return web.json_response({"error": "owner_warming"}, status=503)

    async def overview(request):
        calls.append("overview")
        return web.json_response(OVERVIEW)

    runner, path = await _serve({"/api/summary": summary, "/api/overview": overview})
    try:
        with pytest.raises(OwnerUnavailable) as raised:
            await CandleOwner(path).read_summary()
    finally:
        await runner.cleanup()
    assert str(raised.value) == "owner_warming" and calls == ["summary"]
