import test from 'node:test';
import assert from 'node:assert/strict';
import { frontendModules } from './helpers/frontend-module.mjs';

const { pnlSeries } = frontendModules().load('features/bots/pnl-series.ts');
const now = Date.parse('2026-09-29T10:00:00Z');
const start = now / 1000 - 86_400;
const completePoints = Array.from({ length: 1441 }, (_, index) => ({ timestamp: start + 30 + index * ((86_340) / 1440), identity: 'boot-a', segment: 'a', quote: 'USDC', total_pnl_quote: String(1 + index / 1440) }));
const full = (changes = {}) => ({ source: 'native_mqtt_observer', bot_name: 'v2', range: '1D', coverage_start: start - 60, truncated: false, points: completePoints, ...changes });

test('24h PnL is admitted only for complete, unbroken coverage from one owner', () => {
  const complete = pnlSeries(full(), 'v2', now, '1D');
  assert.equal(complete.change, 1);
  assert.equal(complete.reason, null);

  const partial = pnlSeries(full({ points: full().points.slice(-60), coverage_start: now / 1000 - 3600 }), 'v2', now, '1D');
  assert.equal(partial.points.length, 60, 'partial history remains visible as a chart');
  assert.equal(partial.change, null, 'a one-hour slice cannot be labeled as 24h change');
  assert.match(partial.reason, /complete window coverage/);

  const gap = full({ points: [full().points[0], { ...full().points[2], timestamp: full().points[0].timestamp + 91 }] });
  assert.equal(pnlSeries(gap, 'v2', now, '1D').change, null);
  const ownerChange = full({ points: full().points.map((point, index) => index ? { ...point, identity: 'boot-b' } : point) });
  assert.equal(pnlSeries(ownerChange, 'v2', now, '1D').change, null);
  assert.equal(pnlSeries(full({ range: '1W' }), 'v2', now, '1D').change, null, 'the requested window must match the payload');
});
