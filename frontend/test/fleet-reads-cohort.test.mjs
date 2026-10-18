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
    assert.equal(actual.riskBars.reduce((total, day) => total + day.net, 0), pageRange === 'ALL' ? 10 : 40);
    assert.deepEqual(actual.restarts, []);
  }
});
