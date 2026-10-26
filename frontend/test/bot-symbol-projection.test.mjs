import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { frontendModules } from './helpers/frontend-module.mjs';
import { botHoldingsAt, holdingsEntry } from './helpers/holdings.mjs';

const { load } = frontendModules();
const { buildBotPositionView, mixedOperationalLabel } = load('features/bots/position-view.ts');
const lib = load('lib/fleet-holdings.ts');
// Live 2026-10-05 09:53Z: the API bootstrap projects Meridian V3 into symbol rows without inventory. The reporting owner's
// quant view carries every pair's units, marked value and open-position PnL; Condor admits it as fleet holdings.
const fixture = JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/bots/meridian_v3_symbol_projection.json', import.meta.url), 'utf8'));
const now = Date.parse(fixture.quant_summary.generated_at) + 500;
const controller = 'modular_spot_meridian_v3_unified_live';
// The holdings the server would serve for that observation, written out by hand: the owner rows' units, marked value and
// unrealized PnL as normalized decimals. The owner published no mark availability and no running-executor count, so the
// mark and the executor count are null and no row is small.
const pairs = [
  ['BNB-USDC', '0.1250768584', '98.58557979088', '-1.11442740912'],
  ['BTC-USDC', '0.001163701276', '100.0773787749792', '0.3775416999792'],
  ['ETH-USDC', '0.0551438496', '149.95542740976', '0.40972090976'],
  ['SOL-USDC', '1.236158674', '149.22907512528', '-0.32125087472'],
  ['XRP-USDC', '32.9955824', '49.8893205888', '0.0393093888'],
].map(([pair, units, value, unrealized]) => ({ pair, controller_id: controller, units, marked_value_quote: value, unrealized_pnl_quote: unrealized, running_executor_count: null }));
const holdings = botHoldingsAt(lib, holdingsEntry('meridian_v3', pairs, { held: 5, value: '547.7367816896992', unrealized: '-0.6091062853008', entryCost: null }), now);

test('symbol-only rows take their inventory from the fleet holdings pair with the same owner identity', () => {
  const bare = buildBotPositionView(fixture.bootstrap, 'meridian_v3', now, { allowStale: true });
  assert.equal(bare.inventory.heldPairCount, null, 'the symbol projection alone has no inventory');
  assert.ok(bare.pairs.every(row => row.quantity === null && row.markValue === null && row.bagPnl === null));
  const view = buildBotPositionView(fixture.bootstrap, 'meridian_v3', now, { allowStale: true, holdings });
  const byPair = Object.fromEntries(view.pairs.map(row => [row.pair, row]));
  for (const [pair, units, value, unrealized] of pairs.map(row => [row.pair, row.units, row.marked_value_quote, row.unrealized_pnl_quote])) {
    assert.equal(byPair[pair].quantity, units, pair);
    assert.equal(byPair[pair].markValue, Number(value), pair);
    assert.equal(byPair[pair].bagPnl, Number(unrealized), pair);
    assert.equal(byPair[pair].price, null, `${pair}: an unavailable mark stays unavailable`);
    assert.equal(byPair[pair].phase, 'HOLDING', pair);
    assert.match(byPair[pair].inventorySource, /fleet holdings/i, pair);
    assert.ok(byPair[pair].executors.length > 0, `${pair} keeps its running executors`);
  }
  assert.equal(view.inventory.heldPairCount, 5);
  assert.deepEqual(view.inventory.value, { kind: 'exact', amount: '547.7367816896992' });
  assert.equal(mixedOperationalLabel(view.pairs), 'HOLDING');
});

test('without an admitted holdings entry, or for another owner identity, nothing is filled in', () => {
  const stale = { ...holdings, entry: { ...holdings.entry, state: 'unavailable', reason: 'RUNTIME_NOT_CURRENT', pairs: [] } };
  for (const options of [{}, { holdings: null, holdingsIssue: 'Fleet holdings request failed (503)' }, { holdings: stale }]) {
    const view = buildBotPositionView(fixture.bootstrap, 'meridian_v3', now, { allowStale: true, ...options });
    assert.deepEqual(view.pairs.map(row => row.quantity), view.pairs.map(() => null));
    assert.equal(view.inventory.state, 'unavailable');
  }
  const other = botHoldingsAt(lib, holdingsEntry('meridian_v3', pairs.map(row => ({ ...row, controller_id: 'another_controller' })), { held: 5, value: '547.7367816896992' }), now);
  const view = buildBotPositionView(fixture.bootstrap, 'meridian_v3', now, { allowStale: true, holdings: other });
  assert.deepEqual(view.pairs.map(row => row.quantity), view.pairs.map(() => null), 'a different controller never supplies these rows');
});
