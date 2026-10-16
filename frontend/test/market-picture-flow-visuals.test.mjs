import test from 'node:test';
import assert from 'node:assert/strict';
import { flowHistoryVisuals } from '../src/features/market-picture/flow-history-visuals.mjs';
const point = (index, overrides={}) => ({ time: 1800000000000 + index * 60000, snapshot_id: String(index), source_kind:'observed',
  membership:'members', definitionRegistryHash:'definitions', gapBefore:false,
  flowHistory:{ componentId:'component', quoteAsset:'USDC', scopeHash:'scope', resetAt:0,
    buyQuote:'0', sellQuote:'20', unknownQuote:'5', cumulativeDeltaQuote:String(index * -20),
    expectedInstruments:5, observedInstruments:5, completeInstruments:5, reasons:[] }, ...overrides });

test('flow chart preserves zeros, unknown sides and owner CVD without accumulating displayed trades', () => {
  const rows = [point(0), point(1)];
  rows[1].flowHistory.cumulativeDeltaQuote='123';
  const original=structuredClone(rows);
  const result=flowHistoryVisuals(rows,'USDC');
  assert.deepEqual(result.notional.buy.map(p=>p.value),[0,0]);
  assert.deepEqual(result.notional.unknown.map(p=>p.value),[5,5]);
  assert.deepEqual(result.cvd.map(p=>p.value),[0,123]);
  assert.deepEqual(rows,original);
});

test('gap, reset, quote, source, scope and definition changes break historical lines', () => {
  for(const change of ['gap','reset','quote','source','scope','definition','time']) {
    const rows=[point(0),point(change==='time'?2:1)];
    if(change==='gap')rows[1].gapBefore=true;
    if(change==='reset')rows[1].flowHistory.resetAt=60000;
    if(change==='quote')rows[1].flowHistory.quoteAsset='USDT';
    if(change==='source')rows[1].source_kind='reconstructed';
    if(change==='scope')rows[1].flowHistory.scopeHash='new';
    if(change==='definition')rows[1].definitionRegistryHash='new';
    const result=flowHistoryVisuals(rows,'USDC');
    assert.ok(result.cvd.some(p=>p.value===null),change);
    assert.match(result.rows[1].continuity,/Break/);
  }
});

test('missing flow or CVD never becomes zero; quote selection keeps currency separate', () => {
  const rows=[point(0),point(1,{flowHistory:null}),point(2)];
  rows[2].flowHistory.cumulativeDeltaQuote=null;
  const result=flowHistoryVisuals(rows,'USDC');
  assert.equal(result.notional.buy.find(p=>p.time===rows[1].time).value,null);
  assert.equal(result.cvd.find(p=>p.time===rows[2].time).value,null);
  assert.ok(flowHistoryVisuals(rows,'USDT').cvd.every(p=>p.value===null));
});

test('continuity breaks after the first stored point become named chart markers', async () => {
  const { flowHistoryVisuals } = await import('../src/features/market-picture/flow-history-visuals.mjs');
  const flow = (cvd) => ({ quoteAsset: 'USDC', buyQuote: '1', sellQuote: '1', unknownQuote: '0', cumulativeDeltaQuote: cvd, scopeHash: 's', resetAt: 1 });
  const point = (time, flowHistory) => ({ time, source_kind: 'reconstructed', membership: 'm', definitionRegistryHash: 'd', gapBefore: false, flowHistory });
  const { breaks } = flowHistoryVisuals([point(60_000, flow('1')), point(120_000, flow('2')), point(180_000, flow(null)), point(300_000, flow('3'))], 'USDC');
  assert.deepEqual(breaks, [
    { time: 180_000, label: 'CVD unavailable' },
    { time: 300_000, label: 'previous CVD unavailable, non-1m interval' },
  ], 'the window start is not a break; each later break keeps its reasons');
});
