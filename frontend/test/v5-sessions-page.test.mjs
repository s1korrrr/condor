import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';

const row = (id, extra) => ({ id, agent_id: 'market_analyst', loop_id: null, status: 'COMPLETED', started_at_ms: 1793467481251, finished_at_ms: 1793467481300, summary: 'Source inspection started', effect: 'NONE', ...extra });

function render(sessions, context) {
  context.mock.method(Date, 'now', () => 1793929900000);
  const { load } = frontendModules({
    '@tanstack/react-query': { useQuery: () => ({ data: sessions, isPending: false, isError: false, refetch() {} }) },
    'react-router-dom': { Link: ({ to, children, ...props }) => React.createElement('a', { href: to, ...props }, children) },
    'react-markdown': {},
  });
  return renderToStaticMarkup(React.createElement(load('v5/V5Pages.tsx').SessionsPage));
}

test('the Sessions page says it is this dashboard\'s own action journal and points advisor reports to Agents', context => {
  const html = render([], context);
  assert.match(html, /Actions started from this dashboard: inspections, reports and loops\. Advisor reports are on Agents\./);
});

test('every row is labelled from its kind and old summaries read as plain words', context => {
  const html = render([
    row('a', { kind: 'inspect', summary: 'Inspected source snapshot snap-1; availability=1793467481251' }),
    row('b', { kind: 'report', summary: 'Report request started' }),
    row('c', { kind: 'loop', loop_id: 'market_analyst_monitor', summary: 'Loop started' }),
    row('d', { kind: 'inspect', agent_id: 'helm', summary: 'Inspected paper status helm_v5_paper; ready=True; controllers=3; mode=PAPER (simulated wallet)' }),
    row('e', { summary: 'Old row without a kind' }),
  ], context);
  assert.match(html, /market_analyst · Source inspection ·/);
  assert.match(html, /market_analyst · Report ·/);
  assert.match(html, /market_analyst · Report loop · market_analyst_monitor ·/);
  assert.match(html, /market_analyst · Kind not reported ·/);
  assert.match(html, /Inspected source snapshot snap-1; available 31 Oct 17:24 UTC/);
  assert.match(html, /Inspected paper status helm_v5_paper; ready; controllers=3/);
  assert.doesNotMatch(html, /availability=|ready=True/);
  assert.equal(html.match(/Source inspection</g)?.length ?? 0, 0, 'a non-loop row is no longer blanket-labelled "Source inspection"');
});
