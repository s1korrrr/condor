import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {paperSafetyReads} from '../src/v5/paper-safety.ts';
import {frontendModules} from './helpers/frontend-module.mjs';
import {ownerRisk} from './helpers/owner-risk.mjs';

const fixture = section => JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/paper-api-final3/${section}.json`, import.meta.url)));
const base = ownerRisk('native-entry-holds', fixture('risk'));
const [bnb, btc] = Object.keys(base.data.controllers);
const stubs = {
  ...Object.fromEntries(['@/components/bots/AggregatedPnlChart', '@/components/bots/ControllerBrowser', '@/components/bots/DeployBotDialog', '@/components/bots/PnlSparkline', '@/hooks/useWebSocket', '@/hooks/useRates'].map(name => [name, {}])),
  '@/features/quant-ops/kit/DataTable': {DataTable:() => null},
  '@workspace-monitoring': {PaperStrategyCharts:() => null, StrategyCharts:() => null},
};
const {PaperWorkspace} = frontendModules(stubs).load('pages/tabs/ActiveBotsTab.tsx');
const advance = read => ({...read, snapshot_id:`${read.source.boot_id}:${read.source.sequence + 1}`, generated_at_ms:read.generated_at_ms + 15_000, source:{...read.source, sequence:read.source.sequence + 1}});
const received = read => [{...fixture('status'), snapshot_id:read.snapshot_id, generated_at_ms:read.generated_at_ms, source:read.source}, read];

function render(newer, older) {
  const reads = [...['status', 'wallet', 'positions', 'fills', 'executors', 'decisions', 'history'].map(section => advance(fixture(section))), newer];
  return renderToStaticMarkup(React.createElement(PaperWorkspace, {reads, safetyReads:paperSafetyReads([older], [], newer), complete:true, now:newer.generated_at_ms, reportAt:null, heartbeat:'Fresh', bot:base.bot_id}));
}

function pausedCards(html, controller) {
  return [...html.matchAll(new RegExp(`<h3>${controller}</h3><span[^>]*>[^<]*</span><p>Reported operator pause: Yes`, 'g'))].length;
}

test('owner scoped resume removes BNB pause while BTC retains a native entry hold', () => {
  const older = structuredClone(base);
  older.data.controllers[bnb].operator.paused = true;
  older.data.controllers[btc].operator.paused = true;
  const newer = advance(structuredClone(base));
  newer.data.controllers[btc].operator.paused = true;
  assert.deepEqual(paperSafetyReads([older], [], newer), []);
  const html = render(newer, older);
  assert.equal(pausedCards(html, bnb), 0);
  assert.equal(pausedCards(html, btc), 2);
  assert.match(html, /New acquisitions held/);
});

test('owner named durability reset removes only that hold while emergencies remain visible', () => {
  const older = ownerRisk('ingress-unreadable-hold', fixture('risk'));
  older.reason = 'stop_persistence_failed';
  older.stale_reason = older.reason;
  older.data.control_hold = 'stop_persistence_failed';
  older.data.holds.unshift({reason:'stop_persistence_failed', explanation:'Stop durability requires owner review.'});
  older.data.emergency_recovery = {required:true, hold:{reason:'stop_persistence_failed', failure_id:'fixture'}, acknowledgements:[]};
  for (const controller of Object.values(older.data.controllers)) {
    controller.operator.emergency = true;
    controller.operator.paused = true;
  }
  const newer = advance(structuredClone(older));
  newer.reason = 'ingress_unreadable';
  newer.stale_reason = newer.reason;
  newer.data.control_hold = 'ingress_unreadable';
  newer.data.holds = newer.data.holds.filter(hold => hold.reason !== 'stop_persistence_failed');
  newer.data.emergency_recovery = {required:false, hold:null, acknowledgements:[]};
  assert.deepEqual(paperSafetyReads([older], [], newer), []);
  const html = render(newer, older);
  assert.doesNotMatch(html, /Stop durability failed/);
  assert.match(html, /Command ingress is unreadable/);
  assert.match(html, /Emergency halt reported/);
  assert.match(html, /Omitted controllers remain unknown, not cleared/);
  assert.equal((html.match(/Reported emergency halt: Yes/g) ?? []).length, 2 * Object.keys(base.data.controllers).length);
});

test('mixed owner update removes the old BNB pause and retains the newly paused BTC read', () => {
  const older = structuredClone(base);
  older.data.controllers[bnb].operator.paused = true;
  const newer = advance(structuredClone(base));
  newer.data.controllers[btc].operator.paused = true;
  assert.deepEqual(paperSafetyReads([older], received(newer), newer), [newer]);
  const html = render(newer, older);
  assert.equal(pausedCards(html, bnb), 0);
  assert.equal(pausedCards(html, btc), 2);
  assert.match(html, /New acquisitions held/);
});

test('explicit emergency-clear risk supersedes old emergency while a pause remains', () => {
  const older = structuredClone(base);
  older.data.controllers[bnb].operator.emergency = true;
  const newer = advance(structuredClone(base));
  newer.data.controllers[btc].operator.paused = true;
  assert.deepEqual(paperSafetyReads([older], received(newer), newer), [newer]);
  const html = render(newer, older);
  assert.doesNotMatch(html, /Emergency halt reported|Reported emergency halt: Yes/);
  assert.match(html, /New acquisitions held/);
  assert.equal(pausedCards(html, btc), 2);
});

for (const [group, field] of [['operator', 'paused'], ['operator', 'emergency'], ['native', 'complete']]) {
  for (const value of [null, undefined, 'false']) test(`unknown ${group}.${field} cannot supersede prior safety: ${String(value)}`, () => {
    const older = structuredClone(base);
    older.data.controllers[bnb].operator.paused = true;
    const newer = advance(structuredClone(base));
    newer.data.controllers[btc].operator.paused = true;
    newer.data.controllers[bnb][group][field] = value;
    assert.deepEqual(paperSafetyReads([older], [], newer), [older]);
  });
}

test('risk with an outstanding cursor cannot supersede prior safety', () => {
  const older = structuredClone(base);
  older.data.controllers[bnb].operator.paused = true;
  const newer = {...advance(structuredClone(base)), next_cursor:'pending-risk-page'};
  assert.deepEqual(paperSafetyReads([older], [], newer), [older]);
});

for (const reason of ['OWNER_MARK_UNAVAILABLE', 'native_risk_incomplete', 'paper_controls_unavailable', 'unknown_hold']) test(`partial risk for ${reason} keeps prior evidence`, () => {
  const older = structuredClone(base);
  older.data.controllers[bnb].operator.emergency = true;
  const newer = {...advance(structuredClone(base)), reason};
  assert.deepEqual(paperSafetyReads([older], [], newer), [older]);
});

for (const reason of ['clock_anomaly', 'native_refusal_owner_ambiguous']) test(`recognized reason ${reason} without its own published hold keeps prior evidence`, () => {
  const older = structuredClone(base);
  older.data.controllers[bnb].operator.emergency = true;
  const newer = {...advance(structuredClone(base)), reason};
  newer.data.native_entry_holds = newer.data.native_entry_holds.filter(hold => hold.reason !== reason);
  assert.deepEqual(paperSafetyReads([older], [], newer), [older]);
});

test('partial risk with a monetary schema error keeps prior evidence', () => {
  const older = structuredClone(base);
  older.data.controllers[bnb].operator.emergency = true;
  const newer = advance(structuredClone(base));
  newer.data.fee_quote = {};
  assert.deepEqual(paperSafetyReads([older], [], newer), [older]);
});

for (const registryRemoved of [false, true]) test(`omitted controller stays retained when registry removal is ${registryRemoved}`, () => {
  const older = structuredClone(base);
  older.data.controllers[bnb].operator.emergency = true;
  older.data.controllers[btc].operator.paused = true;
  const newer = advance(structuredClone(base));
  delete newer.data.controllers[bnb];
  newer.data.native_entry_holds = newer.data.native_entry_holds.filter(hold => hold.controller_id !== bnb);
  if (registryRemoved) newer.source = {...newer.source, boot_id:'replacement-without-bnb', sequence:1};
  const retained = paperSafetyReads([older], received(newer), newer);
  assert.equal(retained.filter(read => read.snapshot_id === older.snapshot_id).length, 1);
  const prior = retained.find(read => read.snapshot_id === older.snapshot_id);
  assert.deepEqual(Object.keys(prior.data.controllers), [bnb]);
  const html = renderToStaticMarkup(React.createElement(PaperWorkspace, {reads:received(newer), safetyReads:retained, complete:false, now:newer.generated_at_ms, reportAt:null, heartbeat:'Fresh', bot:base.bot_id}));
  assert.match(html, /Emergency halt reported/);
  assert.equal(pausedCards(html, btc), 0);
  const restored = advance(structuredClone(newer));
  restored.data.controllers[bnb] = structuredClone(base.data.controllers[bnb]);
  assert.deepEqual(paperSafetyReads(retained, [], restored), []);
});

test('owner hold evidence stays retained when the newer risk omits its owner-hold list', () => {
  const older = ownerRisk('ingress-unreadable-hold', fixture('risk'));
  const newer = advance(structuredClone(base));
  const retained = paperSafetyReads([older], [], newer);
  assert.equal(retained.length, 1);
  assert.match(render(newer, older), /Command ingress is unreadable/);
  const explicit = advance(structuredClone(newer));
  explicit.data.holds = [];
  assert.deepEqual(paperSafetyReads(retained, [], explicit), []);
});

test('raw clock anomaly fixture with an unsafe numeric timestamp remains fail-safe', () => {
  const older = structuredClone(base);
  older.data.controllers[bnb].operator.emergency = true;
  const newer = advance(ownerRisk('clock-anomaly-hold', fixture('risk')));
  assert.deepEqual(paperSafetyReads([older], [], newer), [older]);
});
