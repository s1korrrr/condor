import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { paperReadState, paperCompleteRecords, paperControlState, paperRecordSummary, paperSnapshotsAgree, paperWords, paperAmount, paperExactAmount, paperSectionError, paperTime, paperLifetimeTotals, paperOpenExecutorCount, paperOrderCount, paperReadiness, paperRiskHold, paperRiskHolds, paperExitProjection, paperRiskUsage, paperWalletInventory, paperWalletTotals, paperPairObservation } from '../src/v5/policy.ts';
import { frontendModules } from './helpers/frontend-module.mjs';

const now = 1793275200000;

const c1TargetHoldFixtures = {
  "partial-buy-cancel-tp-partial-close": {
    "positions": [
      {
        "position_id": "executor-1",
        "executor_id": "executor-1",
        "controller_id": "v5_BNB_USDC",
        "trading_pair": "BNB-USDC",
        "quantity": "0.6",
        "remaining_basis_quote": "60.06",
        "fee_currency": "USDC",
        "state": "active",
        "protected_exit": true,
        "target_price": "102",
        "target_basis": "native_placed_fixed_target_limit",
        "target_reason": null,
        "protected_exit_order": {
          "order_id": "tp-1",
          "state": "partially_filled",
          "price": "102",
          "remaining_amount": "0.6",
          "placed_at_ms": 1793275130000
        },
        "remaining_target_amount": "0.6"
      }
    ],
    "executors": [
      {
        "executor_id": "executor-1",
        "controller_id": "v5_BNB_USDC",
        "state": "partial_close",
        "remaining_close_quantity": "0.6",
        "quantity": "0.6",
        "remaining_basis_quote": "60.06",
        "cum_fees_quote": "0.1408",
        "realized_pnl_quote": "0.7192",
        "unrealized_pnl_quote": "0.54",
        "unit": "USDC",
        "custom_info": {
          "entry_lifecycle": {
            "state": "terminal",
            "requested_quantity": "2",
            "filled_quantity": "1",
            "canceled_remainder_quantity": "1"
          }
        },
        "target_price": "102",
        "target_basis": "native_placed_fixed_target_limit",
        "target_reason": null,
        "protected_exit_order": {
          "order_id": "tp-1",
          "state": "partially_filled",
          "price": "102",
          "remaining_amount": "0.6",
          "placed_at_ms": 1793275130000
        },
        "remaining_target_amount": "0.6",
        "protected_exit": true
      }
    ]
  },
  "clock-failure-hold": {
    "risk": {
      "schema": "rsibot.v5-paper.risk.v1",
      "control_hold": "clock_persistence_failed",
      "reason": "clock_persistence_failed",
      "explanation": "New acquisitions are held until explicit owner maintenance acknowledgement; protective exits remain enabled.",
      "protected_exits": "preserved",
      "clock_recovery": {
        "required": true,
        "high_water_ms": 1793275200000,
        "hold": {
          "reason": "clock_persistence_failed",
          "failure_id": "fixture-failure",
          "detail": "injected clock durability failure"
        }
      },
      "holds": [
        {
          "reason": "clock_persistence_failed",
          "explanation": "New acquisitions are held until explicit owner maintenance acknowledgement; protective exits remain enabled."
        }
      ]
    }
  },
  "clock-invalid-hold": {
    "risk": {
      "schema": "rsibot.v5-paper.risk.v1",
      "control_hold": "clock_persistence_failed",
      "reason": "clock_invalid",
      "explanation": "Invalid clock: stops still apply; clears and native advancement are held. Timestamp is the last valid native checkpoint.",
      "protected_exits": "preserved",
      "clock_recovery": {
        "required": true,
        "high_water_ms": 1793275200000,
        "hold": {
          "reason": "clock_persistence_failed",
          "failure_id": "fixture-failure",
          "detail": "clock_invalid: invalid poll sample"
        }
      },
      "holds": [
        {
          "reason": "clock_persistence_failed",
          "explanation": "New acquisitions are held until explicit owner maintenance acknowledgement; protective exits remain enabled."
        },
        {
          "reason": "clock_invalid",
          "explanation": "Invalid clock: stops still apply; clears and native advancement are held. Timestamp is the last valid native checkpoint."
        }
      ]
    }
  },
  "stop-persistence-failure-hold": {
    "risk": {
      "schema": "rsibot.v5-paper.risk.v1",
      "control_hold": "stop_persistence_failed",
      "reason": "stop_persistence_failed",
      "explanation": "Stop durability is unproven. Entries stay held until reviewed owner emergency reset; exits remain enabled.",
      "protected_exits": "preserved",
      "clock_recovery": {
        "required": false,
        "high_water_ms": 1793275200000,
        "hold": null
      },
      "holds": [
        {
          "reason": "stop_persistence_failed",
          "explanation": "Stop durability is unproven. Entries stay held until reviewed owner emergency reset; exits remain enabled."
        }
      ],
      "emergency_recovery": {
        "required": true,
        "hold": {
          "reason": "stop_persistence_failed",
          "failure_id": "fixture-stop-durability",
          "detail": "injected stop commit failure"
        },
        "acknowledgements": []
      }
    }
  }
};

test('C1 native target and protected exit remain exact owner values', () => {
  const fixture = c1TargetHoldFixtures['partial-buy-cancel-tp-partial-close'];
  const position = fixture.positions[0];
  const executor = fixture.executors[0];
  const positions = {...fresh,section:'positions',data:[position]};
  const executors = {...fresh,section:'executors',data:[executor]};
  const exit = paperExitProjection(position,positions,executors,now);
  assert.equal(exit.targetPrice, '102');
  assert.equal(exit.basis, 'Native placed fixed-target limit');
  assert.equal(exit.remainingAmount, '0.6');
  assert.equal(exit.order.order_id, 'tp-1');
  assert.equal(exit.order.state, 'partially_filled');
  assert.equal(exit.order.price, '102');
  assert.equal(exit.order.placed_at_ms, 1793275130000);
  const unavailable = {...position,target_price:null,target_reason:'owner_target_unavailable',target_basis:null,protected_exit_order:null,remaining_target_amount:null};
  assert.equal(paperExitProjection(unavailable,{...positions,data:[unavailable]},executors,now).targetPrice,null);
  assert.equal(paperExitProjection(undefined,positions,executors,now).targetPrice,null);
  for (const [key,value] of [['target_price',{}],['target_basis',7],['protected_exit_order',{state:'open'}],['remaining_target_amount',true]]) {
    assert.match(paperSectionError({...fresh,section:'positions',data:[{...position,[key]:value}]}),/schema invalid/);
  }
});

test('affirmative protection requires coherent fresh complete sections and an exact active executor ID', () => {
  const fixture = c1TargetHoldFixtures['partial-buy-cancel-tp-partial-close'];
  const position = fixture.positions[0];
  const positions = {...fresh,section:'positions',data:[position]};
  const executors = {...fresh,section:'executors',data:fixture.executors};
  const verified = paperExitProjection(position,positions,executors,now);
  assert.equal(verified.protectedExit,true);
  assert.equal(verified.targetPrice,'102');
  for (const change of [{completeness:'partial'},{completeness:undefined},{generated_at_ms:now-31000},{snapshot_id:'other:1'},{bot_id:'another_bot'},{data:[]},{data:[{...fixture.executors[0],executor_id:'other'}]},{data:[{...fixture.executors[0],state:'TERMINATED'}]},{data:[{...fixture.executors[0],protected_exit:false}]},{data:[{...fixture.executors[0],trading_pair:'BTC-USDC'}]},{data:[fixture.executors[0],fixture.executors[0]]}]) {
    const unknown = paperExitProjection(position,positions,{...executors,...change},now);
    assert.equal(unknown.protectedExit,null);
    assert.equal(unknown.targetPrice,null);
    assert.equal(unknown.order,null);
    assert.equal(unknown.remainingAmount,null);
    assert.match(unknown.reason,/Protection status unknown · executor data (stale|incomplete) since/);
  }
  for (const change of [{completeness:'partial'},{generated_at_ms:now-31000},{snapshot_id:'other:1'}]) assert.equal(paperExitProjection(position,{...positions,...change},executors,now).protectedExit,null);
  assert.equal(paperExitProjection({...position,executor_id:undefined},positions,executors,now).targetPrice,null);
});

test('hold presence never depends on explanation text, control_hold or envelope validity', () => {
  for (const reason of ['stop_persistence_failed','clock_persistence_failed','clock_invalid']) {
    for (const control of [undefined,null,reason]) for (const explanation of [undefined,null,'','   ']) {
      const read = {...fresh,section:'risk',data:{control_hold:control,holds:[{reason,explanation}]}};
      assert.ok(paperRiskHold(read));
      assert.equal(paperRiskHolds(read)[0].reason,reason);
      assert.ok(paperRiskHolds(read)[0].explanation.trim());
      assert.match(paperRiskHolds(read)[0].action,/Owner action:/);
      assert.ok(paperRiskHold({...read,reason:{}}));
    }
  }
  for (const data of [{control_hold:'future_safety_hold',holds:[]},{holds:[{reason:'future_safety_hold',explanation:''}]}]) {
    const read = {...fresh,section:'risk',data};
    assert.ok(paperRiskHold(read));
    assert.equal(paperRiskHolds(read)[0].label,'Unrecognised owner hold: future_safety_hold · entries held');
    assert.match(paperRiskHolds(read)[0].action,/Owner/);
  }
  assert.equal(paperRiskHolds({...fresh,section:'risk',data:{control_hold:'clock_invalid',holds:[]}})[0].reason,'clock_invalid');
});

for (const [name,fixture] of Object.entries(c1TargetHoldFixtures).filter(([,fixture])=>fixture.risk)) {
  test('C1 risk hold explains the owner clearing action: '+name, () => {
    const read = {...fresh,section:'risk',state:'degraded',reason:fixture.risk.reason,data:fixture.risk};
    const holds = paperRiskHolds(read);
    assert.equal(holds.length, fixture.risk.holds.length);
    for (const [index,hold] of holds.entries()) {
      assert.equal(hold.explanation, fixture.risk.holds[index].explanation);
      assert.ok(hold.action.includes('Owner'));
      assert.ok(hold.action.includes('resume entries cannot clear'));
      if (hold.reason==='stop_persistence_failed') assert.ok(hold.action.includes('emergency reset'));
      else assert.ok(hold.action.includes('maintenance acknowledgement'));
      if (hold.reason==='clock_invalid') assert.ok(hold.action.includes('valid clock'));
    }
  });
}

const fresh = {schema:'rsibot.v5-paper.read.v1', section:'wallet', state:'available', completeness:'complete', bot_id:'meridian_v5_paper', execution_mode:'paper', simulated:true, generated_at_ms:now, snapshot_id:'boot:1', data:{equity_quote:'1000.900000000000001'}};
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
  assert.equal(paperWalletInventory(wallet, now+31000), null);
  assert.equal(paperWalletInventory(wallet, now).asOf, now-5000);
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
  assert.equal(stale.staleSince,now+30000);
  assert.equal(paperPairObservation('BTC-USDC',positions,{...executors,state:'stale',reason:'Owner report expired',source_at_ms:now-60000},decisions,now).staleSince,now-30000);
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

test('an empty executor page without completeness cannot prove zero open executors', () => {
  const read = {...fresh,section:'executors',data:[]};
  delete read.completeness;
  assert.equal(paperOpenExecutorCount(read,now),null);
});

const incompleteChanges = [{completeness:undefined},{completeness:'partial'},{completeness:'unavailable'},{next_cursor:'more'},{state:'stale',reason:'Owner report expired'},{generated_at_ms:now-31000}];

for (const section of ['positions','fills','executors','orders']) {
  test(`${section} table row count never turns an incomplete page into a zero population`, () => {
    const read = {...fresh,section,data:[]};
    assert.deepEqual(paperCompleteRecords(read,now),[]);
    for (const change of incompleteChanges) assert.equal(paperCompleteRecords({...read,...change},now),null);
  });
}

for (const field of ['equity','cash']) {
  test(`wallet ${field} total requires fresh complete unpaginated owner data`, () => {
    const read = {...fresh,data:{equity_quote:'1001.2592',quote_asset:'USDC',assets:[{asset:'USDC',available:'940.6592'}]}};
    assert.equal(paperWalletTotals(read,now)?.[field],field==='equity' ? '1001.2592' : '940.6592');
    for (const change of incompleteChanges) assert.equal(paperWalletTotals({...read,...change},now),null);
  });
}

test('marked holdings aggregate does not sum stale, partial or paginated inventory', () => {
  const read = {...fresh,data:{quote_asset:'USDC',valuation_policy:'midpoint_fresh_book_only',assets:[{asset:'BNB',marked_value_quote:'60.60',mark_at_ms:now}]}};
  assert.equal(paperWalletInventory(read,now)?.value,'60.60');
  for (const change of incompleteChanges) assert.equal(paperWalletInventory({...read,...change},now),null);
});

for (const field of ['used_quote','limit_quote','used_percent']) {
  test(`risk ${field} aggregate requires fresh complete owner data`, () => {
    const rail = {used_quote:'10',limit_quote:'100',used_percent:10};
    const read = {...fresh,section:'risk',data:{rails:[rail]}};
    assert.equal(paperRiskUsage(read,now)?.[0][field],rail[field]);
    for (const change of incompleteChanges) assert.equal(paperRiskUsage({...read,...change},now),null);
  });
}

test('executor count and pair uniqueness require complete fresh unpaginated records', () => {
  const executors = {...fresh,section:'executors',data:[executorRow({trading_pair:'BNB-USDC'})]};
  const positions = {...fresh,section:'positions',data:[positionRow({})]};
  assert.equal(paperOpenExecutorCount(executors,now),1);
  for (const change of incompleteChanges) {
    assert.equal(paperOpenExecutorCount({...executors,...change},now),null);
    assert.equal(paperPairObservation('BNB-USDC',positions,{...executors,...change},undefined,now).executor,undefined);
  }
});

test('paper fleet isolation publishes no rejected, entry, fill, holding or executor aggregates from legacy inputs', () => {
  const {load} = frontendModules();
  const {projectFleetTiles} = load('features/bots/fleet-tiles.ts');
  const paper = {bot:'meridian_v5_paper',name:'Paper',status:'running',view:{activeExecutorCount:0,activeOrderCount:0},quant:{cycleCounts:{open:0}},cycles:{stats:{fillCount:0}},execution:{funnel:[{stage:'orders_rejected',count:0}]},health:null};
  const tiles = projectFleetTiles([paper],now);
  assert.deepEqual(tiles.map(tile=>tile.id),['B01-paper']);
  assert.equal(tiles[0].value,'+1');
  assert.match(tiles[0].basis,/simulated lanes/);
});

test('readiness gate count is checklist configuration, not an observation-derived execution total', () => {
  for (const owner of [undefined,{completeness:'partial'},{ready:true}]) {
    assert.equal(paperReadiness(owner).gates.filter(gate=>gate.priority==='P0' && gate.status!=='PASS').length,4);
  }
});

for (const field of ['fees_paid_quote','realized_pnl_quote','unrealized_pnl_quote','volume_traded_quote','entry_count','exit_count']) {
  test(`${field} is not a lifetime total without fresh complete unpaginated accounting`, () => {
    const read = {...fresh,section:'accounting',completeness:'complete',data:{program:{[field]:field.endsWith('_count') ? 0 : '0'}}};
    assert.equal(paperLifetimeTotals(read,fresh,now)?.[field],read.data.program[field]);
    for (const change of [{completeness:undefined},{completeness:'partial'},{completeness:'unavailable'},{next_cursor:'more'}]) assert.equal(paperLifetimeTotals({...read,...change},fresh,now),null);
    assert.equal(paperLifetimeTotals(read,fresh,now+31000),null);
  });
}

test('clock durability hold explains entry-only protection and owner acknowledgement', () => {
  const risk = {...fresh,section:'risk',state:'degraded',reason:'clock_persistence_failed',data:c1TargetHoldFixtures['clock-failure-hold'].risk};
  assert.equal(paperRiskHold(risk), true);
  assert.equal(paperWords('clock_persistence_failed'), 'Clock durability failed; new acquisitions are held');
  assert.equal(paperRiskHold({...risk,data:null}), false);
  assert.equal(paperControlState(risk), 'Paper control not enabled');
});

test('hold banner labels the clock high-water without an orphaned control sentence', () => {
  const {load} = frontendModules(Object.fromEntries(['@/components/bots/AggregatedPnlChart','@/components/bots/ControllerBrowser','@/components/bots/DeployBotDialog','@/components/bots/PnlSparkline','@/hooks/useWebSocket','@/hooks/useRates'].map(name => [name,{}])));
  const {PaperWorkspace} = load('pages/tabs/ActiveBotsTab.tsx');
  for (const highWater of [undefined, now]) {
    const risk = {...fresh,section:'risk',data:{control_hold:null,holds:[{reason:'clock_persistence_failed',explanation:''}],clock_recovery:{high_water_ms:highWater}}};
    const html = renderToStaticMarkup(React.createElement(PaperWorkspace,{reads:[risk],now,reportAt:now,heartbeat:'Fresh',bot:'meridian_v5_paper'}));
    assert.ok(html.includes(`Clock high-water mark: ${paperTime(highWater,now)}.`));
    assert.doesNotMatch(html,/Not published\. Clock high-water mark/);
  }
});
