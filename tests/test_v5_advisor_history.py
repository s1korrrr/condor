import pytest
from fastapi.testclient import TestClient

from condor.v5.app import create_app
from condor.v5.upstream import UpstreamError, V5Upstream
from test_v5_workspace_auth import FakeUpstream, login, settings
from test_v5_workspace_upstream import Session, make_settings, requests


class HistoryUpstream(FakeUpstream):
    def __init__(self, payload):
        super().__init__()
        self.payload = payload

    async def observation(self, path):
        if path.startswith('/v1/advice/history?'):
            self.observation_calls.append(path)
            if isinstance(self.payload, Exception):
                raise self.payload
            return self.payload
        return await super().observation(path)


def record(task='market_context'):
    return {'request_id': 'req', 'input': {'task_id': task, 'snapshot_id': 'snap', 'secret': 'PRIVATE_INPUT'},
            'result': {'task_id': task, 'status': 'ACCEPTED', 'raw': 'PRIVATE_RAW', 'advice': {
                'summary': 'x' * 1200, 'reason_codes': ['r' * 70] * 10,
                'evidence_refs': ['e' * 140] * 40}}}


def test_history_requires_dashboard_authentication(tmp_path):
    api = HistoryUpstream({'effect': 'NONE', 'records': []})
    with TestClient(create_app(settings=settings(tmp_path), upstream=api, static_dir=tmp_path / 'dist')) as client:
        assert client.get('/api/v5/advisor/history?task_id=market_context&limit=1').status_code == 401
    assert not api.observation_calls


def test_history_projects_bounded_records_and_unfinished_requests(tmp_path):
    api = HistoryUpstream({'effect': 'NONE', 'records': [record(), {'input': {'task_id': 'market_context'}, 'result': None}]})
    with TestClient(create_app(settings=settings(tmp_path), upstream=api, static_dir=tmp_path / 'dist')) as client:
        login(client)
        response = client.get('/api/v5/advisor/history?task_id=market_context&limit=2')
    assert response.status_code == 200
    body = response.json()
    advice = body['records'][0]['record']['result']['advice']
    assert len(advice['summary']) == 1000
    assert len(advice['reason_codes']) == 8 and len(advice['reason_codes'][0]) == 64
    assert len(advice['evidence_refs']) == 32 and len(advice['evidence_refs'][0]) == 128
    assert 'PRIVATE' not in response.text
    assert body['records'][1]['status'] == 'RESULT_NOT_PUBLISHED'
    assert api.observation_calls[-1] == '/v1/advice/history?task_id=market_context&limit=2'


def test_history_drops_non_string_nested_values(tmp_path):
    item = record()
    item['result']['coverage_status'] = []
    item['result']['advice']['reason_codes'] = [{'raw': 'PRIVATE_RAW'}, 'VALID']
    api = HistoryUpstream({'effect': 'NONE', 'records': [item]})
    with TestClient(create_app(settings=settings(tmp_path), upstream=api, static_dir=tmp_path / 'dist')) as client:
        login(client)
        response = client.get('/api/v5/advisor/history?task_id=market_context&limit=1')
    assert response.status_code == 200
    assert response.json()['records'][0]['record']['result']['advice']['reason_codes'] == ['VALID']
    assert 'PRIVATE' not in response.text


@pytest.mark.parametrize('query', ['', 'task_id=market_context', 'task_id=no&limit=1', 'task_id=market_context&limit=0',
    'task_id=market_context&limit=101', 'task_id=market_context&limit=01', 'task_id=market_context&limit=1&limit=2',
    'task_id=market_context&limit=1&other=x', 'task_id=market_context&limit=1&'])
def test_history_rejects_invalid_queries_before_upstream(tmp_path, query):
    api = HistoryUpstream({'effect': 'NONE', 'records': []})
    with TestClient(create_app(settings=settings(tmp_path), upstream=api, static_dir=tmp_path / 'dist')) as client:
        login(client)
        assert client.get('/api/v5/advisor/history?' + query).status_code == 400
    assert not api.observation_calls


@pytest.mark.parametrize('payload', [{'effect': 'ORDER', 'records': []}, {'effect': 'NONE', 'records': [record('source_quality')]},
    {'effect': 'NONE', 'records': [{'input': {'task_id': 'market_context'}}]},
    {'effect': 'NONE', 'records': [record(), record()]}, UpstreamError('upstream_timeout')])
def test_history_fails_closed_on_bad_owner_or_error(tmp_path, payload):
    api = HistoryUpstream(payload)
    with TestClient(create_app(settings=settings(tmp_path), upstream=api, static_dir=tmp_path / 'dist')) as client:
        login(client)
        response = client.get('/api/v5/advisor/history?task_id=market_context&limit=1')
    assert response.status_code == (503 if isinstance(payload, Exception) else 502)
    assert 'PRIVATE' not in response.text


@pytest.mark.asyncio
async def test_history_transport_allowlist(tmp_path):
    requests.clear()
    upstream = V5Upstream(make_settings(tmp_path), session_factory=Session)
    await upstream.observation('/v1/advice/history?task_id=decision_review&limit=100')
    assert len(requests) == 1
    for query in ('task_id=bad&limit=1', 'task_id=market_context&limit=101', 'task_id=market_context&limit=1&limit=2', 'task_id=market_context&limit=1&x=2', 'task_id=market_context&limit=01', 'task_id=market_context&limit=1&', 'task_id=market_context&limit=1#'):
        with pytest.raises(UpstreamError, match='operation_not_allowed'):
            await upstream.observation('/v1/advice/history?' + query)
    assert len(requests) == 1
