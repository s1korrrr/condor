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
const policy = load('v5/policy.ts');
const { paperSafetyReads, paperSafetyBeyondDisplayed } = load('v5/paper-safety.ts');
const fixture = Object.fromEntries(['status', 'wallet', 'positions', 'executors', 'fills', 'risk', 'decisions', 'history', 'operations', 'accounting'].map(section => [section, JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/paper-api-final3/native-replay/${section}.json`, import.meta.url)))]));
for (const read of Object.values(fixture)) read.source.boot_epoch = 1;
const now = fixture.wallet.generated_at_ms;
const controller = (id, extra = {}) => ({ id, current: true, operator: { paused: false, emergency: false }, native: { protected_exits: 'preserved' }, entryHold: false, holds: [], ...extra });
const day = Math.floor(now / 86_400_000) * 86_400_000;
const money = { range: '7d', now_ms: now, daily: [{ day, samples: 2, valid: 2, gaps: 0, first_at_ms: now - 300_000, last_at_ms: now, equity_change: '-12.000000000000000000000000000001' }] };
const tiles = (changes = {}) => paperMoneyTiles({ walletRead: fixture.wallet, accountingRead: fixture.accounting, snapshot: fixture.status, complete: true, now, money, ...changes });

test('operator pause always names the observed scope, including a partial controller report', () => {
  const paused = controller('BNB', { operator: { paused: true, emergency: false } });
  assert.equal(paperHoldSentence([paused], []), 'Buying is paused by an operator for BNB. The owner reports protective exits are preserved by entry controls.');
  assert.match(paperHoldSentence([paused, controller('BTC')], []), /Buying is paused by an operator for BNB\./);
  assert.doesNotMatch(paperHoldSentence([paused, controller('BTC')], []), /for BTC/);
  const risk = structuredClone(fixture.risk);
  const received = Object.keys(risk.data.controllers)[0];
  risk.data.controllers = { [received]: { operator: { paused: true }, native: {} } };
  risk.completeness = 'partial';
  const html = renderToStaticMarkup(React.createElement(PaperWorkspace, { reads: [risk], now, bot: risk.bot_id }));
  assert.match(html.match(/<p class="paper-hold-sentence">(.*?)<\/p>/s)[1], new RegExp(`Buying is paused by an operator for ${received}\\.`));
});

test('native hold projection retains omitted controller scopes without fabricating controller flags', () => {
  const risk = structuredClone(fixture.risk);
  risk.data.controllers = { BNB: { operator: { emergency: true }, native: {} } };
  const hold = { controller_id: 'BTC', reason: 'native_refusal_receipt_pending', explanation: 'BTC owner refusal receipt pending', protected_exits: 'preserved' };
  risk.data.native_entry_holds = [hold];
  assert.equal(policy.paperSectionError(risk), null);
  assert.deepEqual(policy.paperNativeHolds(risk), [{ ...hold, controllerPublished: false }]);
  const render = read => renderToStaticMarkup(React.createElement(PaperWorkspace, { reads: [read], now, bot: read.bot_id }));
  const html = render(risk);
  const sentence = html.match(/<p class="paper-hold-sentence">(.*?)<\/p>/s)[1];
  const details = html.match(/<details class="paper-hold-details">(.*?)<\/details>/s)[1];
  assert.match(sentence, /emergency halt for BNB: buying is stopped/);
  for (const text of [sentence, details]) assert.match(text, /BTC: Native refusal receipt pending \(controller details not published\)/);
  assert.match(details, /BTC owner refusal receipt pending/);
  assert.doesNotMatch(sentence, /Selling|exits|running/);
  assert.equal((details.match(/Reported operator pause:/g) ?? []).length, 1);
  risk.data.controllers = {};
  assert.match(render(risk), /New acquisitions held/);
  assert.match(render(risk), /BTC: Native refusal receipt pending/);
  risk.state = 'stale';
  risk.completeness = 'partial';
  assert.deepEqual(policy.paperNativeHolds(risk), [{ ...hold, controllerPublished: false }]);
  risk.data.controllers.BTC = { operator: {}, native: {} };
  assert.deepEqual(policy.paperNativeHolds(risk), [{ ...hold, controllerPublished: true }]);
  assert.deepEqual(policy.paperNativeHolds(undefined), []);
  assert.deepEqual(policy.paperNativeHolds({ ...risk, section: 'wallet' }), []);
  risk.data.native_entry_holds[0].protected_exits = 'unknown';
  assert.deepEqual(policy.paperNativeHolds(risk), []);
});

test('controls-unavailable exit restriction stays visible alongside an emergency', () => {
  const risk = structuredClone(fixture.risk);
  risk.data.controllers = { BNB: { operator: { emergency: true }, native: {} } };
  risk.data.holds = [{ reason: 'paper_controls_unavailable', explanation: 'Owner control store unavailable' }];
  const html = renderToStaticMarkup(React.createElement(PaperWorkspace, { reads: [risk], now, bot: risk.bot_id }));
  const sentence = html.match(/<p class="paper-hold-sentence">(.*?)<\/p>/s)[1];
  assert.match(sentence, /emergency halt for BNB: buying is stopped/);
  assert.match(sentence, /The owner reports paper controls are unavailable: the runtime refuses all native ticks and exits until the control-store failure is resolved\./);
  assert.doesNotMatch(sentence, /Selling|protective exits are preserved/);
});

test('native holds without controller rows survive safety retention and displayed-signal filtering', () => {
  const risk = structuredClone(fixture.risk);
  const id = Object.keys(risk.data.controllers)[0];
  risk.data.controllers = { [id]: risk.data.controllers[id] };
  risk.data.controllers[id].operator = { emergency: false, paused: false };
  risk.data.native_entry_holds = [{ controller_id: 'BTC', reason: 'native_refusal_receipt_pending', explanation: 'BTC owner refusal receipt pending', protected_exits: 'preserved' }];
  const retained = paperSafetyReads([], [fixture.status, risk]);
  assert.deepEqual(retained, [risk]);
  const newer = structuredClone(risk);
  newer.generated_at_ms += 1_000;
  newer.source.sequence += 1;
  newer.snapshot_id = `${newer.source.boot_id}:${newer.source.sequence}`;
  newer.data.native_entry_holds = [];
  assert.deepEqual(paperNativeReasons(paperSafetyReads(retained, [], newer)), ['native_refusal_receipt_pending']);
  newer.data.controllers[id].operator.emergency = true;
  assert.deepEqual(paperNativeReasons(paperSafetyBeyondDisplayed(retained, [newer])), ['native_refusal_receipt_pending']);
});

const paperNativeReasons = reads => reads.flatMap(read => policy.paperNativeHolds(read).map(hold => hold.reason));

test('emergency, native latch, owner list and no hold never invent state or exits', () => {
  assert.equal(paperHoldSentence([controller('BNB', { operator: { emergency: true } })], []), 'The owner reports an emergency halt for BNB: buying is stopped.');
  assert.match(paperHoldSentence([controller('BNB', { entryHold: true })], []), /Buying is held for BNB/);
  assert.match(paperHoldSentence([], [{ label: 'Clock anomaly' }]), /Clock anomaly/);
  assert.equal(paperHoldSentence([], []), null);
  assert.doesNotMatch(paperHoldSentence([controller('BNB', { entryHold: true })], [{ label: 'Controls unavailable' }]), /Selling|running/);
  assert.doesNotMatch(paperHoldSentence([controller('BNB', { current: false, operator: { paused: true } })], []), /Selling/);
});

test('emergency sentence retains every received hold and its controller scope without an exit claim', () => {
  const controllers = [controller('BNB', { operator: { emergency: true } }), controller('BTC', { entryHold: true }), controller('ETH', { operator: { paused: true } })];
  const sentence = paperHoldSentence(controllers, [{ label: 'Paper controls unavailable' }]);
  assert.match(sentence, /emergency halt for BNB: buying is stopped/);
  assert.match(sentence, /Buying is held for BTC/);
  assert.match(sentence, /Buying is paused by an operator for ETH/);
  assert.match(sentence, /Paper controls unavailable/);
  assert.doesNotMatch(sentence, /Selling|exits|running/);
});

test('entry controls never certify the general selling state or exit coverage', () => {
  const sentence = paperHoldSentence([controller('BNB', { operator: { paused: true }, native: { protected_exits: 'preserved', protected_exit_state: null } })], []);
  assert.match(sentence, /The owner reports protective exits are preserved by entry controls/);
  assert.doesNotMatch(sentence, /Selling|exit coverage|selling works/i);
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

test('all six tiles expire strictly beyond 30000 ms, including a freshly recorded Today row', () => {
  assert.ok(tiles({ now: now + 30_000 }).every(tile => tile.value !== '—'));
  assert.ok(tiles({ now: now + 30_001 }).every(tile => tile.value === '—'));
  const freshMoney = { ...money, now_ms: now + 30_001, daily: [{ ...money.daily[0], last_at_ms: now + 30_001 }] };
  assert.equal(tiles({ now: now + 30_001, money: freshMoney })[2].value, '—');
});

test('Today uses current wallet and accounting, not the aggregate degraded status', () => {
  assert.equal(fixture.status.state, 'degraded');
  assert.equal(fixture.wallet.state, 'available');
  assert.equal(fixture.accounting.state, 'available');
  assert.equal(tiles()[2].value, `${money.daily[0].equity_change} USDC`);
  for (const section of ['wallet', 'accounting']) {
    const readKey = section === 'wallet' ? 'walletRead' : 'accountingRead';
    assert.equal(tiles({ [readKey]: { ...fixture[section], state: 'degraded' } })[2].value, '—');
    assert.equal(tiles({ [readKey]: { ...fixture[section], snapshot_id: 'other' } })[2].value, '—');
    assert.equal(tiles({ [readKey]: { ...fixture[section], completeness: 'partial' } })[2].value, '—');
  }
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
  const moneyQueries = queries.filter(query => query.queryKey[0] === 'v5-money');
  assert.equal(moneyQueries.length, 1);
  assert.deepEqual(moneyQueries[0].queryKey, ['v5-money', '7d']);
  const original = globalThis.fetch;
  const reads = [];
  globalThis.fetch = async (path, options) => { reads.push({ path, options }); return { ok: true, json: async () => money }; };
  try {
    assert.equal(await moneyQueries[0].queryFn(), money);
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
