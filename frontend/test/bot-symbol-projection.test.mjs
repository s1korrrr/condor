import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { frontendModules } from './helpers/frontend-module.mjs';

const { load } = frontendModules();
const { buildBotPositionView, withQuantInventory, openPairCount, mixedOperationalLabel } = load('features/bots/position-view.ts');
const { projectQuantBotSummary } = load('features/bots/quant-roster.ts');
// Live 2026-10-05 09:53Z: the API bootstrap projects Meridian V3 into symbol rows without inventory, while the
// admitted reporting quant summary carries every pair's units, mark and open-position PnL.
const fixture = JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/bots/meridian_v3_symbol_projection.json', import.meta.url), 'utf8'));
const now = Date.parse(fixture.quant_summary.generated_at) + 500;

test('symbol-only rows take their inventory from the admitted quant summary', () => {
  const view = buildBotPositionView(fixture.bootstrap, 'meridian_v3', now, { allowStale: true });
  assert.equal(openPairCount(view.pairs), null, 'the symbol projection alone has no inventory');
  const quant = projectQuantBotSummary(fixture.quant_summary, 'meridian_v3', now);
  assert.equal(quant.admitted, true);
  const merged = withQuantInventory(view, quant.pairs, quant.admitted);
  const byPair = Object.fromEntries(merged.pairs.map(row => [row.pair, row]));
  const source = Object.fromEntries(quant.pairs.map(row => [row.pair, row]));
  for (const pair of ['BNB-USDC', 'BTC-USDC', 'ETH-USDC', 'SOL-USDC', 'XRP-USDC']) {
    assert.equal(byPair[pair].quantity, source[pair].units, pair);
    assert.equal(byPair[pair].markValue, Number(source[pair].markedValue), pair);
    assert.equal(byPair[pair].bagPnl, Number(source[pair].unrealized), pair);
    assert.equal(byPair[pair].phase, 'HOLDING', pair);
    assert.match(byPair[pair].inventorySource, /reporting/i, pair);
    assert.ok(byPair[pair].executors.length > 0, `${pair} keeps its running executors`);
  }
  assert.equal(openPairCount(merged.pairs), 5);
  assert.equal(mixedOperationalLabel(merged.pairs), 'HOLDING');
});

test('without an admitted summary, or for owner-reported rows, nothing is filled in', () => {
  const view = buildBotPositionView(fixture.bootstrap, 'meridian_v3', now, { allowStale: true });
  const quant = projectQuantBotSummary(fixture.quant_summary, 'meridian_v3', now);
  assert.deepEqual(withQuantInventory(view, quant.pairs, false).pairs.map(row => row.quantity), view.pairs.map(row => row.quantity));
  const owner = { ...view, pairs: view.pairs.map(row => ({ ...row, projected: false })) };
  assert.deepEqual(withQuantInventory(owner, quant.pairs, true).pairs.map(row => row.quantity), owner.pairs.map(row => row.quantity));
});
