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
const { Tradepad } = load(page);
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
