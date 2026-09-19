import test from 'node:test';
import assert from 'node:assert/strict';
import { frontendModules } from './helpers/frontend-module.mjs';

const { load } = frontendModules();
const { buildFillTrips, openTripForPair, loadBotFillTrips } = load('features/bots/fill-trips.ts');

const fill = (extra = {}) => ({
  bot_name: 'ok_rsi', source_db_id: 'db', pair: 'ETH-USDC', connector_name: 'okx',
  timestamp: '2026-09-01T00:00:00Z', economics_available: true, fee_quote: 0,
  ...extra,
});
const buy = (id, amount, price, extra = {}) => fill({
  fill_id: id, order_id: `o-${id}`, side: 'buy', exact_amount: amount, amount_base: Number(amount),
  price_quote: Number(price), gross_volume_quote: Number(amount) * Number(price), ...extra,
});
const sell = (id, amount, price, extra = {}) => fill({
  fill_id: id, order_id: `o-${id}`, side: 'sell', exact_amount: amount, amount_base: Number(amount),
  price_quote: Number(price), gross_volume_quote: Number(amount) * Number(price), timestamp: '2026-09-01T01:00:00Z',
  ...extra,
});

test('filled buy then sell reports realized trip PnL', () => {
  const trips = buildFillTrips({ fills: [buy('b1', '1', 100), sell('s1', '1', 110)], orders: [], executors: [] });
  assert.equal(trips.length, 1);
  assert.equal(trips[0].outcome, 'filled');
  assert.equal(trips[0].realizedPnlQuote, 10);
  assert.equal(trips[0].remainingBase, '0');
  assert.equal(trips[0].buyAmountBase, '1');
  assert.equal(trips[0].sellAmountBase, '1');
  assert.equal(trips[0].fills[1].realizedPnlQuote, 10);
});

test('partial inventory stays in the bag with realized PnL only on the sold slice', () => {
  const trips = buildFillTrips({
    fills: [buy('b1', '1', 100), sell('s1', '0.3', 110)],
    orders: [], executors: [],
  });
  assert.equal(trips[0].outcome, 'in_bag');
  assert.equal(trips[0].remainingBase, '0.7');
  assert.equal(trips[0].realizedPnlQuote, 3);
  assert.equal(trips[0].remainingCostQuote, 70);
  assert.equal(trips[0].closedAt, null);
});

test('partial closes that flatten inventory are one filled trip', () => {
  const trips = buildFillTrips({
    fills: [
      buy('b1', '0.3', 100, { timestamp: '2026-09-01T00:00:00Z' }),
      sell('s1', '0.1', 110, { timestamp: '2026-09-01T01:00:00Z' }),
      sell('s2', '0.2', 110, { timestamp: '2026-09-01T02:00:00Z' }),
    ],
    orders: [], executors: [],
  });
  assert.equal(trips.length, 1);
  assert.equal(trips[0].outcome, 'filled');
  assert.equal(trips[0].realizedPnlQuote, 3);
});

test('sell without recorded buy marks unknown cost and omits PnL', () => {
  const trips = buildFillTrips({ fills: [sell('s1', '1', 110)], orders: [], executors: [] });
  assert.equal(trips[0].outcome, 'unknown_cost');
  assert.equal(trips[0].realizedPnlQuote, null);
  assert.equal(trips[0].pnlUnavailableReason, 'missing_entry_basis');
});

test('legacy unverified receipts cannot invent trip PnL', () => {
  const trips = buildFillTrips({
    fills: [buy('b1', '1', 100, { economics_available: false, economics_unavailable_reason: 'legacy_receipt_unverified' }), sell('s1', '1', 110)],
    orders: [], executors: [],
  });
  assert.equal(trips.length, 1);
  assert.equal(trips[0].outcome, 'unknown_cost');
  assert.equal(trips[0].realizedPnlQuote, null);
  assert.equal(trips[0].pnlUnavailableReason, 'legacy_receipt_unverified');
  assert.equal(trips[0].buyAmountBase, '1');
  assert.equal(trips[0].sellAmountBase, '1');
});

test('unverified receipt keeps later same-source PnL unavailable without an authoritative reset', () => {
  const trips = buildFillTrips({
    fills: [
      buy('legacy', '1', 100, { economics_available: false, economics_unavailable_reason: 'legacy_receipt_unverified', timestamp: '2026-09-01T00:00:00Z' }),
      buy('b2', '1', 100, { timestamp: '2026-09-02T00:00:00Z', fill_id: 'b2', order_id: 'o-b2' }),
      sell('s1', '1', 110, { timestamp: '2026-09-02T01:00:00Z' }),
    ],
    orders: [], executors: [],
  });
  assert.equal(trips.length, 1);
  assert.equal(trips[0].outcome, 'unknown_cost');
  assert.equal(trips[0].realizedPnlQuote, null);
  assert.equal(trips[0].pnlUnavailableReason, 'legacy_receipt_unverified');
  assert.equal(trips[0].buyAmountBase, '2');
  assert.equal(trips[0].sellAmountBase, '1');
  assert.equal(trips.some(trip => trip.outcome === 'filled'), false);
});

test('unverified fill inside an open trip invalidates earlier and later leg PnL', () => {
  const trips = buildFillTrips({
    fills: [
      buy('b1', '1', 100, { timestamp: '2026-09-01T00:00:00Z' }),
      sell('legacy-sell', '0.25', 105, {
        economics_available: false,
        economics_unavailable_reason: 'legacy_receipt_unverified',
        timestamp: '2026-09-01T01:00:00Z',
      }),
      sell('s2', '0.75', 110, { timestamp: '2026-09-01T02:00:00Z' }),
    ],
    orders: [], executors: [],
  });
  assert.equal(trips.length, 1);
  assert.equal(trips[0].outcome, 'unknown_cost');
  assert.equal(trips[0].realizedPnlQuote, null);
  assert.equal(trips[0].pnlUnavailableReason, 'legacy_receipt_unverified');
  assert.equal(trips[0].buyAmountBase, '1');
  assert.equal(trips[0].sellAmountBase, '1');
  assert.deepEqual(trips[0].fills.map(item => item.realizedPnlQuote), [null, null, null]);
});

test('wallet sales without buys coalesce as one unknown-cost trip', () => {
  const trips = buildFillTrips({
    fills: [
      sell('s1', '20', 0.70, { pair: 'SUI-USDC', timestamp: '2026-09-12T20:42:00Z' }),
      sell('s2', '18', 0.71, { pair: 'SUI-USDC', timestamp: '2026-09-13T12:27:00Z' }),
    ],
    orders: [],
    executors: [{ source_db_id: 'db', pair: 'SUI-USDC', close_type: 10, pnl_unavailable_reason: 'unknown_wallet_acquisition_cost' }],
  });
  assert.equal(trips.length, 1);
  assert.equal(trips[0].outcome, 'unknown_cost');
  assert.equal(trips[0].sellAmountBase, '38');
  assert.equal(trips[0].realizedPnlQuote, null);
  assert.equal(trips[0].pnlUnavailableReason, 'unknown_wallet_acquisition_cost');
});

test('entry basis is not borrowed across databases', () => {
  const trips = buildFillTrips({
    fills: [buy('b1', '1', 100, { source_db_id: 'buy-db' }), sell('s1', '1', 110, { source_db_id: 'sell-db' })],
    orders: [], executors: [],
  });
  assert.equal(trips.length, 2);
  assert.equal(trips.find(trip => trip.sourceDbId === 'buy-db').outcome, 'in_bag');
  assert.equal(trips.find(trip => trip.sourceDbId === 'sell-db').outcome, 'unknown_cost');
  assert.equal(trips.find(trip => trip.sourceDbId === 'sell-db').realizedPnlQuote, null);
});

test('wallet-sale executor reason keeps SUI-style sales without guessed PnL', () => {
  const trips = buildFillTrips({
    fills: [sell('s1', '20.975', 0.7041, { pair: 'SUI-USDC' })],
    orders: [],
    executors: [{ source_db_id: 'db', pair: 'SUI-USDC', close_type: 10, pnl_unavailable_reason: 'unknown_wallet_acquisition_cost' }],
  });
  assert.equal(trips[0].outcome, 'unknown_cost');
  assert.equal(trips[0].realizedPnlQuote, null);
  assert.equal(trips[0].pnlUnavailableReason, 'unknown_wallet_acquisition_cost');
});

test('futures pairs are omitted from spot trips', () => {
  const trips = buildFillTrips({
    fills: [buy('b1', '1', 100, { pair: 'ETH-USDT-PERP', connector_name: 'okx_perpetual' }), sell('s1', '1', 110, { pair: 'ETH-USDT-PERP', connector_name: 'okx_perpetual' })],
    orders: [], executors: [],
  });
  assert.deepEqual(trips, []);
});

test('unfilled canceled orders are cancelled trips without PnL', () => {
  const trips = buildFillTrips({
    fills: [buy('b1', '1', 100)],
    orders: [{ source_db_id: 'db', pair: 'ETH-USDC', order_id: 'cancel-1', normalized_status: 'canceled', timestamp: '2026-09-01T03:00:00Z' }],
    executors: [],
  });
  assert.equal(trips.find(trip => trip.outcome === 'cancelled').realizedPnlQuote, null);
  assert.equal(trips.find(trip => trip.outcome === 'in_bag').remainingBase, '1');
});

test('retained POSITION_HOLD inventory is hold, not realized', () => {
  const trips = buildFillTrips({
    fills: [buy('b1', '1', 100)],
    orders: [],
    executors: [{ source_db_id: 'db', pair: 'ETH-USDC', close_type: 10 }],
  });
  assert.equal(trips[0].outcome, 'hold');
  assert.equal(trips[0].realizedPnlQuote, 0);
  assert.equal(trips[0].remainingBase, '1');
});

test('openTripForPair returns the current bag, not a completed cycle', () => {
  const trips = buildFillTrips({
    fills: [
      buy('b1', '1', 100, { timestamp: '2026-09-01T00:00:00Z' }),
      sell('s1', '1', 110, { timestamp: '2026-09-01T01:00:00Z' }),
      buy('b2', '2', 90, { timestamp: '2026-09-02T00:00:00Z', fill_id: 'b2', order_id: 'o-b2' }),
    ],
    orders: [], executors: [],
  });
  assert.equal(trips.length, 2);
  const open = openTripForPair(trips, 'ETH-USDC');
  assert.equal(open.outcome, 'in_bag');
  assert.equal(open.remainingBase, '2');
});

test('oversell invalidates the remaining projected basis instead of preserving a stale bag', () => {
  const trips = buildFillTrips({
    fills: [
      buy('b1', '1', 100, { timestamp: '2026-09-01T00:00:00Z' }),
      sell('s1', '0.999', 110, { timestamp: '2026-09-01T01:00:00Z' }),
      sell('s2', '1', 110, { timestamp: '2026-09-01T02:00:00Z' }),
    ],
    orders: [], executors: [],
  });
  const open = openTripForPair(trips, 'ETH-USDC');
  assert.equal(open.outcome, 'unknown_cost');
  assert.equal(open.realizedPnlQuote, null);
  assert.equal(trips.find(trip => trip.outcome === 'unknown_cost').realizedPnlQuote, null);
});

test('loadBotFillTrips rejects a source that changes mid-read', async () => {
  const healthy = { health: { active_db_count: 1, db_errors: 0 }, data_health: { sources: [{ bot_name: 'ok_rsi', source_db_id: 'db', db_status: 'ok', warning_count: 0 }] } };
  let boots = 0;
  const read = async path => path.includes('/bootstrap?') ? (++boots === 1 ? healthy : { ...healthy, health: { active_db_count: 1, db_errors: 1 } }) : { rows: [] };
  await assert.rejects(loadBotFillTrips('ok_rsi', read, new AbortController().signal), /unavailable|changed/);
});
