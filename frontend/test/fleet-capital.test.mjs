import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { frontendModules } from './helpers/frontend-module.mjs';

const { load } = frontendModules();
const capital = load(fileURLToPath(new URL('../../../dashboard/condor-workspace/src/features/overview/fleet-capital.ts', import.meta.url)));
const perf = load('features/quant-ops/fleet-performance.ts');

const NOW = Date.parse('2026-10-01T12:00:00Z');
const stats = (over = {}) => ({ scored: 4, minSample: 10, sufficient: false, wins: 3, losses: 1, breakeven: 0, winRate: 0.75, profitFactor: '3', profitFactorReason: null, expectancy: null, averageWin: '2', averageLoss: '-2', payoffRatio: null, averageHoldingSeconds: null, fees: '1.5', grossVolume: '300', fillCount: 8, ...over });
const cycles = (over = {}, quote = 'USDC', lots = 1) => ({ quote, counts: {}, cycles: [], stats: stats(over), inventoryAge: { availability: 'available', reason: null, oldestAt: null, oldestSeconds: 3600 * lots, weightedSeconds: null, lots: Array.from({ length: lots }, (_, i) => ({ executorId: `e${i}`, pair: 'BTC-USDC', acquiredAt: null, basis: null, ageSeconds: 10, value: '5' })) } });
const window = (over = {}) => ({ from: NOW - 86_400_000, to: NOW, quote: 'USDC', total: 5, realized: 4, unrealized: 1, bots: [{ bot: 'a', stale: false, full: true, firstAt: NOW - 86_400_000, lastAt: NOW }], counted: 1, expected: 1, missing: [], since: NOW - 86_400_000, partial: false, fullBots: 1, latestAt: NOW, ...over });

test('fleet cycles add each bot owner sums, so profit factor and win rate are fleet-wide, not averaged ratios', () => {
  const a = cycles({ scored: 4, wins: 3, losses: 1, averageWin: '2', averageLoss: '-2', fees: '1.5', grossVolume: '300', fillCount: 8 });
  const b = cycles({ scored: 2, wins: 0, losses: 2, averageWin: null, averageLoss: '-1', fees: '0.5', grossVolume: '100', fillCount: 4 }, 'USDC', 2);
  const result = capital.fleetCycles([{ bot: 'a', cycles: a }, { bot: 'b', cycles: b }, { bot: 'c', cycles: null }]);
  assert.equal(result.scored, 6);
  assert.equal(result.wins, 3);
  assert.equal(result.winRate, 0.5);
  assert.equal(result.grossWin, 6);
  assert.equal(result.grossLoss, 4);
  assert.equal(result.profitFactor, 1.5);
  assert.equal(result.fees, 2);
  assert.equal(result.grossVolume, 400);
  assert.equal(result.fillCount, 12);
  assert.equal(result.openLots, 3);
  assert.equal(result.bots, 2);
  assert.equal(result.of, 3);
});

test('fleet cycles ignore a bot quoted in another currency and report no profit factor without a loss', () => {
  const a = cycles({ losses: 0, wins: 4, averageLoss: null });
  const usdt = cycles({}, 'USDT');
  const result = capital.fleetCycles([{ bot: 'a', cycles: a }, { bot: 'b', cycles: usdt }, { bot: 'c', cycles: cycles({}, 'USDC') }]);
  assert.equal(result.quote, 'USDC');
  assert.equal(result.bots, 2);
  assert.equal(capital.fleetCycles([{ bot: 'a', cycles: cycles({ losses: 0, wins: 4, averageLoss: null }) }]).profitFactor, null);
  assert.equal(capital.fleetCycles([{ bot: 'a', cycles: null }]), null);
});

const metric = (value, unit, lastKnown = null) => ({ value, unit, availability: 'available', freshness: 'fresh', observedAt: null, feeBasis: null, metricScope: null, calculationVersion: null, reason: null, lastKnown });

test('allocation converts another unit only with the wallet mark of that asset and adds the unallocated remainder', () => {
  const result = capital.fleetAllocation({
    owned: [{ bot: 'v2', metric: metric('1000', 'USDC') }, { bot: 'v3', metric: metric('500', 'USDT') }, { bot: 'v1', metric: null }],
    wallet: 5000, unit: 'USDT', marks: [{ token: 'USDC', price: 0.999 }, { token: 'BTC', price: 70000 }],
  });
  assert.deepEqual(result.rows.map(row => [row.label, Math.round(row.value * 1000) / 1000]), [['v2', 999], ['v3', 500]]);
  assert.equal(result.unit, 'USDT');
  assert.equal(Math.round(result.remainder * 1000) / 1000, 3501);
  assert.match(result.basis[0], /USDC valued in USDT at the wallet's USDC mark 0\.9990/);
  assert.equal(result.exceedsWallet, false);
});

test('allocation without a conversion mark keeps its own unit and computes no remainder', () => {
  const result = capital.fleetAllocation({ owned: [{ bot: 'v2', metric: metric('1000', 'USDC') }], wallet: 5000, unit: 'USDT', marks: [] });
  assert.equal(result.remainder, null);
  assert.equal(result.unit, 'USDC');
  assert.match(result.basis.join(' '), /No wallet mark converts them/);
});

test('allocation flags owned value above the wallet, uses last-known values as stale and skips invalid ones', () => {
  const over = capital.fleetAllocation({ owned: [{ bot: 'v2', metric: metric('6000', 'USDT') }], wallet: 5000, unit: 'USDT', marks: [] });
  assert.equal(over.exceedsWallet, true);
  assert.equal(over.remainder, 0);
  const stale = capital.fleetAllocation({ owned: [{ bot: 'v2', metric: metric(null, 'USDT', '300') }, { bot: 'v3', metric: metric('-5', 'USDT') }], wallet: 5000, unit: 'USDT', marks: [] });
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.rows.map(row => row.label), ['v2']);
  assert.equal(capital.fleetAllocation({ owned: [{ bot: 'v2', metric: metric(null, 'USDT') }], wallet: 5000, unit: 'USDT', marks: [] }), null);
});

test('net now prefers the live controller report, falls back to a recent saved sample and names missing bots', () => {
  const live = { total: 5, realized: 4, unrealized: 1, quote: 'USDC', reason: null };
  const result = capital.fleetNow([
    { bot: 'v2', controller: live, latest: null },
    { bot: 'v3', controller: { total: null, realized: null, unrealized: null, quote: null, reason: 'expired' }, latest: { total: 2, realized: 1, unrealized: 1, time: NOW - 60_000, quote: 'USDC' } },
    { bot: 'v1', controller: { total: null, realized: null, unrealized: null, quote: null, reason: 'Native controller performance is missing' }, latest: { total: 9, realized: 9, unrealized: 0, time: NOW - 3_600_000, quote: 'USDC' } },
  ], NOW);
  assert.equal(result.total, 7);
  assert.equal(result.realized, 5);
  assert.equal(result.counted, 2);
  assert.equal(result.expected, 3);
  assert.deepEqual(result.fromHistory, ['v3']);
  assert.deepEqual(result.missing.map(item => item.bot), ['v1']);
  assert.match(result.missing[0].reason, /missing/);
  assert.equal(capital.fleetNow([{ bot: 'v1', controller: null, latest: null }], NOW), null);
});

test('net now does not sum a bot quoted in another currency', () => {
  const row = (bot, total, quote) => ({ bot, controller: { total, realized: total, unrealized: 0, quote, reason: null }, latest: null });
  const result = capital.fleetNow([row('a', 1, 'USDC'), row('b', 2, 'USDC'), row('c', 40, 'USDT')], NOW);
  assert.equal(result.total, 3);
  assert.match(result.missing[0].reason, /Quote USDT differs from USDC/);
});

test('strategy rows give every bot a row, split the fleet total and share owned value only in the wallet unit', () => {
  const rows = capital.strategyRows([
    { bot: 'v2', window: { bot: 'v2', quote: 'USDC', change: 6, realized: 5, unrealized: 1, firstAt: NOW - 86_400_000, lastAt: NOW, samples: 40, restarts: 0, full: true, stale: false }, controller: { total: 7, quote: 'USDC' }, latest: null, cycles: cycles(), owned: { value: 1000, unit: 'USDT' }, missing: null },
    { bot: 'v3', window: { bot: 'v3', quote: 'USDC', change: 2, realized: 2, unrealized: 0, firstAt: NOW - 3_600_000, lastAt: NOW, samples: 10, restarts: 1, full: false, stale: false }, controller: null, latest: { total: 3, time: NOW }, cycles: null, owned: { value: 400, unit: 'USDC' }, missing: null },
    { bot: 'v1', window: null, controller: null, latest: null, cycles: null, owned: null, missing: 'Needs two samples inside the window (has 1).' },
  ], 10_000, 'USDT', NOW - 86_400_000);
  assert.deepEqual(rows.map(row => row.bot), ['v2', 'v3', 'v1']);
  assert.equal(rows[0].share, 0.75, 'share of gross movement: 6 of |6|+|2|');
  assert.equal(rows[1].share, 0.25);
  assert.equal(rows[0].netNow, 7);
  assert.equal(rows[0].netSource, 'controller');
  assert.equal(rows[1].netSource, 'history');
  assert.equal(rows[0].ownedShare, 0.1);
  assert.equal(rows[1].ownedShare, null, 'USDC owned value is not divided by a USDT wallet');
  assert.equal(rows[1].since, NOW - 3_600_000);
  assert.equal(rows[1].restarts, 1);
  assert.equal(rows[2].pnl, null);
  assert.match(rows[2].note, /two samples/);
  assert.equal(capital.strategyRows([{ bot: 'a', window: { bot: 'a', quote: 'USDC', change: 1, realized: 1, unrealized: 0, firstAt: 0, lastAt: 1, samples: 2, restarts: 0, full: true, stale: false }, controller: null, latest: null, cycles: null, owned: null, missing: null }], null, 'USDT', 0)[0].share, 1);
});

const tileInput = (over = {}) => ({
  rangeLabel: '7D', unit: 'USDT', range: window(), daily: window({ total: 1.5 }), weekly: window({ total: 3 }), monthly: window({ total: 3, partial: true, since: NOW - 3 * 86_400_000, fullBots: 0, bots: [{ bot: 'a', stale: false, full: false, firstAt: NOW - 3 * 86_400_000, lastAt: NOW }] }),
  series: [{ time: 1, value: 0 }, { time: 2, value: 3 }, { time: 3, value: 1 }], bars: [], walletChange: { amount: -20, percent: -0.002 }, meanWallet: 10_000, drawdown: -0.01, cycles: null, now: NOW, ...over,
});
const ids = result => result.tiles.map(tile => tile.id);

test('tiles exist only when computed: windows, wallet change and PnL drawdown show; risk and cycle tiles stay out', () => {
  const result = capital.fleetTiles(tileInput());
  assert.deepEqual(ids(result), ['C02', 'C02-wallet', 'C03', 'C18-weekly', 'C18-monthly', 'C18-maxdd', 'C18-pnldd']);
  const [period, wallet, daily, , monthly, , dd] = result.tiles;
  assert.equal(period.value, '5');
  assert.equal(period.unit, 'USDC');
  assert.match(period.note, /7D window · 1 of 1 bot$/);
  assert.equal(wallet.value, '-20');
  assert.equal(wallet.unit, 'USDT');
  assert.match(wallet.note, /Includes deposits and withdrawals/);
  assert.equal(daily.value, '1.5');
  assert.match(daily.note, /^24h window · 1 of 1 bot$/);
  assert.match(monthly.note, /^since 2026-09-28 12:00 UTC \(history starts here\) · 1 of 1 bot$/);
  assert.equal(dd.value, '-2');
  assert.match(dd.note, /flow independent/);
  assert.match(result.footnote, /appear after 14 days of fleet PnL.*VaR and expected shortfall after 60.*0 so far/);
  assert.equal(JSON.stringify(result).includes('navailable'), false, 'no tile or note says Unavailable');
  assert.equal(JSON.stringify(result).includes('ollecting'), false, 'no tile says Collecting');
});

test('windows without two samples produce no tile; a window with only stale samples is labelled stale', () => {
  const none = window({ total: null, counted: 0, bots: [], since: null, fullBots: 0, latestAt: null, missing: [{ bot: 'a', reason: 'x' }] });
  const result = capital.fleetTiles(tileInput({ range: none, daily: none, weekly: none, monthly: none, walletChange: null, drawdown: null, series: [] }));
  assert.deepEqual(ids(result), []);
  assert.ok(result.footnote);
  const staleBot = [{ bot: 'a', stale: true, full: true, firstAt: NOW - 86_400_000, lastAt: NOW - 3 * 3600_000 }];
  const stale = capital.fleetTiles(tileInput({ daily: window({ bots: staleBot, latestAt: NOW - 3 * 3600_000 }) }));
  const tile = stale.tiles.find(item => item.id === 'C03');
  assert.equal(tile.state.kind, 'stale');
  assert.match(tile.state.reason, /180 min old/);
});

test('risk tiles appear after the minimum days of completed fleet PnL and the footnote then names only what is missing', () => {
  const day = (i, net) => ({ day: `2026-09-${String(i + 1).padStart(2, '0')}`, net, realized: net, unrealized: 0, bots: 2, cumulative: 0, today: false });
  const bars = Array.from({ length: 20 }, (_, i) => day(i, i % 2 ? 12 : -4));
  const result = capital.fleetTiles(tileInput({ bars: [...bars, { ...day(20, 99), today: true }] }));
  for (const id of ['C18-sharpe', 'C18-sortino', 'C18-vol']) assert.ok(ids(result).includes(id), id);
  const sharpe = result.tiles.find(tile => tile.id === 'C18-sharpe');
  assert.ok(Number(sharpe.value) > 0);
  assert.match(sharpe.note, /Daily fleet PnL ÷ mean wallet · 20 days/);
  assert.equal(result.risk.days, 20, 'today is not part of a daily statistic');
  assert.doesNotMatch(result.footnote, /Sharpe/);
  assert.match(result.footnote, /VaR and expected shortfall after 60 \(20 so far\)/);
  const long = capital.fleetTiles(tileInput({ bars: Array.from({ length: 60 }, (_, i) => day(i % 28, i % 2 ? 12 : -4)) }));
  assert.equal(long.footnote, null);
  assert.ok(long.risk.var95 > 0);
});

test('cycle tiles show with their sample size and lifetime basis, and turnover needs a matching unit and a wallet', () => {
  const fleetCycles = { quote: 'USDT', bots: 2, of: 3, scored: 6, wins: 3, losses: 3, winRate: 0.5, grossWin: 6, grossLoss: 4, profitFactor: 1.5, fees: 2, feeBots: 2, grossVolume: 400, volumeBots: 2, fillCount: 12, openLots: 3, oldestSeconds: 10, countBots: 2, quoteScored: 6, volumeFillCount: 12, fillBots: 2, gaps: { counts: ['c'], quote: ['c'], fees: ['c'], volume: ['c'], fills: ['c'] } };
  const result = capital.fleetTiles(tileInput({ cycles: fleetCycles }));
  const byId = Object.fromEntries(result.tiles.map(tile => [tile.id, tile]));
  assert.equal(byId['C18-winrate'].value, '0.5');
  assert.match(byId['C18-winrate'].note, /3W \/ 3L · n=6 scored cycles · 2 of 3 bots/);
  assert.equal(byId['C18-pf'].value, '1.5');
  assert.equal(byId['C18-fees'].value, '2');
  assert.match(byId['C18-fees'].note, /lifetime · 2 of 3 bots/);
  assert.equal(byId['C18-volume'].value, '400');
  assert.equal(byId['C18-turnover'].value, String(400 / 10_000));
  assert.equal(byId['C18-turnover'].unit, 'x');
  assert.match(byId['C18-turnover'].note, /Lifetime gross volume ÷ mean wallet over 7D/);
  const other = capital.fleetTiles(tileInput({ cycles: { ...fleetCycles, quote: 'USDC', profitFactor: null } }));
  assert.equal(ids(other).includes('C18-turnover'), false, 'USDC volume is not divided by a USDT wallet');
  assert.equal(ids(other).includes('C18-pf'), false);
  const noWallet = capital.fleetTiles(tileInput({ cycles: fleetCycles, meanWallet: null }));
  assert.equal(ids(noWallet).includes('C18-turnover'), false);
  assert.match(noWallet.footnote, /needs a wallet valuation/);
});

test('merged fills carry their bot, newest first; rails keep only limited ones, tightest first', () => {
  const fill = (id, timestamp) => ({ fillId: id, sourceDbId: 'db', pair: 'BTC-USDC', side: 'buy', amount: '1', price: '1', volume: '1', fee: '0', orderType: null, timestamp, orderId: null });
  const merged = capital.mergeFills([{ bot: 'a', fills: [fill('1', '2026-10-01T10:00:00Z'), fill('3', '2026-10-01T12:00:00Z')] }, { bot: 'b', fills: [fill('2', '2026-10-01T11:00:00Z')] }]);
  assert.deepEqual(merged.map(row => `${row.bot}:${row.fillId}`), ['a:3', 'b:2', 'a:1']);
  assert.equal(capital.mergeFills([{ bot: 'a', fills: [fill('1', null), fill('2', '2026-10-01T10:00:00Z')] }], 1)[0].fillId, '2');
  const rail = (name, limit, utilization) => ({ name, scope: 'bot', limit, used: null, remaining: null, utilization, unit: 'USDC', state: 'ok', observedAt: null, source: null });
  const rails = capital.mergeRails([{ bot: 'a', rails: [rail('loss', '50', 0.1), rail('open', null, null)] }, { bot: 'b', rails: [rail('loss', '40', 0.6)] }]);
  assert.deepEqual(rails.map(row => `${row.bot}:${row.name}`), ['b:loss', 'a:loss']);
});

test('holding PnL is merged per asset across bots and never adds different quote currencies', () => {
  const pairs = (unrealized, pair = 'BTC-USDC') => [{ pair, unrealized }];
  const merged = capital.mergeHoldingPnl([
    { bot: 'a', pairs: pairs('1.5'), current: true }, { bot: 'b', pairs: pairs('0.5'), current: true },
    { bot: 'c', pairs: pairs('2', 'ETH-USDC'), current: true }, { bot: 'd', pairs: pairs('9', 'ETH-USDT'), current: true },
    { bot: 'e', pairs: pairs('1', 'SOL-USDC'), current: false },
  ]);
  assert.equal(merged.BTC.value, '2');
  assert.deepEqual(merged.BTC.bots, ['a', 'b']);
  assert.equal(merged.BTC.quote, 'USDC');
  assert.equal(merged.ETH.value, null, 'ETH is owned by two bots in different quotes');
  assert.equal(merged.SOL.value, null);
  assert.match(merged.SOL.reason, /not current/);
});

test('a window summed across an unrecorded stretch keeps its value and says it is incomplete', () => {
  const gapped = capital.fleetTiles(tileInput({ daily: window({ total: 1.5, gaps: [{ bot: 'ok_rsi', uncoveredMs: 38_880_000 }, { bot: 'rsi_modular_v2', uncoveredMs: 38_820_000 }] }) }));
  const tile = gapped.tiles.find(item => item.id === 'C03');
  assert.equal(tile.value, '1.5');
  assert.equal(tile.state.kind, 'incomplete');
  assert.match(tile.state.reason, /unrecorded stretches \(ok_rsi 10\.8 h, rsi_modular_v2 10\.8 h\)/);
  assert.equal(capital.fleetTiles(tileInput({ daily: window({ total: 1.5, gaps: [] }) })).tiles.find(item => item.id === 'C03').state.kind, 'fresh');
});
