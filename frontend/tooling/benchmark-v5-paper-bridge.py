import concurrent.futures
import copy
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import threading

from fastapi.testclient import TestClient

api_source, fixture_source, scratch = map(Path, sys.argv[1:4])
sys.path.insert(0, str(api_source))
from services.strategies.v5_advisory.app import create_app
from services.strategies.v5_advisory.paper_observation import PaperObservation

runtime = Path(tempfile.mkdtemp(prefix='api73-benchmark-', dir=scratch))
trust = runtime / 'owner-trust'
trust.mkdir(mode=0o700)
os.environ['V5_OWNER_TRUST_DIR'] = str(trust)
export = runtime / 'export'
shutil.copytree(api_source / 'test/fixtures/paper_observation_v2/real-trial/emitted', export)
for segment in (export / 'paper_observation.v2.journal').glob('*.json'):
    segment.chmod(0o600)
    segment.write_bytes(segment.read_bytes().rstrip(b'\n'))
    segment.chmod(0o444)
source = export / 'paper_observation.v2.json'
primary = json.loads(source.read_text())
for section in ('fills', 'executors'):
    rows = json.loads((fixture_source / f'{section}.json').read_text())['data']
    extra = fixture_source / f'{section}-offset-200.json'
    if extra.exists():
        rows += json.loads(extra.read_text())['data']
    generated = primary['generated_at_ms']
    def shift(value, key=''):
        if isinstance(value, dict):
            return {name: shift(child, name) for name, child in value.items()}
        if isinstance(value, list):
            return [shift(child) for child in value]
        if key.endswith('_ms') and type(value) is int:
            return min(value, generated)
        return value
    primary[section]['data'] = shift(copy.deepcopy(rows))
source.chmod(0o600)
source.write_text(json.dumps(primary))
watermark = runtime / 'watermarks.json'
clock = lambda: primary['generated_at_ms']
reader = PaperObservation(source, clock, watermark)
reader.rebaseline(reason='isolated dashboard latency benchmark', operator_note='synthetic sized copy; no live stores')
token = runtime / 'read-token'
token.write_text('r' * 40)
application = create_app(token_file=token, paper_observation_path=source, paper_watermark_path=watermark, clock=clock)
lock = threading.Lock()

def send(value):
    with lock:
        print(json.dumps(value), flush=True)

with TestClient(application) as client, concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    send({'ready': True, 'primary_bytes': source.stat().st_size, 'rows': {section: len(primary[section]['data']) for section in ('fills', 'executors')}, 'runtime': str(runtime)})
    def request(message):
        response = client.get(message['path'], headers={'Authorization': 'Bearer ' + 'r' * 40})
        send({'id': message['id'], 'status': response.status_code, 'body': response.json()})
    for line in sys.stdin:
        pool.submit(request, json.loads(line))
