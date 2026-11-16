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
        if path.startswith('/v1/advice/history/projected?'):
            self.observation_calls.append(path)
            if isinstance(self.payload, Exception):
                raise self.payload
            return self.payload
        return await super().observation(path)


def test_history_projects_owner_input_times(tmp_path):
    item = record()
    item.update(received_at_ms=5000, input_cutoff_ms=11000, input_available_at_ms=11000)
    api = HistoryUpstream({'effect': 'NONE', 'records': [item]})
    with TestClient(create_app(settings=settings(tmp_path), upstream=api, static_dir=tmp_path / 'dist')) as client:
        login(client)
        response = client.get('/api/v5/advisor/history?task_id=market_context&limit=1')
    assert response.status_code == 200
    projected = response.json()['records'][0]['record']['result']
    assert projected['input_cutoff_ms'] == 11000
    assert projected['input_available_at_ms'] == 11000


@pytest.mark.parametrize('key', ['requested_at_ms', 'received_at_ms', 'expires_at_ms', 'input_cutoff_ms', 'input_available_at_ms'])
@pytest.mark.parametrize('value', [4102444800001, 9007199254740992])
def test_history_rejects_out_of_range_owner_times(tmp_path, key, value):
    item = record()
    item[key] = value
    api = HistoryUpstream({'effect': 'NONE', 'records': [item]})
    with TestClient(create_app(settings=settings(tmp_path), upstream=api, static_dir=tmp_path / 'dist')) as client:
        login(client)
        response = client.get('/api/v5/advisor/history?task_id=market_context&limit=1')
    assert response.status_code == 502
    assert 'PRIVATE' not in response.text


@pytest.mark.parametrize('limit', ['2', '5'])
def test_history_reads_multiple_projected_records(tmp_path, limit):
    api = HistoryUpstream({'effect': 'NONE', 'records': [record() for _ in range(int(limit))]})
    with TestClient(create_app(settings=settings(tmp_path), upstream=api, static_dir=tmp_path / 'dist')) as client:
        login(client)
        response = client.get(f'/api/v5/advisor/history?task_id=market_context&limit={limit}')
    assert response.status_code == 200
    assert len(response.json()['records']) == int(limit)
    assert api.observation_calls == [f'/v1/advice/history/projected?task_id=market_context&limit={limit}']


def record(task='market_context'):
    return {'request_id': 'req', 'task_id': task, 'effect': 'NONE', 'received_at_ms': 1,
            'status': 'ACCEPTED', 'raw': 'PRIVATE_RAW', 'input': {'secret': 'PRIVATE_INPUT'}, 'advice': {
                'summary': 'x' * 1200, 'reason_codes': ['r' * 70] * 10,
                'evidence_refs': ['e' * 140] * 40}}


@pytest.mark.parametrize('result', [
    {'effect': 'ORDER', 'requested_at_ms': '9999999999999'},
    {'effect': 'ORDER', 'received_at_ms': 1},
    {'effect': 'NONE', 'requested_at_ms': '9999999999999'},
    {'effect': 'NONE', 'requested_at_ms': True},
    {'effect': 'NONE', 'received_at_ms': 0},
    {'effect': 'NONE', 'received_at_ms': 1, 'expires_at_ms': None},
    {'effect': 'NONE', 'received_at_ms': 1, 'input_cutoff_ms': '1'},
    {'effect': 'NONE', 'received_at_ms': 1, 'input_available_at_ms': False},
    {'effect': 'NONE'},
])
def test_history_rejects_malformed_result_envelope(tmp_path, result):
    item = record()
    item.pop('received_at_ms')
    item.update(result)
    api = HistoryUpstream({'effect': 'NONE', 'records': [item]})
    with TestClient(create_app(settings=settings(tmp_path), upstream=api, static_dir=tmp_path / 'dist')) as client:
        login(client)
        response = client.get('/api/v5/advisor/history?task_id=market_context&limit=1')
    assert response.status_code == 502
    assert 'PRIVATE' not in response.text


def test_history_withholds_envelope_when_record_is_invalid(tmp_path):
    invalid = record()
    invalid.pop('effect')
    api = HistoryUpstream({'effect': 'NONE', 'records': [record(), invalid]})
    with TestClient(create_app(settings=settings(tmp_path), upstream=api, static_dir=tmp_path / 'dist')) as client:
        login(client)
        response = client.get('/api/v5/advisor/history?task_id=market_context&limit=5')
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
    provider_cap = 32 * 1024
    provider_raw = {'model': 'model', 'usage': {'input_tokens': 1, 'output_tokens': 1}, 'stop_reason': 'end_turn',
                    'content': [{'type': 'text', 'text': ''}]}
    realistic_result = {'request_id': '0' * 36, 'task_id': 'market_context', 'effect': 'NONE',
                        'received_at_ms': 1, 'status': 'REJECTED', 'raw': provider_raw}
    canonical = lambda value: json.dumps(value, separators=(',', ':'), allow_nan=False).encode()
    provider_raw['content'][0]['text'] = '\u0800' * ((owner_cap - len(canonical(realistic_result))) // 6)
    assert len(encode(provider_raw)) == 32759 < provider_cap
    assert len(canonical(realistic_result)) == 65535 < owner_cap
    result_record = {'request_id': '0' * 36, 'task_id': 'market_context', 'effect': 'NONE', 'received_at_ms': 1, 'raw': ''}
    result_record['raw'] = 'x' * (owner_cap - len(encode(result_record)))
    assert len(encode(input_record)) == owner_cap
    assert len(encode(result_record)) == owner_cap
    item = {'request_id': '0' * 36, 'input': input_record, 'result': result_record}
    body = encode({'effect': 'NONE', 'records': [item]})
    assert len(body) == 131174 <= 2 * owner_cap + wrapper_allowance < MAX_RESPONSE_BYTES

    class HistorySession(Session):
        def request(self, method, url, **kwargs):
            return Response(200, body)

    upstream = V5Upstream(make_settings(tmp_path), session_factory=HistorySession)
    assert len((await upstream.observation('/v1/advice/history?task_id=market_context&limit=1'))['records']) == 1
    realistic_item = {'request_id': '0' * 36, 'input': input_record, 'result': realistic_result}
    body = encode({'effect': 'NONE', 'records': [realistic_item]})
    assert len(body) == 98539 < MAX_RESPONSE_BYTES
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
    api = HistoryUpstream({'effect': 'NONE', 'records': [record()]})
    with TestClient(create_app(settings=settings(tmp_path), upstream=api, static_dir=tmp_path / 'dist')) as client:
        login(client)
        response = client.get('/api/v5/advisor/history?task_id=market_context&limit=1')
        api.payload = {'effect': 'NONE', 'records': [{'task_id': 'market_context', 'request_id': 'pending',
            'status': 'RESULT_NOT_PUBLISHED', 'effect': 'NONE', 'requested_at_ms': 1}]}
        pending = client.get('/api/v5/advisor/history?task_id=market_context&limit=1')
    assert response.status_code == 200
    body = response.json()
    advice = body['records'][0]['record']['result']['advice']
    assert len(advice['summary']) == 1000
    assert len(advice['reason_codes']) == 8 and len(advice['reason_codes'][0]) == 64
    assert len(advice['evidence_refs']) == 32 and len(advice['evidence_refs'][0]) == 128
    assert 'PRIVATE' not in response.text
    assert pending.status_code == 200
    assert pending.json()['records'][0]['status'] == 'RESULT_NOT_PUBLISHED'
    assert api.observation_calls[-1] == '/v1/advice/history/projected?task_id=market_context&limit=1'


def test_history_drops_non_string_nested_values(tmp_path):
    item = record()
    item['coverage_status'] = []
    item['advice']['reason_codes'] = [{'raw': 'PRIVATE_RAW'}, 'VALID']
    api = HistoryUpstream({'effect': 'NONE', 'records': [item]})
    with TestClient(create_app(settings=settings(tmp_path), upstream=api, static_dir=tmp_path / 'dist')) as client:
        login(client)
        response = client.get('/api/v5/advisor/history?task_id=market_context&limit=1')
    assert response.status_code == 200
    assert response.json()['records'][0]['record']['result']['advice']['reason_codes'] == ['VALID']
    assert 'PRIVATE' not in response.text


@pytest.mark.parametrize('query', ['', 'task_id=market_context', 'task_id=no&limit=1', 'task_id=market_context&limit=0',
    'task_id=market_context&limit=6', 'task_id=market_context&limit=25', 'task_id=market_context&limit=100',
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


@pytest.mark.parametrize('status', [404, 405])
def test_history_missing_projected_owner_never_falls_back(tmp_path, status):
    api = HistoryUpstream(UpstreamError('upstream_unavailable', http_status=status))
    with TestClient(create_app(settings=settings(tmp_path), upstream=api, static_dir=tmp_path / 'dist')) as client:
        login(client)
        response = client.get('/api/v5/advisor/history?task_id=market_context&limit=5')
    assert response.status_code == 503
    assert response.json()['detail']['code'] == 'ADVISOR_PROJECTED_HISTORY_UNAVAILABLE'
    assert api.observation_calls == ['/v1/advice/history/projected?task_id=market_context&limit=5']


@pytest.mark.asyncio
async def test_projected_history_transport_bound_and_allowlist(tmp_path):
    item = record()
    item.pop('raw')
    item.pop('input')
    item.update(request_id='\x00' * 128, task_id='decision_review', status='\x00' * 256, model='\x00' * 256,
                actual_usd='0.' + '1' * 62, coverage_status='COMPLETE_OBSERVED_COHORT')
    for key in ('requested_at_ms', 'received_at_ms', 'expires_at_ms', 'input_cutoff_ms', 'input_available_at_ms'):
        item[key] = 4102444800000
    item['advice'] = {'assessment': '\x00' * 1000, 'summary': '\x00' * 1000,
                      'reason_codes': ['\x00' * 64] * 8, 'evidence_refs': ['\x00' * 128] * 32}
    body = json.dumps({'effect': 'NONE', 'records': [item] * 5}, separators=(',', ':'), ensure_ascii=False).encode()
    assert len(body) == 220309 < MAX_RESPONSE_BYTES

    class ProjectedSession(Session):
        def request(self, method, url, **kwargs):
            return Response(200, body)

    upstream = V5Upstream(make_settings(tmp_path), session_factory=ProjectedSession)
    result = await upstream.observation('/v1/advice/history/projected?task_id=decision_review&limit=5')
    assert len(result['records']) == 5
    for limit in ('0', '6', '25', '100', '01', '1&', '1&limit=2', '1#'):
        with pytest.raises(UpstreamError, match='operation_not_allowed'):
            await upstream.observation('/v1/advice/history/projected?task_id=market_context&limit=' + limit)
