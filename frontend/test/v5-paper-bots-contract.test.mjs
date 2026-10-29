import test from 'node:test';
import assert from 'node:assert/strict';
import { paperReadState, paperControlState, paperRecordSummary, paperSnapshotsAgree, paperWords, paperAmount, paperExactAmount, paperSectionError, paperTime, paperLifetimeTotals, paperOpenExecutorCount, paperOrderCount, paperRiskHold, paperWalletInventory, paperPairObservation } from '../src/v5/policy.ts';

const now = 1793275200000;
const fresh = {schema:'rsibot.v5-paper.read.v1', section:'wallet', state:'available', bot_id:'meridian_v5_paper', execution_mode:'paper', simulated:true, generated_at_ms:now, snapshot_id:'boot:1', data:{equity_quote:'1000.900000000000001'}};
const positionRow = changes => ({position_id:'p1', controller_id:'v5_BNB_USDC', trading_pair:'BNB-USDC', state:'active', quantity:'0.6', ...changes});
const executorRow = changes => ({executor_id:'e1', controller_id:'v5_BNB_USDC', state:'active', ...changes});

test('holdings project complete wallet marks, excluding cash, with exact decimals and oldest mark time', () => {
  const wallet = {...fresh, completeness:'complete', data:{quote_asset:'USDC', unit:'USDC', valuation_policy:'midpoint_fresh_book_only', assets:[
    {asset:'USDC',marked_value_quote:'940.6592',mark_at_ms:now},
    {asset:'BNB',marked_value_quote:'60.6',mark_at_ms:now-5000},
    {asset:'ETH',marked_value_quote:'0.000000000000001',mark_at_ms:now},
  ]}};
  assert.deepEqual(paperWalletInventory(wallet, now), {value:'60.600000000000001', unit:'USDC', basis:'Mid of fresh book', asOf:now-5000});
  assert.equal(paperWalletInventory({...wallet,state:'degraded'}, now), null);
  assert.equal(paperWalletInventory({...wallet,completeness:'partial'}, now), null);
  assert.equal(paperWalletInventory({...wallet,next_cursor:'more'}, now), null);
  assert.equal(paperWalletInventory(wallet, now+31000).value, '60.600000000000001');
  assert.equal(paperWalletInventory(wallet, now+31000).asOf, now-5000);
  assert.equal(paperWalletInventory({...wallet,data:{...wallet.data,assets:[{asset:'BNB',marked_value_quote:null}]}}, now), null);
  assert.equal(paperWalletInventory({...wallet,data:{...wallet.data,assets:[wallet.data.assets[0]]}}, now).value, '0');
});

test('known flat requires complete coherent positions and executors, and projects latest pair decision', () => {
  const positions = {...fresh,section:'positions',completeness:'complete',data:[positionRow({executor_id:'e1'})]};
  const executors = {...fresh,section:'executors',completeness:'complete',data:[{executor_id:'e1',controller_id:'v5_BNB_USDC',state:'partial_close'}]};
  const decisions = {...fresh,section:'decisions',completeness:'complete',data:{conditions:[
    {trading_pair:'BTC-USDC',status:'entry_held',reason:'spread_too_wide',event_at_ms:now-1000},
    {trading_pair:'BTC-USDC',status:'waiting_for_signal',event_at_ms:now-5000},
    {trading_pair:'ETH-USDC',status:'ready',event_at_ms:now},
  ]}};
  assert.equal(paperPairObservation('BNB-USDC',positions,executors,decisions,now).knownFlat,false);
  const flat = paperPairObservation('BTC-USDC',positions,executors,decisions,now);
  assert.equal(flat.knownFlat,true);
  assert.equal(flat.decision.status,'entry_held');
  for (const change of [{completeness:'partial'},{next_cursor:'more'},{state:'degraded'},{snapshot_id:'other:1'}]) {
    assert.equal(paperPairObservation('BTC-USDC',positions,{...executors,...change},decisions,now).knownFlat,false);
  }
  assert.equal(paperPairObservation('BTC-USDC',positions,{...executors,data:[{state:'active'}]},decisions,now).knownFlat,false);
  assert.equal(paperPairObservation('BTC-USDC',positions,{...executors,data:[executorRow({trading_pair:'BTC-USDC',state:'TERMINATED'}),executorRow({trading_pair:'BTC-USDC',state:'active'})]},decisions,now).knownFlat,false);
  assert.equal(paperPairObservation('BTC-USDC',positions,{...executors,data:[executorRow({trading_pair:'BTC-USDC',state:'TERMINATED'})]},decisions,now).knownFlat,true);
  assert.equal(paperPairObservation('BTC-USDC',positions,executors,{...decisions,snapshot_id:'other:1'},now).decision,null);
  const stale = paperPairObservation('BTC-USDC',positions,executors,decisions,now+31000);
  assert.equal(stale.knownFlat,false);
  assert.equal(stale.lastReportedFlat,true);
  assert.equal(paperPairObservation('BTC-USDC',positions,{...executors,snapshot_id:'other:1'},decisions,now+31000).lastReportedFlat,false);
});

test('malformed envelope fields are isolated in every state before rendering', () => {
  for (const state of ['available','collecting','degraded','stale','not_applicable']) {
    for (const [key,value] of Object.entries({reason:{},state:[],generated_at_ms:true,source_at_ms:{},observed_at_ms:-1,snapshot_id:[],completeness:{},next_cursor:[],capabilities:[],source:[],bot_id:{},simulated:'true'})) {
      const read = {...fresh,section:'executors',data:[],state,reason:'Owner state',[key]:value};
      assert.match(paperSectionError(read), /Executors owner schema invalid/, `${state}: ${key}`);
      assert.equal(paperReadState(read,now),'degraded');
      assert.equal(paperPairObservation('BTC-USDC',{...fresh,section:'positions',data:[],completeness:'complete'},read,undefined,now).knownFlat,false);
    }
  }
});

test('filled order counts use singular and plural labels without inventing missing counts', () => {
  assert.equal(paperOrderCount(1,'entry'),'1 entry');
  assert.equal(paperOrderCount(1,'exit'),'1 exit');
  assert.equal(paperOrderCount(0,'entry'),'0 entries');
  assert.equal(paperOrderCount(2,'exit'),'2 exits');
  assert.equal(paperOrderCount(null,'entry'),'Count not published');
});

test('an open position binds only its own active executor, never a terminal receipt target', () => {
  const position = positionRow({executor_id:'active-2'});
  const positions = {...fresh,section:'positions',data:[position]};
  const closed = executorRow({executor_id:'closed-1',trading_pair:'BNB-USDC',state:'TERMINATED',target_price:'101'});
  const active = executorRow({executor_id:'active-2',trading_pair:'BNB-USDC',state:'active',target_price:'120'});
  const executors = {...fresh,section:'executors',data:[closed,active]};
  assert.equal(paperPairObservation('BNB-USDC',positions,executors,undefined,now).executor,active);
  assert.equal(paperPairObservation('BNB-USDC',positions,{...executors,data:[closed]},undefined,now).executor,undefined);
  const noId = {...positions,data:[positionRow({})]};
  assert.equal(paperPairObservation('BNB-USDC',noId,executors,undefined,now).executor,active);
  assert.equal(paperPairObservation('BNB-USDC',noId,{...executors,data:[active,{...active,executor_id:'active-3'}]},undefined,now).executor,undefined);
});

test('malformed record data never crashes or becomes a known empty position', () => {
  const badExecutors = {...fresh,section:'executors',completeness:'complete',data:[null]};
  const badPositions = {...fresh,section:'positions',completeness:'complete',data:{bad:'shape'}};
  assert.equal(paperReadState(badExecutors,now),'degraded');
  assert.match(paperSectionError(badExecutors), /Executors owner schema invalid/);
  assert.equal(paperReadState(badPositions,now),'degraded');
  assert.equal(paperOpenExecutorCount(badExecutors,now),null);
  assert.equal(paperPairObservation('BNB-USDC',badPositions,badExecutors,undefined,now).knownFlat,false);
  assert.equal(paperReadState({...badPositions,data:[{}]},now),'degraded');
  assert.equal(paperWalletInventory({...fresh,completeness:'complete',data:{quote_asset:'USDC',assets:[null]}},now),null);
});

test('expanded receipt values preserve all native decimal places', () => {
  assert.equal(paperExactAmount('0.009190091','USDC'),'0.009190091 USDC');
  assert.equal(paperExactAmount('0.0000900000000001','BNB'),'0.0000900000000001 BNB');
  assert.equal(paperExactAmount(null,'USDC'),'Not published');
  assert.equal(paperExactAmount({},'USDC'),'Not published');
});

test('pair decision projection accepts native controller custom info without deriving identity', () => {
  const positions = {...fresh,section:'positions',completeness:'complete',data:[]};
  const executors = {...fresh,section:'executors',completeness:'complete',data:[]};
  const decisions = {...fresh,section:'decisions',source_at_ms:now,completeness:'complete',data:{controllers:[{id:'btc',pair:'BTC-USDC',custom_info:{modular_status:'waiting_for_signal'}}]}};
  assert.equal(paperPairObservation('BTC-USDC',positions,executors,decisions,now).decision.status,'waiting_for_signal');
  assert.equal(paperPairObservation('BNB-USDC',positions,executors,decisions,now).decision,null);
});

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
  const terminal = executorRow({state:'TERMINATED', terminal:true, quantity:'0.00009', remaining_basis_quote:'0.0089630541', realized_pnl_quote:'0.009190091'});
  assert.equal(paperOpenExecutorCount({...fresh,section:'executors',data:[terminal]}, now), 0);
  assert.equal(paperOpenExecutorCount({...fresh,section:'executors',data:[executorRow({state:'partial_close'}),terminal]}, now), 1);
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
