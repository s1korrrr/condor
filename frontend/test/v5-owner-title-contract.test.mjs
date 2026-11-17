import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import * as ReactQuery from '@tanstack/react-query';

const { load } = frontendModules();
const { OwnerValue } = load('v5/OwnerValue.tsx');
const overrides = Object.fromEntries(['@/components/bots/AggregatedPnlChart', '@/components/bots/ControllerBrowser', '@/components/bots/DeployBotDialog', '@/components/bots/PnlSparkline', '@/hooks/useWebSocket', '@/hooks/useRates'].map(name => [name, {}]));
overrides['@/components/charts/RecordedCandleChart'] = { RecordedCandleChart: () => null };
overrides['@tanstack/react-query'] = { ...ReactQuery, useQuery: () => ({ data: undefined, isPending: true, isError: false }) };
const baselineSource = (filename, source) => process.env.V5_TITLE_BASELINE
  ? execFileSync('git', ['show', `${process.env.V5_TITLE_BASELINE}:frontend/src/${path.relative(path.resolve(import.meta.dirname, '../src'), filename)}`], { cwd: path.resolve(import.meta.dirname, '../..'), encoding: 'utf8' }) : source;
const modules = frontendModules(overrides, { 'pages/tabs/ActiveBotsTab.tsx': ['PaperMetric'] }, baselineSource);
const { PaperMetric } = modules.load('pages/tabs/ActiveBotsTab.tsx');

for (const [label, value, expected] of [
  ['live profit', '114.1396691483993272381433853', '≈ 114.139669148399 (rounded)'],
  ['live wallet', '199123.96997705845820', '≈ 199123.969977058458 (rounded)'],
  ['twelve-place padded control', '199123.96997705845800', '199123.96997705845800'],
]) {
  test(`Bots ${label} title uses the shared owner rule`, () => {
    const html = renderToStaticMarkup(React.createElement(PaperMetric, { label: 'Owner value', value: '114.14 USDC', exact: value }));
    assert.ok(html.includes(`title="${expected}"`), html);
  });
}

test('live breakeven expression rounds each input, not just its result', () => {
  const { breakEvenDistanceDetail } = modules.load('v5/bots-position-model.mjs');
  const distance = breakEvenDistanceDetail('680.8963033983613722931914460', 594.17);
  const html = renderToStaticMarkup(React.createElement(modules.load('v5/OwnerValue.tsx').OwnerValue, { value: '14.5962', kind: 'pct', exact: distance.exact }));
  assert.match(html, /title="\(≈ 680\.896303398361 \(rounded\) − 594\.17\) × 100 \/ 594\.17 = ≈ 14\.5962 % \(rounded\)"/);
});

test('Trades exact overrides cannot bypass rounding, including negative ties and carry', () => {
  for (const [value, expected] of [
    ['1.1234567890125', '≈ 1.123456789013 (rounded)'],
    ['-1.1234567890125', '≈ −1.123456789013 (rounded)'],
    ['9.9999999999995', '≈ 10 (rounded)'],
  ]) {
    const html = renderToStaticMarkup(React.createElement(modules.load('v5/OwnerValue.tsx').OwnerValue, { value: '0', kind: 'coin', exact: value }));
    assert.ok(html.includes(`title="${expected}"`), html);
  }
});

test('owner title expressions leave IDs and words unchanged', () => {
  const exact = 'owner abc123.12345678901234567890 · owner task-1.12345678901234567890 · SHA deadbeef · not published';
  assert.ok(renderToStaticMarkup(React.createElement(OwnerValue, { value: '1', kind: 'coin', exact })).includes(`title="${exact}"`));
});

test('owner expressions handle leading-dot decimals, Unicode minus, and exponents', () => {
  const html = renderToStaticMarkup(React.createElement(modules.load('v5/OwnerValue.tsx').OwnerValue, { value: '1', kind: 'coin', exact: '(.1234567890125 − −1.1234567890125) / 1e-13' }));
  assert.ok(html.includes('title="(≈ 0.123456789013 (rounded) − ≈ −1.123456789013 (rounded)) / ≈ 0 (rounded)"'), html);
});

test('phone row summaries and expanded fields do not reintroduce raw owner titles', () => {
  const { Rows } = modules.load('features/quant-ops/kit/Rows.tsx');
  const value = '114.1396691483993272381433853';
  const html = renderToStaticMarkup(React.createElement(Rows, { rows: [{ value }], rowId: () => 'owner', label: 'Owner values', columns: [
    { id: 'value', header: 'Profit', value: row => row.value, cell: row => React.createElement(modules.load('v5/OwnerValue.tsx').OwnerValue, { value: row.value, kind: 'usdc' }) },
  ] }));
  assert.ok(!html.includes(`title="${value}"`), html);
  assert.equal(html.match(/title="≈ 114\.139669148399 \(rounded\)"/g)?.length, 4);
});

test('Bots cash and traded-volume tiles use two decimals like the money summary', () => {
  const reads = ['status', 'wallet', 'positions', 'executors', 'fills', 'risk', 'decisions', 'history', 'operations', 'accounting'].map(section => JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/paper-api-final3/native-replay/${section}.json`, import.meta.url))));
  const now = reads[0].generated_at_ms;
  const html = renderToStaticMarkup(React.createElement(modules.load('pages/tabs/ActiveBotsTab.tsx').PaperWorkspace, { reads, accountingRead: reads.at(-1), now, reportAt: now, heartbeat: 'Fresh', bot: reads[0].bot_id }));
  for (const label of ['Available cash', 'Traded volume']) {
    const value = html.match(new RegExp(`<dt>${label}</dt><dd[^>]*>([^<]+)</dd>`))?.[1];
    assert.match(value ?? '', /^[\d,]+\.\d{2} USDC$/, `${label}: ${value}`);
  }
});
