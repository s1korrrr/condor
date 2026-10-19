import test from 'node:test';
import assert from 'node:assert/strict';
import { frontendModules } from './helpers/frontend-module.mjs';

const { load } = frontendModules();
const fleet = load('features/quant-ops/fleet-performance.ts');
const performance = load('features/quant-ops/performance-history.ts');

const NOW = Date.parse('2026-10-01T12:00:00Z');
const MIN = 60_000;

/** A native performance-history payload; `rows` are [minutesBeforeNow, total, realizedShare?, identity?]. */
function payload(bot, range, rows, { quote = 'USDC', segment = 'seg-1' } = {}) {
  const points = rows.map(([minutesAgo, total, realized, identity = 'boot-a']) => {
    const r = realized ?? total;
    return {
      timestamp: (NOW - minutesAgo * MIN) / 1000, total_pnl_quote: String(total), realized_pnl_quote: String(r),
      unrealized_pnl_quote: String(+(total - r).toFixed(10)), quote, identity, segment,
    };
  });
  return { source: 'native_mqtt_observer', bot_name: bot, range, coverage_start: points[0]?.timestamp ?? null, points, truncated: false };
}
const history = (bot, rows, range = '1D', options) => fleet.parseBotHistory(payload(bot, range, rows, options), bot, range, NOW + 5_000);
const hours = count => count * 60;

test('parsing keeps only valid native samples and names a failed or empty read', () => {
  const ok = history('v2', [[120, 1], [60, 2], [0, 3]]);
  assert.equal(ok.samples.length, 3);
  assert.equal(ok.quote, 'USDC');
  assert.equal(fleet.parseBotHistory(null, 'v2', '1D', NOW, true).reason, 'Performance history read failed.');
  assert.match(fleet.parseBotHistory(payload('v2', '1D', []), 'v2', '1D', NOW).reason, /Recording begins/);
  assert.match(fleet.parseBotHistory(payload('other', '1D', [[1, 1]]), 'v2', '1D', NOW).reason, /identity is invalid/);
});

function numericPayload(first, second) {
  return { source: 'native_mqtt_observer', bot_name: 'v2', range: '1D', truncated: false, points: [first, second].map((value, index) => ({
    timestamp: (NOW - (1 - index) * MIN) / 1000, total_pnl_quote: value, realized_pnl_quote: value,
    unrealized_pnl_quote: '0', quote: 'USDC', identity: 'boot-a', segment: 'seg-1',
  })) };
}

test('browser rejects malformed, underflowed and overflowing owner decimals without fabricating PnL', () => {
  for (const value of ['1_000', ' 1 ', '1\n', '1\r', '1\r\n', '0x10', '１２', '١', '1e1000000', '1e-1000000']) {
    const result = fleet.parseBotHistory(numericPayload('0', value), 'v2', '1D', NOW + 5_000);
    assert.equal(result.samples.length, 0, value);
    assert.match(result.reason, /invalid|unrepresentable/i);
  }
  for (const [first, second] of [['-1e308', '1e308'], ['1e30', '1000000000000000000000000000001']]) {
    const result = fleet.parseBotHistory(numericPayload(first, second), 'v2', '1D', NOW + 5_000);
    assert.equal(result.samples.length, 0, `${first} to ${second}`);
    assert.match(result.reason, /invalid|unrepresentable/i);
  }
  assert.equal(performance.historyAmount('9'.repeat(38))?.key != null, true);
  assert.equal(performance.historyAmount('9'.repeat(39)), null);
  assert.equal(performance.historyAmount('9'.repeat(38) + '0'.repeat(90))?.key != null, true);
  assert.equal(performance.historyAmount('1e127')?.key != null, true);
  assert.equal(fleet.parseBotHistory(numericPayload('0.1', '0.2'), 'v2', '1D', NOW + 5_000).samples.length, 2);
  assert.equal(fleet.parseBotHistory(numericPayload('0e-' + '9'.repeat(240), '0.1'), 'v2', '1D', NOW + 5_000).samples.length, 2);
  const bridged = numericPayload('1e30', '1000000000000000000000000000001');
  bridged.points[0].segment = 'backfill-v2';
  bridged.points[1].identity = 'boot-b';
  assert.equal(fleet.parseBotHistory(bridged, 'v2', '1D', NOW + 5_000).samples.length, 0);
});

test('public history admission compares the owner balance tolerance exactly', () => {
  for (const sign of ['', '-']) {
    const payload = numericPayload('0', `${sign}0.000001${'0'.repeat(35)}1`);
    payload.points[1].realized_pnl_quote = '0';
    assert.equal(performance.projectPerformanceHistory(payload, 'v2', NOW + 5_000, '1D').points.length, 0);
  }
  const boundary = numericPayload('0', '0.000001');
  boundary.points[1].realized_pnl_quote = '0';
  assert.equal(performance.projectPerformanceHistory(boundary, 'v2', NOW + 5_000, '1D').points.length, 2);
  const ordinary = numericPayload('0', '0.3');
  ordinary.points[1].realized_pnl_quote = '0.1';
  ordinary.points[1].unrealized_pnl_quote = '0.2';
  assert.equal(performance.projectPerformanceHistory(ordinary, 'v2', NOW + 5_000, '1D').points.length, 2);
});

test('browser marks an overflowing combined fleet result unavailable rather than Infinity', () => {
  const huge = bot => ({ bot, range: '1D', quote: 'USDC', reason: null, gapMs: 90_000,
    bucketSeconds: null, truncated: false, samples: [
      { time: NOW - MIN, total: 0, realized: 0, unrealized: 0, owner: 0 },
      { time: NOW, total: 1e308, realized: 1e308, unrealized: 0, owner: 0 },
    ] });
  const histories = [huge('v2'), huge('v3')];
  const window = fleet.fleetWindow(histories, ['v2', 'v3'], NOW - MIN, NOW, NOW);
  assert.equal(window.total, null);
  assert.equal(window.counted, 0);
  assert.equal(window.missing.length, 2);
  assert.deepEqual(fleet.fleetSeries(histories, NOW - MIN, NOW), []);
  assert.deepEqual(fleet.fleetDailyBars(histories, NOW, NOW - MIN), []);
  const small = { ...huge('small'), samples: [
    { time: NOW - MIN, total: 0, realized: 0, unrealized: 0, owner: 0 },
    { time: NOW, total: 1, realized: 1, unrealized: 0, owner: 0 },
  ] };
  const rounded = fleet.fleetWindow([{ ...huge('large'), samples: [
    { time: NOW - MIN, total: 0, realized: 0, unrealized: 0, owner: 0 },
    { time: NOW, total: 1e30, realized: 1e30, unrealized: 0, owner: 0 },
  ] }, small], ['large', 'small'], NOW - MIN, NOW, NOW);
  assert.equal(rounded.total, null);
  assert.equal(rounded.counted, 0);
  const reversed = fleet.fleetWindow([small, { ...huge('large'), samples: [
    { time: NOW - MIN, total: 0, realized: 0, unrealized: 0, owner: 0 },
    { time: NOW, total: 1e30, realized: 1e30, unrealized: 0, owner: 0 },
  ] }], ['small', 'large'], NOW - MIN, NOW, NOW);
  assert.equal(reversed.total, null);
  assert.equal(reversed.counted, 0);
  const cohort = { quote: 'USDC', bots: [{ bot: 'small' }, { bot: 'large' }] };
  assert.deepEqual(fleet.fleetSeries([small, { ...huge('large'), samples: [
    { time: NOW - MIN, total: 0, realized: 0, unrealized: 0, owner: 0 },
    { time: NOW, total: 1e30, realized: 1e30, unrealized: 0, owner: 0 },
  ] }], NOW - MIN, NOW, 60, cohort), []);
  assert.deepEqual(fleet.fleetDailyBars([small, { ...huge('large'), samples: [
    { time: NOW - MIN, total: 0, realized: 0, unrealized: 0, owner: 0 },
    { time: NOW, total: 1e30, realized: 1e30, unrealized: 0, owner: 0 },
  ] }], NOW, NOW - MIN, cohort), []);
  const run = { ...huge('run'), samples: [
    { time: NOW - 2 * MIN, total: 0, realized: 0, unrealized: 0, owner: 0 },
    { time: NOW - MIN, total: 1, realized: 1, unrealized: 0, owner: 0 },
    { time: NOW, total: 1e30, realized: 1e30, unrealized: 0, owner: 0 },
  ] };
  assert.equal(fleet.botWindow(run, NOW - 2 * MIN, NOW, NOW).change, null);
  const direct = numericPayload('1', '1e30');
  const projected = performance.projectPerformanceHistory(direct, 'v2', NOW + 5_000, '1D');
  assert.equal(projected.points.length, 2);
  assert.equal(projected.change, null);
});

test('fleet window sums per-bot native changes and is independent of deposits', () => {
  const v2 = history('v2', [[hours(24), 10], [hours(12), 14], [0, 16]]);
  const v3 = history('v3', [[hours(24), -4], [hours(12), -3], [0, -1]]);
  const window = fleet.fleetWindow([v2, v3], ['v2', 'v3'], NOW - 86_400_000, NOW, NOW);
  assert.equal(window.total, 6 + 3);
  assert.equal(window.counted, 2);
  assert.equal(window.partial, false);
  assert.equal(window.quote, 'USDC');
  assert.equal(fleet.windowLabel(window, '24h window'), '24h window');
  assert.equal(fleet.coverageLabel(window), '2 of 2 bots');
});

test('partial history reports the covered span and says where history starts', () => {
  // History starts 3h ago: the 24h window is only partly covered.
  const v2 = history('v2', [[180, 5], [90, 6], [0, 9]]);
  const window = fleet.fleetWindow([v2], ['v2'], NOW - 86_400_000, NOW, NOW);
  assert.equal(window.total, 4);
  assert.equal(window.partial, true);
  assert.equal(window.since, NOW - 180 * MIN);
  assert.equal(fleet.windowLabel(window, '24h window'), 'since 2026-10-01 09:00 UTC (history starts here)');
});

test('a bot that appears mid-window contributes from its first sample, never a made-up opening value', () => {
  const v2 = history('v2', [[hours(24), 0], [hours(12), 2], [0, 4]]);
  const late = history('v3', [[hours(2), 100], [0, 101]]);
  const window = fleet.fleetWindow([v2, late], ['v2', 'v3'], NOW - 86_400_000, NOW, NOW);
  assert.equal(window.total, 4 + 1);
  assert.equal(window.partial, true);
  assert.equal(window.fullBots, 1);
  assert.equal(fleet.windowLabel(window, '24h window'), '24h window · v3 counted from 2026-10-01 10:00 UTC (history starts here)');
  const series = fleet.fleetSeries([v2, late], NOW - 86_400_000, NOW, 60);
  // The late bot's absolute PnL of 100 never appears as a step in the fleet curve.
  assert.ok(series.every(point => Math.abs(point.value) < 10), JSON.stringify(series.map(point => point.value)));
  assert.equal(series.at(-1).value, 5);
  assert.equal(series[0].value, 0);
});

test('series align bots reporting at different seconds on one grid and add up to the window change', () => {
  const a = fleet.parseBotHistory({ ...payload('a', '1D', []), points: [0, 1, 2, 3].map(i => ({ timestamp: (NOW - (3 - i) * 10 * MIN) / 1000 - 53, total_pnl_quote: String(i), realized_pnl_quote: String(i), unrealized_pnl_quote: '0', quote: 'USDC', identity: 'x', segment: 's' })) }, 'a', '1D', NOW + 5_000);
  const b = fleet.parseBotHistory({ ...payload('b', '1D', []), points: [0, 1, 2, 3].map(i => ({ timestamp: (NOW - (3 - i) * 10 * MIN) / 1000 - 19, total_pnl_quote: String(2 * i), realized_pnl_quote: String(2 * i), unrealized_pnl_quote: '0', quote: 'USDC', identity: 'y', segment: 's' })) }, 'b', '1D', NOW + 5_000);
  assert.equal(a.samples.length, 4);
  const series = fleet.fleetSeries([a, b], NOW - 3600_000, NOW, 60);
  // Offsets -53s and -19s share a minute bucket, so each grid time carries both bots.
  assert.deepEqual(series.map(point => point.value), [0, 3, 6, 9]);
  const window = fleet.fleetWindow([a, b], ['a', 'b'], NOW - 3600_000, NOW, NOW);
  assert.equal(window.total, series.at(-1).value);
});

test('an owner restart is a boundary: nothing is added across it and the restart is reported', () => {
  const v2 = history('v2', [[hours(10), 5], [hours(8), 7], [hours(6), 0, undefined, 'boot-b'], [0, 2, undefined, 'boot-b']]);
  const window = fleet.fleetWindow([v2], ['v2'], NOW - 86_400_000, NOW, NOW);
  // +2 before the restart and +2 after it; the reset from 7 to 0 is not a loss.
  assert.equal(window.total, 4);
  assert.equal(window.bots[0].restarts, 1);
  const series = fleet.fleetSeries([v2], NOW - 86_400_000, NOW, 60);
  assert.equal(series.at(-1).value, 4);
  assert.deepEqual(fleet.restartTimes([v2], NOW - 86_400_000, NOW), [NOW - hours(6) * MIN]);
  const bars = fleet.fleetDailyBars([v2], NOW);
  assert.equal(bars.reduce((sum, day) => sum + day.net, 0), 4);
});

test('a bot with no usable history is named missing and the total says how many bots it covers', () => {
  const v2 = history('v2', [[120, 1], [0, 4]]);
  const failed = fleet.parseBotHistory(null, 'v3', '1D', NOW, true);
  const single = history('ok_rsi', [[0, 7]]);
  const window = fleet.fleetWindow([v2, failed, single], ['v2', 'v3', 'ok_rsi'], NOW - 86_400_000, NOW, NOW);
  assert.equal(window.total, 3);
  assert.equal(window.counted, 1);
  assert.equal(window.expected, 3);
  assert.deepEqual(window.missing.map(item => item.bot), ['v3', 'ok_rsi']);
  assert.match(window.missing[1].reason, /two samples/);
  assert.equal(fleet.coverageLabel(window), '1 of 3 bots · missing: v3, ok_rsi');
  const none = fleet.fleetWindow([failed], ['v3'], NOW - 86_400_000, NOW, NOW);
  assert.equal(none.total, null);
  assert.equal(fleet.windowLabel(none, '24h window'), '24h window');
});

test('bots quoted in a different currency are not summed with the fleet quote', () => {
  const a = history('a', [[60, 0], [0, 2]]);
  const b = history('b', [[60, 0], [0, 3]]);
  const c = history('c', [[60, 0], [0, 100]], '1D', { quote: 'USDT' });
  const window = fleet.fleetWindow([a, b, c], ['a', 'b', 'c'], NOW - 86_400_000, NOW, NOW);
  assert.equal(window.quote, 'USDC');
  assert.equal(window.total, 5);
  assert.match(window.missing[0].reason, /Quote USDT differs/);
});

test('daily bars attribute a step to the later sample UTC day and sum to the window change', () => {
  // Midnight UTC is 2026-10-01T00:00Z, 12h before NOW. v2 samples: 22:00, 23:00, 01:00, 12:00; v3: 23:00, 11:00.
  const v2 = history('v2', [[hours(14), 1, 1], [hours(13), 4, 3], [hours(11), 6, 3], [0, 10, 3]]);
  const v3 = history('v3', [[hours(13), 0], [hours(1), -2]]);
  const bars = fleet.fleetDailyBars([v2, v3], NOW);
  assert.deepEqual(bars.map(day => day.day), ['2026-09-30', '2026-10-01']);
  assert.equal(bars[0].net, 3);
  assert.equal(bars[0].realized, 2);
  assert.equal(bars[0].unrealized, 1);
  assert.equal(bars[1].net, 2 + 4 - 2);
  assert.equal(bars[1].today, true);
  assert.equal(bars[1].bots, 2);
  assert.equal(bars[1].cumulative, 7);
  assert.equal(bars[1].realized, -2);
  const window = fleet.fleetWindow([v2, v3], ['v2', 'v3'], NOW - 86_400_000, NOW, NOW);
  assert.equal(window.total, 7);
  assert.equal(bars.reduce((sum, day) => sum + day.net, 0), window.total);
});

test('fleet PnL drawdown is peak-to-trough on the curve that starts at zero', () => {
  const points = [3, 5, 1, 2, -1, 4].map((value, index) => ({ time: index, value }));
  assert.deepEqual(fleet.pnlDrawdown(points), { depth: 6, from: 1, to: 4 });
  assert.equal(fleet.pnlDrawdown([{ time: 1, value: 2 }, { time: 2, value: 3 }]), null);
});

test('risk statistics stay null until the stated minimum of days and only then compute', () => {
  const short = fleet.fleetRisk(Array.from({ length: 13 }, (_, i) => (i % 2 ? 0.01 : -0.004)));
  assert.equal(short.days, 13);
  assert.equal(short.sharpe, null);
  assert.equal(short.volatilityDaily, null);
  assert.equal(short.var95, null);
  const enough = fleet.fleetRisk(Array.from({ length: 20 }, (_, i) => (i % 2 ? 0.01 : -0.004)));
  assert.ok(enough.sharpe > 0);
  assert.ok(enough.sortino > 0);
  assert.ok(enough.volatilityDaily > 0);
  assert.equal(enough.var95, null, 'tail statistics need 60 days');
  const tail = fleet.fleetRisk(Array.from({ length: 60 }, (_, i) => (i % 2 ? 0.01 : -0.004)));
  assert.equal(tail.var95, 0.004);
  assert.equal(tail.expectedShortfall95, 0.004);
  // Annualised with sqrt(365): mean 0.003, sample sd of a two-point series.
  const mean = (0.01 - 0.004) / 2;
  const sd = Math.sqrt(((0.01 - mean) ** 2 * 10 + (-0.004 - mean) ** 2 * 10) / 19);
  assert.ok(Math.abs(enough.sharpe - (mean / sd) * Math.sqrt(365)) < 1e-9);
});

test('finite but unrepresentable daily-return moments never become infinite or fabricated risk statistics', () => {
  const risk = fleet.fleetRisk(Array.from({ length: 20 }, (_, index) => index % 2 ? 1e197 : -1e197));
  assert.equal(risk.days, 20);
  assert.equal(risk.volatilityDaily, null);
  assert.equal(risk.sharpe, null);
  assert.equal(risk.sortino, null);
  assert.match(risk.invalidReason, /unrepresentable/i);
  assert.doesNotMatch(JSON.stringify(risk), /Infinity|NaN/);
  const flat = fleet.fleetRisk(Array(20).fill(0.01));
  assert.equal(flat.volatilityDaily, 0);
  assert.equal(flat.sharpe, null, 'a zero denominator is undefined, not an overflow');
  assert.equal(flat.invalidReason, null);
  const empty = fleet.fleetRisk([]);
  assert.equal(empty.days, 0);
  assert.equal(empty.invalidReason, null);
});

test('daily returns use completed days only and need a positive equity basis', () => {
  const days = [{ day: 'a', net: 10, today: false }, { day: 'b', net: -5, today: false }, { day: 'c', net: 99, today: true }];
  assert.deepEqual(fleet.dailyReturns(days, 1000), [0.01, -0.005]);
  assert.deepEqual(fleet.dailyReturns(days, null), []);
  assert.deepEqual(fleet.dailyReturns(days, 0), []);
  assert.deepEqual(fleet.dailyReturns([{ ...days[0], net: Infinity }], 1000), [], 'overflow is not a daily return');
});

test('series, daily bars and risk bars never add a bot in another quote currency', () => {
  const usdc = history('v2', [[hours(24), 0], [hours(12), 10], [0, 20]]);
  const usdt = history('v3', [[hours(24), 0], [hours(12), 100], [0, 200]], '1D', { quote: 'USDT' });
  const series = fleet.fleetSeries([usdc, usdt], NOW - 86_400_000, NOW);
  assert.equal(series.at(-1).value, 20);
  assert.equal(fleet.fleetDailyBars([usdc, usdt], NOW, NOW - 86_400_000).reduce((total, day) => total + day.net, 0), 20);
});

test('one-sample or out-of-window histories cannot choose the charts currency', () => {
  const usdc = history('a', [[60, 0], [0, 10]]);
  for (const rows of [[[30, 0]], [[120, 0], [90, 100]]]) {
    const histories = [usdc, history('b', rows, '1D', { quote: 'USDT' }), history('c', rows, '1D', { quote: 'USDT' })];
    const from = NOW - 60 * MIN;
    const window = fleet.fleetWindow(histories, ['a', 'b', 'c'], from, NOW, NOW);
    assert.equal(window.quote, 'USDC');
    assert.equal(window.total, 10);
    assert.equal(window.counted, 1);
    assert.equal(fleet.fleetSeries(histories, from, NOW).at(-1)?.value, 10);
    assert.equal(fleet.fleetDailyBars(histories, NOW, from).reduce((total, day) => total + day.net, 0), 10);
    assert.deepEqual(fleet.restartTimes(histories, from, NOW), []);
  }
});

test('restart markers exclude another quotes owner changes', () => {
  const a = history('a', [[60, 0], [0, 10]]);
  const b = history('b', [[60, 0], [30, 2], [0, 4, undefined, 'boot-b']], '1D', { quote: 'USDT' });
  assert.deepEqual(fleet.restartTimes([a, b], NOW - 60 * MIN, NOW), []);
});

test('daily bars add up to the window change: a step that starts before the window is not counted', () => {
  const only = history('v2', [[25 * 60, 0], [0, 10]]);
  const window = fleet.fleetWindow([only], ['v2'], NOW - 86_400_000, NOW, NOW);
  assert.equal(window.total, null);
  assert.equal(fleet.fleetDailyBars([only], NOW, NOW - 86_400_000).length, 0);
});

test('daily bars for a closed window stop at its end', () => {
  const rows = Array.from({ length: 31 }, (_, day) => [(30 - day) * 24 * 60, day * 2]);
  const h = history('v2', rows, '1M');
  const from = NOW - 20 * 86_400_000, to = NOW - 10 * 86_400_000;
  const bars = fleet.fleetDailyBars([h], to, from);
  assert.ok(bars.length <= 11);
  assert.ok(bars.every(day => Date.parse(day.day) <= to));
});

test('custom UTC end is excluded from fleet totals, curve, bars and restart markers', () => {
  const from = NOW - 2 * MIN, to = NOW - MIN;
  const v2 = history('v2', [[2, 0], [1.5, 2], [1, 9, undefined, 'boot-b']]);
  const window = fleet.fleetWindow([v2], ['v2'], from, to, NOW, true);
  assert.equal(window.total, 2);
  assert.equal(fleet.fleetSeries([v2], from, to, 1, window, true).at(-1).value, 2);
  assert.equal(fleet.fleetDailyBars([v2], to, from, window, true).reduce((sum, bar) => sum + bar.net, 0), 2);
  assert.deepEqual(fleet.restartTimes([v2], from, to, window, true), []);
  assert.equal(fleet.fleetWindow([v2], ['v2'], from, to, NOW).bots[0].restarts, 1, 'named as-of window keeps its final owner observation');
});

test('daily risk admits only complete observed UTC days for every selected bot', () => {
  const day = 86_400_000;
  const end = Date.parse('2026-10-18T00:00:00Z');
  const dense = Array.from({ length: 48 }, (_, index) => ({
    time: end - day + index * 30 * MIN, total: index, realized: index, unrealized: 0, owner: 0,
  }));
  const base = { range: '1M', quote: 'USDT', gapMs: 31.5 * MIN, bucketSeconds: 1800, truncated: false, reason: null };
  const good = { ...base, bot: 'a', samples: dense };
  const sparse = { ...base, bot: 'b', samples: [dense[0], dense[1]] };
  const full = fleet.fleetWindow([good], ['a'], end - day, end, end);
  assert.equal(fleet.qualifiedFleetDailyBars([good], end, end - day, full).length, 1);
  const partial = fleet.fleetWindow([good, sparse], ['a', 'b'], end - day, end, end);
  assert.deepEqual(fleet.qualifiedFleetDailyBars([good, sparse], end, end - day, partial), []);
  const restart = { ...good, samples: dense.map((sample, index) => ({ ...sample, owner: index < 24 ? 0 : 1 })) };
  assert.deepEqual(fleet.qualifiedFleetDailyBars([restart], end, end - day, fleet.fleetWindow([restart], ['a'], end - day, end, end)), []);
  const overflow = { ...good, samples: dense.map((sample, index) => ({ ...sample, total: index ? 1e308 : -1e308, realized: index ? 1e308 : -1e308 })) };
  assert.deepEqual(fleet.qualifiedFleetDailyBars([overflow], end, end - day, fleet.fleetWindow([overflow], ['a'], end - day, end, end)), []);
});

test('qualified daily PnL includes the midnight step once with bucketed close-to-close baselines', () => {
  const day = 86_400_000, start = Date.parse('2026-10-16T00:00:00Z');
  const samples = Array.from({ length: 98 }, (_, index) => ({
    time: start - 30 * MIN + index * 30 * MIN,
    total: index, realized: index, unrealized: 0, owner: 0,
  }));
  // The last point is exactly the half-open end and cannot enter the second completed day.
  samples[97].total = samples[97].realized = 1_000;
  const history = { bot: 'a', range: '1M', quote: 'USDT', samples, gapMs: 31.5 * MIN,
    bucketSeconds: 1800, truncated: false, reason: null };
  const end = start + 2 * day, from = start - 30 * MIN;
  const selected = fleet.fleetWindow([history], ['a'], from, end, end, true);
  const bars = fleet.qualifiedFleetDailyBars([history], end, from, selected);
  assert.deepEqual(bars.map(bar => bar.net), [48, 48]);
  assert.deepEqual(bars.map(bar => bar.cumulative), [48, 96]);
});

test('a recording hole inside one owner run is summed across but reported, never presented as covered', () => {
  // Live 2026-10-05: V1/V2 history had no samples 10-04 18:47 → 10-05 05:35 (API rejected both bots).
  const rows = [];
  for (let minute = hours(24); minute >= hours(12); minute -= 1) rows.push([minute, 10 + (hours(24) - minute) / 1000]);
  for (let minute = hours(1.2); minute >= 0; minute -= 1) rows.push([minute, 20 + (hours(1.2) - minute) / 1000]);
  const v1 = history('v1', rows);
  const window = fleet.fleetWindow([v1], ['v1'], NOW - 86_400_000, NOW, NOW);
  assert.equal(window.partial, false);
  assert.ok(Math.abs(window.total - (rows.at(-1)[1] - rows[0][1])) < 1e-9);
  assert.equal(window.gaps.length, 1);
  assert.equal(window.gaps[0].bot, 'v1');
  assert.equal(window.gaps[0].uncoveredMs, (hours(12) - hours(1.2)) * MIN);
  const dense = history('v2', rows.filter(([minute]) => minute >= hours(12)));
  assert.deepEqual(fleet.fleetWindow([dense], ['v2'], NOW - hours(24) * MIN, NOW - hours(12) * MIN, NOW).gaps, []);
});
