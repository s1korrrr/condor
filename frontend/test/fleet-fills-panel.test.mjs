import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';

const calls = [];
const keep = Symbol('keepPreviousData');
const { load } = frontendModules({
  'react-router-dom': { Link: ({ to, children, ...rest }) => React.createElement('a', { href: to, ...rest }, children), useLocation: () => ({ hash: '' }) },
  '@tanstack/react-query': { keepPreviousData: keep, useInfiniteQuery: options => options },
  '@/lib/auth-token': { authFetch: async (path, init) => { calls.push({ path, init }); return responder(path); } },
});
let responder = async () => new Response('{}');
const lib = load('lib/fleet-fills.ts');
const model = load('features/bots/fleet-fills-model.ts');
const { FleetFillsView } = load('components/bots/FleetFillsPanel.tsx');
const { fleetFillColumns } = load('components/bots/fleet-fills-columns.tsx');
const { useFleetFills } = load('features/quant-ops/use-fleet-fills.ts');
const registry = load('features/quant-ops/panel-registry.ts');
const links = load('features/bots/chart-links.ts');
const example = name => JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/fleet_fills/${name}.example.json`, import.meta.url), 'utf8'));
const page = name => lib.parseFleetFills(example(name));

const noFilters = { bots: [], side: null, pair: null };
const render = (view, extra = {}) => renderToStaticMarkup(React.createElement(FleetFillsView, {
  view, filters: noFilters, botOptions: [{ bot: 'ok_rsi', label: 'V1 ok_rsi' }, { bot: 'meridian_v3', label: 'V3 meridian_v3' }], pairDraft: '',
  onToggleBot() {}, onSide() {}, onPairDraft() {}, onReset() {}, onLoadMore() {}, ...extra,
}));
/** A missing-status document derived from the partial example: every reader down. Only the status fields change. */
function allDown() {
  const body = structuredClone(example('page_partial'));
  body.status = 'missing'; body.reason = 'SOURCE_UNAVAILABLE'; body.items = []; body.has_more = false; body.next_cursor = null; body.matched = 0;
  for (const bot of body.bots) Object.assign(bot, { status: 'unavailable', reason: 'SOURCE_UNAVAILABLE', rows_read: 0, rows_accepted: 0 });
  return lib.parseFleetFills(body);
}

test('B40 is a registered bot panel and the Capital link lands on its anchor', () => {
  assert.ok(registry.BOT_PANELS.includes('B40'));
  assert.equal(new Set(registry.BOT_PANELS).size, registry.BOT_PANELS.length);
  assert.equal(links.fleetFillsHref(), '/bots#fleet-fills');
});

test('an ok feed renders every bot with its generation badge, a fresh glyph and the contract columns', () => {
  const pages = [page('page_first'), page('page_second')];
  const view = model.projectFleetFills({ pages });
  assert.equal(view.state.kind, 'fresh');
  assert.equal(view.rows.length, 7);
  assert.equal(view.matched, 7);
  assert.equal(view.hasMore, false);
  const html = render(view);
  assert.match(html, /data-panel-id="B40"/);
  assert.match(html, /data-state="fresh"/);
  for (const header of ['Time (UTC)', 'Bot', 'Side', 'Pair', 'Amount', 'Price', 'Volume', 'Fee', 'Receipt', 'PnL']) assert.match(html, new RegExp(`<span>${header.replace(/[()]/g, '\\$&')}</span>`));
  for (const badge of ['V1', 'V2', 'V3']) assert.match(html, new RegExp(`<span class="q-pill"[^>]*>${badge}</span>`));
  assert.match(html, /<\/span> meridian_v3<\/td>/, 'the generation is its own badge, not repeated in the name');
  assert.doesNotMatch(html, /V1 · ok_rsi|V1 V1/);
  assert.match(html, /Legacy 6dp/);
  assert.match(html, />Exact</);
  assert.match(html, /0\.0741 USDC/, 'fee carries its unit');
  assert.match(html, /<td data-kind="number"[^>]*>—<\/td>/, 'realized_pnl null is an absent value');
  assert.doesNotMatch(html, /Older fills are not part of this feed/);
  assert.doesNotMatch(html, /Load more fills/);
});

test('rows keep the server order and ids as row identity; the table sorts, filters and exports the raw decimals', () => {
  const view = model.projectFleetFills({ pages: [page('page_first')] });
  const column = id => fleetFillColumns.find(item => item.id === id);
  const row = view.rows[0];
  assert.deepEqual(fleetFillColumns.map(item => item.id), ['time', 'bot', 'side', 'pair', 'amount', 'price', 'volume', 'fee', 'receipt', 'pnl']);
  assert.equal(column('amount').value(row), row.amount, 'raw exact string for sort, filter and CSV');
  assert.equal(column('bot').value(row), 'V3 meridian_v3');
  assert.equal(column('pnl').value(row), null);
  assert.equal(column('time').value(row), new Date(row.time_ms).toISOString().replace('T', ' ').slice(0, 19));
  assert.equal(column('time').value({ ...row, time_ms: null }), null, 'an owner stamp without an offset is not guessed');
  assert.equal(column('fee').value({ ...row, fee: null }), null);
  assert.match(column('pnl').title(row), /no per-fill realised PnL/);
  assert.match(column('receipt').title({ ...row, receipt: 'legacy_6dp' }), /not promoted to exact/);
});

test('a partial feed shows the rows and a visible notice naming each unavailable bot and its reason', () => {
  const view = model.projectFleetFills({ pages: [page('page_partial')] });
  assert.equal(view.state.kind, 'incomplete');
  assert.match(view.state.reason, /V3 meridian_v3 \(the owner read failed or timed out\)/);
  assert.deepEqual(view.unavailable.map(bot => bot.bot), ['meridian_v3']);
  assert.equal(view.rows.length, 3);
  assert.equal(view.hasMore, true);
  const html = render(view);
  assert.match(html, /data-state="incomplete"/);
  assert.match(html, /<p class="q-notice" role="status">V3 meridian_v3 fills are not in this feed: the owner read failed or timed out\.<\/p>/);
  assert.match(html, /Load more fills/);
  assert.match(html, /3 of 5 matching loaded/);
});

test('a missing feed is its own unavailable state, never an empty "no fills" table', () => {
  const view = model.projectFleetFills({ pages: [allDown()] });
  assert.equal(view.state.kind, 'unavailable');
  assert.equal(view.missing, true);
  assert.deepEqual(view.rows, []);
  const html = render(view);
  assert.match(html, /data-state="unavailable"/);
  assert.match(html, /data-fleet-fills="unavailable"/);
  assert.match(html, /This is not &quot;no fills&quot;/);
  assert.doesNotMatch(html, /<table/);
  assert.doesNotMatch(html, /No fills recorded by any bot/);
  const noRegistry = allDown(); noRegistry.reason = 'NO_REGISTRY';
  assert.match(model.projectFleetFills({ pages: [noRegistry] }).state.reason, /no bot registry/);
});

test('an ok feed with no rows says no bot recorded fills; a filter that matches nothing says so differently', () => {
  const empty = structuredClone(example('page_first')); empty.items = []; empty.matched = 0; empty.has_more = false; empty.next_cursor = null;
  const view = model.projectFleetFills({ pages: [lib.parseFleetFills(empty)] });
  assert.equal(view.state.kind, 'fresh');
  assert.equal(view.emptyText, 'No fills recorded by any bot.');
  assert.match(render(view), /No fills recorded by any bot\./);
  assert.equal(model.projectFleetFills({ pages: [lib.parseFleetFills(empty)], filtered: true }).emptyText, 'No fill matches these filters.');
});

test('the end of a truncated window says older fills are not part of this feed, and only then', () => {
  const truncated = structuredClone(example('page_second'));
  truncated.window = { horizon_ms: 1799999900000, truncated: true, owner_limit: 500 };
  truncated.bots[0].saturated = true;
  const end = model.projectFleetFills({ pages: [lib.parseFleetFills(truncated)] });
  assert.match(end.footnote, /Older fills are not part of this feed/);
  assert.match(end.footnote, /newest 500 rows/);
  assert.match(end.footnote, /V1 ok_rsi reached that limit/);
  assert.match(render(end), /Older fills are not part of this feed/);
  const middle = structuredClone(example('page_first'));
  middle.window = { horizon_ms: 1799999900000, truncated: true, owner_limit: 500 };
  assert.equal(model.projectFleetFills({ pages: [lib.parseFleetFills(middle)] }).footnote, null, 'more pages follow');
});

test('paper bots and unattributable owner rows are named, not silently dropped', () => {
  const body = structuredClone(example('page_first'));
  body.bots.push({ ...structuredClone(body.bots[0]), bot: 'rsi_paper', display_name: 'rsi_paper', generation: null, paper: true, status: 'excluded', reason: 'PAPER_EXCLUDED' });
  body.bots[1].rejected = { NO_FILL_ID: 2, DUPLICATE: 1 };
  const view = model.projectFleetFills({ pages: [lib.parseFleetFills(body)] });
  assert.equal(view.state.kind, 'fresh');
  assert.match(view.footnote, /Not read \(paper\): rsi_paper/);
  assert.match(view.notices.join('\n'), /3 owner rows could not be attributed and are not listed \(NO_FILL_ID 2, DUPLICATE 1\)/);
});

test('read failures keep their kind: unauthorized, error, and stale rows after a failed refresh', () => {
  assert.equal(model.projectFleetFills({ pages: undefined, pending: true }).state.kind, 'collecting');
  assert.equal(model.projectFleetFills({ pages: undefined, error: Object.assign(new Error('x'), { status: 403 }) }).state.kind, 'unauthorized');
  const failed = model.projectFleetFills({ pages: undefined, error: new lib.FleetFillsError('Unsupported fleet fills schema fleet-fills.v2: update the dashboard.') });
  assert.equal(failed.state.kind, 'error');
  assert.match(failed.state.reason, /update the dashboard/);
  assert.equal(failed.missing, true);
  const stale = model.projectFleetFills({ pages: [page('page_first')], error: new Error('Fleet fills request failed (502)') });
  assert.equal(stale.state.kind, 'stale');
  assert.equal(stale.rows.length, 4, 'the last good rows stay visible');
});

test('cursor merge: loaded pages concatenate without duplicates and the last page decides whether more can load', () => {
  const view = model.projectFleetFills({ pages: [page('page_first'), page('page_second')] });
  assert.equal(new Set(view.rows.map(row => row.id)).size, 7);
  assert.equal(view.hasMore, false);
  assert.equal(model.projectFleetFills({ pages: [page('page_first')] }).hasMore, true);
});

test('filter controls render selected bots, side and an invalid pair hint', () => {
  const view = model.projectFleetFills({ pages: [page('page_filtered')], filtered: true });
  const html = render(view, { filters: { bots: ['ok_rsi'], side: 'sell', pair: null }, pairDraft: 'BNB-', updating: true });
  assert.match(html, /aria-pressed="true"[^>]*>V1 ok_rsi</);
  assert.match(html, /aria-pressed="false"[^>]*>V3 meridian_v3</);
  assert.match(html, /<option value="sell" selected="">Sells<\/option>/);
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, />Reset</);
  assert.match(html, /Updating…/);
  assert.deepEqual(model.pairFilterFromDraft('bnb/usdc'), { pair: 'BNB-USDC', valid: true });
  assert.deepEqual(model.pairFilterFromDraft(''), { pair: null, valid: true });
  assert.deepEqual(model.pairFilterFromDraft('BNB'), { pair: null, valid: false });
});

test('the hook polls every 30s, pages by cursor, keeps previous rows while a filter loads and sends filters to the server', async () => {
  const options = useFleetFills('v2', { bots: ['rsi_modular_v2', 'meridian_v3'], side: 'buy', pair: 'BNB-USDC' });
  assert.equal(options.refetchInterval, 30_000);
  assert.equal(options.placeholderData, keep);
  assert.equal(options.retry, false);
  assert.equal(options.enabled, true);
  assert.deepEqual(options.queryKey, ['fleet-fills', 'v2', 50, ['meridian_v3', 'rsi_modular_v2'], 'buy', 'BNB-USDC']);
  assert.equal(useFleetFills(null).enabled, false);
  assert.equal(options.getNextPageParam(page('page_first')), page('page_first').next_cursor);
  assert.equal(options.getNextPageParam(page('page_second')), undefined);
  responder = async () => new Response(JSON.stringify(example('page_first')), { status: 200 });
  const result = await options.queryFn({ pageParam: 'CURSOR', signal: new AbortController().signal });
  assert.equal(result.items.length, 4);
  assert.equal(calls.at(-1).path, '/api/v1/servers/v2/fleet/fills?limit=50&before=CURSOR&bot=meridian_v3&bot=rsi_modular_v2&side=buy&pair=BNB-USDC');
  await options.queryFn({ pageParam: null, signal: new AbortController().signal });
  assert.doesNotMatch(calls.at(-1).path, /before=/);
  responder = async () => new Response('{}', { status: 502 });
  await assert.rejects(options.queryFn({ pageParam: null, signal: new AbortController().signal }), error => error.status === 502);
  responder = async () => new Response(JSON.stringify({ ...example('page_first'), schema_version: 'fleet-fills.v2' }), { status: 200 });
  await assert.rejects(options.queryFn({ pageParam: null, signal: new AbortController().signal }), /Unsupported fleet fills schema/);
});
