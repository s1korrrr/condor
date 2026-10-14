import test from 'node:test';
import assert from 'node:assert/strict';
import { frontendModules } from './helpers/frontend-module.mjs';

const { load } = frontendModules();
const { projectFleetAggregates, splitPaper, paperNote } = load('features/bots/fleet-inventory.ts');

const reads = (bot, pairs, funnel = [{ stage: 'orders_created', count: 4 }], lots = []) => ({
  bot,
  quant: { pairs: pairs.map(([pair, units, markedValue]) => ({ pair, units, markedValue })) },
  cycles: { inventoryAge: { lots } },
  execution: { funnel },
});

test('per-symbol inventory, heatmap and lifecycle counts sum live bots only', () => {
  const live = reads('rsi_modular_v2', [['BTC-USDT', '0.01', '650'], ['ETH-USDT', '0', null]], undefined, [{ pair: 'BTC-USDT', ageSeconds: 7200 }]);
  const v3 = reads('meridian_v3', [['BTC-USDT', '0.02', '1300']]);
  const paper = reads('meridian_v4_paper', [['BTC-USDT', '5', '325000'], ['SOL-USDT', '10', '1400']], [{ stage: 'orders_created', count: 1000 }]);
  const withPaper = projectFleetAggregates([live, paper, v3]);
  const liveOnly = projectFleetAggregates([live, v3]);
  assert.deepEqual(withPaper.paper, ['meridian_v4_paper']);
  assert.deepEqual({ ...withPaper, paper: [] }, { ...liveOnly, paper: [] }, 'a paper bot changes no aggregate');
  assert.deepEqual(withPaper.inventory, [['BTC', { positions: 2, units: 0.03, value: 1950, oldest: 7200 }]]);
  assert.equal(withPaper.inventoryTotal, 1950);
  assert.deepEqual(withPaper.assets, ['BTC', 'ETH'], 'SOL is held only by the paper bot');
  assert.ok(withPaper.heatCells.every(cell => cell.row !== 'meridian_v4_paper'));
  assert.deepEqual(withPaper.funnel, [{ stage: 'orders_created', count: 8 }]);
});

test('the paper rule is the shared token rule and the note names the count', () => {
  const { live, paper } = splitPaper([{ bot: 'meridian_v4_paper' }, { bot: 'meridian_v4_d2h_paper' }, { bot: 'papermill_v2' }, { bot: 'ok_rsi' }]);
  assert.deepEqual(paper.map(item => item.bot), ['meridian_v4_paper', 'meridian_v4_d2h_paper']);
  assert.deepEqual(live.map(item => item.bot), ['papermill_v2', 'ok_rsi']);
  assert.equal(paperNote(0), '');
  assert.equal(paperNote(1), '+1 paper bot, not counted');
  assert.equal(paperNote(2), '+2 paper bots, not counted');
});
