import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {paperJournalReads} from '../src/v5/paper-journal.ts';

const fixture = () => JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/paper-api-final3/native-replay/status.json',import.meta.url)));
function held() {
  const read = fixture();
  read.reason = 'OWNER_JOURNAL_EXCEEDED';
  read.data.journal_budget = {state:'exceeded',journal_evidence_held:true};
  return read;
}
function clear() {
  const read = fixture();
  read.source.sequence += 1;
  read.snapshot_id = `${read.source.boot_id}:${read.source.sequence}`;
  read.generated_at_ms += 15000;
  read.state = 'available';
  read.reason = null;
  read.data.operations = {...read.data.operations,state:'available',reason:null,stale_reason:null,completeness:'complete'};
  return read;
}

test('progress reset, error and missing completion cannot clear a received hold', () => {
  const read = held();
  assert.deepEqual(paperJournalReads([], [read]), [read]);
  assert.deepEqual(paperJournalReads([read], []), [read]);
  assert.deepEqual(paperJournalReads([read], [], fixture()), [read]);
});

test('only a qualified newer same-owner operations-clear completion supersedes a hold', () => {
  const read = held();
  assert.deepEqual(paperJournalReads([read], [], clear()), []);
  assert.deepEqual(paperJournalReads([read], [clear()]), [read]);
});

for (const [name, mutate] of [
  ['same sequence', read => {read.source.sequence -= 1;}],
  ['older sequence', read => {read.source.sequence -= 2;}],
  ['other bot', read => {read.bot_id = 'other-paper-bot';}],
  ['partial status', read => {read.completeness = 'partial';}],
  ['stale status', read => {read.state = 'stale';}],
  ['unavailable operations', read => {delete read.data.operations;}],
  ['partial operations', read => {read.data.operations.completeness = 'partial';}],
  ['still held diagnostic', read => {read.data.operations.stale_reason = 'observation_journal_exceeded';}],
  ['cursor incomplete', read => {read.next_cursor = 'more';}],
]) test(`${name} cannot supersede retained journal evidence`, () => {
  const read = held(), candidate = clear();
  mutate(candidate);
  assert.deepEqual(paperJournalReads([read], [], candidate), [name === 'still held diagnostic' ? candidate : read]);
});
