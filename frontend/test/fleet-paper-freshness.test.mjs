import test from 'node:test';
import assert from 'node:assert/strict';
import { frontendModules } from './helpers/frontend-module.mjs';

// Contract: the "Paper bots" summary tile keeps the registered paper-lane count, but its state is never fresher than
// the member cards. Mixed or missing observations keep stale / incomplete / collecting; a heartbeat never substitutes.
const { load } = frontendModules();
const { projectFleetTiles } = load('features/bots/fleet-tiles.ts');
const now = Date.parse('2026-11-05T14:40:00Z');
const ago = seconds => new Date(now - seconds * 1000).toISOString();

function paper(name, { quant = 'current', viewStale = false, viewAge = 1, quantAge = 4, read = true, view = true } = {}) {
  return {
    bot: name, name: name.toUpperCase(), status: 'running',
    view: read && view ? { orders: [], ordersStatus: { complete: true }, activeOrderCount: 0, activeExecutorCount: 0, stale: viewStale, ageSeconds: viewAge, observedAt: ago(viewAge) } : null,
    holdings: null,
    quant: read ? { freshness: quant, observedAt: ago(quantAge), pairs: [], cycleCounts: {} } : null,
    cycles: null, execution: null, health: null,
    // A current heartbeat on every lane: it must never make the summary fresh.
    paperOwner: { generatedAtMs: now - 1000, state: 'running' },
  };
}
const paperTile = inputs => projectFleetTiles(inputs, now).find(tile => tile.id === 'B01-paper');

test('all paper lanes stale: the summary is stale, not fresh', () => {
  const tile = paperTile([paper('a_paper', { quant: 'stale' }), paper('b_paper', { viewStale: true })]);
  assert.equal(tile.value, '+2');
  assert.equal(tile.state.kind, 'stale');
  assert.match(tile.state.reason, /A_PAPER.*B_PAPER/);
});

test('one fresh and one stale paper lane: the summary keeps the stale member', () => {
  const tile = paperTile([paper('a_paper'), paper('b_paper', { quant: 'stale' })]);
  assert.equal(tile.value, '+2');
  assert.equal(tile.state.kind, 'stale');
  assert.match(tile.state.reason, /B_PAPER/);
  assert.doesNotMatch(tile.state.reason, /A_PAPER/);
});

test('missing reads stay collecting or incomplete, never fresh', () => {
  assert.equal(paperTile([paper('a_paper'), paper('b_paper', { read: false })]).state.kind, 'collecting');
  assert.equal(paperTile([paper('a_paper'), paper('b_paper', { view: false })]).state.kind, 'incomplete');
  // Stale outranks missing evidence.
  assert.equal(paperTile([paper('a_paper', { quant: 'stale' }), paper('b_paper', { read: false })]).state.kind, 'stale');
});

test('an observation read as current expires when its age passes the freshness window', () => {
  assert.equal(paperTile([paper('a_paper', { viewAge: 45 })]).state.kind, 'stale');
  assert.equal(paperTile([paper('a_paper', { quantAge: 31 })]).state.kind, 'stale');
  const read = paper('a_paper');
  assert.equal(projectFleetTiles([read], now).find(tile => tile.id === 'B01-paper').state.kind, 'fresh');
  assert.equal(projectFleetTiles([read], now + 40_000).find(tile => tile.id === 'B01-paper').state.kind, 'stale');
});

test('every lane current: the summary is fresh, and paper never enters live tiles', () => {
  const tile = paperTile([paper('a_paper'), paper('b_paper')]);
  assert.equal(tile.state.kind, 'fresh');
  const tiles = projectFleetTiles([paper('a_paper', { quant: 'stale' })], now);
  assert.deepEqual(tiles.map(item => item.id), ['B01-paper']);
});

// Owner-contract payloads through the real owner projections (quant summary and runtime bootstrap), at the root #652
// baseline stale age: one paper lane current, one 120 s old. The expectation is what the owner projections themselves
// report for each lane, not the tile rule under test.
test('owner-projected paper lanes: one stale lane keeps the Paper bots tile stale', () => {
  const { projectQuantBotSummary } = load('features/bots/quant-roster.ts');
  const { buildBotPositionView } = load('features/bots/position-view.ts');
  const lane = (bot, ageSeconds) => {
    const at = ago(ageSeconds);
    const summary = {
      schema_version: 'rsibot.quant_ops.v1', execution_authorized: false, generated_at: at, source_times: { runtime_status: at },
      scope: { bot_key: bot, execution_mode: 'paper', ownership_basis: 'native_verified' },
      data: { bot_id: bot, operational_state: 'FLAT', operational_label: 'FLAT', heartbeat: at, pairs: [], cycle_counts: { open: 0 } },
    };
    const bootstrap = { runtime_status: { bot_name: bot, updated_at: at, active_orders_count: 0, controllers: [], positions_held: [], active_executors: [] }, monitoring: { bot_name: bot, stale_threshold_seconds: 30 } };
    const quant = projectQuantBotSummary(summary, bot, now);
    const view = buildBotPositionView(bootstrap, bot, now, { allowStale: true, holdings: null });
    return { owner: { quant: quant.freshness, viewStale: view.stale }, input: { ...paper(bot), quant, view } };
  };
  const current = lane('meridian_v4_paper', 1), old = lane('meridian_v4_d2h_paper', 120);
  assert.deepEqual(current.owner, { quant: 'current', viewStale: false }, 'owner projections call the current lane current');
  assert.deepEqual(old.owner, { quant: 'stale', viewStale: true }, 'owner projections call the 120 s lane stale');
  const tile = paperTile([current.input, old.input]);
  assert.equal(tile.value, '+2', 'the registered paper-lane count is unchanged');
  assert.equal(tile.state.kind, 'stale');
  assert.match(tile.state.reason, /MERIDIAN_V4_D2H_PAPER/);
  assert.equal(paperTile([current.input]).state.kind, 'fresh', 'a lane the owner calls current stays fresh');
});
