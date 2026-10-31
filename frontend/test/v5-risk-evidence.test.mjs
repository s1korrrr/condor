import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {paperCoherentRead} from '../src/v5/policy.ts';
import {paperSafetyReads} from '../src/v5/paper-safety.ts';

const fixture = section => JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/paper-api-final3/native-replay/${section}.json`, import.meta.url)));
test('received same-snapshot risk remains in progress after another worker fails', async () => {
  const seen = [];
  const sections = ['risk','history'].map(section => ({section,path:`/fixture/${section}`}));
  await assert.rejects(paperCoherentRead('/fixture/status',sections,async (_path,section) => {
    if (section === 'history') throw new Error('Later section failed');
    return fixture(section);
  },async () => {},reads => seen.push(reads)));
  assert.ok(seen.at(-1).some(read => read.section === 'risk'));
});

test('a risk worker already in flight may publish a validated hold after its peer fails', async () => {
  let resolveRisk;
  const risk = new Promise(resolve => {resolveRisk = resolve;});
  const seen = [];
  const pending = paperCoherentRead('/fixture/status',[{section:'risk',path:'/risk'},{section:'history',path:'/history'}],async (_path,section) => {
    if (section === 'history') {resolveRisk(fixture('risk')); throw new Error('Peer failed');}
    return section === 'risk' ? risk : fixture(section);
  },async () => {},reads => seen.push(reads));
  await assert.rejects(pending);
  assert.ok(seen.at(-1).some(read => read.section === 'risk'));
});

test('safety evidence is compacted by positive signal and clears only on a complete newer snapshot', () => {
  const status = fixture('status'), risk = fixture('risk');
  let held = [];
  for (let index = 0; index < 200; index++) held = paperSafetyReads(held,[{...status,generated_at_ms:status.generated_at_ms + index},{...risk,generated_at_ms:risk.generated_at_ms + index}]);
  assert.equal(held.length,1);
  assert.equal(paperSafetyReads(held,[]).length,1);
  assert.equal(paperSafetyReads(held,[],{...status,generated_at_ms:status.generated_at_ms + 198}).length,1);
  assert.equal(paperSafetyReads(held,[],{...status,generated_at_ms:status.generated_at_ms + 200}).length,0);
  assert.equal(paperSafetyReads([],[status,{...risk,snapshot_id:'different'}]).length,0);
  assert.equal(paperSafetyReads([],[status,{...risk,bot_id:'other'}]).length,0);
});
