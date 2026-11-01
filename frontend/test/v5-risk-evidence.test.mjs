import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {paperCoherentRead} from '../src/v5/policy.ts';
import {paperSafetyReads} from '../src/v5/paper-safety.ts';

const fixture = section => JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/paper-api-final3/native-replay/${section}.json`, import.meta.url)));
const clearRisk = read => {
  const cleared = structuredClone(read);
  cleared.data.control_hold = null;
  cleared.data.holds = [];
  cleared.data.native_entry_holds = [];
  for (const controller of Object.values(cleared.data.controllers)) {
    controller.operator.emergency = false;
    controller.operator.paused = false;
    controller.native.entry_hold = false;
  }
  return cleared;
};

test('a complete higher owner sequence clears a hold despite a backward or missing timestamp', () => {
  for (const generated of [null, fixture('status').generated_at_ms - 60_000]) {
    const base = fixture('risk');
    const risk = {...base, data:{...base.data, control_hold:'clock_anomaly'}, generated_at_ms:generated};
    const status = fixture('status');
    const newer = {...clearRisk(fixture('risk')), source:{...status.source, sequence:status.source.sequence + 1}, generated_at_ms:status.generated_at_ms - 60_000};
    assert.deepEqual(paperSafetyReads([risk], [], newer), []);
  }
});

test('equal or lower owner sequence cannot clear safety even with a later timestamp', () => {
  const risk = fixture('risk'), status = fixture('status');
  for (const sequence of [status.source.sequence, status.source.sequence - 1]) {
    const older = {...clearRisk(risk), source:{...status.source, sequence}, generated_at_ms:status.generated_at_ms + 60_000};
    assert.equal(paperSafetyReads([risk], [], older).length, 1);
  }
});

test('a replacement boot clears superseded safety; unknown ordering stays fail-safe', () => {
  const risk = fixture('risk'), status = fixture('status');
  const reboot = {...clearRisk(risk), source:{...status.source, boot_id:'different-boot'}, generated_at_ms:status.generated_at_ms - 60_000};
  assert.equal(paperSafetyReads([risk], [], reboot).length, 0);
  const unsequenced = {...risk, data:{...risk.data, control_hold:'clock_anomaly'}, source:{}, generated_at_ms:null};
  assert.equal(paperSafetyReads([unsequenced], [], {...clearRisk(risk), source:{}}).length, 1);
});

for (const patch of [{section:'status'}, {state:'degraded'}, {completeness:'unavailable'}, {completeness:'partial'}, {data:null}, {data:{}}]) test(`only affirmative complete risk can clear safety: ${JSON.stringify(patch)}`, () => {
  const risk = fixture('risk');
  const candidate = {...clearRisk(risk), source:{...risk.source, sequence:risk.source.sequence + 1}, ...patch};
  assert.equal(paperSafetyReads([risk], [], candidate).length, 1);
});
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
  const advance = (read, index) => ({...read, generated_at_ms:read.generated_at_ms + index, source:{...read.source, sequence:read.source.sequence + index}});
  for (let index = 0; index < 200; index++) held = paperSafetyReads(held,[advance(status,index), advance(risk,index)]);
  assert.equal(held.length,1);
  assert.equal(paperSafetyReads(held,[]).length,1);
  assert.equal(paperSafetyReads(held,[],advance(clearRisk(risk),198)).length,1);
  assert.equal(paperSafetyReads(held,[],advance(clearRisk(risk),200)).length,0);
  assert.equal(paperSafetyReads([],[status,{...risk,snapshot_id:'different'}]).length,0);
  assert.equal(paperSafetyReads([],[status,{...risk,bot_id:'other'}]).length,0);
});
