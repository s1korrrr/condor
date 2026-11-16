import json

import pytest
from fastapi.testclient import TestClient

from condor.v5.app import create_app
from condor.v5.upstream import MAX_RESPONSE_BYTES, UpstreamError, V5Upstream
from test_v5_workspace_auth import FakeUpstream, login, settings
from test_v5_workspace_upstream import Response, Session, make_settings, requests


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
            'result': {'task_id': task, 'effect': 'NONE', 'received_at_ms': 1, 'status': 'ACCEPTED', 'raw': 'PRIVATE_RAW', 'advice': {
                'summary': 'x' * 1200, 'reason_codes': ['r' * 70] * 10,
                'evidence_refs': ['e' * 140] * 40}}}


@pytest.mark.parametrize('result', [
    {'effect': 'ORDER', 'requested_at_ms': '9999999999999'},
    {'effect': 'ORDER', 'received_at_ms': 1},
    {'effect': 'NONE', 'requested_at_ms': '9999999999999'},
    {'effect': 'NONE', 'requested_at_ms': True},
    {'effect': 'NONE', 'received_at_ms': 0},
    {'effect': 'NONE', 'received_at_ms': 1, 'expires_at_ms': None},
    {'effect': 'NONE'},
])
def test_history_rejects_malformed_result_envelope(tmp_path, result):
    item = record()
    item['result'].pop('received_at_ms')
    item['result'].update(result)
    api = HistoryUpstream({'effect': 'NONE', 'records': [item]})
    with TestClient(create_app(settings=settings(tmp_path), upstream=api, static_dir=tmp_path / 'dist')) as client:
        login(client)
        response = client.get('/api/v5/advisor/history?task_id=market_context&limit=1')
    assert response.status_code == 502
    assert 'PRIVATE' not in response.text


def test_history_withholds_whole_envelope_when_later_record_is_invalid(tmp_path):
    invalid = record()
    invalid['result'].pop('effect')
    api = HistoryUpstream({'effect': 'NONE', 'records': [record(), invalid]})
    with TestClient(create_app(settings=settings(tmp_path), upstream=api, static_dir=tmp_path / 'dist')) as client:
        login(client)
        response = client.get('/api/v5/advisor/history?task_id=market_context&limit=2')
    assert response.status_code == 502
    assert 'PRIVATE' not in response.text


@pytest.mark.asyncio
async def test_history_size_guard_accepts_one_owner_capped_record(tmp_path):
    owner_cap = 64 * 1024
    wrapper_allowance = 1024
    assert 2 * owner_cap + wrapper_allowance == 132096
    assert MAX_RESPONSE_BYTES - (2 * owner_cap + wrapper_allowance) == 123904
    encode = lambda value: json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode()
    input_record = {'schema_version': 'advisory-input.v3', 'task_id': 'market_context', 'snapshot_id': 'snap',
                    'context_hash': 'a' * 64, 'scope_hash': 'b' * 64, 'cutoff_ms': 1, 'available_at_ms': 1,
                    'baseline_binding_hash': None, 'strategy_assessment_eligible': False,
                    'features': {'x': {'value': 1.0, 'unit': 'fraction_0_1', 'status': 'QUALIFIED'}},
                    'coverage_status': 'PARTIAL_OR_UNKNOWN'}
    feature = input_record['features'].pop('x')
    input_record['features']['x' * (owner_cap - len(encode(input_record)) - len(encode(feature)) - 3)] = feature
    result_record = {'request_id': '0' * 36, 'task_id': 'market_context', 'effect': 'NONE', 'received_at_ms': 1, 'raw': ''}
    result_record['raw'] = 'x' * (owner_cap - len(encode(result_record)))
    assert len(encode(input_record)) == owner_cap
    assert len(encode(result_record)) == owner_cap
    item = {'request_id': '0' * 36, 'input': input_record, 'result': result_record}
    body = encode({'effect': 'NONE', 'records': [item]})
    assert len(body) <= 2 * owner_cap + wrapper_allowance < MAX_RESPONSE_BYTES

    class HistorySession(Session):
        def request(self, method, url, **kwargs):
            return Response(200, body)

    upstream = V5Upstream(make_settings(tmp_path), session_factory=HistorySession)
    assert len((await upstream.observation('/v1/advice/history?task_id=market_context&limit=1'))['records']) == 1
    body = encode({'effect': 'NONE', 'records': [item, item]})
    assert len(body) > MAX_RESPONSE_BYTES
    with pytest.raises(UpstreamError, match='upstream_response_too_large'):
        await upstream.observation('/v1/advice/history?task_id=market_context&limit=2')


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
