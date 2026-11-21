// Helm's own moves are shown: each coin's last decision (time, age, reason), the active-executor count, and a headline
// that never says "idle" when an executor is active or a decision is recent. Missing values say "not published".
import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { frontendModules } from './helpers/frontend-module.mjs';
import { helmExecutors, helmHeadline, helmLastDecision } from '../src/v5/helm-model.mjs';

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

test('a fresh executor count is shown with its report time and keeps the page from saying idle', context => {
  context.mock.method(Date, 'now', () => NOW_S * 1000);
  const html = render({ active_executors: { count: 3, observed_at: NOW_S - 5 }, symbols: [coin('BNB-USDC', { at: NOW_S - 1900, reason: 'store_executor_action' })] });
  assert.match(html, /<span>Active executors<\/span><strong>3<\/strong> <small>reported 6 Nov 01:51 UTC · 5 s ago<\/small>/);
  assert.match(html, /Running, no entry signal · 3 active executors/);
  assert.match(html, /No coin has an entry signal: no rebound\. Activity: 3 active executors · latest decision BNB-USDC 6 Nov 01:20 UTC · 31 min ago · store executor action\./);
  assert.doesNotMatch(html, /idle/i);
});

test('a count observed an hour ago is not the headline: it is qualified with its own time in the detail', context => {
  context.mock.method(Date, 'now', () => NOW_S * 1000);
  // The status file is fresh (generated now), but the executor snapshot inside it is an hour old.
  const html = render({ active_executors: { count: 3, observed_at: NOW_S - 3600 }, symbols: [coin('BNB-USDC', { at: NOW_S - 1900, reason: 'store_executor_action' })] });
  assert.match(html, /<span>Active executors<\/span><strong>3<\/strong> <small>reported 6 Nov 00:51 UTC · 60 min ago<\/small>/);
  assert.match(html, /<strong>Helm paper bot: Running, waiting for a signal<\/strong>/);
  assert.doesNotMatch(html, /Helm paper bot: [^<]*active executor/);
  assert.match(html, /Activity: 3 active executors as of 6 Nov 00:51 UTC \(60 min ago\) · latest decision BNB-USDC/);
  assert.doesNotMatch(html, /idle/i);
});

test('the count stays in the headline up to the status freshness bound and not a second past it', () => {
  const at = observed => helmHeadline({ state: 'FRESH', status: status({ active_executors: { count: 2, observed_at: observed } }) }, { nowS: NOW_S });
  assert.equal(at(NOW_S - 30).text, 'Running, no entry signal · 2 active executors');
  assert.equal(at(NOW_S - 31).text, 'Running, waiting for a signal');
  assert.match(at(NOW_S - 31).detail, /Activity: 2 active executors as of 6 Nov 01:51 UTC \(31 s ago\) · /);
  assert.equal(at(NOW_S + 10).text, 'Running, waiting for a signal');
  assert.match(at(NOW_S + 10).detail, /Activity: 2 active executors as of 6 Nov 01:51 UTC \(ahead of this read\) · /);
});

test('an undated count says so, stays out of the headline and is not made current by a fresh status file', context => {
  context.mock.method(Date, 'now', () => NOW_S * 1000);
  const html = render({ active_executors: { count: 3, observed_at: null } });
  assert.match(html, /<span>Active executors<\/span><strong>3<\/strong> <small>count time not published<\/small>/);
  assert.match(html, /<strong>Helm paper bot: Running, waiting for a signal<\/strong>/);
  assert.match(html, /Activity: 3 active executors, count time not published · /);
  const unknownClock = helmHeadline({ state: 'FRESH', status: status({ active_executors: { count: 3, observed_at: NOW_S } }) });
  assert.equal(unknownClock.text, 'Running, waiting for a signal');
  assert.match(unknownClock.detail, /3 active executors as of 6 Nov 01:51 UTC/);
});

test('a partly covered roster says how many controllers it covered and never reads as zero', context => {
  context.mock.method(Date, 'now', () => NOW_S * 1000);
  const partial = { count: null, covered: 1, of: 2 };
  assert.deepEqual(helmExecutors(status({ active_executors: partial }), { nowS: NOW_S }), { value: 'Not published', note: 'incomplete: 1 of 2 controllers', count: null, current: false, incomplete: 'incomplete: 1 of 2 controllers' });
  const html = render({ active_executors: partial });
  assert.match(html, /<span>Active executors<\/span><strong>Not published<\/strong> <small>incomplete: 1 of 2 controllers<\/small>/);
  assert.match(html, /Activity: active executors not published \(incomplete: 1 of 2 controllers\) · /);
  assert.doesNotMatch(html, /no active executors/);
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

test('Overview qualifies the count the same way: fresh in the headline, old or undated only in the detail', context => {
  context.mock.method(Date, 'now', () => NOW_S * 1000);
  const fresh = renderOverview({ active_executors: { count: 3, observed_at: NOW_S - 5 } });
  assert.match(fresh, /<strong>Running, no entry signal · 3 active executors<\/strong>/);
  const old = renderOverview({ active_executors: { count: 3, observed_at: NOW_S - 3600 } });
  assert.match(old, /<strong>Running, waiting for a signal<\/strong>/);
  assert.match(old, /Activity: 3 active executors as of 6 Nov 00:51 UTC \(60 min ago\)/);
  const undated = renderOverview({ active_executors: { count: 3, observed_at: null } });
  assert.match(undated, /<strong>Running, waiting for a signal<\/strong>/);
  assert.match(undated, /Activity: 3 active executors, count time not published/);
  // Judged as of the read, like the status: a count observed 40 s before it is past the bound.
  const aging = renderOverview({ active_executors: { count: 3, observed_at: NOW_S - 40 } });
  assert.match(aging, /<strong>Running, waiting for a signal<\/strong>/);
  assert.match(aging, /3 active executors as of 6 Nov 01:51 UTC \(40 s ago\)/);
});

test('a published zero is zero, an unpublished count is never zero', () => {
  assert.deepEqual(helmExecutors(status({ active_executors: { count: 0, observed_at: NOW_S - 5 } }), { nowS: NOW_S }), { value: '0', note: 'reported 6 Nov 01:51 UTC · 5 s ago', count: 0, current: true, when: '6 Nov 01:51 UTC (5 s ago)' });
  assert.equal(helmExecutors(status({ active_executors: { count: 2, observed_at: null } }), { nowS: NOW_S }).note, 'count time not published');
  for (const missing of [status(), status({ active_executors: null }), status({ active_executors: { count: null, observed_at: 1 } })]) {
    const shown = helmExecutors(missing, { nowS: NOW_S });
    assert.equal(shown.value, 'Not published');
    assert.equal(shown.count, null);
    assert.doesNotMatch(shown.value, /^0$/);
  }
});

test('nothing published: the page says what is missing, not idle or zero', context => {
  context.mock.method(Date, 'now', () => NOW_S * 1000);
  const html = render();
  assert.match(html, /<span>Active executors<\/span><strong>Not published<\/strong>/);
  assert.match(html, /<td><span class="v5m-muted">not published<\/span><\/td>/);
  assert.match(html, /<dt>Last decision<\/dt><dd><span class="v5m-muted">not published<\/span><\/dd>/);
  assert.match(html, /Activity: active executors not published · no decision time published\./);
  assert.match(html, /Running, waiting for a signal/);
  assert.doesNotMatch(html, /idle/i);
});

test('with no active executor published as zero the activity line says so', () => {
  const headline = helmHeadline({ state: 'FRESH', status: status({ active_executors: { count: 0, observed_at: NOW_S } }) }, { nowS: NOW_S });
  assert.equal(headline.text, 'Running, waiting for a signal');
  assert.match(headline.detail, /Activity: no active executors · no decision time published\./);
});

test('mixed holds keep the coin list and add the same activity line', () => {
  const headline = helmHeadline({ state: 'FRESH', status: status({ active_executors: { count: 1, observed_at: NOW_S }, symbols: [coin('ETH-USDC', { at: NOW_S - 40, reason: 'sell_placed' }, { candidate_hold: 'bag_gap_not_met' })] }) }, { nowS: NOW_S });
  assert.equal(headline.text, 'Running, entry gate ready');
  assert.equal(headline.detail, 'ETH-USDC: bag gap not met. Activity: 1 active executor · latest decision ETH-USDC 6 Nov 01:51 UTC · 40 s ago · sell placed.');
});
