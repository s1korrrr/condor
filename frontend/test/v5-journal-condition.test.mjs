import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {frontendModules} from './helpers/frontend-module.mjs';

const {OwnerJournalCondition} = frontendModules().load('v5/OwnerJournalCondition.tsx');
const render = (status, snapshotLabel = 'Retained snapshot · stale') => renderToStaticMarkup(
  React.createElement(OwnerJournalCondition, {status, snapshotLabel}));

for (const [state, reason] of [['exceeded','OWNER_JOURNAL_EXCEEDED'], ['segment_capacity','OWNER_JOURNAL_SEGMENT_CAPACITY'], ['inventory_unavailable','OWNER_JOURNAL_INVENTORY_UNAVAILABLE']]) {
  test(`journal ${state} keeps the named reason and explicit owner conditions`, () => {
    const html = render({state:'stale',reason,data:{journal_budget:{state,journal_evidence_held:true,native_execution_continues:true,post_transition_bytes:123,limit_bytes:536870912,legacy_segment_count:1200,post_transition_segment_count:300,reader_segment_limit:4096}}});
    for (const text of [reason, 'journal_evidence_held: true', 'native_execution_continues: true', 'Retained snapshot · stale', 'Owner status: stale', '123 / 536870912 bytes', '1500 / 4096 segments']) assert.ok(html.includes(text), text);
    assert.ok(!html.includes('ready to trade'));
  });
}

test('reason alone never infers native execution or held flags', () => {
  const html = render({state:'degraded',reason:'OWNER_JOURNAL_EXCEEDED',data:{}});
  assert.ok(html.includes('native_execution_continues: unavailable'));
  assert.ok(html.includes('journal_evidence_held: unavailable'));
});

test('budget state survives an unrelated stale reason and false flags remain false', () => {
  const html = render({state:'stale',reason:'OWNER_SECTION_STALE',data:{journal_budget:{state:'exceeded',journal_evidence_held:false,native_execution_continues:false}}});
  assert.ok(html.includes('OWNER_SECTION_STALE'));
  assert.ok(html.includes('exceeded'));
  assert.ok(html.includes('native_execution_continues: false'));
});

test('an explicit owner held condition remains visible without a known reason', () => {
  const html = render({state:'degraded',reason:null,data:{journal_budget:{journal_evidence_held:true}}});
  assert.ok(html.includes('journal_evidence_held: true'));
  assert.ok(html.includes('native_execution_continues: unavailable'));
});

test('unrelated owner status is not replaced by a journal banner', () => {
  assert.equal(render({state:'degraded',reason:'OWNER_SECTION_DEGRADED',data:{}}), '');
  assert.equal(render(undefined), '');
});
