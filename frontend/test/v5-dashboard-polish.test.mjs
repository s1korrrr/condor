import * as ReactQuery from '@tanstack/react-query';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { paperCoherentRead, paperSectionError } from '../src/v5/policy.ts';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';

const fixture = section => JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/paper-api-final3/native-replay/${section}.json`, import.meta.url)));

for (const section of ['status','wallet','risk','decisions','history','accounting','operations']) for (const value of [{},[]]) test(`${section} rejects a monetary container in fee_quote: ${JSON.stringify(value)}`, () => {
  const read = fixture(section);
  assert.equal(paperSectionError(read),null);
  read.data.fee_quote = value;
  assert.match(paperSectionError(read),/schema invalid/);
});

test('three-worker pinned pool streams sections and drains failures before restart', async () => {
  let active = 0, peak = 0, attempt = 0;
  const progress = [];
  const sections = ['wallet', 'positions', 'executors', 'risk', 'history', 'accounting'];
  const reads = await paperCoherentRead('/status', sections.map(section => ({section, path:`/${section}`})), async (path, section) => {
    if (section === 'status') { assert.equal(active, 0); attempt++; }
    else assert.equal(new URL(path, 'https://fixture.invalid').searchParams.get('snapshot_id'), `epoch:${attempt}`);
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, section === 'wallet' ? 4 : 1));
    active--;
    if (attempt === 1 && section === 'positions') throw Object.assign(new Error('changed'), {status:409});
    return {...fixture(section), snapshot_id:`epoch:${attempt}`, generated_at_ms:1793275200000 + attempt};
  }, async () => {}, reads => progress.push(reads));
  assert.equal(peak, 3);
  assert.equal(attempt, 2);
  assert.equal(reads.length, 7);
  assert.ok(progress.some(reads => reads.length > 1 && reads.length < 7));
  assert.ok(progress.some(reads => reads.length === 0));
  for (const reads of progress) assert.ok(new Set(reads.map(read => read.snapshot_id)).size <= 1);
  const reset = progress.findLastIndex(reads => reads.length === 0);
  assert.ok(progress.slice(reset + 1).every(reads => reads.every(read => read.snapshot_id === 'epoch:2')));
});

for (const field of ['reason', 'read_at_ms', 'observed_at_ms', 'source_at_ms', 'capabilities', 'source']) test(`requires API envelope field ${field}`, () => {
  const read = fixture('fills'); delete read[field];
  assert.match(paperSectionError(read), /schema invalid/);
});

for (const field of ['fee_quote', 'price', 'quantity', 'amount', 'balance', 'pnl']) for (const value of [{}, []]) test(`rejects ${field} container ${JSON.stringify(value)}`, () => {
  const read = fixture('fills'); read.data[0][field] = value;
  assert.match(paperSectionError(read), /schema invalid/);
});

test('blank capability members remain owner-compatible', () => {
  const read = fixture('fills'); read.capabilities = [''];
  assert.equal(paperSectionError(read), null);
});

test('Bots risk caption normalizes owner punctuation and hides partial totals', () => {
  const {load} = frontendModules(Object.fromEntries(['@/components/bots/AggregatedPnlChart','@/components/bots/ControllerBrowser','@/components/bots/DeployBotDialog','@/components/bots/PnlSparkline','@/hooks/useWebSocket','@/hooks/useRates'].map(name => [name,{}])));
  const risk = fixture('risk'); risk.reason = 'Paper section completeness is not complete.'; risk.data = {};
  const wallet = fixture('wallet');
  const html = renderToStaticMarkup(React.createElement(load('pages/tabs/ActiveBotsTab.tsx').PaperWorkspace, {reads:[wallet,risk],complete:false,now:wallet.read_at_ms,reportAt:wallet.generated_at_ms,heartbeat:'Fresh',bot:wallet.bot_id}));
  assert.doesNotMatch(html, /\.\. Loss rails/);
  assert.doesNotMatch(html, /Fresh complete owner wallet/);
});

for (const label of ['Checking','Unavailable','Stale','Incomplete','Available']) test(`Settings subtitle reflects ${label} owner reads`, () => {
  const profile = {readiness:{paper_owner:{mode:'PAPER',bot_name:'meridian_v5_paper'}}};
  const settings = {identity:{},budget:{}};
  const {load} = frontendModules({
    '@tanstack/react-query':{useQueryClient:() => new ReactQuery.QueryClient(),useQuery:({queryKey}) => ({data:queryKey[0]==='v5-profile'?profile:settings,refetch(){}})},
    './usePaperObservation':{usePaperObservation:() => ({summary:{label,reason:'Fixture state'}})},
    'react-markdown':{},
  });
  const html = renderToStaticMarkup(React.createElement(load('v5/V5Pages.tsx').SettingsPage));
  assert.match(html, new RegExp(`Read-only configuration · paper owner reads: ${label.toLowerCase()}`));
  if (label !== 'Available') assert.doesNotMatch(html, /current owner-reported readiness/);
});
