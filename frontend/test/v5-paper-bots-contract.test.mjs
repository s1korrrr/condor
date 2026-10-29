import test from 'node:test';
import assert from 'node:assert/strict';
import { paperReadState, paperControlState, paperRecordSummary, paperSnapshotsAgree } from '../src/v5/policy.ts';

const now = 1793275200000;
const fresh = {schema:'rsibot.v5-paper.read.v1', section:'wallet', state:'available', bot_id:'meridian_v5_paper', execution_mode:'paper', simulated:true, generated_at_ms:now, snapshot_id:'boot:1', data:{equity_quote:'1000.900000000000001'}};

test('paper freshness uses owner milliseconds and never a missing quant request', () => {
  assert.equal(paperReadState(fresh, now + 5000), 'available');
  assert.equal(paperReadState(fresh, now + 31000), 'stale');
  assert.equal(paperReadState({...fresh, generated_at_ms:now/1000}, now), 'stale');
  assert.equal(paperReadState({...fresh, generated_at_ms:now+6000}, now), 'degraded');
  assert.equal(paperReadState({...fresh, execution_mode:'live'}, now), 'degraded');
  assert.equal(fresh.data.equity_quote, '1000.900000000000001');
});

test('pair book degradation does not expire a current owner heartbeat', () => {
  assert.equal(paperReadState({...fresh, section:'positions', state:'degraded', reason:'BNB book stale'}, now), 'degraded');
  assert.equal(paperReadState(fresh, now), 'available');
});

test('no paper control button before a separately bound ingress', () => {
  assert.equal(paperControlState(null), 'Paper control not enabled');
  assert.equal(paperControlState({...fresh, data:{paused:true}}), 'Paper control not enabled');
});

test('related sections must have the same boot and sequence before comparison', () => {
  assert.equal(paperSnapshotsAgree([fresh, {...fresh, section:'fills'}]), true);
  assert.equal(paperSnapshotsAgree([fresh, {...fresh, snapshot_id:'new-boot:1'}]), false);
  assert.equal(paperSnapshotsAgree([fresh, {...fresh, generated_at_ms:now+1}]), false);
});

test('a partial fill summary keeps exact native quantity and actual fee currency', () => {
  const text = paperRecordSummary({trade_id:'fill-1', trading_pair:'BNB-USDC', side:'SELL', quantity:'0.4', price:'102', fee_amount:'0.0408', fee_currency:'USDC'});
  assert.match(text, /quantity 0.4 · price 102 · fee 0.0408 USDC/);
});
