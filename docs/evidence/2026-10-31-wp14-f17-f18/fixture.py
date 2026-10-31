import copy
import base64
import json
import time
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

from fastapi import Request
from fastapi.responses import RedirectResponse
from condor.v5.app import create_app
from condor.v5.config import Settings
from condor.v5.state import WorkspaceState
from condor.v5.upstream import UpstreamError

root = Path('/fixture')
runtime = Path('/fixture-runtime')
runtime.mkdir(exist_ok=True)
for name in ('dashboard', 'observation', 'request'):
    (runtime / (name + '.token')).write_text('fixture-only-access-' + 'x' * 40)
v1 = json.loads((Path('/opt/condor/real-fixtures') / 'native-status.json').read_text())
c1 = json.loads((root / 'c1-1e131c74.json').read_text())
c1['risk'] = json.loads((root / 'native-risk-1e131c74.json').read_text())['risk']
scenarios = {name: json.loads((root / file).read_text()) for name, file in {'closed': 'closed-1757956.json', 'dust': 'dust-1757956.json', 'hold': 'clock-1757956.json', 'invalid': 'invalid-1757956.json', 'stop': 'stop-1757956.json'}.items()}
scenarios.update({name: json.loads((root / ('b123-' + file + '.json')).read_text()) for name, file in {'damaged':'stop-intent-log-damaged','ingress':'ingress-unreadable-hold','anomaly':'clock-anomaly-hold','controls':'paper-controls-unavailable'}.items()})
api_envelopes = {section: json.loads((Path('/opt/condor/real-fixtures/native-replay') / (section + '.json')).read_text()) for section in ('status','wallet','positions','fills','executors','risk','decisions','history','operations','accounting')}
mode = 'fresh'
fixed = int(time.time() * 1000)


def refresh():
    value = copy.deepcopy(v1)
    now = time.time() - (60 if mode == 'stale' else 0)
    value.update(generated_at=now, report_observed_at=now)
    if mode == 'hold':
        value.update(ready=False, reasons=['clock_persistence_failed'])
    pending = runtime / ('status-' + str(time.time_ns()) + '.pending')
    pending.write_text(json.dumps(value))
    pending.replace(runtime / 'meridian_v5_paper.status.json')


class FixtureSource:
    async def observation(self, path):
        if path.startswith('/v1/paper/'):
            section = urlsplit(path).path.rsplit('/', 1)[1]
            packet = copy.deepcopy(api_envelopes[section])
            requested = parse_qs(urlsplit(path).query)
            if 'limit' in requested and int(requested['limit'][0]) > 200:
                raise AssertionError('Owner API limit exceeded')
            if 'cursor' in requested:
                cursor = json.loads(base64.urlsafe_b64decode(requested['cursor'][0]))
                assert cursor['section'] == section
                assert cursor['snapshot_id'] == requested['snapshot_id'][0]
                packet = json.loads((Path('/opt/condor/real-fixtures/native-replay') / (section + '-offset-' + str(cursor['offset']) + '.json')).read_text())
            pinned = parse_qs(urlsplit(path).query).get('snapshot_id', [None])[0]
            sequence = int(pinned.rsplit(':', 1)[1]) if pinned else int(time.time() // 10)
            generated = sequence * 10000
            snapshot = packet['snapshot_id'].rsplit(':', 1)[0] + ':' + str(sequence)
            offset = generated - packet['generated_at_ms']
            def shift(value, key=''):
                if isinstance(value, dict):
                    return {name: shift(child, name) for name, child in value.items()}
                if isinstance(value, list):
                    return [shift(child) for child in value]
                if key == 'snapshot_id':
                    return snapshot
                if key == 'next_cursor' and value is not None:
                    cursor = json.loads(base64.urlsafe_b64decode(value))
                    cursor['snapshot_id'] = snapshot
                    return base64.urlsafe_b64encode(json.dumps(cursor).encode()).decode()
                if key == 'sequence':
                    return sequence
                if key.endswith('_ms') and type(value) is int:
                    return value + offset
                return value
            return shift(packet)
        if path == '/v1/context':
            return {'schema_version':'multi-venue-evidence.v1', 'snapshot_id':'fixture-context', 'available_at_ms':fixed}
        if path == '/v1/source/status':
            return {'schema_version':'v5-feed-refresh-status.v1', 'state':'HEALTHY', 'last_attempt_at_ms':fixed-2000, 'last_success_at_ms':fixed-2000, 'last_success_cutoff_ms':fixed-60000, 'observed_at_ms':fixed, 'feed_fresh_until_ms':fixed-1000, 'feed_freshness':'UNAVAILABLE', 'refresher_status':'CURRENT'}
        if path == '/v1/identity':
            return {'upstream_revision':'synthetic-browser-fixture'}
        if path == '/v1/advice/status':
            return dict(enabled=False, model=None, calls_today=0, spent_usd='0', reserved_usd='0', effect='NONE')
        if path == '/v1/advice/history':
            return {'records':[], 'effect':'NONE'}
        if path == '/v1/advice/latest':
            return {'status':'UNAVAILABLE', 'record':None, 'effect':'NONE'}
        raise AssertionError(path)

    async def task_profiles(self):
        return {'tasks':[{'task_id':name, 'model':None, 'enabled':False, 'reason':'Paid requests disabled for fixture qualification'} for name in ('market_context', 'source_quality', 'decision_review')], 'scheduler':{'enabled':False}}

    async def latest_task_report(self, task_id):
        return {'status':'HISTORICAL_REPORT', 'effect':'NONE', 'record':{
            'request_id':'fixture-expired-'+task_id, 'snapshot_id':'fixture-context',
            'input':{'task_id':task_id, 'snapshot_id':'fixture-context'},
            'result':{'task_id':task_id, 'effect':'NONE', 'status':'REJECTED', 'requested_at_ms':fixed-100000,
                      'received_at_ms':fixed-90000, 'expires_at_ms':fixed-60000, 'actual_usd':None,
                      'rejection':'fixture-invalid-response', 'advice':{'summary':'Synthetic expired/rejected record. No provider invocation.'}}}}

    async def request_report(self, *args):
        raise AssertionError('Provider invocation forbidden in qualification')


from condor.v5.candles import CandleOwner, validate_payload

async def synthetic_candle_read(self, view, query):
    now = int(time.time())
    end = now // 60 * 60
    common = dict(lane='okx__spot',venue='okx',segment='spot',health='green',health_rules=[dict(level='green',rule='fixture',detail='Synthetic closed candles; not a production source')],partition_errors=[],available=True,last_minute=end-60,last_minute_age_s=now-end,coverage_1h=1.0,coverage_24h=None,coverage_7d=None,gaps_7d=None,pending=0,unrecoverable_7d=None,no_trade_7d=None,ws_state='fixture',grace_s=10,volume_unit='base')
    if view == 'overview':
        value = dict(now=now,status_age_s=2,status_error=None,tiles=[dict(**common,pairs_held=5,pairs_listed=5)])
    elif view == 'symbols':
        value = dict(now=now,rows=[dict(**common,pair=pair) for pair in ('BNB-USDC','BTC-USDC','ETH-USDC','SOL-USDC','XRP-USDC')])
    else:
        count = {'1h':60,'6h':360,'24h':1440,'7d':10080}[query['range']]
        start=end-count*60
        value = dict(now=now,lane='okx__spot',venue='okx',segment='spot',pair=query['pair'],range=query['range'],res_s=60,start=start,end=end-60,volume_unit='base',totals=dict(final=count,no_trade=0,unrecoverable=0,missing=0,pending=0,corrections=0),buckets=[[start+offset*60,100,102,99,101,None,1,0,0,0,0,0] for offset in range(count)])
    return validate_payload(view,value)

CandleOwner.read = synthetic_candle_read

refresh()
settings = Settings(runtime_root=runtime/'store', dashboard_token_file=runtime/'dashboard.token',
                    dashboard_origin='https://razer.tailb24ea3.ts.net:28443',
                    observation_base_url='http://fixture.invalid', observation_read_token_file=runtime/'observation.token',
                    advisor_control_base_url='http://fixture.invalid', advisor_request_token_file=runtime/'request.token',
                    cookie_secure=True, stock_agents_root=Path('/opt/condor/agents_v5'),
                    paper_status_file=runtime/'meridian_v5_paper.status.json', host_operations_file=runtime/'operations.json', candle_store_socket=runtime/'synthetic.sock')
store = WorkspaceState(settings.runtime_root)
if not store.sessions():
    for status, summary in [('COMPLETED','Synthetic deterministic source inspection'), ('FAILED','Synthetic interrupted request · provider charge UNKNOWN; do not retry automatically')]:
        session = store.create_session('decision_reviewer', kind='inspect')
        store.add_tick(session['id'], status=status, summary=summary, evidence_refs=['fixture:partial-close'])
        store.finish_session(session['id'], status, summary)
app = create_app(settings=settings, state=store, upstream=FixtureSource(), static_dir=Path('/opt/condor/frontend/dist-v5'))


@app.get('/__fixture/expire')
async def expire_fixture_cookie():
    response = RedirectResponse('/settings')
    response.delete_cookie('rsi_v5_session', path='/')
    return response


@app.middleware('http')
async def update_fixture(request: Request, call_next):
    global fixed
    fixed = int(time.time() * 1000)
    refresh()
    operations = json.loads((Path('/opt/condor/real-fixtures') / 'host-operations.json').read_text())
    offset = fixed - operations['generated_at_ms'] - 100
    def rebase(value, key=''):
        if isinstance(value, dict):
            return {name: rebase(child, name) for name, child in value.items()}
        if isinstance(value, list):
            return [rebase(child) for child in value]
        if key.endswith('_ms') and type(value) is int:
            return value + offset
        return value
    operations = rebase(operations)
    pending = runtime / ('operations-' + str(time.time_ns()) + '.pending')
    pending.write_text(json.dumps(operations))
    pending.replace(runtime / 'operations.json')
    return await call_next(request)


@app.post('/__fixture/{state}')
async def fixture_state(state: str):
    global mode
    if state not in {'damaged', 'ingress', 'anomaly', 'controls', 'fresh', 'stale', 'incomplete', 'fault', 'closed', 'dust', 'hold', 'invalid', 'stop', 'missing_completeness', 'accounting_collecting', 'malformed', 'malformed_envelope', 'executor_partial', 'executor_stale', 'hold_empty', 'hold_unknown', 'hold_control_only'}:
        return {'error':'fixture_state_not_allowed'}
    mode = state
    return {'fixture_state':mode}
