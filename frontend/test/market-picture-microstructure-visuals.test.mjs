import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';
import { flowCohorts, projectFlowSelection, bookCohorts, projectBookSelection } from '../src/features/market-picture/microstructure-visuals.mjs';

const asOf = 1_800_000_000_000;
const frame = { available_at_ms: asOf - 10, expires_at_ms: asOf + 10_000 };
const flow = (changes = {}) => ({
  instrumentId: 'venue:spot:AAA-USD', sourceId: 'source-a', inputDigest: 'digest', quoteAsset: 'USD', channel: 'trades',
  windowStart: asOf - 60_000, windowEnd: asOf, available: asOf - 10, expires: asOf + 10_000,
  resetId: 'reset', resetAt: asOf - 3_600_000, coverageStart: asOf - 60_000, coverageEnd: asOf,
  gaps: [], buyQuote: '10.25', sellQuote: '8.5', unknownQuote: '1.25', knownImbalance: '0.093', confirmationImbalance: '0.093',
  unknownShare: '0.0625', cumulativeBefore: null, cumulativeAfter: null, trades: 5, duplicates: 0,
  complete: true, reasons: [], capabilityUsable: true, ...changes,
});
const book = (changes = {}) => ({
  instrumentId: 'venue:spot:AAA-USD', sourceId: 'source-a', channel: 'depth', sequence: 3,
  observed: asOf, available: asOf - 10, expires: asOf + 10_000, access: 'public', side: 'buy',
  requestedSize: '2', sizeUnit: 'base', coveredBase: '2', coveredQuote: '40', uncovered: '0',
  coveredVwap: '20', vwap: '20', costBps: '12.5', costPercentile7d: null,
  costPercentileSampleCount: 0, costPercentileExpectedSamples: 10080, costPercentileReasons: ['INSUFFICIENT_HISTORY'],
  costPercentileReferenceDigest: null, feeBps: '10', feeSource: 'owner-schedule', totalCostBps: '22.5',
  spreadBps: '4', bandBps: '25', bidCovered: '2', askCovered: '2', bandComplete: true, bandImbalance: null,
  reasons: [], capabilityUsable: true, ...changes,
});

test('flow cohorts retain exact instrument/source/window identity without combining independent sources', () => {
  const rows = [flow(), flow({ sourceId: 'source-b' }), flow({ windowStart: asOf - 120_000, windowEnd: asOf - 60_000 })];
  assert.deepEqual(flowCohorts(rows), [
    { instrumentId: 'venue:spot:AAA-USD', sourceId: 'source-a', channel: 'trades', quoteAsset: 'USD', windowMs: 60_000, latestEnd: asOf },
    { instrumentId: 'venue:spot:AAA-USD', sourceId: 'source-b', channel: 'trades', quoteAsset: 'USD', windowMs: 60_000, latestEnd: asOf },
  ]);
});

test('flow chart rows show only owner-recorded buy, sell and unknown quote amounts; partial rows stay labelled', () => {
  const selection = { instrumentId: 'venue:spot:AAA-USD', sourceId: 'source-a', channel: 'trades', quoteAsset: 'USD', windowMs: 60_000 };
  const result = projectFlowSelection([
    flow(), flow({ windowStart: asOf - 120_000, windowEnd: asOf - 60_000 }),
    flow({ sourceId: 'source-b' }),
  ], selection, frame, asOf);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].buyQuote, 10.25);
  assert.equal(result.rows[0].sellQuote, 8.5);
  assert.equal(result.rows[0].unknownQuote, 1.25);
  assert.equal(result.rows[0].unit, 'USD');
  assert.deepEqual(result.rows[0].exact, { buyQuote: '10.25', sellQuote: '8.5', unknownQuote: '1.25' });
  const partial = projectFlowSelection([flow({ complete: false, reasons: ['GAP'], gaps: [[asOf - 30_000, asOf - 20_000]] })], selection, frame, asOf);
  assert.equal(partial.rows[0].state, 'PARTIAL · GAP');
  assert.equal(partial.rows[0].unknownQuote, 1.25);
});

test('flow freshness and source qualification keep bars unavailable; malformed values are not coerced to zero', () => {
  const selection = { instrumentId: 'venue:spot:AAA-USD', sourceId: 'source-a', channel: 'trades', quoteAsset: 'USD', windowMs: 60_000 };
  for (const [row, expected] of [
    [flow({ available: asOf + 1 }), 'FUTURE'],
    [flow({ expires: asOf }), 'EXPIRED'],
    [flow({ capabilityUsable: false }), 'SOURCE NOT QUALIFIED'],
    [flow({ buyQuote: 'not-a-number' }), 'INVALID VALUE'],
  ]) {
    const projected = projectFlowSelection([row], selection, frame, asOf).rows[0];
    assert.equal(projected.state, expected);
    assert.equal(projected.buyQuote, null);
  }
});

test('book cohorts require one instrument, source, channel, observed instant and size unit', () => {
  const rows = [book(), book({ side: 'sell' }), book({ sourceId: 'source-b' }), book({ observed: asOf - 1 }), book({ sizeUnit: 'quote' })];
  assert.deepEqual(bookCohorts(rows), [
    { instrumentId: 'venue:spot:AAA-USD', sourceId: 'source-a', channel: 'depth', observed: asOf, sizeUnit: 'base' },
    { instrumentId: 'venue:spot:AAA-USD', sourceId: 'source-b', channel: 'depth', observed: asOf, sizeUnit: 'base' },
    { instrumentId: 'venue:spot:AAA-USD', sourceId: 'source-a', channel: 'depth', observed: asOf - 1, sizeUnit: 'base' },
    { instrumentId: 'venue:spot:AAA-USD', sourceId: 'source-a', channel: 'depth', observed: asOf, sizeUnit: 'quote' },
  ]);
});

test('book costs are plotted only for complete known-access sizes and fee totals need explicit fee provenance', () => {
  const selection = { instrumentId: 'venue:spot:AAA-USD', sourceId: 'source-a', channel: 'depth', observed: asOf, sizeUnit: 'base' };
  const rows = [book(), book({ side: 'sell', requestedSize: '4', coveredBase: '4', costBps: '18', totalCostBps: null, feeBps: null, feeSource: null }),
    book({ side: 'buy', requestedSize: '6', coveredBase: '5', uncovered: '1', bandComplete: false })];
  const result = projectBookSelection(rows, selection, frame, asOf, 'book');
  assert.equal(result.unit, 'bps');
  assert.deepEqual(result.rows.map(row => row.costBps), [12.5, 18, null]);
  assert.deepEqual(result.rows.map(row => row.coverage.requested), ['2', '4', '6']);
  assert.deepEqual(result.rows.map(row => row.coverage.covered), [2, 4, 5]);
  assert.deepEqual(result.rows.map(row => row.coverage.uncovered), ['0', '0', '1']);
  const total = projectBookSelection([book({ totalCostBps: '22.5' }), book({ side: 'sell', feeSource: null })], selection, frame, asOf, 'total');
  assert.deepEqual(total.rows.map(row => row.costBps), [22.5, null]);
  assert.equal(total.rows[1].state, 'FEE PROVENANCE UNAVAILABLE');
});

test('unknown access, stale rows, missing coverage, and duplicate side-size samples fail closed', () => {
  const selection = { instrumentId: 'venue:spot:AAA-USD', sourceId: 'source-a', channel: 'depth', observed: asOf, sizeUnit: 'base' };
  for (const [rows, expected] of [
    [[book({ access: 'unknown' })], 'ACCESS UNAVAILABLE'],
    [[book({ expires: asOf })], 'EXPIRED'],
    [[book({ uncovered: 'bad' })], 'INVALID COVERAGE'],
    [[book(), book()], 'DUPLICATE SIZE/SIDE'],
  ]) {
    const row = projectBookSelection(rows, selection, frame, asOf, 'book').rows[0];
    assert.equal(row.state, expected);
    assert.equal(row.costBps, null);
  }
});

test('rendered future rows redact exact flow, cost, and coverage values and use unique control IDs', async () => {
  const { load } = frontendModules({
    '@/features/quant-ops/kit/charts': {
      BarsChart: ({ rows }) => React.createElement('output', null, JSON.stringify(rows)),
    },
  });
  const { MicrostructureVisuals } = load('features/market-picture/MicrostructureVisuals.tsx');
  const futureAsOf = asOf;
  const futureFrame = {
    snapshot_id: 'snapshot-private-hash-sentinel', stream_id: 'stream', epoch: 'epoch', sequence: 1, payload_digest: 'payload',
    cutoff_ms: futureAsOf, available_at_ms: futureAsOf - 10, expires_at_ms: futureAsOf + 10_000,
    source_kind: 'synthetic', universeId: 'universe', universeRevision: '1', membershipHash: 'membership', quote: 'USD', expected: 1, valid: 1,
    assets: [], breadth: {}, normalizedBreadth: {}, breadthTrajectory: [], hourlyInternals: null, candleAnomalies: null,
    breadthDivergence: [], contributions: {}, sourceCapabilities: [], dailyInternals: [], pressure: {}, summary: {}, participation: {},
    comparisons: {}, comparisonContext: null, relativeStrengthChanges: null, distribution: {}, raw: {},
    microstructure: {
      componentId: 'component-id-secret-sentinel', sourceKind: 'synthetic', cutoff: futureAsOf, available: futureAsOf - 1,
      replayClass: 'fixture', rawInputsRetained: false,
      flows: [flow({ buyQuote: '987654321', sellQuote: '987654322', unknownQuote: '987654323', available: futureAsOf + 1,
        trades: 987654320, gaps: [[1_888_888_888_888, 1_888_888_888_999]], reasons: ['future-gap-reason-sentinel'] })],
      liquidity: [book({ requestedSize: '87654321', coveredBase: '87654321', coveredQuote: '76543210', uncovered: '0',
        costBps: '7777', totalCostBps: '8888', feeBps: '99', available: futureAsOf + 1 })],
    },
  };
  const html = renderToStaticMarkup(React.createElement(React.Fragment, null,
    React.createElement(MicrostructureVisuals, { frame: futureFrame, asOf: futureAsOf }),
    React.createElement(MicrostructureVisuals, { frame: futureFrame, asOf: futureAsOf }),
  ));
  for (const withheld of ['987654321', '987654322', '987654323', '987654320', 'future-gap-reason-sentinel', '1_888_888_888_888', '7777', '8888', '87654321', '76543210', '99']) {
    assert.equal(html.includes(withheld), false, `future value ${withheld} must not appear in rendered output`);
  }
  assert.equal(html.includes(new Date(1_888_888_888_888).toISOString()), false, 'future gap bounds must not appear in rendered output');
  assert.match(html, /FUTURE/);
  assert.equal(html.includes('component-id-secret-sentinel'), false);
  assert.equal(html.includes('snapshot-private-hash-sentinel'), false);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'two rendered instances must not duplicate control or heading IDs');

  futureFrame.microstructure.flows = [flow({ buyQuote: '0', sellQuote: '0', unknownQuote: '0', trades: 1, available: futureAsOf - 1 })];
  const zeroHtml = renderToStaticMarkup(React.createElement(MicrostructureVisuals, { frame: futureFrame, asOf: futureAsOf, only: 'flow' }));
  assert.match(zeroHtml, /Recorded amounts: buy 0, sell 0, unknown 0 USD/);
});

test('malformed or over-covered requested sizes cannot create a cost bar or >100 percent coverage', () => {
  const selection = { instrumentId: 'venue:spot:AAA-USD', sourceId: 'source-a', channel: 'depth', observed: asOf, sizeUnit: 'base' };
  const rows = [
    book({ requestedSize: '0', coveredBase: '0' }),
    book({ requestedSize: '-2', coveredBase: '1' }),
    book({ requestedSize: '2', coveredBase: '3' }),
    book({ requestedSize: '2', coveredBase: '2', uncovered: '0.5' }),
    book({ requestedSize: '3', coveredBase: '3', uncovered: '0' }),
  ];
  const projected = projectBookSelection(rows, selection, frame, asOf, 'book');
  assert.deepEqual(projected.rows.map(row => row.coveragePercent), [null, null, null, null, 100]);
  assert.deepEqual(projected.rows.map(row => row.costBps), [null, null, null, null, 12.5]);
  assert.deepEqual(projected.rows.map(row => row.state), ['INVALID COVERAGE', 'INVALID COVERAGE', 'INVALID COVERAGE', 'INVALID COVERAGE', 'COVERED']);
});
