import test from 'node:test';
import assert from 'node:assert/strict';
import { frontendModules } from './helpers/frontend-module.mjs';

const { botNet, winRateText } = frontendModules().load('features/bots/bot-net.ts');
const metric = (value, freshness = 'fresh', lastKnown = null) => ({ value, lastKnown, unit: 'USDC', availability: 'available', freshness, observedAt: null, feeBasis: null });

test('net prefers the controller report, then the owner native net, then last known', () => {
  assert.deepEqual(botNet(1.2, metric('1.5')), { value: 1.2, stale: false, source: 'controller report' });
  assert.deepEqual(botNet(null, metric('1.525309')), { value: 1.525309, stale: false, source: 'owner native net' },
    'a missing API lifecycle must not hide a fresh native net');
  assert.deepEqual(botNet(null, metric('1.5', 'stale')), { value: 1.5, stale: true, source: 'owner native net' });
  assert.deepEqual(botNet(null, metric(null, 'stale', '0.9')), { value: 0.9, stale: true, source: 'owner native net' });
  assert.deepEqual(botNet(null, metric(null)), { value: null, stale: false, source: null });
  assert.deepEqual(botNet(null, null), { value: null, stale: false, source: null });
});

test('win rate waits for the owner minimum sample', () => {
  assert.equal(winRateText({ scored: 2, minSample: 10, winRate: 1 }), 'Collecting 2/10');
  assert.equal(winRateText({ scored: 0, minSample: 10, winRate: null }), 'Collecting 0/10');
  assert.equal(winRateText({ scored: 12, minSample: 10, winRate: 0.5833 }), '58.3%');
});
