from __future__ import annotations

import json

import pytest

from condor.v5.config import Settings
from condor.v5.upstream import UpstreamError, V5Upstream


class Content:
    def __init__(self, body):
        self.body = body

    async def read(self, size):
        chunk, self.body = self.body[:size], self.body[size:]
        return chunk


class Response:
    def __init__(self, status, body):
        self.status = status
        self.content = Content(body)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None


class Session:
    def __init__(self, *, timeout):
        self.timeout = timeout
        timeouts.append(timeout)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    def request(self, method, url, **kwargs):
        requests.append((method, url, kwargs))
        if url.endswith("/v1/assessments"):
            return Response(409, b'{"status":"BUDGET_REFUSED","effect":"NONE"}')
        return Response(200, b'{"tasks":[]}')


requests = []
timeouts = []


@pytest.mark.asyncio
async def test_paper_transport_enforces_api73_page_limit_and_cursor_capacity(tmp_path):
    requests.clear()
    upstream = V5Upstream(make_settings(tmp_path), session_factory=Session)
    await upstream.observation("/v1/paper/history?limit=200")
    assert len(requests) == 1
    for query in ("limit=201", "limit=1000", "cursor=" + "a" * 513):
        with pytest.raises(UpstreamError, match="operation_not_allowed"):
            await upstream.observation("/v1/paper/history?" + query)
    assert len(requests) == 1


class SlowValidResponse(Response):
    simulated_elapsed_sec = 10.1

    async def __aenter__(self):
        # Model a service completing just after its ten-second provider budget;
        # the report HTTP timeout must still allow the trusted envelope to land.
        assert self.simulated_elapsed_sec < timeouts[-1].total
        return self


class SlowSession(Session):
    def request(self, method, url, **kwargs):
        requests.append((method, url, kwargs))
        if url.endswith("/v1/assessments"):
            body = b'{"request_id":"r1","status":"ACCEPTED","advice":{"assessment":"NORMAL","reason_codes":["MIXED_CONTEXT"],"evidence_refs":["breadth_1h"],"summary":"Evidence is mixed."},"effect":"NONE"}'
            return SlowValidResponse(200, body)
        return Response(200, b'{"tasks":[]}')


def make_settings(tmp_path):
    read = tmp_path / "read"
    request = tmp_path / "request"
    read.write_text("r" * 48)
    request.write_text("q" * 48)
    return Settings(
        runtime_root=tmp_path / "runtime",
        dashboard_token_file=tmp_path / "dash",
        dashboard_origin="https://v5.example.test",
        observation_base_url="https://context-api.example.test",
        observation_read_token_file=read,
        advisor_control_base_url="https://advisor-api.example.test",
        advisor_request_token_file=request,
    )


@pytest.mark.asyncio
async def test_task_profiles_use_read_token_and_assessments_use_distinct_request_token(
    tmp_path,
):
    requests.clear()
    upstream = V5Upstream(make_settings(tmp_path), session_factory=Session)
    await upstream.task_profiles()
    assert requests[0][0:2] == ("GET", "https://advisor-api.example.test/v1/tasks")
    assert requests[0][2]["headers"]["Authorization"] == "Bearer " + "r" * 48
    assert requests[0][2]["allow_redirects"] is False

    with pytest.raises(UpstreamError) as refused:
        await upstream.request_report("market_context", "snap-1")
    assert refused.value.code == "task_refused"
    assert requests[1][0:2] == (
        "POST",
        "https://advisor-api.example.test/v1/assessments",
    )
    assert requests[1][2]["headers"]["Authorization"] == "Bearer " + "q" * 48
    assert json.loads(requests[1][2]["data"]) == {
        "task_id": "market_context",
        "snapshot_id": "snap-1",
    }


@pytest.mark.asyncio
async def test_request_cannot_choose_arbitrary_task_or_snapshot(tmp_path):
    requests.clear()
    upstream = V5Upstream(make_settings(tmp_path), session_factory=Session)
    with pytest.raises(UpstreamError, match="task_not_allowed"):
        await upstream.request_report("decision_reviewer", "snap-1")
    with pytest.raises(UpstreamError, match="snapshot_id_required"):
        await upstream.request_report("market_context", "")
    assert requests == []


@pytest.mark.asyncio
async def test_latest_task_report_uses_only_fixed_task_scoped_read_paths(tmp_path):
    requests.clear()
    upstream = V5Upstream(make_settings(tmp_path), session_factory=Session)
    await upstream.latest_task_report("market_context")
    assert requests[0][0:2] == (
        "GET",
        "https://context-api.example.test/v1/advice/latest?task_id=market_context",
    )
    with pytest.raises(UpstreamError, match="task_not_allowed"):
        await upstream.latest_task_report("decision_reviewer")
    assert len(requests) == 1


@pytest.mark.asyncio
async def test_valid_report_after_ten_second_provider_budget_fits_twelve_second_http_cap(
    tmp_path,
):
    requests.clear()
    timeouts.clear()
    upstream = V5Upstream(make_settings(tmp_path), session_factory=SlowSession)
    result = await upstream.request_report("market_context", "snapshot-7")
    assert result["status"] == "ACCEPTED"
    assert result["effect"] == "NONE"
    assert timeouts[-1].total == 12
