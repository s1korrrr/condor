import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { frontendModules } from './helpers/frontend-module.mjs';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const page = fileURLToPath(new URL('../../../dashboard/condor-workspace/src/pages/Tradepad.tsx', import.meta.url));
const { load } = frontendModules({
  '@tanstack/react-query': { useQuery: () => ({ isPending: false }) },
  '@/lib/auth-token': { authFetch: () => { throw new Error('No network'); } },
});
const { Tradepad, parsePaperCampaignJson, paperOwnerFreshness } = load(page);
const publication = 'w1772323200-1790812800';
function render(data) {
  return renderToStaticMarkup(React.createElement(Tradepad, { presentation: 'paper', paperPublicationId: publication, paperRead: { data, error: null, pending: false, refresh() {} } }));
}
test('paper Tradepad shows the deferred owner campaign and rejects invalid shapes', () => {
  const data = { schema: 'tradepad.bundle.v2', delivery: 'deferred-assets-v1', campaign: { id: publication }, datasets: [{ id: publication, source_index: [{}], strategies: [{ id: 'one', label: 'Buy and hold' }], metrics_only: [] }] };
  const html = render(data);
  assert.match(html, /1 source sessions/);
  assert.match(html, /Buy and hold/);
  assert.match(html, /Charts and source assets are not displayed/);
  assert.match(render({ ...data, delivery: 'full' }), /Not connected: Tradepad response has bad shape/);
  assert.match(render({ ...data, datasets: [null] }), /Not connected: Tradepad response has bad shape/);
});

test('failed refresh never presents retained data as current', () => {
  const data = { schema: 'tradepad.bundle.v2', delivery: 'deferred-assets-v1', campaign: { id: publication }, datasets: [{ id: publication, source_index: [], strategies: [{ id: 'one', label: 'Old campaign' }], metrics_only: [] }] };
  assert.match(render(data), /Old campaign/);
  const html = renderToStaticMarkup(React.createElement(Tradepad, { presentation: 'paper', paperPublicationId: publication, paperRead: { data, error: 'owner unavailable', pending: false, refresh() {} } }));
  assert.match(html, /owner unavailable/);
  assert.doesNotMatch(html, /Old campaign/);
  assert.throws(() => parsePaperCampaignJson('{'), SyntaxError);
});

test('decimal strings retain precision and trailing zeros', () => {
  const data = { schema: 'tradepad.bundle.v2', delivery: 'deferred-assets-v1', campaign: { id: publication }, datasets: [{ id: publication, source_index: [], strategies: [{ id: 'one', label: 'Example', metrics: { pnl: '9007199254740993.00' } }], metrics_only: [] }] };
  assert.match(render(data), /9007199254740993\.00/);
  const numberData = parsePaperCampaignJson(`{"schema":"tradepad.bundle.v2","delivery":"deferred-assets-v1","campaign":{"id":"${publication}"},"datasets":[{"id":"${publication}","source_index":[],"strategies":[{"id":"one","label":"Example","metrics":{"pnl":9007199254740993}}],"metrics_only":[]}]}`);
  assert.match(render(numberData), /9007199254740993/);
  assert.match(render(numberData), /owner publishes a float; shown as published/);
});

test('owner deadline expires as the clock advances and remains expired on repeat', () => {
  const data = { generated_at: '2026-10-29T12:00:00Z', fresh_until: '2026-10-29T12:01:00Z' };
  assert.match(paperOwnerFreshness(data, Date.parse('2026-10-29T12:00:30Z')), /within owner/);
  assert.match(paperOwnerFreshness(data, Date.parse('2026-10-29T12:01:00Z')), /not current.*expired/);
  assert.match(paperOwnerFreshness({ ...data }, Date.parse('2026-10-29T12:02:00Z')), /not current.*expired/);
});

test('mounted page crosses the owner deadline without another request', async () => {
  const { Window } = await import('happy-dom');
  const window = new Window({ url: 'https://fixture.invalid/' });
  const globals = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'IS_REACT_ACT_ENVIRONMENT'];
  const previous = new Map(globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, value: name === 'IS_REACT_ACT_ENVIRONMENT' ? true : name === 'window' ? window : window[name] });
  const originalNow = Date.now, originalInterval = globalThis.setInterval, originalClear = globalThis.clearInterval;
  let now = Date.parse('2026-10-29T12:00:30Z'), tick;
  Date.now = () => now;
  globalThis.setInterval = callback => { tick = callback; return 1; };
  globalThis.clearInterval = () => {};
  const { createRoot } = require('react-dom/client');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const data = { schema: 'tradepad.bundle.v2', delivery: 'deferred-assets-v1', generated_at: '2026-10-29T12:00:00Z', fresh_until: '2026-10-29T12:01:00Z', campaign: { id: publication }, datasets: [{ id: publication, source_index: [], strategies: [{ id: 'one', label: 'Published row' }], metrics_only: [] }] };
  const element = React.createElement(Tradepad, { presentation: 'paper', paperPublicationId: publication, paperRead: { data, error: null, pending: false, refresh() {} } });
  try {
    await React.act(async () => root.render(element));
    assert.match(container.textContent, /within owner freshness deadline/);
    now = Date.parse('2026-10-29T12:01:01Z');
    await React.act(async () => tick());
    assert.match(container.textContent, /not current · owner deadline expired/);
    await React.act(async () => root.render(element));
    assert.match(container.textContent, /not current · owner deadline expired/);
    const failed = React.createElement(Tradepad, { presentation: 'paper', paperPublicationId: publication, paperRead: { data, error: 'Not connected: upstream returned HTTP 503', pending: false, refresh() {} } });
    await React.act(async () => root.render(failed));
    assert.match(container.textContent, /HTTP 503/);
    assert.doesNotMatch(container.textContent, /Published row/);
  } finally {
    await React.act(async () => root.unmount());
    Date.now = originalNow; globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClear;
    for (const [name, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name];
  }
});

test('no deadline is not presented as current and long lists are bounded', () => {
  const data = { schema: 'tradepad.bundle.v2', delivery: 'deferred-assets-v1', generated_at: '2026-10-29T12:00:00Z', campaign: { id: publication }, datasets: [{ id: publication, source_index: [], strategies: Array.from({ length: 101 }, (_, index) => ({ id: String(index), label: `row-${index}` })), metrics_only: [] }] };
  const html = render(data);
  assert.match(html, /freshness deadline not published/i);
  assert.match(html, /first 100 of 101/i);
  assert.doesNotMatch(html, /row-100/);
});

test('future or missing owner generation never claims a deadline is current', () => {
  const now = Date.parse('2026-10-29T12:00:00Z');
  assert.match(paperOwnerFreshness({ generated_at: '2026-10-29T12:00:01Z', fresh_until: '2026-10-29T12:01:00Z' }, now), /freshness unknown.*owner clock ahead/);
  assert.match(paperOwnerFreshness({ fresh_until: '2026-10-29T12:01:00Z' }, now), /freshness unknown.*not published/);
});
