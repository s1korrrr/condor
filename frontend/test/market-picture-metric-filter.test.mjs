import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules, memoryStorage } from './helpers/frontend-module.mjs';
import * as model from '../src/features/market-picture/model.mjs';
import * as pulse from '../src/features/market-picture/pulse.mjs';
import * as contract from '../src/features/market-picture/contract.mjs';
import * as health from '../src/features/market-picture/health.mjs';
import * as cohorts from '../src/features/market-picture/metric-cohort.mjs';

const raw = JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/market-picture.m1-components.fixture.json', import.meta.url)));
const frame = contract.projectFrame(await contract.validateFrame(raw, { allowFixture: true }));
function* walk(node) {
  if (Array.isArray(node)) { for (const child of node) yield* walk(child); return; }
  if (!node || typeof node !== 'object' || !node.props) return;
  yield node;
  yield* walk(node.props.children);
}
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(text).join('') : node?.props ? text(node.props.children) : '';
function harness(t) {
  const globals = { location: globalThis.location, localStorage: globalThis.localStorage };
  globalThis.location = { search: '', origin: 'http://fixture.invalid', pathname: '/' };
  globalThis.localStorage = memoryStorage();
  t.after(() => Object.assign(globalThis, globals));
  let index = 0;
  const slots = [], downloads = [];
  let exported;
  const download = new Promise(resolve => { exported = resolve; });
  const react = { ...React, useEffect: () => {}, useMemo: fn => fn(), useCallback: fn => fn,
    useRef: value => ({ current: value }), useState(initial) {
      const slot = index++;
      if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial;
      return [slots[slot], value => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value; }];
    } };
  const source = { data: { frame: structuredClone(frame), components: {}, history: [], events: [], correlations: [], faults: {}, eventCursor: null }, frozen: false, loading: false };
  const { load } = frontendModules({ react, './model.mjs': { ...model, downloadFile: (...args) => { downloads.push(args); exported(args); } }, './pulse.mjs': pulse,
    './contract.mjs': contract, './health.mjs': health, './metric-cohort.mjs': cohorts,
    '@/lib/auth': {}, '@/hooks/useServer': {}, '@/lib/api': { api: {} }, './source': {}, './useMarketPicture': { useMarketPicture: () => source },
  }, { 'features/market-picture/AssetPanels.tsx': ['InstrumentsPanelView'] });
  const { MarketPictureSurface } = load('features/market-picture/MarketPicture.tsx');
  const render = () => { index = 0; return MarketPictureSurface({ server: 'fixture', userId: 'test', fixture: source.data }); };
  const find = (tree, file, name) => [...walk(tree)].find(node => node.type === load(`features/market-picture/${file}.tsx`)[name]);
  const instruments = () => find(render(), 'AssetPanels', 'InstrumentsPanel');
  const table = () => [...walk(load('features/market-picture/AssetPanels.tsx').InstrumentsPanelView(instruments().props))].find(node => node.type === load('features/quant-ops/kit/DataTable.tsx').DataTable);
  const select = request => find(render(), 'MarketPulse', 'MarketPulseHero').props.onSelectMetric(request);
  return { source, render, find, instruments, table, select, downloads, download, load };
}

test('breadth and participation clicks filter actual table rows; search composes and clear restores', t => {
  const h = harness(t);
  h.select({ kind: 'breadth', horizon: '15', side: 'advancing' });
  assert.deepEqual(h.table().props.rows.map(row => row.symbol), ['BTC', 'C000', 'ETH']);
  const selected = h.instruments().props.displayFilter;
  assert.equal(selected.valid, 5);
  assert.equal(selected.snapshotId, frame.snapshot_id);
  assert.match(text(h.render()), /Display filter.*3 matches.*5\/5 valid/);
  assert.equal(h.find(h.render(), 'MarketPulse', 'MarketPulseHero').props.frame.expected, 5, 'headlines retain the full owner universe');
  [...walk(h.render())].find(node => node.props['aria-label'] === 'Search market symbols').props.onChange({ target: { value: 'ETH' } });
  assert.deepEqual(h.table().props.rows.map(row => row.symbol), ['ETH']);
  [...walk(h.render())].find(node => node.props['aria-label'] === 'Clear metric filter').props.onClick();
  assert.equal(h.instruments().props.displayFilter, null);
  [...walk(h.render())].find(node => node.props['aria-label'] === 'Search market symbols').props.onChange({ target: { value: '' } });
  assert.equal(h.table().props.rows.length, 5);
  h.find(h.render(), 'OverviewPanels', 'ParticipationPanel').props.selectPredicate('above_ema21');
  assert.deepEqual(h.table().props.rows.map(row => row.symbol), ['BTC', 'C000', 'ETH']);
});

test('zero matches and unqualified selections never fall back to all instruments', t => {
  const h = harness(t);
  h.select({ kind: 'breadth', horizon: '15', side: 'unchanged' });
  assert.equal(h.instruments().props.displayFilter.status, 'available');
  assert.equal(h.table().props.rows.length, 0);
  assert.match(h.table().props.emptyText, /No instruments satisfy/);
  h.source.data.frame.breadth['15'].advancing = 5;
  h.select({ kind: 'breadth', horizon: '15', side: 'advancing' });
  assert.equal(h.instruments().props.displayFilter.status, 'unavailable');
  assert.equal(h.table().props.rows.length, 0);
  assert.match(h.table().props.emptyText, /BREADTH_CONTRIBUTORS_UNRECONCILED/);
});

test('refresh reevaluates a selected definition and refuses changed definitions', t => {
  const h = harness(t);
  h.select({ kind: 'breadth', horizon: '15', side: 'advancing' });
  const next = structuredClone(h.source.data.frame);
  next.snapshot_id = 'b'.repeat(64);
  next.assets[0].returns['15'].value = 1;
  next.assets[1].returns['15'].value = -1;
  h.source.data.frame = next;
  assert.deepEqual(h.table().props.rows.map(row => row.symbol), ['BNB', 'C000', 'ETH']);
  assert.equal(h.instruments().props.displayFilter.snapshotId, next.snapshot_id);
  next.breadth['15'].positive.definition = 'changed owner definition';
  assert.equal(h.instruments().props.displayFilter.status, 'unavailable');
  assert.equal(h.table().props.rows.length, 0);
  assert.match(h.table().props.emptyText, /DEFINITION_MISMATCH/);
});

test('daily filters retain their own valid population and exports carry the subset provenance', async t => {
  const h = harness(t);
  h.source.data.frame.dailyInternals = h.source.data.frame.dailyInternals.slice(2, 4);
  h.find(h.render(), 'MarketPulse', 'DailyInternalsPanel').props.onSelectMetric({ kind: 'daily-above', period: '20' });
  assert.deepEqual(h.table().props.rows.map(row => row.symbol), ['C000', 'ETH']);
  assert.equal(h.instruments().props.displayFilter.valid, 2);
  assert.equal(h.instruments().props.displayFilter.expected, 5);
  const metadata = h.table().props.exportMetadata;
  assert.equal(metadata.metric_definition, 'daily_sma_20_above_close');
  assert.equal(metadata.metric_valid, 2);
  assert.equal(metadata.snapshot_id, frame.snapshot_id);
  [...walk(h.render())].find(node => node.type === 'button' && text(node) === ' Export').props.onClick();
  const exportTree = h.render();
  await [...walk(exportTree)].find(node => node.type === 'button' && /Full context & research JSON/.test(text(node))).props.onClick();
  await h.download;
  const packet = JSON.parse(h.downloads.find(row => row[1] === 'application/json')[2]);
  assert.equal(packet.frame.snapshot_id, raw.snapshot_id);
  assert.equal(packet.full_universe_count, 5);
  assert.deepEqual(packet.metric_symbol_subset_ids, ['okx:spot:C000-USDC', 'okx:spot:ETH-USDC']);
  assert.equal(packet.instrument_selection_scope, 'metric_filter_and_symbol_search_before_table_controls');
  assert.equal(packet.display_instrument_ids, undefined);
  assert.equal(packet.metric_filter.valid, 2);
  assert.deepEqual(packet.metric_filter.instrumentIds, ['okx:spot:C000-USDC', 'okx:spot:ETH-USDC']);
  [...walk(exportTree)].find(node => node.type === 'button' && /Instrument subset CSV/.test(text(node))).props.onClick();
  const csv = h.downloads.find(row => row[1] === 'text/csv;charset=utf-8')[2];
  assert.match(csv, /metric_definition/);
  assert.match(csv, /daily_sma_20_above_close/);
  assert.match(csv, /okx:spot:ETH-USDC/);
  assert.doesNotMatch(csv, /okx:spot:BTC-USDC/);
  assert.equal(csv.split('\r\n').length, 3);
});

test('summary evidence keeps the native return and scoped source rows without fabricated history', async () => {
  const { load } = frontendModules({ './model.mjs': model, './pulse.mjs': pulse, './metric-cohort.mjs': cohorts,
    react: { ...React, useMemo: fn => fn() } }, { 'features/market-picture/MarketPulse.tsx': ['MarketSnapshotTilesView'] });
  const tiles = [];
  const tree = load('features/market-picture/MarketPulse.tsx').MarketSnapshotTilesView({ frame, history: [], window: '24h', horizon: '60', onInspect: tile => tiles.push(tile) });
  for (const node of walk(tree)) if (node.type === 'button' && node.props['aria-haspopup'] === 'dialog') node.props.onClick();
  const render = key => renderToStaticMarkup(React.createElement(load('features/market-picture/SummaryEvidence.tsx').SummaryEvidence, { selection: { tile: tiles.find(tile => tile.key === key), frame, samples: [], window: '24h' } }));
  const returns = render('equal_weight_return');
  assert.match(returns, /Owner return evidence/);
  assert.ok(returns.includes(frame.contributions["60"].equalReturn.original), "stored return retains native precision");
  assert.match(returns, /weight is not redistributed/);
  assert.doesNotMatch(returns, /<table/);
  const flows = render('spot_flow');
  assert.match(flows, /mp-summary-flow-observations-caption/);
  assert.doesNotMatch(flows, /mp-summary-book-observations-caption/);
  assert.match(flows, /not a market-wide imbalance/);
  assert.match(flows, /does not retain a comparable history series/);
  const books = render('spot_liquidity');
  assert.match(books, /mp-summary-book-observations-caption/);
  assert.doesNotMatch(books, /mp-summary-flow-observations-caption/);
});
