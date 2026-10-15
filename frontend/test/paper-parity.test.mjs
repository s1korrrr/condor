import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';

const { load } = frontendModules({
  'react-router-dom': { Link: ({ to, children, ...rest }) => React.createElement('a', { href: to, ...rest }, children), useLocation: () => ({ hash: '' }) },
});
const { projectPaperRuntimePnl, projectBotPnl } = load('features/bots/controller-pnl.ts');
const { projectPerformanceHistory } = load('features/quant-ops/performance-history.ts');
const { pnlSeries } = load('features/bots/pnl-series.ts');
const { buildBotPositionView } = load('features/bots/position-view.ts');
const lib = load('lib/fleet-fills.ts');
const model = load('features/bots/fleet-fills-model.ts');
const { FleetFillsView } = load('components/bots/FleetFillsPanel.tsx');

const now = Date.parse('2026-10-15T10:00:00Z');
const PAPER = 'meridian_v4_paper';
const example = name => JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/fleet_fills/${name}.example.json`, import.meta.url), 'utf8'));

/** A paper bot's reporting observation in the live runtime-status shape. */
function paperRuntime(bot = PAPER, over = {}) {
  return {
    runtime_status: {
      bot_name: bot, updated_at: new Date(now - 4_000).toISOString(), simulated: true,
      controllers: [{ controller_id: 'modular_spot_meridian_v4_paper_btc', pair: 'BTC-USDT', price_quote: 65000, state: 'HOLDING' }],
      active_executors: [], lifecycle_executors: [], positions_held: [{ controller_id: 'modular_spot_meridian_v4_paper_btc', pair: 'BTC-USDT', amount_base: 0.01, unrealized_pnl_quote: -1.5 }],
      summary: { pnl_available: true, realized_pnl_quote: 12.5, unrealized_pnl_quote: -1.5, fees_quote: 0.4, net_pnl_quote: 10.6 },
      ...over,
    },
    monitoring: { bot_name: bot, stale_threshold_seconds: 30 },
  };
}

test('a paper bot shows its simulated runtime PnL; a live bot never reads it', () => {
  const view = projectPaperRuntimePnl(paperRuntime(), PAPER, now);
  assert.deepEqual([view.total, view.realized, view.unrealized, view.quote, view.simulated, view.reason], [11, 12.5, -1.5, 'USDT', true, null]);
  assert.equal(projectPaperRuntimePnl(paperRuntime('rsi_modular_v2'), 'rsi_modular_v2', now).total, null);
  assert.match(projectPaperRuntimePnl(paperRuntime(PAPER, { updated_at: new Date(now - 600_000).toISOString() }), PAPER, now).reason, /stale/);
  assert.equal(projectPaperRuntimePnl(paperRuntime(PAPER, { simulated: false }), PAPER, now).total, null);
  assert.equal(projectPaperRuntimePnl(paperRuntime(PAPER, { summary: { pnl_available: false } }), PAPER, now).total, null);
  // The card's PnL: native controller performance for live bots, simulated runtime PnL for a paper bot.
  const paperCard = projectBotPnl(undefined, paperRuntime(), PAPER, now);
  assert.equal(paperCard.total, 11);
  assert.equal(paperCard.simulated, true);
  const liveCard = projectBotPnl(undefined, paperRuntime('rsi_modular_v2'), 'rsi_modular_v2', now);
  assert.equal(liveCard.total, null);
  assert.notEqual(liveCard.simulated, true);
});

test('a paper bot renders the same position view as a live bot from the live runtime shape', () => {
  const view = buildBotPositionView(paperRuntime(), PAPER, now);
  assert.equal(view.pairs.length, 1);
  assert.equal(view.pairs[0].pair, 'BTC-USDT');
  assert.equal(view.stale, false);
});

test('simulated history parses for a paper id only; live ids still require the native observer', () => {
  const body = (bot, source, simulated) => ({ source, simulated, bot_name: bot, range: '1D', coverage_start: 1, bucket_seconds: null, truncated: false,
    points: [1, 2].map(n => ({ timestamp: now / 1000 - 600 + n * 60, identity: 'i', segment: 's', quote: 'USDT', realized_pnl_quote: String(n), unrealized_pnl_quote: '0', total_pnl_quote: String(n) })) });
  assert.equal(projectPerformanceHistory(body(PAPER, 'reporting_paper_runtime', true), PAPER, now, '1D').change, 1);
  // The card sparkline series accepts the simulated history (its change still needs full-day coverage).
  assert.equal(pnlSeries(body(PAPER, 'reporting_paper_runtime', true), PAPER, now, '1D').points.length, 2);
  assert.equal(pnlSeries(body('rsi_modular_v2', 'reporting_paper_runtime', true), 'rsi_modular_v2', now, '1D').points.length, 0);
  assert.equal(projectPerformanceHistory(body(PAPER, 'reporting_paper_runtime', false), PAPER, now, '1D').change, null, 'a paper history must say it is simulated');
  assert.equal(projectPerformanceHistory(body(PAPER, 'native_mqtt_observer'), PAPER, now, '1D').change, null);
  assert.equal(projectPerformanceHistory(body('rsi_modular_v2', 'reporting_paper_runtime', true), 'rsi_modular_v2', now, '1D').change, null);
  assert.equal(projectPerformanceHistory(body('rsi_modular_v2', 'native_mqtt_observer'), 'rsi_modular_v2', now, '1D').change, 1);
});

test('the paper fills feed is requested and rendered as its own labelled panel', () => {
  assert.equal(lib.fleetFillsPath('v2', { scope: 'paper', limit: 50 }), '/api/v1/servers/v2/fleet/fills?scope=paper&limit=50');
  assert.equal(lib.fleetFillsPath('v2', { limit: 50 }), '/api/v1/servers/v2/fleet/fills?limit=50');
  const body = structuredClone(example('page_first'));
  body.scope = 'paper';
  body.items = body.items.map(item => ({ ...item, bot: PAPER, display_name: PAPER, generation: 'V4', paper: true }));
  body.bots = [{ ...body.bots[0], bot: PAPER, display_name: PAPER, generation: 'V4', paper: true }];
  const paperPage = lib.parseFleetFills(body);
  assert.equal(paperPage.scope, 'paper');
  assert.ok(paperPage.items.every(item => item.paper));
  assert.equal(lib.parseFleetFills(example('page_first')).scope, 'live');
  const view = model.projectFleetFills({ pages: [paperPage], error: null, pending: false, filtered: false });
  const html = renderToStaticMarkup(React.createElement(FleetFillsView, {
    view, filters: { bots: [], side: null, pair: null }, botOptions: [{ bot: PAPER, label: `V4 ${PAPER}` }], pairDraft: '', scope: 'paper',
    onToggleBot() {}, onSide() {}, onPairDraft() {}, onReset() {}, onLoadMore() {},
  }));
  assert.match(html, /Paper fills \(simulated\)/);
  assert.match(html, /never in live fills or Capital/);
  assert.match(html, /data-panel-id="B40-paper"|B40-paper/);
  assert.match(html, />PAPER</);
});
