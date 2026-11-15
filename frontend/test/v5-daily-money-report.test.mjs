import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const day = Date.UTC(2026, 10, 14), slot = 300_000, dayMs = 86_400_000;
const U = 'UNAVAILABLE';
const row = (minute, fields = {}) => ({ bot: 'v5', at_ms: day + minute * 60_000, unit: 'USDC', equity: '100', realized: '10', fees: '1', unrealized: '-2', ...fields });
function python(args, input) {
  return spawnSync(process.env.PYTHON ?? 'python3', args, { cwd: root, input, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
}
function report(rows, start = day, end = day + dayMs, as_of_ms = end) {
  const result = python(['-c', 'import json,sys; from condor.v5.daily_money import daily_report; p=json.load(sys.stdin); print(json.dumps(daily_report(**p)))'], JSON.stringify({ rows, start_ms: start, end_ms: end, as_of_ms }));
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('UTC boundaries select first/last recorded samples, exclude next midnight, and retain both bots', () => {
  const rows = report([row(-1, { equity: '1' }), row(1439, { equity: '110', realized: '13', fees: '1.2' }), row(0), row(1440, { equity: '900' })]);
  assert.equal(rows.length, 2);
  const [v5, helm] = rows;
  assert.equal(v5.equity_start, '100');
  assert.equal(v5.equity_end, '110');
  assert.equal(v5.equity_change, '10');
  assert.equal(v5.equity_change_pct, '10.000000000000');
  assert.equal(v5.realized_pnl, '3');
  assert.equal(v5.fees, '0.2');
  assert.equal(v5.unrealized_pnl_end, '-2');
  assert.equal(v5.partial, false);
  assert.equal(v5.missing_slots, 286);
  assert.equal(helm.bot, 'helm');
  assert.equal(helm.equity_end, U);
});

test('missing days and missing bot data get explicit unavailable rows', () => {
  const rows = report([row(0), row(2880)], day, day + 3 * dayMs);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map(item => item.bot), ['v5', 'helm', 'v5', 'helm', 'v5', 'helm']);
  for (const item of rows.filter(item => item.date === '2026-11-15')) {
    assert.equal(item.samples, 0);
    assert.equal(item.missing_slots, 288);
    assert.equal(item.equity_change, U);
    assert.equal(item.partial, true);
  }
  for (const item of report([])) {
    for (const key of ['equity_start', 'equity_end', 'equity_change', 'equity_change_pct', 'realized_pnl', 'fees', 'unrealized_pnl_end', 'buys', 'sells', 'fills', 'cash_end', 'held_value_end']) assert.equal(item[key], U, key);
  }
});

test('gaps at endpoints are never replaced by the nearest good value', () => {
  const [v5] = report([row(0, { gap: 'wallet: stale' }), row(5), row(1435, { gap: 'accounting: degraded' })]);
  assert.equal(v5.equity_start, U);
  assert.equal(v5.equity_end, U);
  assert.equal(v5.realized_pnl, U);
  assert.equal(v5.unrealized_pnl_end, U);
  assert.equal(v5.present_slots, 3);
  assert.equal(v5.value_slots, 1);
  assert.equal(v5.gaps, 2);
  assert.match(v5.data_quality, /wallet: stale/);
});

test('sampler restart duplicates never inflate coverage or synthesize midnight values', () => {
  const [v5] = report([row(600), row(600.5), row(610, { equity: '101' })]);
  assert.equal(v5.samples, 3);
  assert.equal(v5.present_slots, 2);
  assert.equal(v5.missing_slots, 286);
  assert.equal(v5.partial, true);
  assert.equal(v5.first_at_ms, day + 600 * 60_000);
  assert.equal(v5.equity_change, '1');
  assert.match(v5.data_quality, /1 duplicate-slot samples/);
  const [full] = report(Array.from({ length: 288 }, (_, i) => row(i * 5)));
  assert.equal(full.present_slots, 288);
  assert.equal(full.partial, false);
  assert.equal(full.missing_slots, 0);
});

test('money arithmetic retains 18 integer and 30 fraction digits without Decimal default-context rounding', () => {
  const [v5] = report([row(0, { equity: '999999999999999999.000000000000000000000000000001', realized: '0.000000000000000000000000000001', fees: '1.000000000000000000000000000001' }), row(1435, { equity: '999999999999999999.000000000000000000000000000003', realized: '0.000000000000000000000000000003', fees: '1.000000000000000000000000000004' })]);
  assert.equal(v5.equity_change, '0.000000000000000000000000000002');
  assert.equal(v5.realized_pnl, '0.000000000000000000000000000002');
  assert.equal(v5.fees, '0.000000000000000000000000000003');
  assert.equal(v5.equity_end, '999999999999999999.000000000000000000000000000003');
});

test('an ongoing day stays partial even after its last slot starts; future samples are excluded', () => {
  const rows = Array.from({ length: 288 }, (_, i) => row(i * 5));
  assert.equal(report(rows, day, day + dayMs, day + dayMs - 1)[0].partial, true);
  const [v5] = report(rows, day, day + dayMs, day + slot);
  assert.equal(v5.samples, 2);
  assert.equal(v5.last_at_ms, day + slot);
});

test('an observed lifetime-counter reset withholds PnL and fees even after fees catch up', () => {
  const [v5] = report([row(0, { fees: '10' }), row(5, { fees: '0' }), row(1435, { fees: '11' })]);
  assert.equal(v5.fees, U);
  assert.equal(v5.realized_pnl, U);
  assert.equal(v5.equity_change, '0');
  assert.match(v5.data_quality, /possible owner reset/);
});

test('numbers, scientific notation, lone samples, zero bases and unit changes do not become guessed money', () => {
  assert.equal(report([row(0, { equity: 100 }), row(5)])[0].equity_start, U);
  assert.equal(report([row(0, { equity: '1e2' }), row(5)])[0].equity_change, U);
  assert.equal(report([row(0)])[0].equity_change, U);
  assert.equal(report([row(0, { equity: '0' }), row(5)])[0].equity_change_pct, U);
  const [changed] = report([row(0), row(5, { unit: 'USDT' })]);
  assert.equal(changed.equity_change, U);
  assert.equal(changed.equity_end, U);
  assert.match(changed.data_quality, /unit changed/);
  assert.equal(report([row(0), row(5, { fees: '0' })])[0].fees, U);
});

test('Helm exposes only its published PnL, never substitutes equity or cash', () => {
  const [, helm] = report([row(0, { bot: 'helm', unit: null, equity: null, fees: null }), row(1435, { bot: 'helm', unit: null, equity: null, fees: null, realized: '11.01' })]);
  assert.equal(helm.realized_pnl, '1.01');
  assert.equal(helm.unrealized_pnl_end, '-2');
  for (const key of ['unit', 'equity_start', 'equity_end', 'fees', 'buys', 'sells', 'fills', 'cash_end', 'held_value_end']) assert.equal(helm[key], U);
});

test('CLI reads the existing ledger without changing it and exports the same pure rows as JSON and markdown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'condor-daily-money-'));
  const source = path.join(dir, 'samples.jsonl'), output = path.join(dir, 'report');
  const rows = [row(0), row(1435, { equity: '100.000000000000000000000000000001' })];
  const bytes = rows.map(item => JSON.stringify(item)).join('\n') + '\n{"torn":\n';
  fs.writeFileSync(source, bytes);
  const args = ['-m', 'condor.v5.daily_money_report', '--input', source, '--output-dir', output, '--day', '2026-11-14'];
  const result = python(args);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(fs.readFileSync(path.join(output, 'daily-money-2026-11-14.json'), 'utf8'));
  assert.deepEqual(payload.rows, report(rows));
  assert.equal(payload.malformed_lines, 1);
  assert.equal(fs.readFileSync(source, 'utf8'), bytes);
  assert.match(fs.readFileSync(path.join(output, 'daily-money-2026-11-14.md'), 'utf8'), /100\.000000000000000000000000000001/);
  assert.notEqual(python(args).status, 0, 'earlier exports must not be overwritten');
});

test('CLI missing input produces unavailable rows and never creates a second sampler record', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'condor-daily-empty-'));
  const source = path.join(dir, 'missing', 'samples.jsonl');
  const result = python(['-m', 'condor.v5.daily_money_report', '--input', source, '--output-dir', dir, '--day', '2026-11-14']);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(fs.readFileSync(path.join(dir, 'daily-money-2026-11-14.json'), 'utf8'));
  assert.match(payload.source_state, /UNAVAILABLE/);
  assert.deepEqual(payload.rows, report([]));
  assert.equal(fs.existsSync(source), false);
});

test('Money page renders exact daily strings through the real adaptive DataTable', () => {
  const rows = report([row(0), row(1435, { equity: '100.000000000000000000000000000001' })]);
  const { load } = frontendModules({
    '@tanstack/react-query': { useQuery: ({ queryKey }) => queryKey[0] === 'v5-money' ? { data: { rows: [], daily_report: rows, sampler: false, recorder_errors: { count: 0 }, range: '7d' } } : { data: undefined } },
    '@/features/quant-ops/kit/charts': { BarsChart: () => null, TimeSeriesChart: () => null },
  }, { 'v5/V5Money.tsx': ['dailyColumns'] });
  const { V5Money, dailyColumns } = load('v5/V5Money.tsx');
  assert.equal(dailyColumns.find(item => item.id === 'equity_end').kind, undefined, 'money must not use numeric table conversion');
  const html = renderToStaticMarkup(React.createElement(V5Money));
  assert.match(html, /<h2>Daily<\/h2>/);
  assert.match(html, /100\.000000000000000000000000000001/);
  assert.match(html, /HELM/);
  assert.match(html, /UNAVAILABLE/);
  assert.match(html, /partial day/);
  assert.match(html, /Cash at end/);
  assert.match(html, /Held value at end/);
});
