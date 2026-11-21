import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules, paperWorkspaceModules } from './helpers/frontend-module.mjs';

// W-T2, live 2026-11-21 (install 10, condor 45ec2f82): Bots said "Sell orders placed 0 of 15" for BTC while the owner has one
// active BTC executor, because the executors read hit its byte budget ("primary byte budget recent window"); the V5 entry pause
// (owner custom_info.operator, since 14 Nov 14:40Z) showed neither its start nor its reason; fills listed oldest first with no
// last fill per pair; owner codes such as journal.reader_capacity_near showed raw.
const final3 = Object.fromEntries(['status','wallet','positions','executors','fills','risk','decisions','history','operations'].map(section => [section, JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/paper-api-final3/${section}.json`, import.meta.url)))]));
const now = final3.status.read_at_ms;
const DAY = 86_400_000;
const PAIRS = ['BNB-USDC', 'BTC-USDC', 'ETH-USDC', 'SOL-USDC', 'XRP-USDC'];
const model = () => frontendModules().load('v5/bots-truth.ts');

// An executors read cut at its byte budget: one running BTC executor among 100 terminal rows, and it is NOT the terminal window.
const row = final3.executors.data[0];
const runningBtc = {...row, executor_id: 'btc-live', controller_id: 'modular_spot_meridian_v5_paper_btc', trading_pair: 'BTC-USDC', state: 'RUNNING', terminal: false};
const terminal = Array.from({length: 100}, (_, index) => ({...row, executor_id: `done-${index}`, state: 'TERMINATED', terminal: true, trading_pair: PAIRS[index % 5]}));
const budgetCut = {...final3.executors, state: 'degraded', completeness: 'partial', next_cursor: null, reason: 'primary byte budget recent window', stale_reason: 'primary byte budget recent window', data: [runningBtc, ...terminal]};

const btcLots = Array.from({length: 15}, (_, index) => ({...final3.positions.data[0], position_id: `btc-${index}`, executor_id: `btc-lot-${index}`, controller_id: 'modular_spot_meridian_v5_paper_btc', trading_pair: 'BTC-USDC', state: 'held_reconciliation', quantity: '0.000165', protected_exit: false, protected_exit_order: null, protection_reason: 'no_active_fixed_target_executor'}));
const positions = {...final3.positions, data: btcLots};

const PAUSED_AT = Date.parse('2026-11-14T14:40:00Z');
const pausedNow = PAUSED_AT + 7 * DAY;
const decisionsWith = (operator, at = pausedNow) => {
  const read = structuredClone(final3.decisions);
  read.generated_at_ms = read.observed_at_ms = read.source_at_ms = at - 5_000;
  read.data.controllers = PAIRS.map(pair => ({...read.data.controllers[0], id: `modular_spot_meridian_v5_paper_${pair.split('-')[0].toLowerCase()}`, pair, custom_info: {...read.data.controllers[0].custom_info, operator}}));
  return read;
};
const operator = {entry_paused: true, last_command_id: 'cmd-1', reason: 'Approved paper journal-cap maintenance', scope: null, updated_at: PAUSED_AT / 1000};

test('an executors read cut at its byte budget never shows 0 of N sell orders: partial · not published, with the count actually read', () => {
  const {PaperPositions} = frontendModules().load('v5/PaperPositions.tsx');
  const html = renderToStaticMarkup(React.createElement(PaperPositions, {positions, executors: budgetCut, decisions: final3.decisions, now}));
  assert.match(html, /<dt>Sell orders placed<\/dt><dd>partial · not published · 1 active executor for BTC among the 101 rows read/);
  assert.doesNotMatch(html, /\b0 of 15\b/);
  const unread = renderToStaticMarkup(React.createElement(PaperPositions, {positions, executors: undefined, decisions: final3.decisions, now}));
  assert.match(unread, /<dt>Sell orders placed<\/dt><dd>partial · not published · no executor rows read/);
  assert.doesNotMatch(unread, /\b0 of 15\b/);
});

test('a complete executors read still shows the verified count', () => {
  const {PaperPositions} = frontendModules().load('v5/PaperPositions.tsx');
  const lot = {...btcLots[0], protected_exit: true};
  const executor = {executor_id: lot.executor_id, controller_id: lot.controller_id, trading_pair: 'BTC-USDC', state: 'active', protected_exit: true};
  const html = renderToStaticMarkup(React.createElement(PaperPositions, {positions: {...positions, data: [lot]}, executors: {...final3.executors, data: [executor]}, decisions: final3.decisions, now}));
  assert.match(html, /1 of 1 · verified protected exits/);
});

test('the Open executors tile says partial · not published with the rows actually read, and keeps a provable count', () => {
  const {PaperWorkspace} = paperWorkspaceModules().load('pages/tabs/ActiveBotsTab.tsx');
  const html = renderToStaticMarkup(React.createElement(PaperWorkspace, {reads: Object.values({...final3, positions, executors: budgetCut}), now, reportAt: final3.status.generated_at_ms, heartbeat: 'Fresh', bot: 'meridian_v5_paper'}));
  assert.match(html, /<dt>Open executors<\/dt><dd[^>]*>partial · not published<\/dd><small>1 active executor among the 101 rows actually read · the owner&#x27;s list is incomplete: The owner cut this read at its byte budget and published only the recent window · not a total/);
  assert.doesNotMatch(html, /<dt>Open executors<\/dt><dd[^>]*>0<\/dd>/);
  const windowed = {...budgetCut, stale_reason: 'bounded_terminal_window_see_history_terminal_executors', reason: null};
  const exact = renderToStaticMarkup(React.createElement(PaperWorkspace, {reads: Object.values({...final3, positions, executors: windowed}), now, reportAt: final3.status.generated_at_ms, heartbeat: 'Fresh', bot: 'meridian_v5_paper'}));
  assert.match(exact, /<dt>Open executors<\/dt><dd[^>]*>1<\/dd>/);
});

test('entry pause: since, reason, each missing part named, and never silent', () => {
  const {entryPause, entryPauseText} = model();
  const full = entryPause(decisionsWith(operator), pausedNow);
  assert.equal(full.coins.length, 5);
  assert.equal(full.since, PAUSED_AT);
  assert.deepEqual(full.reasons, ['Approved paper journal-cap maintenance']);
  const text = entryPauseText(full, pausedNow);
  assert.match(text.lead, /^Entries paused \(5 of 5 pairs\) since 2026-11-14 14:40:00 UTC · 7d ago$/);
  assert.equal(text.missing, null);
  const noReason = entryPauseText(entryPause(decisionsWith({...operator, reason: null}), pausedNow), pausedNow);
  assert.match(noReason.lead, /since 2026-11-14 14:40:00 UTC/);
  assert.deepEqual(noReason.reasons, []);
  assert.match(noReason.missing, /^reason not published \(owner field custom_info\.operator\.reason\)$/);
  const noStart = entryPauseText(entryPause(decisionsWith({...operator, updated_at: null}), pausedNow), pausedNow);
  assert.equal(noStart.lead, 'Entries paused (5 of 5 pairs)');
  assert.match(noStart.missing, /^start time not published \(owner field custom_info\.operator\.updated_at\)$/);
  const neither = entryPauseText(entryPause(decisionsWith({entry_paused: true}), pausedNow), pausedNow);
  assert.match(neither.missing, /start time not published .* · reason not published/);
  // Epoch milliseconds and ISO text are both read; a time in the future is not a start time.
  assert.equal(entryPause(decisionsWith({...operator, updated_at: PAUSED_AT}), pausedNow).since, PAUSED_AT);
  assert.equal(entryPause(decisionsWith({...operator, updated_at: '2026-11-14T14:40:00Z'}), pausedNow).since, PAUSED_AT);
  assert.equal(entryPause(decisionsWith({...operator, updated_at: pausedNow / 1000 + 86400}), pausedNow).since, null);
});

test('entry pause: the risk flag alone still shows the pause and says the decisions read does not carry it; no pause shows nothing', () => {
  const {entryPause, entryPauseText} = model();
  assert.equal(entryPause(decisionsWith({...operator, entry_paused: false}), pausedNow), null);
  assert.equal(entryPause(undefined, pausedNow, false), null);
  const risk = entryPauseText(entryPause(undefined, pausedNow, true), pausedNow);
  assert.equal(risk.lead, 'Entries paused');
  assert.match(risk.missing, /start time not published .* · reason not published .* · decisions read not available/);
  const stale = entryPauseText(entryPause(decisionsWith(operator, pausedNow - 120_000), pausedNow, true), pausedNow);
  assert.match(stale.missing, /decisions read stale/);
});

test('the Bots page shows the entry pause with its start and owner reason, and names a missing reason', () => {
  const {PaperWorkspace} = paperWorkspaceModules().load('pages/tabs/ActiveBotsTab.tsx');
  const render = decisions => renderToStaticMarkup(React.createElement(PaperWorkspace, {reads: Object.values({...final3, decisions}), now: pausedNow, reportAt: pausedNow - 5_000, heartbeat: 'Fresh', bot: 'meridian_v5_paper'}));
  const html = render(decisionsWith(operator));
  assert.match(html, /<strong>Entries paused \(5 of 5 pairs\) since 2026-11-14 14:40:00 UTC · 7d ago: <\/strong><span>Approved paper journal-cap maintenance<\/span>/);
  assert.match(render(decisionsWith({...operator, reason: null})), /reason not published \(owner field custom_info\.operator\.reason\)/);
  assert.doesNotMatch(render(decisionsWith({...operator, entry_paused: false})), /Entries paused/);
});

test('the Overview V5 card shows the same pause banner from the owner decisions read, and says so when that read failed', () => {
  const read = decisionsWith(operator);
  const mount = result => {
    const {V5PauseNotice} = frontendModules({'@tanstack/react-query': {useQuery: ({queryKey}) => queryKey[0] === 'v5-profile' ? {data: {readiness: {paper_owner: {bot_name: 'meridian_v5_paper'}}}} : result}}).load('v5/V5PauseNotice.tsx');
    return renderToStaticMarkup(React.createElement(V5PauseNotice));
  };
  assert.match(mount({data: read, dataUpdatedAt: pausedNow, isPending: false, isError: false}), /Entries paused \(5 of 5 pairs\) since 2026-11-14 14:40:00 UTC · 7d ago: <\/strong><span>Approved paper journal-cap maintenance<\/span>/);
  assert.match(mount({isPending: true, isError: false}), /Reading the entry-pause state/);
  assert.match(mount({isPending: false, isError: true, error: new Error('HTTP 503')}), /Entry-pause state not read: HTTP 503\. Not paused is not implied\./);
  const sourceOverview = fs.readFileSync(new URL('../src/v5/V5Overview.tsx', import.meta.url), 'utf8');
  assert.match(sourceOverview, /<h3><NavLink to="\/bots">V5 paper bot<\/NavLink><\/h3>\s*<V5PauseNotice \/>/);
});

test('fills are listed newest first and a last fill per pair line gives each pair its time and age', () => {
  const fill = final3.fills.data[0];
  const stamp = index => now - (30 - index) * 3_600_000;
  const data = Array.from({length: 20}, (_, index) => ({...fill, trade_id: `trade-${String(index).padStart(2, '0')}`, order_id: `order-${index}`, event_at_ms: stamp(index), trading_pair: PAIRS[index % 5], side: index % 2 ? 'SELL' : 'BUY'}));
  const fills = {...final3.fills, state: 'available', completeness: 'partial', next_cursor: null, data};
  const {PaperWorkspace} = paperWorkspaceModules().load('pages/tabs/ActiveBotsTab.tsx');
  const html = renderToStaticMarkup(React.createElement(PaperWorkspace, {reads: Object.values({...final3, fills}), now, reportAt: final3.status.generated_at_ms, heartbeat: 'Fresh', bot: 'meridian_v5_paper'}));
  const shown = [...html.matchAll(/title="Copy full owner ID">(trade-\d\d)</g)].map(match => match[1]);
  assert.deepEqual(shown.slice(0, 3), ['trade-19', 'trade-18', 'trade-17'], 'newest fill first');
  assert.ok(shown.indexOf('trade-19') < shown.indexOf('trade-12'));
  const last = html.match(/Last fill per pair<\/h3><ul>(.*?)<\/ul>/)[1];
  assert.match(last, /<li><strong>XRP<\/strong>: Sell · \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC · 11h ago<\/li>/);
  assert.match(last, /<li><strong>BNB<\/strong>: Sell · .* UTC · 15h ago<\/li>/);
  assert.match(html, /Newest fill among the retained rows only/);
  const unseen = renderToStaticMarkup(React.createElement(PaperWorkspace, {reads: Object.values({...final3, fills: {...fills, data: data.filter(item => item.trading_pair !== 'SOL-USDC')}}), now, reportAt: final3.status.generated_at_ms, heartbeat: 'Fresh', bot: 'meridian_v5_paper'}));
  assert.match(unseen, /<li><strong>SOL<\/strong>: no fill among the retained rows<\/li>/);
});

test('model helpers: newest-first keeps undated rows last and never mutates the owner rows', () => {
  const {newestFirstFills} = model();
  const rows = [{id: 'a', event_at_ms: 1}, {id: 'b'}, {id: 'c', event_at_ms: 3}, {id: 'd', event_at_ms: 2}];
  assert.deepEqual(newestFirstFills(rows).map(item => item.id), ['c', 'd', 'a', 'b']);
  assert.deepEqual(rows.map(item => item.id), ['a', 'b', 'c', 'd']);
  assert.equal(newestFirstFills(null), null);
});

test('known owner codes show plain words with the code in small print; an unknown code is shown as published', () => {
  const {OwnerCode} = frontendModules().load('v5/OwnerCode.tsx');
  const html = code => renderToStaticMarkup(React.createElement(OwnerCode, {code}));
  assert.equal(html('journal.reader_capacity_near'), 'The owner&#x27;s journal reader is close to its capacity limit <small class="owner-code">journal.reader_capacity_near</small>');
  assert.match(html('OWNER_JOURNAL_EXCEEDED'), /^The owner&#x27;s paper journal has passed its size budget <small class="owner-code">OWNER_JOURNAL_EXCEEDED<\/small>$/);
  assert.equal(html('some_future_code'), 'some_future_code');
  assert.equal(html(null), 'Not published');
});

test('the journal evidence panel explains its codes in words and keeps them in small print', () => {
  const {OwnerJournalCondition} = frontendModules().load('v5/OwnerJournalCondition.tsx');
  const status = {...final3.status, state: 'degraded', reason: 'OWNER_JOURNAL_EXCEEDED', data: {...final3.status.data, journal_budget: {state: 'exceeded', journal_evidence_held: true, native_execution_continues: true}}};
  const html = renderToStaticMarkup(React.createElement(OwnerJournalCondition, {status, snapshotLabel: 'Fresh'}));
  assert.match(html, /<p>The owner&#x27;s paper journal has passed its size budget <small class="owner-code">OWNER_JOURNAL_EXCEEDED<\/small> · exceeded<\/p>/);
  assert.match(html, /<p>Journal evidence is held back · native execution continues<\/p>/);
  assert.ok(html.includes('journal_evidence_held: true'));
});

test('a stale executors read gives no partial row count; fills with no qualified time never count as "no fill"', () => {
  const {openExecutorsPartial, sellOrdersPartial, lastFillPerPair, newestFirstFills} = model();
  assert.equal(openExecutorsPartial(budgetCut, now + 31_000).value, 'Not published');
  assert.match(sellOrdersPartial(budgetCut, 'BTC-USDC', now + 31_000), /no executor rows read/);
  assert.equal(openExecutorsPartial(budgetCut, now).value, 'partial · not published');
  const fill = final3.fills.data[0];
  const snapshotAt = final3.fills.generated_at_ms;
  const future = {...fill, trade_id: 'future', trading_pair: 'BNB-USDC', event_at_ms: snapshotAt + 3_600_000};
  const old = {...fill, trade_id: 'old', trading_pair: 'BTC-USDC', event_at_ms: snapshotAt - 1000};
  const read = {...final3.fills, completeness: 'partial', next_cursor: null, data: [future, old]};
  const last = lastFillPerPair(read, ['BNB-USDC', 'BTC-USDC', 'ETH-USDC'], now);
  assert.deepEqual(last.rows.map(item => [item.pair, item.rows, item.at]), [['BNB-USDC', 1, null], ['BTC-USDC', 1, snapshotAt - 1000], ['ETH-USDC', 0, null]]);
  assert.deepEqual(newestFirstFills([future, old], item => item.event_at_ms <= snapshotAt ? item.event_at_ms : null).map(item => item.trade_id), ['old', 'future']);
});
