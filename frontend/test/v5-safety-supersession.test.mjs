import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {paperSafetyReads} from '../src/v5/paper-safety.ts';
import {frontendModules} from './helpers/frontend-module.mjs';

const fixture = section => JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/paper-api-final3/${section}.json`, import.meta.url)));
const base = fixture('risk');
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

test('owner scoped resume removes BNB pause while BTC remains paused', () => {
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
  const older = structuredClone(base);
  older.data.control_hold = 'stop_persistence_failed';
  older.data.emergency_recovery = {required:true, hold:{reason:'stop_persistence_failed', failure_id:'fixture'}, acknowledgements:[]};
  for (const controller of Object.values(older.data.controllers)) {
    controller.operator.emergency = true;
    controller.operator.paused = true;
  }
  const newer = advance(structuredClone(older));
  newer.data.control_hold = null;
  newer.data.emergency_recovery = {required:false, hold:null, acknowledgements:[]};
  assert.deepEqual(paperSafetyReads([older], [], newer), []);
  const html = render(newer, older);
  assert.doesNotMatch(html, /Stop durability failed/);
  assert.match(html, /Emergency halt reported/);
  assert.equal((html.match(/Reported emergency halt: Yes/g) ?? []).length, 10);
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
