import json
import os
import shutil
from pathlib import Path

from services.strategies.v5_advisory.paper_observation import PaperObservation
from services.strategies.v5_advisory.app import create_app
from fastapi.testclient import TestClient

root = Path(__file__).parent / 'f15-api-source'
work = root / 'emitted-fixture-final'
work.mkdir(exist_ok=True)
trust = root / 'synthetic-owner-trust'
trust.mkdir(mode=0o700, exist_ok=True)
os.environ['V5_OWNER_TRUST_DIR'] = str(trust)
fixtures = root / 'test/fixtures/paper_observation_v2'
for folder in ['candles', 'terminal']:
    if not (work / folder).exists():
        shutil.copytree(fixtures / folder, work / folder)
    for file in (work / folder).glob('*.json'):
        file.chmod(0o444)
value = json.loads((fixtures / 'partial-buy-cancel-tp-partial-close.json').read_text())
source = work / 'paper_observation.v2.json'
source.write_text(json.dumps(value))
reader = PaperObservation(source, lambda: value['generated_at_ms'], work / 'watermarks.json')
reader.rebaseline(reason='F15 consumer contract regression', operator_note='Synthetic pinned API fixture, no runtime state')
sections = ['status', 'wallet', 'positions', 'executors', 'risk', 'fills', 'accounting', 'decisions', 'history', 'operations']
token = work / 'synthetic-read.token'
token.write_text('fixture-read-' + 'x' * 40)
headers = {'Authorization': 'Bearer ' + token.read_text()}
app = create_app(token_file=token, paper_observation_path=source,
                 paper_watermark_path=work / 'watermarks.json', clock=lambda: value['generated_at_ms'])
emitted = {}
with TestClient(app) as client:
    for section in sections + ['candles']:
        response = client.get('/v1/paper/' + section, headers=headers,
                              params={'pair': 'BNB-USDC'} if section == 'candles' else {})
        assert response.status_code == 200, response.text
        emitted[section] = response.json()
unbound_app = create_app(token_file=token, paper_watermark_path=work / 'collecting-watermarks.json',
                         clock=lambda: value['generated_at_ms'])
with TestClient(unbound_app) as client:
    response = client.get('/v1/paper/positions', headers=headers)
    assert response.status_code == 200, response.text
    emitted['collecting'] = response.json()
(root / 'api-envelopes.json').write_text(json.dumps(emitted, indent=2) + '\n')
for name, part in emitted.items():
    print(name, part['state'], part['completeness'], part['capabilities'])
