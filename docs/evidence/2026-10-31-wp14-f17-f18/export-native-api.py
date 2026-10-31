import json
import os
import shutil
from pathlib import Path

from fastapi.testclient import TestClient
from services.strategies.v5_advisory.app import create_app
from services.strategies.v5_advisory.paper_observation import PaperObservation

root = Path('/home/rsi/dev/rsibot/.workspace/scratch/v5-paper-dashboard/f17-native-api-replay-b')
original = Path('/home/rsi/dev/rsibot/.workspace/scratch/v5-wp14/final3-20261030/trial/data/runtime_status')
shutil.copytree(original, root / 'owner-export')
source = root / 'owner-export/paper_observation.v2.json'
value = json.loads(source.read_text())
(root / 'owner-trust').mkdir(mode=0o700)
os.environ['V5_OWNER_TRUST_DIR'] = str(root / 'owner-trust')
os.environ['V5_PAPER_WATERMARK_FILE'] = str(root / 'watermarks.json')
os.environ['V5_PAPER_OWNER_ANCHOR_FILE'] = str(root / 'owner-anchor.json')
reader = PaperObservation(source, lambda: value['generated_at_ms'])
reader.rebaseline(reason='Disposable real copied-export contract replay', operator_note='FINAL3 stopped native trial export, no runtime or live authority')
token = root / 'fixture-read-token'
token.write_text('r' * 40)
app = create_app(token_file=token, paper_observation_path=source, clock=lambda: value['generated_at_ms'])
with TestClient(app) as client:
    output = root / 'responses'
    output.mkdir()
    for section in ('status','wallet','positions','fills','executors','risk','decisions','history','operations','accounting'):
        response = client.get('/v1/paper/' + section, headers={'Authorization': 'Bearer ' + 'r' * 40}, params={'limit': 200})
        assert response.status_code == 200, (section, response.text)
        (output / (section + '.json')).write_text(json.dumps(response.json(), indent=2) + '\n')
        print(section, response.status_code, response.json()['state'])
