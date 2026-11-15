import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

test('shared strip poller retries warming at five seconds then resumes thirty seconds', async context => {
  globalThis.window = new Window({url:'https://fixture.invalid/'});
  const { QueryClient, QueryObserver } = await import('@tanstack/react-query');
  const { frontendModules } = await import('./helpers/frontend-module.mjs');
  const { candleSummaryInterval, candleSummaryQuery } = frontendModules().load('v5/candle-store-api');
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async () => {
    calls.push(Date.now());
    return {ok:true, json:async () => calls.length === 1 ? {state:'UNAVAILABLE',reason:'owner_warming'} : {state:'AVAILABLE',data:{tiles:[]}}};
  };
  const client = new QueryClient();
  const observer = new QueryObserver(client, {...candleSummaryQuery(), retry:false, refetchInterval:candleSummaryInterval});
  try {
    context.mock.timers.enable({apis:['setInterval']});
    observer.subscribe(() => {});
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));
    await settle();
    assert.equal(calls.length, 1);
    context.mock.timers.tick(4999); await settle();
    assert.equal(calls.length, 1);
    context.mock.timers.tick(1); await settle();
    assert.equal(calls.length, 2);
    assert.equal(observer.getCurrentResult().isSuccess, true);
    context.mock.timers.tick(29_999); await settle();
    assert.equal(calls.length, 2);
    context.mock.timers.tick(1); await settle();
    assert.equal(calls.length, 3);
  } finally {
    observer.destroy(); client.clear(); context.mock.timers.reset(); globalThis.fetch = originalFetch; delete globalThis.window;
  }
});
