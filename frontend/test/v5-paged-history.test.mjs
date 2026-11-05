import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as policy from '../src/v5/policy.ts';
import {frontendModules} from './helpers/frontend-module.mjs';
import {paperSafetyReads} from '../src/v5/paper-safety.ts';
import {paperJournalReads} from '../src/v5/paper-journal.ts';

const fixture = section => JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/paper-api-final3/native-replay/${section}.json`, import.meta.url)));
const partial = section => ({...fixture(section), state:'degraded', completeness:'partial', reason:'primary_byte_budget_recent_window'});

test('history preserves the native retained-fill gap but refuses unknown scalar gaps', () => {
  for (const [gaps,accepted] of [[['bounded_recent_fill_window'],true], [[{reason:'owner_gap'}],true], [['unknown_window'],false], [[false],false], [[null],false]]) {
    const read = partial('history');read.data.gaps = gaps;
    assert.equal(policy.paperSectionError(read) === null,accepted);
  }
});

test('partial retained rows stay visible without becoming complete totals or flatness evidence', () => {
  for (const section of ['fills', 'executors']) {
    const read = partial(section), now = read.generated_at_ms;
    assert.deepEqual(policy.paperRetainedRecords(read, now), read.data);
    assert.equal(policy.paperCompleteRecords(read, now), null);
    assert.equal(policy.paperOpenExecutorCount(read, now), null);
    assert.equal(policy.paperRetainedRecords(read, now + 30001), null);
    assert.equal(policy.paperRetainedRecords({...read, capabilities:[]}, now), null);
    assert.equal(policy.paperRetainedRecords({...read, completeness:'unavailable'}, now), null);
    assert.equal(policy.paperRetainedRecords({...read, generated_at_ms:now + 60000}, now), null);
    assert.equal(policy.paperRetainedRecords({...read, data:[{quantity:'NaN'}]}, now), null);
  }
});

test('Bots adaptive tables and exact details show partial fills and executor rows with bounded-window labels', () => {
  const stubs = Object.fromEntries(['@/components/bots/AggregatedPnlChart','@/components/bots/ControllerBrowser','@/components/bots/DeployBotDialog','@/components/bots/PnlSparkline','@/hooks/useWebSocket','@/hooks/useRates'].map(name => [name,{}]));
  const {load} = frontendModules(stubs, {'v5/components/PaperWorkspace.tsx':['PaperRecords']});
  const {PaperRecords} = load('v5/components/PaperWorkspace.tsx');
  for (const kind of ['fills', 'executors']) {
    const read = partial(kind);
    const html = renderToStaticMarkup(React.createElement(PaperRecords, {read,kind,now:read.generated_at_ms}));
    assert.match(html, /Partial retained window/);
    assert.match(html, /not lifetime history/);
    assert.match(html, /q-dt/);
    assert.ok(html.includes(String(read.data[0][kind === 'fills' ? 'trade_id' : 'executor_id'])));
    assert.doesNotMatch(html, /Incomplete or stale owner read/);
  }
});

function terminalPage(rows, cursor) {
  return {...partial('history'), next_cursor:cursor, data:{...fixture('history').data,
    segments:[{file:'same-owner-segment'}], terminal_executors:{completeness:'partial', capabilities:['read'], data:{
      delivery:'publication_pages', publication_record_count:3, retained_count:1, total_count:12,
      retention:'primary_byte_bounded_recent_window', records:rows,
    }}}};
}

test('history pagination merges terminal records in order without duplicating journal segments or upgrading completeness', async () => {
  const pages = [terminalPage([{executor_id:'a'}, {executor_id:'b'}], 'next'), terminalPage([{executor_id:'c'}], null)];
  const paths = [];
  const read = await policy.paperObservationPages('/history', async path => {paths.push(path);return pages[paths.length - 1];});
  assert.deepEqual(read.data.terminal_executors.data.records.map(row => row.executor_id), ['a','b','c']);
  assert.equal(read.data.segments.length, 1);
  assert.equal(read.completeness, 'partial');
  assert.equal(policy.paperCompleteRead(read, read.generated_at_ms), false);
  assert.equal(new URL(paths[1], 'https://fixture.invalid').searchParams.get('snapshot_id'), pages[0].snapshot_id);
});

test('history loads the full 500-row byte-split retained window and still stops at a bounded page budget', async () => {
  const expected = Array.from({length:500}, (_,index) => ({executor_id:`terminal-${index}`}));
  let calls = 0;
  const read = await policy.paperObservationPages('/history',async () => {
    const start = calls++ * 64;
    const page = terminalPage(expected.slice(start,start+64),start+64 < 500 ? String(calls) : null);
    page.data.terminal_executors.data.publication_record_count = 500;
    return page;
  });
  assert.equal(calls,8);
  assert.deepEqual(read.data.terminal_executors.data.records,expected);
  assert.equal(read.next_cursor,null);
  assert.equal(read.completeness,'partial');
  calls = 0;
  const bounded = await policy.paperObservationPages('/history',async () => terminalPage([{executor_id:String(calls)}],String(++calls)));
  assert.equal(calls,16);
  assert.equal(bounded.next_cursor,'16');
  assert.equal(policy.paperCompleteRead(bounded,bounded.generated_at_ms),false);
});

test('terminal pagination refuses changed metadata, missing pages and changed source identity', async () => {
  for (const change of ['metadata','source','snapshot','missing']) {
    let calls = 0;
    const first = terminalPage([{executor_id:'a'}], 'next'), next = terminalPage([{executor_id:'b'}], null);
    if (change === 'metadata') next.data.terminal_executors.data.publication_record_count = 4;
    if (change === 'source') next.source = {...first.source, sha256:'f'.repeat(64)};
    if (change === 'snapshot') next.snapshot_id = 'other:2';
    await assert.rejects(policy.paperObservationPages('/history', async () => {
      if (++calls === 1) return first;
      if (change === 'missing') throw new Error('owner page unavailable');
      return next;
    }), /Mixed owner|history page|owner page/);
  }
});

test('terminal history uses the adaptive table, labels the retained window, and withholds stale or unavailable rows', () => {
  const {load} = frontendModules();
  const {PaperTerminalHistory} = load('v5/PaperTerminalHistory.tsx');
  const read = terminalPage([{executor_id:'terminal-a',trading_pair:'BNB-USDC'}], null);
  const render = (value, now = read.generated_at_ms) => renderToStaticMarkup(React.createElement(PaperTerminalHistory,{read:value,now}));
  const html = render(read);
  assert.match(html, /terminal-a/);
  assert.match(html, /q-dt/);
  assert.match(html, /at most 500 terminal rows, not lifetime history/);
  for (const value of [{...read,completeness:'unavailable'}, {...read,state:'stale'}, {...read,capabilities:[]}]) {
    assert.doesNotMatch(render(value), /terminal-a/);
  }
  assert.doesNotMatch(render(read, read.generated_at_ms + 30001), /terminal-a/);
});

test('failed history page cannot erase received risk or retained journal holds', async () => {
  const risk = fixture('risk'), status = fixture('status');
  const journal = {...status, state:'degraded', reason:'OWNER_JOURNAL_EXCEEDED', data:{...status.data,journal_budget:{state:'exceeded',journal_evidence_held:true,native_execution_continues:true}}};
  const received = [];
  await assert.rejects(policy.paperCoherentRead('/status', [{section:'risk',path:'/risk'}, {section:'history',path:'/history',paginate:true}], async (path, section) => {
    if (section === 'status') return journal;
    if (section === 'risk') return risk;
    if (path.includes('cursor=')) throw new Error('owner page unavailable');
    return {...terminalPage([{executor_id:'terminal-a'}], 'next'),snapshot_id:status.snapshot_id};
  }, undefined, reads => received.push(...reads)), /owner page unavailable/);
  assert.ok(paperSafetyReads([risk], received).some(read => read.section === 'risk'));
  assert.equal(paperJournalReads([journal], received).length, 1);
  const {load} = frontendModules();
  const html = renderToStaticMarkup(React.createElement(load('v5/OwnerJournalCondition.tsx').OwnerJournalCondition,{status:journal,snapshotLabel:'Retained owner condition'}));
  assert.match(html, /Paper journal evidence held/);
  assert.match(html, /not current execution or readiness proof/);
});
