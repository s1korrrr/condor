// The shared builder output (condor/tests/fixtures/fleet_holdings/holdings.example.json) rendered by the dashboard.
// Every expectation below is derived by hand from docs/reference/fleet-holdings-v1.md and the fixture's numbers,
// not from running this code: age = (served_at_ms - observed_at_ms) + local time since receipt; current only while
// state == current and age < stale_after_ms; totals are the exact value, else "≥ known" when positive, else a dash;
// held counts only when held_pair_count is present; small grouping is the server's flag.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';
import { holdingsExample } from './helpers/holdings.mjs';

const { load } = frontendModules({ 'react-router-dom': { Link: ({ to, children, ...rest }) => React.createElement('a', { href: to, ...rest }, children) } });
const lib = load('lib/fleet-holdings.ts');
const { buildBotPositionView, partitionBotInventory, projectBotInventory } = load('features/bots/position-view.ts');
const { projectBotStats, projectFleetTiles } = load('features/bots/fleet-tiles.ts');
const { CommandDeskObservation } = load('components/bots/NativeBotCommandDesk.tsx');
const { RosterObservation } = load('components/bots/BotsRoster.tsx');

// The route stamps served_at_ms per response; the builder fixture has none. Serve it as built: served = generated.
const fixture = holdingsExample();
const served = fixture.generated_at_ms; // 1761436800000
const received = Date.parse('2026-10-25T12:00:00Z'); // the browser clock is unrelated to the owner clock
const read = { body: lib.parseFleetHoldings({ ...fixture, served_at_ms: served }), receivedAtMs: received };
const holdings = bot => lib.botHoldings(read, bot);

/** Owner bootstraps for the same identities, observed 1 s before `received` on the browser clock. */
function bootstrap(bot, controllers, executors = []) {
  return { runtime_status: { bot_name: bot, updated_at: new Date(received - 1000).toISOString(), controllers, positions_held: [], active_executors: executors, active_orders: [], active_orders_status: { complete: true } }, monitoring: { bot_name: bot, stale_threshold_seconds: 30 } };
}
const v3 = 'modular_spot_meridian_v3_unified_live';
const symbol = pair => ({ controller_id: v3, pair, pair_projection_source: 'native_owner_symbols', observation_status: 'unavailable', price_quote: null, custom_info: {} });
const payloads = {
  ok_rsi: bootstrap('ok_rsi', [{ controller_id: 'ok-rsi-bnb', pair: 'BNB-USDC', state: 'HOLDING', price_quote: 1 }, { controller_id: 'ok-rsi-xrp', pair: 'XRP-USDC', state: 'HOLDING', price_quote: 1 }, { controller_id: 'ok-rsi-btc', pair: 'BTC-USDC', state: 'FLAT', price_quote: 1 }]),
  meridian_v3: bootstrap('meridian_v3', [symbol('BTC-USDC'), symbol('ETH-USDC')], [{ executor_id: 'x1', controller_id: v3, pair: 'BTC-USDC', side: 'buy', executor_type: 'position', remaining_position_amount_base: '0.001' }]),
  rsi_modular_v2: bootstrap('rsi_modular_v2', [{ controller_id: 'ok-rsi-bnb', pair: 'BNB-USDC', state: 'HOLDING', price_quote: 1 }]),
  meridian_v4_paper: bootstrap('meridian_v4_paper', [{ controller_id: 'ok-rsi-bnb', pair: 'BNB-USDC', state: 'HOLDING', price_quote: 1 }]),
  partial_bot: bootstrap('partial_bot', [{ controller_id: 'ok-rsi-bnb', pair: 'BNB-USDC', state: 'HOLDING', price_quote: 1 }, { controller_id: 'e', pair: 'ETH-USDC', state: 'HOLDING', price_quote: 1 }]),
  offline_bot: bootstrap('offline_bot', [{ controller_id: 'off', pair: 'BTC-USDC', state: 'HOLDING', price_quote: 1 }]),
};
const desk = (bot, now = received) => renderToStaticMarkup(React.createElement(CommandDeskObservation, { payload: payloads[bot], bot, now, section: 'positions', selected: null, onSelect: () => {}, holdings: holdings(bot) }));
const roster = (bot, now = received) => renderToStaticMarkup(React.createElement(RosterObservation, { payload: payloads[bot], bot, now, holdings: holdings(bot) }));
const between = (html, start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));

test('the decoder admits the builder fixture as six bots in registry order', () => {
  assert.deepEqual(read.body.bots.map(row => row.bot), ['ok_rsi', 'meridian_v3', 'rsi_modular_v2', 'meridian_v4_paper', 'partial_bot', 'offline_bot']);
});

test('age rule: server ages plus local elapsed time, never the browser clock against the owner clock', () => {
  // ok_rsi: 1761436800000 - 1761436796000 = 4000 ms at receipt; 30000 ms threshold.
  assert.equal(lib.holdingsAgeMs(holdings('ok_rsi'), received), 4000);
  assert.equal(lib.holdingsFreshness(holdings('ok_rsi'), received), 'current');
  assert.equal(lib.holdingsFreshness(holdings('ok_rsi'), received + 25_999), 'current', '29999 ms old');
  assert.equal(lib.holdingsFreshness(holdings('ok_rsi'), received + 26_000), 'stale', '30000 ms old is no longer current');
  // A browser clock far from the owner clock changes nothing: only (now - received) counts.
  assert.equal(lib.holdingsAgeMs(holdings('ok_rsi'), received - 3_600_000), 4000);
  // rsi_modular_v2: the server says stale; 1761436800000 - 1761436755000 = 45000 ms.
  assert.equal(lib.holdingsAgeMs(holdings('rsi_modular_v2'), received), 45_000);
  assert.equal(lib.holdingsFreshness(holdings('rsi_modular_v2'), received), 'stale');
  assert.equal(lib.holdingsAgeMs(holdings('offline_bot'), received), null);
  assert.equal(lib.holdingsFreshness(holdings('offline_bot'), received), 'unavailable');
});

test('per-bot inventory: held counts, totals and freshness for each of the six bots', () => {
  const expected = {
    ok_rsi: { state: 'current', held: 2, registered: 3, value: { kind: 'exact', amount: '2400.5' }, paper: false },
    meridian_v3: { state: 'current', held: 2, registered: 2, value: { kind: 'exact', amount: '300.4' }, paper: false },
    rsi_modular_v2: { state: 'stale', held: 1, registered: 1, value: { kind: 'exact', amount: '2400' }, paper: false },
    meridian_v4_paper: { state: 'current', held: 1, registered: 1, value: { kind: 'exact', amount: '2400' }, paper: true },
    partial_bot: { state: 'current', held: null, registered: 2, value: { kind: 'at_least', amount: '2400' }, paper: false },
    offline_bot: { state: 'unavailable', held: null, registered: null, value: { kind: 'none', amount: null }, paper: false },
  };
  for (const [bot, want] of Object.entries(expected)) {
    const inventory = projectBotInventory(holdings(bot), received);
    assert.deepEqual({ state: inventory.state, held: inventory.heldPairCount, registered: inventory.registeredPairCount, value: inventory.value, paper: inventory.paper }, want, bot);
  }
  assert.equal(projectBotInventory(holdings('offline_bot'), received).reason, 'SOURCE_UNAVAILABLE');
  assert.equal(projectBotInventory(holdings('ok_rsi'), received + 26_000).state, 'stale', 'aged past the threshold');
});

test('fleet tiles and bot stats use the holdings counts; paper is counted apart and stale is flagged', () => {
  const input = bot => ({ bot, name: bot, status: 'running', view: null, holdings: holdings(bot), quant: null, cycles: null, execution: null, health: null });
  const stats = Object.fromEntries(Object.keys(payloads).map(bot => [bot, projectBotStats(input(bot), received)]));
  assert.deepEqual(Object.fromEntries(Object.entries(stats).map(([bot, row]) => [bot, [row.held, row.registered, row.inventoryState]])), {
    ok_rsi: [2, 3, 'current'], meridian_v3: [2, 2, 'current'], rsi_modular_v2: [1, 1, 'stale'],
    meridian_v4_paper: [1, 1, 'current'], partial_bot: [null, 2, 'current'], offline_bot: [null, null, 'unavailable'],
  });
  const tile = projectFleetTiles(Object.keys(payloads).map(input), received).find(row => row.id === 'B03');
  // Live bots with a held count: ok_rsi 2/3, meridian_v3 2/2, rsi_modular_v2 1/1 (paper and unknown counts left out).
  assert.equal(tile.value, '5 / 6');
  assert.equal(tile.state.kind, 'stale');
  assert.match(tile.basis, /1 last known/);
});

test('small grouping is the server flag: ok_rsi XRP and meridian_v3 ETH only', () => {
  const groups = bot => { const { primary, small } = partitionBotInventory(buildBotPositionView(payloads[bot], bot, received, { holdings: holdings(bot) }).pairs); return { primary: primary.map(row => row.pair), small: small.map(row => row.pair) }; };
  assert.deepEqual(groups('ok_rsi'), { primary: ['BNB-USDC', 'BTC-USDC'], small: ['XRP-USDC'] }, 'flat BTC has no units, so it is not small');
  assert.deepEqual(groups('meridian_v3'), { primary: ['BTC-USDC'], small: ['ETH-USDC'] }, 'in-flight BTC is never grouped');
  for (const bot of ['rsi_modular_v2', 'meridian_v4_paper', 'partial_bot', 'offline_bot']) assert.deepEqual(groups(bot).small, [], bot);
});

test('command desk shows each bot per the client rules', () => {
  const ok = desk('ok_rsi');
  assert.match(ok, /Held pairs <strong>2 \/ 3<\/strong>/);
  assert.match(ok, /Holdings value <strong>2,400\.5 USDC<\/strong>/);
  assert.match(ok, /Small holdings \(1\)/);
  assert.match(ok, /BNB-USDC position inspector/);
  assert.match(ok, /4 BNB/);
  assert.doesNotMatch(ok, /Inventory Last known|Inventory Unavailable/);

  const okAged = desk('ok_rsi', received + 26_000);
  assert.match(okAged, /data-state="stale">Inventory Last known · 30s old\. Values below are the last known holdings, not current\./);
  assert.match(okAged, /Holdings value <strong>2,400\.5 USDC<\/strong>/, 'stale is shown as last known, not hidden');

  const meridian = desk('meridian_v3');
  assert.match(meridian, /Held pairs <strong>2 \/ 2<\/strong>/);
  assert.match(meridian, /Holdings value <strong>300\.4 USDC<\/strong>/);
  assert.match(meridian, /Small holdings \(1\)/);
  const inspector = between(meridian, 'BTC-USDC position inspector', '</dl>');
  assert.match(inspector, /Current market value<\/dt><dd>300 USDC/);
  assert.match(inspector, /0\.003 BTC/);
  assert.match(inspector, /Tracked inventory cost<\/dt><dd>Unavailable/, 'in-flight executor inventory has no retained cost');

  const v2 = desk('rsi_modular_v2');
  assert.match(v2, /Held pairs <strong>1 \/ 1<\/strong>/);
  assert.match(v2, /data-state="stale">Inventory Last known · 45s old/);

  const paper = desk('meridian_v4_paper');
  assert.match(paper, /Held pairs <strong>1 \/ 1<\/strong>/);
  assert.match(paper, /Paper · simulated/);
  assert.doesNotMatch(desk('ok_rsi'), /Paper · simulated/);

  const partial = desk('partial_bot');
  assert.match(partial, /Held pairs <strong>—<\/strong>/, 'no held count for a partial book');
  assert.match(partial, /Holdings value <strong>≥ 2,400 USDC<\/strong>/);

  const offline = desk('offline_bot');
  assert.match(offline, /Held pairs <strong>—<\/strong>/);
  assert.match(offline, /Holdings value <strong>—<\/strong>/);
  assert.match(offline, /data-state="unavailable">Inventory Unavailable · SOURCE UNAVAILABLE\. Units, values and PnL are withheld\./);
  assert.match(between(offline, 'BTC-USDC position inspector', '</dl>'), /Current market value<\/dt><dd>Unavailable/);
  assert.doesNotMatch(offline, /0 USDC/, 'an unavailable bot is never an empty book');
});

test('roster card shows each bot per the client rules', () => {
  const value = html => between(html, 'data-panel-id="B12"', '</div>');
  const ok = roster('ok_rsi');
  assert.match(value(ok), /2,400\.50 USDC/);
  assert.match(value(ok), /2 open pairs/);
  assert.match(ok, /<li><span>Inventory<\/span><strong>Current · 4s old<\/strong><\/li>/);

  assert.match(value(roster('meridian_v3')), /300\.40 USDC/);
  assert.match(value(roster('meridian_v3')), /marked PnL 9\.05 USDC/);

  const v2 = roster('rsi_modular_v2');
  assert.match(v2, /^<div class="q-bot-card" data-state="stale">/);
  assert.match(v2, /Inventory Last known · 45s old\. Units, values and PnL below are the last known holdings\./);
  assert.match(value(v2), /2,400\.00 USDC/);

  assert.match(roster('meridian_v4_paper'), /<li><span>Inventory<\/span><strong>Current · 4s old · paper \(simulated\)<\/strong><\/li>/);

  const partial = roster('partial_bot');
  assert.match(value(partial), /≥ 2,400\.00 USDC/);
  assert.match(value(partial), /Open pair count unavailable/);
  assert.match(partial, /Current · 4s old · partial \(PAIR QUANTITY UNKNOWN\)/);

  const offline = roster('offline_bot');
  assert.match(value(offline), /<strong>—<\/strong>/);
  assert.match(value(offline), /Open pair count unavailable/);
  assert.match(offline, /Inventory Unavailable · SOURCE UNAVAILABLE\. Units, values and PnL are withheld\./);
});

test('a malformed holdings body is an error, never an empty book', () => {
  const base = { ...fixture, served_at_ms: served };
  const broken = [
    { ...base, schema: 'fleet-holdings.v2' },
    { ...base, served_at_ms: undefined },
    { ...base, bots: null },
    { ...base, bots: [{ ...fixture.bots[0], pairs: [{ ...fixture.bots[0].pairs[0], units: 4 }] }] },
    { ...base, bots: [{ ...fixture.bots[0], held_pair_count: 2, inventory_complete: false }] },
    { ...base, bots: [{ ...fixture.bots[5], pairs: [fixture.bots[0].pairs[0]] }] },
    { ...base, bots: [{ ...fixture.bots[5], reason: null }] },
    { ...base, bots: [fixture.bots[0], fixture.bots[0]] },
  ];
  for (const body of broken) assert.throws(() => lib.parseFleetHoldings(body), lib.FleetHoldingsError);
  const extra = lib.parseFleetHoldings({ ...base, future_field: 1, bots: [{ ...fixture.bots[0], future_field: 'x' }] });
  assert.equal(extra.bots[0].held_pair_count, 2, 'unknown fields are ignored');
});
