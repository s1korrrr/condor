import test from 'node:test';
import assert from 'node:assert/strict';
import { frontendModules } from './helpers/frontend-module.mjs';

const { load } = frontendModules();
const { projectFleetTiles, projectBotStats, tileNote, durationLabel, fillTotals } = load('features/bots/fleet-tiles.ts');
const { projectFleetHealth, stackRestarts } = load('features/bots/fleet-health.ts');
const now = Date.parse('2026-10-01T12:00:00Z');
const ago = seconds => new Date(now - seconds * 1000).toISOString();

const funnel = (created, filled, canceled = 0, rejected = 0) => [{ stage: 'orders_created', count: created }, { stage: 'orders_filled', count: filled }, { stage: 'orders_canceled', count: canceled }, { stage: 'orders_rejected', count: rejected }];
const cycle = (over = {}) => ({ cycleId: 'c', pair: 'BTC-USDC', controllerId: 'btc', side: 'buy', outcome: 'closed_scored', result: 'win', openedAt: ago(7200), firstFillAt: ago(7000), closedAt: ago(3600), holdingSeconds: 3400, netPnl: '1', fees: '0.1', grossVolume: '100', fillCount: 2, closeType: null, closeReason: null, ...over });
const health = (restart = 0, bootId = 'fa3b7a25-4557', state = 'healthy') => ({ state: 'healthy', mode: 'running', generatedAt: ago(2), freshness: 'current', heartbeat: { state, bootId, lifecycleState: 'running', sequence: 12 }, services: [{ id: 'api', state: 'healthy', detail: '', restartCount: restart, startedAt: ago(9000), observedAt: ago(2) }, { id: 'exec', state: 'healthy', detail: '', restartCount: 0, startedAt: ago(9000), observedAt: ago(2) }], expected: ['api', 'exec'] });

function bot(name, over = {}) {
  return {
    bot: name, name: name.toUpperCase(), status: 'running',
    view: { pairs: [{ quantity: '1' }, { quantity: '0' }, { quantity: '2' }], orders: [{}, {}], ordersStatus: { complete: true }, activeOrderCount: 2, activeExecutorCount: 3, stale: false, ageSeconds: 1, observedAt: ago(1) },
    quant: { freshness: 'current', observedAt: ago(4), pairs: [{ units: '1', workingOrders: 1 }], cycleCounts: { open: 9 } },
    cycles: { quote: 'USDC', counts: { open: 2, closed_scored: 6, entry_pending: 1, entry_unfilled: 2 },
      cycles: [cycle(), cycle({ cycleId: 'old', firstFillAt: ago(100000), openedAt: ago(100100), closedAt: ago(95000), fillCount: 3 }), cycle({ cycleId: 'open', closedAt: null, outcome: 'open', fillCount: 1 })],
      stats: { scored: 6, minSample: 5, wins: 4, losses: 2, breakeven: 0, winRate: 4 / 6, averageHoldingSeconds: 3600, fees: '1.5', grossVolume: '1000', fillCount: 20 },
      inventoryAge: { availability: 'available', oldestSeconds: 86400 * 2, lots: [{ ageSeconds: 86400 * 2 }, { ageSeconds: 3600 }] } },
    execution: { fillRatio: 0.75, makerCount: 5, takerCount: 1, orderSampleSufficient: true, funnel: funnel(8, 6, 2, 0) },
    health: health(), ...over,
  };
}
const byId = tiles => Object.fromEntries(tiles.map(tile => [tile.id, tile]));
const noUnavailable = tiles => { for (const tile of tiles) { assert.doesNotMatch(`${tile.title} ${tile.value} ${tile.basis}`, /unavailable/i, tile.id); assert.notEqual(tile.value, ''); } };

test('one bot: every counter is computed from its own reads and no tile says Unavailable', () => {
  const tiles = byId(projectFleetTiles([bot('rsi')], now));
  noUnavailable(Object.values(tiles));
  assert.equal(tiles.B01.value, '1 / 1');
  assert.equal(tiles.B26.value, '3', 'runtime active executors win over lifecycle cycles');
  assert.equal(tiles.B03.value, '2 / 3', 'pairs holding units over registered pairs');
  assert.equal(tiles.B27.value, '2');
  assert.equal(tiles['B03-entries'].value, '1');
  assert.match(tiles['B03-entries'].basis, /2 entries ended unfilled/);
  assert.equal(tiles.B05.value, '20');
  assert.match(tiles.B05.basis, /24h 2 opened \/ 1 closed/, 'cycles older than 24h are excluded; an open cycle has no close');
  assert.equal(tiles.B36.value, '66.7%');
  assert.equal(tiles['B36-hold'].value, '1.0h');
  assert.equal(tiles.B39.value, '2.0d');
  assert.equal(tiles.B37.value, '75.0%');
  assert.match(tiles.B37.basis, /6\/8 orders filled · 2 canceled · 0 rejected · maker 5 \/ taker 1/);
  assert.equal(tiles.B38.value, '1.50');
  assert.match(tiles.B38.basis, /15\.0 bps of 1,?000 traded/);
  assert.equal(tiles['B01-heartbeat'].value, '4s');
  assert.equal(tiles['B38-restarts'].value, '0');
  assert.deepEqual(tiles.B26.perBot.length, 1);
  assert.equal(tileNote(tiles.B26), tiles.B26.basis, 'a single bot has no per-bot footnote');
});

test('two bots: counters add, ratios pool by counts, per-bot values stay in the footnote', () => {
  const second = bot('meridian', {
    view: { pairs: [{ quantity: '0' }, { quantity: '0.5' }], orders: [{}], ordersStatus: { complete: true }, activeOrderCount: 1, activeExecutorCount: 1, stale: false, ageSeconds: 1, observedAt: ago(1) },
    cycles: { quote: 'USDC', counts: { open: 1, entry_pending: 0, entry_unfilled: 1 }, cycles: [], stats: { scored: 2, minSample: 5, wins: 1, losses: 1, breakeven: 0, winRate: 0.5, averageHoldingSeconds: 7200, fees: '0.5', grossVolume: '500', fillCount: 4 }, inventoryAge: { availability: 'available', oldestSeconds: 7200, lots: [{ ageSeconds: 7200 }] } },
    execution: { fillRatio: 0.5, makerCount: 0, takerCount: 2, orderSampleSufficient: false, funnel: funnel(2, 1, 1) },
    quant: { freshness: 'current', observedAt: ago(9), pairs: [], cycleCounts: { open: 1 } },
    health: health(2, 'bbbbbbbb-1111'),
  });
  const tiles = byId(projectFleetTiles([bot('rsi'), second], now));
  noUnavailable(Object.values(tiles));
  assert.equal(tiles.B01.value, '2 / 2');
  assert.equal(tiles.B26.value, '4');
  assert.equal(tiles.B03.value, '3 / 5');
  assert.equal(tiles.B27.value, '3');
  assert.equal(tiles.B05.value, '24');
  assert.equal(tiles.B36.value, '62.5%', 'pooled 5 wins of 8 scored cycles is above the 5 minimum, so a rate');
  assert.equal(tiles.B37.value, '70.0%', '7 filled of 10 created, pooled by order counts and not the mean of 75% and 50%');
  assert.equal(tiles.B37.state.kind, 'collecting', 'one bot is below the order sample minimum');
  assert.equal(tiles.B38.value, '2.00', 'fees pooled in one quote');
  assert.match(tiles.B38.basis, /13\.3 bps/);
  assert.equal(tiles.B39.value, '2.0d', 'oldest lot is the maximum across bots');
  assert.equal(tiles['B01-heartbeat'].value, '9s', 'the oldest owner heartbeat leads');
  assert.equal(tiles['B38-restarts'].value, '2', 'the shared api service counts once, at its highest restart count');
  assert.match(tileNote(tiles.B26), /RSI 3 · MERIDIAN 1$/);
  assert.equal(tiles.B26.perBot.map(row => row.text).join(','), '3,1');
});

test('three bots, one with a failed read: it still counts as registered and the tiles say how many bots they cover', () => {
  const failed = { bot: 'ok_rsi', name: 'ok_rsi', status: 'running', view: null, quant: null, cycles: null, execution: null, health: null };
  const tiles = byId(projectFleetTiles([bot('rsi'), bot('meridian'), failed], now));
  noUnavailable(Object.values(tiles));
  assert.equal(tiles.B01.value, '3 / 3');
  assert.equal(tiles.B01.state.kind, 'incomplete', 'an unread heartbeat is missing coverage, not an observed stale heartbeat');
  assert.match(tiles.B01.state.reason, /not read for 1 bot/);
  assert.equal(tiles.B26.value, '6', 'only the two read bots contribute');
  assert.equal(tiles.B26.state.kind, 'incomplete');
  assert.match(tiles.B26.state.reason, /2 of 3 bots/);
  assert.equal(tiles.B03.value, '4 / 6');
  assert.equal(tiles.B26.perBot.length, 2, 'the failed bot is absent from the per-bot footnote instead of showing a placeholder');
});

test('a tile with no source in any bot is dropped rather than printed as Unavailable', () => {
  const bare = name => ({ bot: name, name, status: 'stopped', view: null, quant: null, cycles: null, execution: null, health: null });
  const tiles = projectFleetTiles([bare('a'), bare('b')], now);
  assert.deepEqual(tiles.map(tile => tile.id), ['B01']);
  assert.equal(tiles[0].value, '0 / 2');
  assert.deepEqual(projectFleetTiles([], now), [], 'no registered bot means no tiles');
  const unknown = projectFleetTiles([{ ...bare('a'), status: null }], now)[0];
  assert.equal(unknown.value, '0 verified / 1', 'an unknown lifecycle is labelled, never a bare zero');
});

test('fees from different quote currencies are shown side by side, never added', () => {
  const eur = bot('eur', { cycles: { ...bot('x').cycles, quote: 'EUR', stats: { ...bot('x').cycles.stats, fees: '2', grossVolume: '100' } } });
  const tile = byId(projectFleetTiles([bot('usd'), eur], now)).B38;
  assert.equal(tile.value, '1.50 USDC + 2.00 EUR');
  assert.doesNotMatch(tile.basis, /bps/, 'no cross-currency fee rate');
});

test('win rate waits for the owner minimum sample and says so', () => {
  const few = bot('few', { cycles: { ...bot('x').cycles, stats: { ...bot('x').cycles.stats, scored: 3, wins: 2, losses: 1, minSample: 10 } } });
  const tile = byId(projectFleetTiles([few], now)).B36;
  assert.equal(tile.value, '2W / 1L');
  assert.equal(tile.state.kind, 'collecting');
  assert.deepEqual(tile.state.sample, { have: 3, need: 10 });
});

test('executors fall back to lifecycle cycles, then to the quant summary, and the basis says which', () => {
  const noRuntime = bot('a', { view: null });
  assert.equal(projectBotStats(noRuntime, now).executors, 2);
  assert.equal(projectBotStats(noRuntime, now).executorsBasis, 'lifecycle');
  const onlyQuant = bot('b', { view: null, cycles: null });
  assert.equal(projectBotStats(onlyQuant, now).executors, 9);
  assert.match(byId(projectFleetTiles([noRuntime], now)).B26.basis, /lifecycle/);
});

test('operations health: only the requested bot, a stamped generation, and restarts count each service once', () => {
  const payload = bot => ({ schema_version: 1, bot_name: bot, health: { schema_version: 1, generated_at: ago(1), state: 'healthy', heartbeat: { state: 'healthy', boot_id: 'x', sequence: 3 }, services: [{ id: 'api', state: 'healthy', restart_count: 2 }, { id: 'api2', state: 'healthy', restart_count: null }], expected_services: ['api'] } });
  assert.equal(projectFleetHealth(payload('rsi'), 'ok_rsi', now), null, 'another bot is never presented');
  assert.equal(projectFleetHealth({ ...payload('rsi'), health: { ...payload('rsi').health, generated_at: new Date(now + 60_000).toISOString() } }, 'rsi', now), null, 'a future generation is rejected');
  const one = projectFleetHealth(payload('rsi'), 'rsi', now), two = projectFleetHealth(payload('meridian'), 'meridian', now);
  assert.deepEqual(stackRestarts([one, two, null]), { services: 2, restarts: 2, restarted: 1 });
  assert.equal(stackRestarts([null]), null, 'no operations read means no restart tile');
});

test('durations are compact and never negative', () => {
  assert.deepEqual([4, 125, 7200, 172800].map(durationLabel), ['4s', '2m', '2.0h', '2.0d']);
  assert.equal(durationLabel(-1), '—');
  assert.equal(durationLabel(null), '—');
});

test('a bot without scored cycles still counts its recorded fills, fees and volume', () => {
  const rows = [
    { fee: '0.05', volume: '50', pair: 'ETH-USDC', timestamp: ago(3000) },
    { fee: '0.07', volume: '70', pair: 'BTC-USDC', timestamp: ago(9000) },
  ];
  const totals = fillTotals(rows);
  assert.deepEqual({ count: totals.count, quote: totals.quote }, { count: 2, quote: 'USDC' });
  assert.ok(Math.abs(totals.fees - 0.12) < 1e-9 && totals.volume === 120);
  assert.equal(fillTotals([]), null);
  assert.equal(fillTotals([{ ...rows[0], fee: null }, rows[1]]).fees, null, 'a partial ledger is never presented as complete');
  const legacy = projectBotStats(bot('v1', { cycles: null, execution: null, quant: null, fillTotals: totals }), now);
  assert.equal(legacy.fills, 2);
  assert.equal(legacy.quote, 'USDC');
  assert.ok(Math.abs(legacy.fees - 0.12) < 1e-9);
  const tiles = byId(projectFleetTiles([bot('v2'), bot('v1', { cycles: null, execution: null, quant: null, fillTotals: totals })], now));
  assert.equal(tiles.B05.value, '22', 'V2 fills (20) plus the legacy bot ledger (2)');
  noUnavailable(Object.values(tiles));
});

// Live shapes 2026-10-05: the owner withholds lifetime fees for V3 (`quote_currency: unknown`) and V1 (13 legacy 6dp
// receipts), while every fill in each ledger carries a fee. The server fleet summary already falls back to the ledger.
const ledgerRow = (fee, volume, exact = true) => ({ fee, volume, pair: 'ETH-USDC', timestamp: ago(600), feeExact: exact });
const v3Cycles = over => ({ ...bot('x').cycles, quote: 'unknown', stats: { ...bot('x').cycles.stats, fees: null, grossVolume: null, fillCount: 2 }, ...over });

test('fees stay the same when the owner cycles land after the fill ledger: a withheld owner total falls back to the ledger', () => {
  const ledger = fillTotals([ledgerRow('0.6', '700'), ledgerRow('0.5923', '705')], 500);
  const loading = projectBotStats(bot('v3', { cycles: null, fillTotals: ledger }), now);
  const loaded = projectBotStats(bot('v3', { cycles: v3Cycles(), fillTotals: ledger }), now);
  assert.ok(Math.abs(loading.fees - 1.1923) < 1e-9);
  assert.equal(loaded.fees, loading.fees, 'a null owner aggregate must not erase a value the ledger proves');
  assert.equal(loaded.volume, 1405, 'volume follows the fee source so the bps rate is one cohort');
  assert.equal(loaded.quote, 'USDC', "'unknown' is not a currency; the ledger pairs supply it");
  const tile = byId(projectFleetTiles([bot('v2'), bot('v3', { cycles: v3Cycles(), fillTotals: ledger })], now)).B38;
  assert.equal(tile.state.kind, 'fresh', 'both bots have fee receipts');
  assert.equal(tile.unit, 'USDC', 'one quote, not a blank group beside USDC');
  assert.match(tile.perBot.find(row => row.bot === 'v3').text, /fill ledger/);
});

test('owner fees win when published; a saturated ledger or an unpriced fee row never stands in for a lifetime total', () => {
  const ledger = fillTotals([ledgerRow('9', '900')], 500);
  assert.equal(projectBotStats(bot('v2', { fillTotals: ledger }), now).fees, 1.5, 'owner aggregate precedes the ledger');
  const saturated = fillTotals([ledgerRow('0.1', '10'), ledgerRow('0.1', '10')], 2);
  assert.equal(saturated.saturated, true);
  assert.equal(projectBotStats(bot('v3', { cycles: v3Cycles(), fillTotals: saturated }), now).fees, null, 'a page-limited ledger is a lower bound');
  assert.equal(projectBotStats(bot('v3', { cycles: null, fillTotals: saturated }), now).fills, null, 'nor is its row count a lifetime fill count');
  const partial = fillTotals([ledgerRow(null, '10'), ledgerRow('0.1', '10')], 500);
  assert.equal(projectBotStats(bot('v3', { cycles: v3Cycles(), fillTotals: partial }), now).fees, null);
});

test('legacy rounded fee receipts are counted and named, not presented as exact', () => {
  const ledger = fillTotals([ledgerRow('0.006228', '7', false), ledgerRow('0.0908', '100')], 500);
  assert.equal(ledger.inexactFees, 1);
  const tile = byId(projectFleetTiles([bot('v1', { cycles: { ...bot('x').cycles, stats: { ...bot('x').cycles.stats, fees: null } }, fillTotals: ledger })], now)).B38;
  assert.match(tile.basis, /1 legacy rounded fee receipt/);
});

test('an unadmitted owner summary is not an empty inventory', () => {
  const unadmitted = bot('v3', { view: null, quant: { freshness: 'current', admitted: false, observedAt: ago(4), pairs: [], cycleCounts: { open: null } } });
  const stats = projectBotStats(unadmitted, now);
  assert.equal(stats.held, null, 'zero of zero pairs is not a read');
  const tile = byId(projectFleetTiles([bot('v1'), bot('v2'), unadmitted], now)).B03;
  assert.equal(tile.value, '4 / 6');
  assert.equal(tile.state.kind, 'incomplete');
  assert.match(tile.state.reason, /2 of 3 bots/);
  const admittedEmpty = bot('v4', { view: null, quant: { freshness: 'current', admitted: true, observedAt: ago(4), pairs: [{ units: '0', workingOrders: 0 }], cycleCounts: { open: 0 } } });
  assert.equal(projectBotStats(admittedEmpty, now).held, 0, 'an admitted flat owner is a real zero');
});

test('a heartbeat that has not been read yet is collecting, not stale; a read old heartbeat is stale', () => {
  const pending = { bot: 'v3', name: 'V3', status: 'running', view: null, quant: null, cycles: null, execution: null, health: null };
  const first = byId(projectFleetTiles([bot('v1'), pending], now));
  assert.notEqual(first.B01.state.kind, 'stale', 'first paint before the owner reads land must not flag a stale bot');
  assert.equal(first.B01.state.kind, 'incomplete');
  assert.match(first.B01.state.reason, /not read for 1 bot/);
  assert.notEqual(first['B01-heartbeat'].state.kind, 'stale');
  const old = bot('v3', { quant: { ...bot('x').quant, freshness: 'stale', observedAt: ago(120) } });
  const later = byId(projectFleetTiles([bot('v1'), old], now));
  assert.equal(later.B01.state.kind, 'stale');
  assert.equal(later['B01-heartbeat'].state.kind, 'stale');
});

test('maker/taker keeps the owner unclassified bucket instead of printing 0/0', () => {
  const plainLimit = bot('v3', { execution: { ...bot('x').execution, makerCount: 0, takerCount: 0, liquidityUnclassifiedCount: 43 } });
  const stats = projectBotStats(plainLimit, now);
  assert.equal(stats.liquidityUnclassified, 43);
  const tile = byId(projectFleetTiles([bot('v1'), plainLimit], now)).B37;
  assert.match(tile.basis, /maker 5 \/ taker 1 · 43 unclassified/);
});
