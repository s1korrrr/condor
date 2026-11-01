import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {PAPER_OWNER_HOLD_REASONS, PAPER_NATIVE_ENTRY_HOLD_REASONS, paperSafetyReads} from '../src/v5/paper-safety.ts';
import {paperSectionError} from '../src/v5/policy.ts';
import {ownerRisk} from './helpers/owner-risk.mjs';

const source = fs.readFileSync(new URL('../../tests/fixtures/paper-c1-1e131c74/owner-observation.py.txt', import.meta.url), 'utf8');
const envelope = JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/paper-api-final3/risk.json', import.meta.url)));
const sorted = values => [...values].sort();

test('hold qualification constants match the pinned owner source', () => {
  assert.equal(createHash('sha256').update(source).digest('hex'), '85f351a494c8cd53947ebebd71c5374941745b6433b8b3e45c036a58f7ff77f4');
  const explanations = source.match(/explanations = dict\(([^]*?)\n\s+clock =/)[1];
  const owner = [...explanations.matchAll(/^\s*([a-z_]+)='/gm)].map(match => match[1]);
  const native = [...source.matchAll(/causes\.append\(\('([a-z0-9_]+)'/g)].map(match => match[1]);
  assert.deepEqual(sorted(PAPER_OWNER_HOLD_REASONS), sorted(owner));
  assert.deepEqual(sorted(PAPER_NATIVE_ENTRY_HOLD_REASONS), sorted(native));
  assert.match(source, /'complete' if reason is None else\s*'unavailable' if data is None else 'partial'/);
});

for (const reason of [...PAPER_OWNER_HOLD_REASONS, ...PAPER_NATIVE_ENTRY_HOLD_REASONS]) test(`published partial owner hold ${reason} qualifies`, () => {
  const older = ownerRisk('native-entry-holds', envelope);
  const controller = Object.keys(older.data.controllers)[0];
  older.data.controllers[controller].operator.emergency = true;
  const newer = ownerRisk('native-entry-holds', envelope);
  newer.reason = reason;
  newer.stale_reason = reason;
  newer.source = {...newer.source, sequence:newer.source.sequence + 1};
  newer.snapshot_id = `${newer.source.boot_id}:${newer.source.sequence}`;
  newer.data.holds = [];
  if (PAPER_OWNER_HOLD_REASONS.includes(reason)) {
    newer.data.holds = [{reason, explanation:'Owner safety hold.'}];
  } else {
    newer.data.native_entry_holds = [{controller_id:controller, reason, explanation:'Native entry hold.', protected_exits:'preserved'}];
  }
  assert.equal(newer.completeness, 'partial');
  assert.equal(newer.state, 'degraded');
  assert.equal(paperSectionError(newer), null);
  assert.deepEqual(paperSafetyReads([older], [], newer), []);
});
