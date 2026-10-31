import asyncio
import base64
import json
import os
from pathlib import Path
import time
from urllib.parse import parse_qs, urlsplit

from fastapi import Request

from condor.v5.app import create_app
from condor.v5.config import Settings

owner = Path(__file__).resolve().parents[1]
fixtures = owner / 'tests/fixtures/paper-api-final3'
runtime = Path(os.environ['V5_POLISH_RUNTIME'])
runtime.mkdir(parents=True, exist_ok=False)
for name in ('dashboard', 'observation', 'request'):
    (runtime / f'{name}.token').write_text('fixture-only-' + 'x' * 48)
epoch = int(time.time() * 1000)
mode = 'fresh'

def shift(value, offset, key=''):
    if isinstance(value, dict):
        return {name: shift(child, offset, name) for name, child in value.items()}
    if isinstance(value, list):
        return [shift(child, offset) for child in value]
    if key.endswith('_ms') and type(value) is int:
        return value + offset
    return value

def refresh_files():
    status = json.loads((fixtures / 'native-status.json').read_text())
    status['generated_at'] = time.time()
    status['report_observed_at'] = time.time()
    (runtime / 'meridian_v5_paper.status.json').write_text(json.dumps(status))
    operations = json.loads((fixtures / 'host-operations.json').read_text())
    operations = shift(operations, epoch - operations['generated_at_ms'])
    (runtime / 'operations.json').write_text(json.dumps(operations))

class FixtureSource:
    async def observation(self, path):
        if path.startswith('/v1/paper/'):
            if mode == 'fault':
                from condor.v5.upstream import UpstreamError
                raise UpstreamError('fixture_fault', http_status=503)
            section = urlsplit(path).path.rsplit('/', 1)[1]
            query = parse_qs(urlsplit(path).query)
            suffix = ''
            if 'cursor' in query:
                cursor = json.loads(base64.urlsafe_b64decode(query['cursor'][0]))
                suffix = '-offset-' + str(cursor['offset'])
            packet = json.loads((fixtures / 'native-replay' / f'{section}{suffix}.json').read_text())
            original_snapshot = packet['snapshot_id']
            snapshot = query.get('snapshot_id', [original_snapshot.rsplit(':', 1)[0] + ':' + str(epoch)])[0]
            generated = int(snapshot.rsplit(':', 1)[1])
            await asyncio.sleep(.12)
            packet = shift(packet, generated - packet['generated_at_ms'])
            def pin(value, key=''):
                if isinstance(value, dict):
                    return {name: pin(child, name) for name, child in value.items()}
                if isinstance(value, list):
                    return [pin(child) for child in value]
                if key == 'snapshot_id':
                    return snapshot
                if key == 'sequence':
                    return generated
                if key == 'next_cursor' and value is not None:
                    cursor = json.loads(base64.urlsafe_b64decode(value))
                    cursor['snapshot_id'] = snapshot
                    return base64.urlsafe_b64encode(json.dumps(cursor).encode()).decode()
                return value
            packet = pin(packet)
            if section == 'wallet':
                for asset in packet['data']['assets']:
                    if asset['asset'] == 'USDC':
                        asset['available'] = asset['available'] + '123456789123456789'
            return packet
        if path == '/v1/context':
            return {'schema_version':'multi-venue-evidence.v1','snapshot_id':'fixture-context','available_at_ms':epoch}
        if path == '/v1/source/status':
            return {'schema_version':'v5-feed-refresh-status.v1','state':'UNAVAILABLE'}
        if path == '/v1/identity':
            return {'upstream_revision':'synthetic-polish-fixture'}
        return {}

    async def task_profiles(self):
        return {'tasks':[], 'scheduler':{'enabled':False}}

    async def latest_task_report(self, task_id):
        return {'status':'UNAVAILABLE','effect':'NONE','record':None}

    async def request_report(self, *args):
        raise AssertionError('Provider calls forbidden')

refresh_files()
settings = Settings(runtime_root=runtime / 'store', dashboard_token_file=runtime / 'dashboard.token',
    dashboard_origin=os.environ['V5_POLISH_ORIGIN'], observation_base_url='http://fixture.invalid',
    observation_read_token_file=runtime / 'observation.token', advisor_control_base_url='http://fixture.invalid',
    advisor_request_token_file=runtime / 'request.token', cookie_secure=True,
    stock_agents_root=owner / 'agents_v5', paper_status_file=runtime / 'meridian_v5_paper.status.json',
    host_operations_file=runtime / 'operations.json')
app = create_app(settings=settings, upstream=FixtureSource(), static_dir=Path(os.environ['V5_POLISH_DIST']))

@app.middleware('http')
async def renew_fixture(request: Request, call_next):
    global epoch
    epoch = int(time.time() // 10) * 10000
    refresh_files()
    return await call_next(request)

@app.post('/__fixture/{state}')
async def fixture_state(state: str):
    global mode
    if state not in {'fresh','fault'}:
        return {'error':'Unsupported fixture state'}
    mode = state
    return {'fixture_state':mode}
