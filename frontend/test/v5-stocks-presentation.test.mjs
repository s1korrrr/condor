import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import { frontendModules } from './helpers/frontend-module.mjs';

const now = Math.floor(Date.now() / 1000);
const identity = { region: 'eea', instId: 'EXAMPLE-USDT', instType: 'SPOT' };
const event = price => ({ ...identity, dataset: 'ticker', event_time_ms: now * 1000 - 1000, received_at_ms: now * 1000, source: 'ws', data: { last: price, bidPx: '9876.000000000000001', askPx: '9877.000000000000001', vol24h: '456.000000000000001', volCcy24h: '1234567.890123456789' } });
const channel = { state: 'live', age_s: 0, event_time_ms: now * 1000 - 1000, received_at_ms: now * 1000, reason: null };
const coverage = { capture_started_at: now - 3600, candle_start: null, candle_end: null, historical_trades: false, historical_books: false };
const instrument = { instId: identity.instId, instType: 'SPOT', instCategory: '3', state: 'live', quoteCcy: 'USDT', ruleType: 'normal' };
const latest = { ticker: event('123.456789012345678901'), mark_price: null, index_price: null, funding: null, open_interest: null };
const catalog = { format: 'okx-stocks-v1', ...identity, now, state: 'live', catalog_at: now, updated_at: now, reason: null, rows: [{ instrument, latest, channels: { ticker: channel }, coverage, captured: true }], capture: [{ instType: 'SPOT', instId: identity.instId, listed: true }] };
const market = { ...catalog, format: 'okx-stock-market-v1', latest: { ...latest, ticker: event('9876.543210'), books: null }, channels: { ticker: channel }, coverage, recent_trades: [], book_depth: null, captured: true };
const swap = { instId: 'AAPL-USDT-SWAP', instType: 'SWAP', instCategory: '3', state: 'live', quoteCcy: 'USDT', settleCcy: 'USDT' };
const listedOnly = { instrument: swap, latest: { ticker: null, mark_price: null, index_price: null, funding: null, open_interest: null }, channels: {}, coverage: { ...coverage, capture_started_at: null }, captured: false };

function render({ configured = true, data = catalog, failed = [], marketData = market } = {}) {
  const requests = [];
  const { load } = frontendModules({
    '@tanstack/react-query': { useQuery: options => {
      requests.push(options);
      const key = options.queryKey[0];
      const isError = failed.includes(key);
      return { isPending: false, isFetching: false, isError, error: isError ? new Error('owner_unreachable') : null, errorUpdatedAt: now * 1000, refetch() {}, data: key === 'stock-catalog' ? data : key === 'stock-market' ? marketData : undefined };
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

test('selected public fields format venue decimals while titles retain exact records', () => {
  const { html } = render();
  assert.match(html, /title="9876\.000000000000001">9,876/);
  assert.match(html, /title="9877\.000000000000001">9,877/);
  assert.match(html, /title="456\.000000000000001">456\.00/);
  assert.match(html, /All recorded market fields/);
  assert.match(html, /1234567\.890123456789/);
  const window = new Window();
  window.document.body.innerHTML = html;
  const record = [...window.document.querySelectorAll('pre')].find(pre => pre.title.includes('1234567.890123456789'));
  assert.ok(record);
  assert.doesNotMatch(record.textContent, /\d\.\d{9}/);
  window.close();
  assert.match(html, /Funding settlement \(UTC\)/);
  const { html: failed } = render({ failed: ['stock-market'] });
  assert.doesNotMatch(failed, /All recorded market fields|9876\.000000000000001|1234567\.890123456789/);
});

test('configured Stocks formats exponent, signed and integer numeric fields without changing identifiers or times', () => {
  const ticker = { ...event('1.234567890123e-20'), data: { last: '1.234567890123e-20', bidPx: '+99.78007932', askPx: '198961', vol24h: 12345 } };
  const instrumentWithValues = { ...instrument, tickSz: '+99.78007932', lotSz: '1.234567890123e-20', minSz: '198961', ctVal: null, maxLmtSz: '198961', maxMktSz: 198961, instIdCode: '123456789', instrumentCode: '001234', version: '001', listTime: '1700000000000' };
  const book = { ...event('0'), dataset: 'books', data: { bids: [['+99.78007932', '198961', '0', '3']], asks: [] } };
  const trade = { ...event('0'), dataset: 'trades', data: { tradeId: '1234567890123', count: '3', px: '1.234567890123e-20', sz: '+99.78007932', side: 'buy' } };
  const marketWithValues = { ...market, latest: { ...market.latest, ticker, books: book }, channels: { ticker: channel, books: channel, trades: channel }, recent_trades: [trade], book_depth: { bids: 1, asks: 0 } };
  const data = { ...catalog, rows: [{ ...catalog.rows[0], instrument: instrumentWithValues, latest: { ...latest, ticker } }] };
  const { html } = render({ data, marketData: marketWithValues });
  const window = new Window();
  window.document.body.innerHTML = html;
  const document = window.document;
  for (const [exact, display] of [['1.234567890123e-20', '0.0000'], ['+99.78007932', '99.78'], ['198961', '198,961'], ['12345', '12,345']]) {
    assert.ok([...document.querySelectorAll('[title]')].some(element => element.title === exact && element.textContent === display), `${exact} is formatted and retains its exact title`);
  }
  const records = [...document.querySelectorAll('pre')];
  const publicRecord = records.find(record => record.title.includes('1.234567890123e-20'));
  const metadataRecord = records.find(record => record.title.includes('1700000000000'));
  assert.ok(publicRecord && metadataRecord);
  const exactRecords = [...document.querySelectorAll('details')].filter(details => details.querySelector(':scope > summary')?.textContent === 'Exact record · as sent');
  assert.equal(exactRecords.length, 2, 'both market and metadata records have a keyboard and touch disclosure');
  assert.ok(exactRecords.some(details => details.querySelector('pre')?.textContent.includes('1.234567890123e-20')));
  assert.ok(exactRecords.some(details => details.querySelector('pre')?.textContent.includes('"instrumentCode": "001234"')));
  assert.match(publicRecord.textContent, /0\.0000/);
  assert.match(publicRecord.textContent, /99\.78/);
  assert.match(publicRecord.textContent, /198,961/);
  assert.match(publicRecord.textContent, /12,345/);
  assert.match(publicRecord.textContent, /1234567890123/);
  assert.doesNotMatch(publicRecord.textContent, /"count"/);
  assert.match(publicRecord.textContent, new RegExp(`"event_time_ms": ${ticker.event_time_ms}`));
  assert.match(publicRecord.textContent, /"3"/);
  assert.match(publicRecord.title, /\+99\.78007932/);
  assert.match(metadataRecord.textContent, /198,961/);
  assert.match(metadataRecord.textContent, /"maxLmtSz": "198,961"/);
  assert.match(metadataRecord.textContent, /"maxMktSz": "198,961"/);
  assert.match(metadataRecord.textContent, /"ctVal": null/);
  assert.doesNotMatch(metadataRecord.textContent, /"instIdCode"|"instrumentCode"|"version"/);
  assert.match(metadataRecord.textContent, /1700000000000/);
  assert.match(metadataRecord.textContent, /EXAMPLE-USDT/);
  window.close();
});

test('unknown Stocks fields appear only in the exact as-sent record', () => {
  const ticker = { ...event('123.45'), data: { last: '123.45', newPrice: '99.7800793' } };
  const { html } = render({ marketData: { ...market, latest: { ...market.latest, ticker } } });
  const window = new Window();
  window.document.body.innerHTML = html;
  const exact = [...window.document.querySelectorAll('details')].find(details => details.querySelector(':scope > summary')?.textContent === 'Exact record · as sent' && details.textContent.includes('newPrice'));
  const ordinary = [...window.document.querySelectorAll('pre[title]')].find(pre => pre.title.includes('newPrice'));
  assert.ok(ordinary);
  assert.doesNotMatch(ordinary.textContent, /newPrice|99\.7800793/);
  assert.match(ordinary.textContent, /"last": "123\.45"/);
  assert.ok(exact, 'unknown field remains available as sent');
  assert.match(exact.textContent, /99\.7800793/);
  window.close();
});

test('captured column labels captured and listed-only rows', () => {
  const { html } = render({ data: { ...catalog, rows: [...catalog.rows, listedOnly] } });
  assert.match(html, /Sort by Capture"><span>Capture<\/span>/);
  assert.match(html, /<td data-kind="text" title="Captured">Captured<\/td>/);
  assert.match(html, /<td data-kind="text" title="Not captured">Not captured<\/td>/);
  assert.match(html, /2 observed instruments match this product filter; 1 are captured/);
  assert.doesNotMatch(html, /Listed but not captured/);
});

test('selected listed-only instrument shows the exact allowlist entry instead of charts or reads', () => {
  const { html, requests } = render({ data: { ...catalog, rows: [listedOnly], capture: [] } });
  assert.match(html, /Listed but not captured/);
  assert.match(html, /<code class="v5-stock-entry">eea:SWAP:AAPL-USDT-SWAP<\/code>/);
  assert.match(html, /--stocks-instruments/);
  assert.match(html, /This is not a data gap/);
  assert.match(html, /Discovery only/);
  assert.doesNotMatch(html, /Recorded stock chart|9876\.543210|Selected public observations|Loading recorded trade candles/);
  for (const key of ['stock-market', 'stock-candles']) {
    assert.ok(requests.filter(request => request.queryKey[0] === key).every(request => request.enabled === false), `${key} must not read a listed-only instrument`);
  }
  assert.match(html, /Instrument metadata/);
});

test('a selected read that reports captured=false replaces its data with the notice', () => {
  const { html } = render({ marketData: { ...market, captured: false } });
  assert.match(html, /Listed but not captured/);
  assert.match(html, /eea:SPOT:EXAMPLE-USDT/);
  assert.doesNotMatch(html, /9876\.543210|Selected public observations|Recorded stock chart/);
});

test('allowlist entries missing from the catalog get a compact region notice', () => {
  const capture = [...catalog.capture, { instType: 'SWAP', instId: 'MISSING-USDT-SWAP', listed: false }];
  const { html } = render({ data: { ...catalog, capture } });
  assert.match(html, /1 capture allowlist entry is not in the current EEA catalog/);
  assert.match(html, /eea:SWAP:MISSING-USDT-SWAP/);
  assert.doesNotMatch(html, /eea:SPOT:EXAMPLE-USDT/);
  assert.doesNotMatch(render().html, /capture allowlist entr|Discovery only/);
  assert.doesNotMatch(render({ data: { ...catalog, state: 'disabled', reason: 'stocks_not_configured', rows: [], capture: [] } }).html, /Discovery only/);
});

test('catalog failure also removes the capture notices', () => {
  const capture = [{ instType: 'SWAP', instId: 'MISSING-USDT-SWAP', listed: false }];
  const { html } = render({ data: { ...catalog, rows: [listedOnly], capture }, failed: ['stock-catalog'] });
  assert.match(html, /Stock data read unavailable/);
  assert.doesNotMatch(html, /Listed but not captured|MISSING-USDT-SWAP|AAPL-USDT-SWAP|Not captured/);
});
