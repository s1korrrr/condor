import test from 'node:test';
import assert from 'node:assert/strict';
import { frontendModules } from './helpers/frontend-module.mjs';

test('the live hook binds page charts and risk bars to their respective admitted window', () => {
  const now = 1_800_000_000_000;
  const bots = ['a', 'b', 'c'];
  const { load } = frontendModules({
    react: { useMemo: calculate => calculate() },
    '@tanstack/react-query': { useQueries: ({ queries }) => queries.map(query => {
      const [, , bot, range] = query.queryKey;
      const rows = bot === 'a' || range === '1M' ? [[60, 0], [0, bot === 'a' ? 10 : 20]] : [[0, 0]];
      return { isPending: false, isError: false, dataUpdatedAt: now, data: {
        source: 'native_mqtt_observer', bot_name: bot, range, truncated: false,
        points: rows.map(([minutes, total]) => ({ timestamp: (now - minutes * 60_000) / 1000,
          total_pnl_quote: String(total), realized_pnl_quote: String(total), unrealized_pnl_quote: '0',
          quote: bot === 'a' ? 'USDC' : 'USDT', identity: 'boot', segment: 'run' })),
      } };
    }) },
    '@/lib/auth-token': {},
    '@/features/bots/controller-pnl': {},
    '@/features/bots/quant-roster': {},
  });
  const { useFleetPerformance } = load('features/quant-ops/fleet-reads.ts');
  for (const pageRange of ['1D', 'ALL']) {
    const actual = useFleetPerformance({ server: 'test', bots, now, pageRange });
    assert.equal(actual.range.quote, 'USDC');
    assert.equal(actual.range.total, 10);
    assert.equal(actual.series.at(-1).value, 10);
    assert.equal(actual.bars.reduce((total, day) => total + day.net, 0), 10);
    assert.equal(actual.riskQuote, pageRange === 'ALL' ? 'USDC' : 'USDT');
    assert.equal(actual.riskWindow.quote, actual.riskQuote);
    assert.deepEqual(actual.riskBars, [], 'one-minute fragments never qualify as completed risk days');
    assert.deepEqual(actual.restarts, []);
  }
});

test('the hook admits full same-currency observed days in its own 30D risk interval', () => {
  const day = 86_400_000, now = Date.parse('2026-10-18T00:00:00Z');
  const rows = Array.from({ length: 15 * 48 }, (_, index) => ({
    timestamp: (now - 15 * day + index * 30 * 60_000) / 1000,
    total_pnl_quote: String(index), realized_pnl_quote: String(index), unrealized_pnl_quote: '0',
    quote: 'USDT', identity: 'boot', segment: 'run',
  }));
  const { load } = frontendModules({
    react: { useMemo: calculate => calculate() },
    '@tanstack/react-query': { useQueries: ({ queries }) => queries.map(query => ({ isPending: false, isError: false, dataUpdatedAt: now, data: {
      source: 'native_mqtt_observer', bot_name: 'a', range: query.queryKey[3], truncated: false,
      bucket_seconds: query.queryKey[3] === '1M' ? 1800 : null, points: rows,
    } })) },
    '@/lib/auth-token': {}, '@/features/bots/controller-pnl': {}, '@/features/bots/quant-roster': {},
  });
  const actual = load('features/quant-ops/fleet-reads.ts').useFleetPerformance({ server: 'test', bots: ['a'], now, pageRange: '1D' });
  assert.equal(actual.riskWindow.quote, 'USDT');
  assert.equal(actual.riskBars.length, 15);
  assert.ok(actual.riskBars.every(bar => !bar.today && bar.bots === 1));
});

test('a supplied historical end is excluded by the hook while named as-of windows keep their endpoint', () => {
  const end = Date.parse('2026-10-17T12:00:00Z'), now = end + 60_000;
  const rows = [[end - 120_000, 0], [end - 60_000, 10], [end, 20]].map(([time, total]) => ({
    timestamp: time / 1000, total_pnl_quote: String(total), realized_pnl_quote: String(total), unrealized_pnl_quote: '0',
    quote: 'USDT', identity: 'boot', segment: 'run',
  }));
  const { load } = frontendModules({
    react: { useMemo: calculate => calculate() },
    '@tanstack/react-query': { useQueries: ({ queries }) => queries.map(query => ({ isPending: false, isError: false, dataUpdatedAt: now, data: {
      source: 'native_mqtt_observer', bot_name: 'a', range: query.queryKey[3], truncated: false, points: rows,
    } })) },
    '@/lib/auth-token': {}, '@/features/bots/controller-pnl': {}, '@/features/bots/quant-roster': {},
  });
  const { useFleetPerformance } = load('features/quant-ops/fleet-reads.ts');
  const custom = useFleetPerformance({ server: 'test', bots: ['a'], now, pageRange: 'ALL',
    window: { start: new Date(end - 120_000).toISOString(), end: new Date(end).toISOString() } });
  assert.equal(custom.range.total, 10);
  assert.equal(custom.series.at(-1)?.value, 10);
  assert.equal(custom.bars.reduce((sum, bar) => sum + bar.net, 0), 10);
  const named = useFleetPerformance({ server: 'test', bots: ['a'], now: end, pageRange: '1D' });
  assert.equal(named.range.total, 20);
});
