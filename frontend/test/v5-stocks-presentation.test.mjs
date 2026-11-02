import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';

const now = Math.floor(Date.now() / 1000);
const identity = { region: 'eea', instId: 'EXAMPLE-USDT', instType: 'SPOT' };
const event = price => ({ ...identity, dataset: 'ticker', event_time_ms: now * 1000 - 1000, received_at_ms: now * 1000, source: 'ws', data: { last: price, bidPx: '9876.000000000000001', askPx: '9877.000000000000001', vol24h: '456.000000000000001', volCcy24h: '1234567.890123456789' } });
const channel = { state: 'live', age_s: 0, event_time_ms: now * 1000 - 1000, received_at_ms: now * 1000, reason: null };
const coverage = { capture_started_at: now - 3600, candle_start: null, candle_end: null, historical_trades: false, historical_books: false };
const instrument = { instId: identity.instId, instType: 'SPOT', instCategory: '3', state: 'live', quoteCcy: 'USDT', ruleType: 'normal' };
const latest = { ticker: event('123.456789012345678901'), mark_price: null, index_price: null, funding: null, open_interest: null };
const catalog = { format: 'okx-stocks-v1', ...identity, now, state: 'live', catalog_at: now, updated_at: now, reason: null, rows: [{ instrument, latest, channels: { ticker: channel }, coverage }] };
const market = { ...catalog, format: 'okx-stock-market-v1', latest: { ...latest, ticker: event('9876.543210'), books: null }, channels: { ticker: channel }, coverage, recent_trades: [], book_depth: null };

function render({ configured = true, data = catalog, failed = [] } = {}) {
  const requests = [];
  const { load } = frontendModules({
    '@tanstack/react-query': { useQuery: options => {
      requests.push(options);
      const key = options.queryKey[0];
      const isError = failed.includes(key);
      return { isPending: false, isFetching: false, isError, error: isError ? new Error('owner_unreachable') : null, errorUpdatedAt: now * 1000, refetch() {}, data: key === 'stock-catalog' ? data : key === 'stock-market' ? market : undefined };
    } },
    '@/components/charts/RecordedCandleChart': { RecordedCandleChart: () => React.createElement('figure', { 'aria-label': 'Recorded stock chart' }) },
  });
  return { html: renderToStaticMarkup(React.createElement(load('v5/V5Stocks').V5Stocks, { configured })), requests };
}

test('unconfigured Stocks is explicit and issues no enabled data reads', () => {
  const { html, requests } = render({ configured: false });
  assert.match(html, /Stock data is not configured/);
  assert.doesNotMatch(html, /123\.456789|9876\.543210|Recorded stock chart/);
  assert.ok(requests.every(request => request.enabled === false));
});

test('successful empty catalog differs from a failed read and has no instrument selector', () => {
  const { html } = render({ data: { ...catalog, state: 'empty', rows: [] } });
  assert.match(html, /successful discovery returned no instruments/);
  assert.doesNotMatch(html, /<label>Instrument|owner_unreachable/);
});

test('catalog failure removes retained prices and the previous instrument choices', () => {
  const { html } = render({ failed: ['stock-catalog'] });
  assert.match(html, /Stock data read unavailable/);
  assert.doesNotMatch(html, /123\.456789|9876\.543210|<label>Instrument/);
});

test('selected detail failure cannot render its earlier success', () => {
  const { html } = render({ failed: ['stock-market'] });
  assert.match(html, /Public observations: owner_unreachable/);
  assert.doesNotMatch(html, /9876\.543210/);
  assert.match(html, /123\.456789012345678901/);
});

test('default region is EEA and spot derivative metrics are explicitly not applicable', () => {
  const { html, requests } = render();
  assert.equal(requests[0].queryKey[1], 'eea');
  assert.match(html, /Funding rate[\s\S]{0,180}Not applicable/);
  assert.match(html, /Mark price[\s\S]{0,180}Not applicable/);
  assert.match(html, /Public data does not establish account trading eligibility/);
  assert.doesNotMatch(html, /Place order|Buy stock|Sell stock/);
});

test('selected public fields keep exact venue decimals and expose the full recorded record', () => {
  const { html } = render();
  assert.match(html, /Best bid[\s\S]{0,180}9876\.000000000000001/);
  assert.match(html, /Best ask[\s\S]{0,180}9877\.000000000000001/);
  assert.match(html, /24h volume[\s\S]{0,180}456\.000000000000001/);
  assert.match(html, /All recorded market fields/);
  assert.match(html, /1234567\.890123456789/);
  assert.match(html, /Funding settlement \(UTC\)/);
  const { html: failed } = render({ failed: ['stock-market'] });
  assert.doesNotMatch(failed, /All recorded market fields|9876\.000000000000001|1234567\.890123456789/);
});
