import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {newerSnapshot, paperSafetyReads} from '../src/v5/paper-safety.ts';
import {paperJournalReads} from '../src/v5/paper-journal.ts';

const base = JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/paper-api-final3/risk.json', import.meta.url)));
function read(epoch, sequence = 1, boot = 'boot-a') {
  const value = structuredClone(base);
  value.source = {...value.source, boot_id:boot, sequence};
  if (epoch !== undefined) value.source.boot_epoch = epoch;
  value.snapshot_id = `${boot}:${sequence}`;
  return value;
}

for (const [name, candidate, prior, expected] of [
  ['same epoch higher sequence', read(1, 2), read(1), true],
  ['higher epoch lower sequence', read(2, 1, 'boot-b'), read(1, 100), true],
  ['lower epoch', read(1, 100, 'boot-b'), read(2), false],
  ['equal pair', read(1), read(1), false],
  ['equal epoch different boot', read(1, 2, 'boot-b'), read(1), false],
  ['same boot higher epoch', read(2), read(1, 100), true],
  ['maximum known epoch', read(1025, 1, 'boot-b'), read(1024), true],
  ['legacy same boot', read(undefined, 2), read(undefined), false],
  ['legacy different boot', read(undefined, 2, 'boot-b'), read(undefined), false],
]) test(`owner boot order: ${name}`, () => assert.equal(newerSnapshot(candidate, prior), expected));

for (const invalid of [undefined, null, true, false, 0, -1, 1.5, '2', 1026, Number.MAX_SAFE_INTEGER + 1]) {
  for (const side of ['candidate', 'prior']) test(`invalid epoch ${String(invalid)} on ${side} cannot order`, () => {
    const candidate = read(2, 2, 'boot-b'), prior = read(1);
    const target = side === 'candidate' ? candidate : prior;
    if (invalid === undefined) delete target.source.boot_epoch;
    else target.source.boot_epoch = invalid;
    assert.equal(newerSnapshot(candidate, prior), false);
  });
}

for (const invalid of [null, true, 0, -1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1]) {
  for (const side of ['candidate', 'prior']) test(`invalid sequence ${String(invalid)} on ${side} cannot order`, () => {
    const candidate = read(2, 2, 'boot-b'), prior = read(1);
    (side === 'candidate' ? candidate : prior).source.sequence = invalid;
    assert.equal(newerSnapshot(candidate, prior), false);
  });
}

function emergency(value, held) {
  for (const controller of Object.values(value.data.controllers)) {
    controller.operator.emergency = held;
    controller.operator.paused = false;
    controller.native.entry_hold = false;
  }
  value.data.holds = [];
  value.data.native_entry_holds = [];
  value.data.control_hold = null;
  return value;
}

test('delayed old-boot all-clear cannot replace new-epoch emergency', () => {
  const held = emergency(read(2, 1, 'boot-b'), true);
  const delayed = emergency(read(1, 100), false);
  delayed.generated_at_ms += 1000;
  assert.deepEqual(paperSafetyReads([held], [], delayed), [held]);
});

test('new epoch complete clear supersedes old-epoch emergency', () => {
  const held = emergency(read(1, 100), true);
  const clear = emergency(read(2, 1, 'boot-b'), false);
  clear.generated_at_ms -= 1000;
  assert.deepEqual(paperSafetyReads([held], [], clear), []);
});

test('legacy different-boot clear retains the received emergency', () => {
  const held = emergency(read(undefined, 100), true);
  const clear = emergency(read(undefined, 1, 'boot-b'), false);
  assert.deepEqual(paperSafetyReads([held], [], clear), [held]);
});

test('legacy same-boot sequence 101 cannot clear sequence 100 emergency', () => {
  const held = emergency(read(undefined, 100), true);
  const clear = emergency(read(undefined, 101), false);
  assert.deepEqual(paperSafetyReads([held], [], clear), [held]);
});

test('legacy same-boot sequence 101 cannot clear sequence 100 journal condition', () => {
  const status = JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/paper-api-final3/status.json', import.meta.url)));
  const held = {...status, source:{...status.source, boot_id:'boot-a', sequence:100}, snapshot_id:'boot-a:100', state:'degraded', reason:'OWNER_JOURNAL_EXCEEDED'};
  held.data.journal_budget = {state:'exceeded', journal_evidence_held:true};
  const clear = structuredClone(held);
  clear.source.sequence = 101;
  clear.snapshot_id = 'boot-a:101';
  clear.state = 'available';
  clear.reason = null;
  delete clear.data.journal_budget;
  clear.data.operations = {...clear.data.operations, state:'available', completeness:'complete', reason:null, stale_reason:null};
  assert.deepEqual(paperJournalReads([held], [], clear), [held]);
});
