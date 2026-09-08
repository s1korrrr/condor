import test from 'node:test';
import assert from 'node:assert/strict';
import { botCountLabel, nativeBotQuote, observedFleetCounts, expireNativeBotPage, botPollingPolicy } from '../src/lib/bot-monitoring.ts';

test('native bots use prompt REST observations and omit unsupported controller history', () => {
  assert.deepEqual(botPollingPolicy(true), { interval: 5000, controllerHistory: false, channels: [] });
  assert.deepEqual(botPollingPolicy(false), { interval: 30000, controllerHistory: true, channels: ['bots','controller_perf'] });
});

test('profile changes remove every legacy channel and restore them only for full API', () => {
  const full = botPollingPolicy(false).channels;
  const native = botPollingPolicy(true).channels;
  assert.deepEqual(full.filter(channel => !native.includes(channel)), ['bots','controller_perf']);
  assert.equal(native.join(','), '');
  assert.deepEqual(botPollingPolicy(false).channels.filter(channel => !native.includes(channel)), full);
});

function page() {
  return {bots:[{bot_name:'main',status:'running',num_controllers:1,controller_count_current:true,performance_received_at:1000,performance_stale_after_seconds:30,status_received_at:1005,status_stale_after_seconds:30}],controllers:[{bot_name:'main',global_pnl_quote:0}],total_pnl:0,total_volume:0,metrics_available:true};
}
test('native cached performance expires on source clock despite newer lifecycle or HTTP cache reads',()=>{
  const source=page();
  assert.equal(expireNativeBotPage(source,true,1029000).total_pnl,0);
  const expired=expireNativeBotPage(source,true,1030000);
  assert.equal(expired.total_pnl,null);
  assert.equal(expired.metrics_available,false);
  assert.equal(expired.controllers.length,0);
  assert.equal(expired.bots[0].controller_count_current,false);
  assert.equal(expired.bots[0].status,'running');
  assert.equal(expireNativeBotPage(source,true,1035000).bots[0].status,'stale');
  assert.equal(source.bots[0].controller_count_current,true);
});
test('missing timestamps fail closed and fresh source recovery restores observed zero',()=>{
  const source=page();delete source.bots[0].performance_received_at;
  assert.equal(expireNativeBotPage(source,true,1001000).metrics_available,false);
  const fresh=page();fresh.bots[0].performance_received_at=1100;fresh.bots[0].status_received_at=1100;
  assert.equal(expireNativeBotPage(fresh,true,1101000).total_pnl,0);
  assert.equal(expireNativeBotPage(fresh,true,1101000).controllers.length,1);
});
test('full API semantics remain unchanged and native rows cannot borrow another bots expiry',()=>{
  const source=page();assert.equal(expireNativeBotPage(source,false,999999999),source);
  source.controllers.push({bot_name:'sui',global_pnl_quote:42});
  assert.deepEqual(expireNativeBotPage(source,true,1001000).controllers.map(row=>row.bot_name),['main']);
});

test('native identity counts survive absent economics and label unknown fleet coverage', () => {
  assert.deepEqual(observedFleetCounts([
    { status: 'running', num_controllers: 5, controller_count_current: true },
    { status: 'unknown', num_controllers: 0, controller_count_current: false },
  ]), { active: '1 observed · partial', controllers: '5 observed · partial' });
  assert.deepEqual(observedFleetCounts([
    { status: 'running', num_controllers: 5, controller_count_current: true },
  ]), { active: '1 observed', controllers: '5 observed' });
  assert.deepEqual(observedFleetCounts([]), { active: 'UNAVAILABLE', controllers: 'UNAVAILABLE' });
  assert.equal(nativeBotQuote(null, 'USDC').converted, false);
});

test('native unknown counts remain unavailable while verified zero and full API zero remain zero', () => {
  assert.equal(botCountLabel(0, true, false), 'UNAVAILABLE');
  assert.equal(botCountLabel(22, true, false), 'UNAVAILABLE');
  assert.equal(botCountLabel(0, true, true), '0');
  assert.equal(botCountLabel(22, true, true), '22');
  assert.equal(botCountLabel(0, false, false), '0');
});

test('native economics preserve source USDC values and reject implicit conversion', () => {
  assert.deepEqual(nativeBotQuote(360.25, 'USDC'), {value:360.25, converted:true});
  assert.deepEqual(nativeBotQuote(0, 'USDC'), {value:0, converted:true});
  for (const [value,quote] of [[360.25,'USDT'],[1,'BTC'],[NaN,'USDC'],[Infinity,'USDC']]) {
    assert.equal(nativeBotQuote(value,quote).converted, false);
    assert.equal(Number.isNaN(nativeBotQuote(value,quote).value), true);
  }
});
