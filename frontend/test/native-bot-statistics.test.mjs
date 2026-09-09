import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecordedBotStatistics, validateRecordedSource, loadRecordedBotStatistics } from '../src/lib/native-bot-statistics.ts';

const row = (extra = {}) => ({ bot_name: 'ok_rsi', source_db_id: 'db', pair: 'SOL-USDC', timestamp: '2026-09-09T01:00:00Z', ...extra });
const input = () => ({
  fills: [row({fill_id:'f1',order_id:'o1',side:'buy',gross_volume_quote:10,fee_quote:0.01}), row({fill_id:'f2',order_id:'o1',side:'buy',gross_volume_quote:5,fee_quote:0.005})],
  orders: [row({order_id:'o1',normalized_status:'filled'}),row({order_id:'o2',normalized_status:'canceled'})],
  executors: [row({executor_id:'e1',normalized_status:'closed',filled_amount_quote:0,fees_quote:0,net_pnl_quote:0})],
});

test('partial fills count separately from executed orders and unfilled executor closures', () => {
  const stats=buildRecordedBotStatistics('ok_rsi',input());
  assert.equal(stats.fillCount,2);
  assert.equal(stats.executedOrderCount,1);
  assert.equal(stats.closedExecutorCount,1);
  assert.equal(stats.canceledOrderCount,1);
  assert.equal(stats.fullyFilledOrderCount,1);
  assert.equal(stats.fullyFilledOrderShare,0.5);
  assert.equal(stats.volume,15);
  assert.equal(stats.fees,0.015);
  assert.equal(stats.tradeWinRate,null);
  assert.equal(stats.completedTradeCount,null);
});
test('known configured pairs show zero recorded activity without inventing returns',()=>{
  const stats=buildRecordedBotStatistics('ok_rsi',{fills:[],orders:[],executors:[],configuredPairs:['SUI-USDC']});
  assert.equal(stats.volume,0);
  assert.equal(stats.fees,0);
  assert.equal(stats.pairs[0].fillCount,0);
  assert.equal(stats.fullyFilledOrderShare,null);
  assert.equal(stats.tradeWinRate,null);
});
test('wrong bot, duplicate identities and malformed rows fail visibly', () => {
  for (const change of [data=>data.fills[0].bot_name='other',data=>data.fills.push({...data.fills[0]}),data=>data.orders[0].order_id=null]) {
    const data=input();change(data);
    assert.throws(()=>buildRecordedBotStatistics('ok_rsi',data));
  }
});
test('missing fees are unavailable instead of zero and currencies never mix',()=>{
  const data=input();data.fills[0].fee_quote=null;
  assert.equal(buildRecordedBotStatistics('ok_rsi',data).fees,null);
  data.fills[0].pair='BTC-USDT';
  const stats=buildRecordedBotStatistics('ok_rsi',data);
  assert.equal(stats.volume,null);
  assert.equal(stats.quote,null);
  assert.equal(stats.pairs.length,2);
});
test('empty recorded history has zero events and no fabricated financial results',()=>{
  const stats=buildRecordedBotStatistics('ok_rsi',{fills:[],orders:[],executors:[]});
  assert.equal(stats.fillCount,0);
  assert.equal(stats.volume,null);
  assert.equal(stats.firstFillAt,null);
  assert.equal(stats.tradeWinRate,null);
});
test('HTTP success without a healthy complete database cannot mean zero activity',()=>{
  const healthy=()=>({health:{active_db_count:1,db_errors:0},data_health:{sources:[{bot_name:'ok_rsi',source_db_id:'db',db_status:'ok',warning_count:0}]}});
  assert.deepEqual(validateRecordedSource('ok_rsi',healthy()),['db']);
  for(const mutate of [v=>v.health.active_db_count=0,v=>v.health.db_errors=1,v=>v.data_health.sources=[],v=>v.data_health.sources[0].warning_count=1,v=>v.data_health.sources[0].bot_name='other']){
    const payload=healthy();mutate(payload);assert.throws(()=>validateRecordedSource('ok_rsi',payload));
  }
});
test('invalid source classifications fail instead of displaying false empty history',()=>{
  for(const mutate of [v=>v.fills[0].timestamp='invalid',v=>v.fills[0].side=null,v=>v.executors[0].normalized_status=null]){
    const value=input();mutate(value);assert.throws(()=>buildRecordedBotStatistics('ok_rsi',value));
  }
});
test('read boundary checks database health after the event reads and rejects cancellation',async()=>{
  const payload={health:{active_db_count:1,db_errors:0},data_health:{sources:[{bot_name:'ok_rsi',source_db_id:'db',db_status:'ok',warning_count:0}]}};
  let bootstrapReads=0;
  const read=async path=>path.includes('/bootstrap?') ? (++bootstrapReads===1?payload:{...payload,health:{active_db_count:1,db_errors:1}}) : {rows:[]};
  await assert.rejects(loadRecordedBotStatistics('ok_rsi',read,new AbortController().signal),/unavailable/);
  const controller=new AbortController();controller.abort();
  await assert.rejects(loadRecordedBotStatistics('ok_rsi',async()=>payload,controller.signal),{name:'AbortError'});
});

test('activity groups actual fill volume by UTC day and retains calendar gaps', () => {
  const data = input();
  data.fills = [
    row({fill_id:'a',order_id:'o1',side:'buy',timestamp:'2026-09-09T01:00:00+02:00',gross_volume_quote:10,fee_quote:0.01}),
    row({fill_id:'b',order_id:'o2',side:'sell',timestamp:'2026-09-10T23:00:00Z',gross_volume_quote:7,fee_quote:0.007}),
  ];
  const stats = buildRecordedBotStatistics('ok_rsi', data);
  assert.ok(stats.activity, 'Activity aggregation must be available');
  assert.deepEqual(stats.activity.daily.map(point => [point.startDate, point.endDate, point.buyVolume, point.sellVolume, point.fillCount]), [
    ['2026-09-08','2026-09-08',10,0,1],
    ['2026-09-09','2026-09-09',0,0,0],
    ['2026-09-10','2026-09-10',0,7,1],
  ]);
  assert.equal(stats.activity.daysWithoutRecordedFills, 1);
  assert.equal(stats.activity.bucketDays, 1);
});

test('long retained activity is bounded without dropping old fills or volume', () => {
  const data = input();
  data.fills = [
    row({fill_id:'a',order_id:'o1',side:'buy',timestamp:'2025-01-01T00:00:00Z',gross_volume_quote:10,fee_quote:0.01}),
    row({fill_id:'b',order_id:'o2',side:'sell',timestamp:'2026-01-01T00:00:00Z',gross_volume_quote:12,fee_quote:0.012}),
  ];
  const { activity } = buildRecordedBotStatistics('ok_rsi', data);
  assert.ok(activity, 'Activity aggregation must be available');
  assert.ok(activity.daily.length <= 90);
  assert.equal(activity.daily[0].startDate, '2025-01-01');
  assert.equal(activity.daily.at(-1).endDate, '2026-01-01');
  assert.equal(activity.daily.reduce((sum, point) => sum + point.buyVolume, 0), 10);
  assert.equal(activity.daily.reduce((sum, point) => sum + point.sellVolume, 0), 12);
  assert.equal(activity.daily.reduce((sum, point) => sum + point.fillCount, 0), 2);
  assert.equal(activity.daysWithoutRecordedFills, 364);
});

test('order distribution counts recorded statuses including unknown outcomes', () => {
  const data = input();
  data.orders.push(row({order_id:'o3',normalized_status:'unknown'}));
  const { activity } = buildRecordedBotStatistics('ok_rsi', data);
  assert.ok(activity, 'Activity aggregation must be available');
  assert.deepEqual(activity.orderStatuses, [
    {status:'canceled',count:1}, {status:'filled',count:1}, {status:'unknown',count:1},
  ]);
});

test('empty history has no invented series and mixed or missing volume is unavailable', () => {
  const empty = buildRecordedBotStatistics('ok_rsi', {fills:[],orders:[],executors:[],configuredPairs:['SUI-USDC']});
  assert.ok(empty.activity, 'Activity aggregation must be available');
  assert.deepEqual(empty.activity.daily, []);
  assert.deepEqual(empty.activity.orderStatuses, []);
  const mixed = input(); mixed.fills[0].pair = 'SOL-USDT';
  assert.equal(buildRecordedBotStatistics('ok_rsi', mixed).activity.volumeUnavailable, 'mixed_quote_currencies');
  assert.deepEqual(buildRecordedBotStatistics('ok_rsi', mixed).activity.daily, []);
  const missing = input(); missing.fills[0].gross_volume_quote = null;
  assert.equal(buildRecordedBotStatistics('ok_rsi', missing).activity.volumeUnavailable, 'missing_fill_volume');
  assert.deepEqual(buildRecordedBotStatistics('ok_rsi', missing).activity.daily, []);
});
