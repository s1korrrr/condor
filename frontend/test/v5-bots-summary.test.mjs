import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import * as ReactQuery from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';

const overrides = Object.fromEntries(['@/components/bots/AggregatedPnlChart', '@/components/bots/ControllerBrowser', '@/components/bots/DeployBotDialog', '@/components/bots/PnlSparkline', '@/hooks/useWebSocket', '@/hooks/useRates'].map(name => [name, {}]));
const { load } = frontendModules(overrides);
const { paperHoldSentence, paperMoneyTiles, PaperWorkspace } = load('pages/tabs/ActiveBotsTab.tsx');
const fixture = Object.fromEntries(['status', 'wallet', 'positions', 'executors', 'fills', 'risk', 'decisions', 'history', 'operations', 'accounting'].map(section => [section, JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/paper-api-final3/native-replay/${section}.json`, import.meta.url)))]));
const now = fixture.wallet.generated_at_ms;
const controller = (id, extra = {}) => ({ id, current: true, operator: { paused: false, emergency: false }, native: { protected_exits: 'preserved' }, entryHold: false, holds: [], ...extra });
const day = Math.floor(now / 86_400_000) * 86_400_000;
const money = { range: '7d', now_ms: now, daily: [{ day, samples: 2, valid: 2, gaps: 0, first_at_ms: now - 300_000, last_at_ms: now, equity_change: '-12.000000000000000000000000000001' }] };
const tiles = (changes = {}) => paperMoneyTiles({ walletRead: fixture.wallet, accountingRead: fixture.accounting, snapshot: fixture.status, complete: true, now, money, ...changes });

test('operator pause names only the paused controllers unless all are paused', () => {
  const paused = controller('BNB', { operator: { paused: true, emergency: false } });
  assert.equal(paperHoldSentence([paused], []), 'Buying is paused by an operator. Selling is not paused.');
  assert.match(paperHoldSentence([paused, controller('BTC')], []), /Buying is paused by an operator for BNB\./);
  assert.doesNotMatch(paperHoldSentence([paused, controller('BTC')], []), /for BTC/);
});

test('emergency, native latch, owner list and no hold never invent state or exits', () => {
  assert.equal(paperHoldSentence([controller('BNB', { operator: { emergency: true } })], []), 'The owner reports an emergency halt for BNB: buying is stopped.');
  assert.match(paperHoldSentence([controller('BNB', { entryHold: true })], []), /Buying is held for BNB/);
  assert.match(paperHoldSentence([], [{ label: 'Clock anomaly' }]), /Clock anomaly/);
  assert.equal(paperHoldSentence([], []), null);
  assert.doesNotMatch(paperHoldSentence([controller('BNB', { entryHold: true })], [{ label: 'Controls unavailable' }]), /Selling|running/);
  assert.doesNotMatch(paperHoldSentence([controller('BNB', { current: false, operator: { paused: true } })], []), /Selling/);
});

test('six tiles use exact owner strings and only zero-flow equity minus funding', () => {
  const walletRead = structuredClone(fixture.wallet);
  Object.assign(walletRead.data, { equity_quote: '199999.999999999999999999999999999999', initial_funding_quote: '200000', external_cash_flows_quote: '-0.000' });
  const result = tiles({ walletRead });
  assert.deepEqual(result.map(tile => tile.label), ['Wallet equity', 'Since start', 'Today', 'Profit from closed trades', 'Coins still held', 'Fees paid']);
  assert.equal(result[0].value, '199999.999999999999999999999999999999 USDC');
  assert.equal(result[1].value, '-0.000000000000000000000000000001 USDC');
  assert.equal(result[2].value, '-12.000000000000000000000000000001 USDC');
  assert.deepEqual(result.slice(3).map(tile => tile.value), ['realized_pnl_quote', 'unrealized_pnl_quote', 'fees_paid_quote'].map(key => `${fixture.accounting.data.program[key]} USDC`));
  for (const flows of ['0.000000000000000000000000000001', null, 0, 'bad']) {
    walletRead.data.external_cash_flows_quote = flows;
    assert.equal(tiles({ walletRead })[1].value, '—');
  }
  walletRead.data.external_cash_flows_quote = '0';
  walletRead.data.equity_quote = '200000.000000000000000000000000000001';
  assert.equal(tiles({ walletRead })[1].value, '0.000000000000000000000000000001 USDC');
});

test('incomplete, stale, future, incoherent and failed owner reads withhold money', () => {
  assert.ok(tiles({ complete: false }).every(tile => tile.value === '—'));
  assert.ok(tiles({ now: now + 400_000 }).every(tile => tile.value === '—'));
  for (const change of [{ completeness: 'partial' }, { state: 'degraded' }, { next_cursor: 'more' }, { generated_at_ms: now + 1_000 }]) {
    assert.equal(tiles({ walletRead: { ...fixture.wallet, ...change } })[0].value, '—');
    assert.equal(tiles({ accountingRead: { ...fixture.accounting, ...change } })[3].value, '—');
  }
  assert.equal(tiles({ accountingRead: { ...fixture.accounting, snapshot_id: 'other' } })[3].value, '—');
  assert.equal(tiles({ walletRead: { ...fixture.wallet, snapshot_id: 'other' } })[0].value, '—');
  assert.equal(tiles({ walletRead: { ...fixture.wallet, bot_id: 'other' } })[0].value, '—');
  assert.equal(tiles({ accountingRead: { ...fixture.accounting, bot_id: 'other' } })[3].value, '—');
  assert.equal(tiles({ money: undefined })[2].value, '—');
});

test('Today is only the current UTC-day Money row, never an older or gap value', () => {
  assert.equal(tiles({ money: { ...money, daily: [money.daily[0], { ...money.daily[0], day: day - 86_400_000, equity_change: '999' }] } })[2].value, '-12.000000000000000000000000000001 USDC');
  for (const change of [{ day: day - 86_400_000 }, { gaps: 1 }, { equity_change: null }, { last_at_ms: now + 1 }, { last_at_ms: now - 400_000 }]) {
    assert.equal(tiles({ money: { ...money, daily: [{ ...money.daily[0], ...change }] } })[2].value, '—');
  }
  assert.equal(tiles({ money: { ...money, now_ms: now - 91_000 } })[2].value, '—');
  assert.equal(tiles({ money: { ...money, now_ms: now + 1 } })[2].value, '—');
  assert.equal(tiles({ money: { ...money, daily: [null] } })[2].value, '—');
});

test('Bots uses the Money view reader and shared 7d cache key and withholds failed cached reads', async () => {
  const queries = [];
  let failed = false;
  const { load } = frontendModules({ ...overrides,
    '@/v5/usePaperClock': { usePaperClock: () => now },
    '@/v5/usePaperSnapshot': { usePaperSnapshot: () => ({ complete: true, data: Object.values(fixture), refetch() {} }) },
    '@tanstack/react-query': { ...ReactQuery, useQuery: options => { queries.push(options); return { data: money, isError: failed }; } },
  });
  const { V5PaperBots } = load('pages/tabs/ActiveBotsTab.tsx');
  const render = () => renderToStaticMarkup(React.createElement(V5PaperBots, { bot: 'meridian_v5_paper', ownerState: 'AVAILABLE', generatedAt: now / 1000 }));
  assert.match(render(), /-12\.000000000000000000000000000001 USDC/);
  assert.deepEqual(queries[0].queryKey, ['v5-money', '7d']);
  const original = globalThis.fetch;
  const reads = [];
  globalThis.fetch = async (path, options) => { reads.push({ path, options }); return { ok: true, json: async () => money }; };
  try {
    assert.equal(await queries[0].queryFn(), money);
    assert.deepEqual(reads.map(read => read.path), ['/api/v5/money?range=7d']);
    assert.equal(reads[0].options.credentials, 'include');
  } finally { globalThis.fetch = original; }
  failed = true;
  assert.doesNotMatch(render(), /-12\.000000000000000000000000000001 USDC/);
});

test('hold evidence stays rendered in closed Details above the six money tiles', () => {
  const risk = structuredClone(fixture.risk);
  const id = Object.keys(risk.data.controllers)[0];
  risk.data.controllers[id].operator.paused = true;
  const html = renderToStaticMarkup(React.createElement(PaperWorkspace, { reads: Object.values({ ...fixture, risk }), accountingRead: fixture.accounting, money, now, reportAt: now, heartbeat: 'Fresh', bot: 'meridian_v5_paper' }));
  assert.match(html, /paper-hold-sentence/);
  assert.match(html, /<details class="paper-hold-details"><summary>/);
  assert.ok(html.indexOf('paper-hold-details') < html.indexOf('Since start'));
  assert.doesNotMatch(html, /Controller entry controls/);
  assert.match(html, /As of .*Z · .*ago/);
  assert.match(html, /Omitted controllers remain unknown/);
});
