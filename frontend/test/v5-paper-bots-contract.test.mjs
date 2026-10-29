import test from 'node:test';
import assert from 'node:assert/strict';
import { paperReadState, paperControlState, paperRecordSummary, paperSnapshotsAgree, paperWords, paperAmount, paperTime, paperLifetimeTotals, paperOpenExecutorCount, paperRiskHold } from '../src/v5/policy.ts';

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

test('paper presentation uses readable reasons and boolean words', () => {
  assert.equal(paperWords('midpoint_fresh_book_only'), 'Mid of fresh book');
  assert.equal(paperWords('controls_not_integrated'), 'Risk controls not yet connected to this paper bot');
  assert.equal(paperWords('partial_close'), 'Partially closed');
  assert.equal(paperWords(false), 'No');
  assert.equal(paperWords(true), 'Yes');
  assert.equal(paperWords(null), 'Not published');
});

test('amount display rounds decimal text without binary arithmetic or fake zero', () => {
  assert.equal(paperAmount('1001.2592', 'USDC'), '1,001.2592 USDC');
  assert.equal(paperAmount('999.99999', 'USDC'), '1,000.0000 USDC');
  assert.equal(paperAmount('-0.000001', 'BNB', 6), '−0.000001 BNB');
  assert.equal(paperAmount('9007199254740993.00001', 'USDC'), '9,007,199,254,740,993.0000 USDC');
  assert.equal(paperAmount(null, 'USDC'), 'Not published');
  assert.equal(paperAmount('NaN', 'USDC'), 'Not published');
});

test('event time is UTC and relative, never an epoch or future observation', () => {
  assert.equal(paperTime(now - 5000, now), '2026-10-29 11:59:55 UTC · 5s ago');
  assert.equal(paperTime(now + 6000, now), 'Not published');
  assert.equal(paperTime(null, now), 'Not published');
});

test('native lifetime receipts require a fresh matching snapshot, not fill-page sums', () => {
  const totals = {fees_paid_quote:'0.1408', realized_pnl_quote:'0.7192', unrealized_pnl_quote:'0.54', volume_traded_quote:'140.8', entry_count:1, exit_count:1};
  const read = {...fresh, section:'accounting', data:{program:totals}};
  assert.deepEqual(paperLifetimeTotals(read, fresh, now), totals);
  assert.equal(paperLifetimeTotals({...read,snapshot_id:'other:1'}, fresh, now), null);
  assert.equal(paperLifetimeTotals({...read,state:'degraded'}, fresh, now), null);
  assert.equal(paperLifetimeTotals(read, fresh, now+31000), null);
  assert.equal(paperLifetimeTotals({...fresh,section:'fills',data:[totals]}, fresh, now), null);
});

test('terminal receipts and proven dust are not open executors or discarded PnL', () => {
  const terminal = {state:'TERMINATED', terminal:true, quantity:'0.00009', remaining_basis_quote:'0.0089630541', realized_pnl_quote:'0.009190091'};
  assert.equal(paperOpenExecutorCount({...fresh,section:'executors',data:[terminal]}, now), 0);
  assert.equal(paperOpenExecutorCount({...fresh,section:'executors',data:[{state:'partial_close'},terminal]}, now), 1);
  assert.equal(paperOpenExecutorCount({...fresh,section:'executors',data:[{state:'unknown'}]}, now), null);
  assert.equal(paperOpenExecutorCount({...fresh,section:'executors',data:[],next_cursor:'more'}, now), null);
  assert.equal(paperAmount(terminal.quantity,'BNB',6), '0.000090 BNB');
  assert.equal(paperAmount(terminal.realized_pnl_quote,'USDC',6), '0.009190 USDC');
  assert.equal(paperWords('TERMINATED'), 'Terminated');
});

test('clock durability hold explains entry-only protection and owner acknowledgement', () => {
  const risk = {...fresh,section:'risk',state:'degraded',data:{control_hold:'clock_persistence_failed',protected_exits:'preserved'}};
  assert.equal(paperRiskHold(risk), 'New acquisitions are held until explicit owner maintenance acknowledgement; protective exits remain enabled.');
  assert.equal(paperWords('clock_persistence_failed'), 'Clock durability failed; new acquisitions are held');
  assert.equal(paperRiskHold({...risk,data:null}), null);
  assert.equal(paperControlState(risk), 'Paper control not enabled');
});
