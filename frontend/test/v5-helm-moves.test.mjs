// Helm's own moves are shown: each coin's last decision (time, age, reason) and a headline that never says "idle" while
// a decision is recent. Missing values say "not published". No executor count is shown anywhere.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { frontendModules } from './helpers/frontend-module.mjs';
import { helmHeadline, helmLastDecision } from '../src/v5/helm-model.mjs';

const NOW_S = 1793929900;
const GATE = [{ gate: 'ready', note: '' }];
const coin = (pair, last_decision, extra = {}) => ({ pair, status: 'portfolio_grant_required', candidate_hold: 'no_rebound', signal: null, bag: null, last_decision, ...extra });
const status = (extra = {}) => ({ generated_at: NOW_S, age_s: 0, reasons: [], ready: true, withheld: 0, gates: GATE, control_rejections: { count: 0, recent: [] }, actions: 350, steps: 1000, symbols: [coin('BNB-USDC', null)], ...extra });

function render(extra = {}) {
  const { load } = frontendModules({
    '@tanstack/react-query': { useQuery: () => ({ data: { state: 'FRESH', status: status(extra), bot: 'helm_v5_paper', observed_at: NOW_S }, dataUpdatedAt: Date.now(), refetch() {} }) },
  });
  return renderToStaticMarkup(React.createElement(load('v5/V5Helm').V5Helm));
}

test('a recent decision shows its time, age and reason on the coin row', context => {
  context.mock.method(Date, 'now', () => NOW_S * 1000);
  const html = render({ symbols: [coin('BNB-USDC', { at: NOW_S - 125, reason: 'store_executor_action' })] });
  assert.match(html, /<th>Last decision<\/th>/);
  assert.match(html, /<td><span>6 Nov 01:49 UTC · 2 min ago · store executor action<\/span><\/td>/);
  assert.match(html, /<dt>Last decision<\/dt><dd><span>6 Nov 01:49 UTC · 2 min ago · store executor action<\/span><\/dd>/);
  assert.doesNotMatch(html, /not published<\/span><\/td>/);
});

test('a missing decision says not published, and a half-published one says which half', () => {
  assert.equal(helmLastDecision(coin('BNB-USDC', null), { nowS: NOW_S }), 'not published');
  assert.equal(helmLastDecision({ pair: 'BNB-USDC' }, { nowS: NOW_S }), 'not published');
  assert.equal(helmLastDecision(coin('BNB-USDC', { at: NOW_S - 30, reason: null }), { nowS: NOW_S }), '6 Nov 01:51 UTC · 30 s ago · reason not published');
  assert.equal(helmLastDecision(coin('BNB-USDC', { at: null, reason: 'no_rebound' }), { nowS: NOW_S }), 'time not published · no rebound');
  assert.match(helmLastDecision(coin('BNB-USDC', { at: NOW_S + 60, reason: 'x' }), { nowS: NOW_S }), /ahead of this read/);
});

test('a recent decision keeps the page from saying idle and is named in the headline detail', context => {
  context.mock.method(Date, 'now', () => NOW_S * 1000);
  const html = render({ symbols: [coin('BNB-USDC', { at: NOW_S - 1900, reason: 'store_executor_action' })] });
  assert.match(html, /<strong>Helm paper bot: Running, waiting for a signal<\/strong>/);
  assert.match(html, /No coin has an entry signal: no rebound\. Latest decision: BNB-USDC 6 Nov 01:20 UTC · 31 min ago · store executor action\./);
  assert.doesNotMatch(html, /idle/i);
});

test('no executor count appears on the page, whatever the status carries', context => {
  context.mock.method(Date, 'now', () => NOW_S * 1000);
  const html = render({ symbols: [coin('BNB-USDC', { at: NOW_S - 40, reason: 'sell_placed' })] });
  assert.doesNotMatch(html, /executors/i);
  assert.doesNotMatch(html, /Active executor/i);
});

function renderOverview(extra) {
  const data = { state: 'FRESH', status: status(extra), bot: 'helm_v5_paper', observed_at: NOW_S };
  const { load } = frontendModules({
    '@tanstack/react-query': { useQuery: ({ queryKey }) => ({ data: queryKey[0] === 'v5-helm' ? data : undefined, dataUpdatedAt: NOW_S * 1000, isPending: queryKey[0] !== 'v5-helm' }) },
    './V5Money': { V5Money: () => null, readMoney() {} },
    './V5Helm': { readHelm() {} },
  });
  return renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(load('v5/V5Overview.tsx').V5Overview)));
}

test('Overview names the same latest decision and no count', context => {
  context.mock.method(Date, 'now', () => NOW_S * 1000);
  const html = renderOverview({ symbols: [coin('BNB-USDC', { at: NOW_S - 125, reason: 'store_executor_action' })] });
  assert.match(html, /<strong>Running, waiting for a signal<\/strong>/);
  assert.match(html, /Latest decision: BNB-USDC 6 Nov 01:49 UTC · 2 min ago · store executor action\./);
  assert.doesNotMatch(html, /active executor/i);
});

test('nothing published: the page says what is missing, not idle', context => {
  context.mock.method(Date, 'now', () => NOW_S * 1000);
  const html = render();
  assert.match(html, /<td><span class="v5m-muted">not published<\/span><\/td>/);
  assert.match(html, /<dt>Last decision<\/dt><dd><span class="v5m-muted">not published<\/span><\/dd>/);
  assert.match(html, /No decision time published\./);
  assert.match(html, /Running, waiting for a signal/);
  assert.doesNotMatch(html, /idle/i);
});

test('mixed holds keep the coin list and add the latest decision', () => {
  const headline = helmHeadline({ state: 'FRESH', status: status({ symbols: [coin('ETH-USDC', { at: NOW_S - 40, reason: 'sell_placed' }, { candidate_hold: 'bag_gap_not_met' })] }) }, { nowS: NOW_S });
  assert.equal(headline.text, 'Running, entry gate ready');
  assert.equal(headline.detail, 'ETH-USDC: bag gap not met. Latest decision: ETH-USDC 6 Nov 01:51 UTC · 40 s ago · sell placed.');
});
