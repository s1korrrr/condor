import json
import os
from pathlib import Path

from fastapi.testclient import TestClient
from services.strategies.v5_advisory.app import create_app

root = Path('/home/rsi/dev/rsibot/.workspace/scratch/v5-paper-dashboard/f17-native-api-replay-b')
source = root / 'owner-export/paper_observation.v2.json'
value = json.loads(source.read_text())
os.environ['V5_OWNER_TRUST_DIR'] = str(root / 'owner-trust')
os.environ['V5_PAPER_WATERMARK_FILE'] = str(root / 'watermarks.json')
os.environ['V5_PAPER_OWNER_ANCHOR_FILE'] = str(root / 'owner-anchor.json')
app = create_app(token_file=root / 'fixture-read-token', paper_observation_path=source, clock=lambda: value['generated_at_ms'])
with TestClient(app) as client:
    for section in ('fills', 'positions', 'executors', 'history'):
        packet = json.loads((root / 'responses' / (section + '.json')).read_text())
        offset = 0
        while packet['next_cursor']:
            offset += 200
            response = client.get('/v1/paper/' + section, headers={'Authorization': 'Bearer ' + 'r' * 40}, params={'limit': 200, 'cursor': packet['next_cursor'], 'snapshot_id': packet['snapshot_id']})
            assert response.status_code == 200, (section, response.text)
            packet = response.json()
            (root / 'responses' / (section + '-offset-' + str(offset) + '.json')).write_text(json.dumps(packet, indent=2) + '\n')
            print(section, offset, len(packet['data']), response.status_code)
