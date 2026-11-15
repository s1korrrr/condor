import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

test('shared strip poller retries a warming owner in five seconds', async () => {
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
  const observer = new QueryObserver(client, {...candleSummaryQuery(), retry:false, refetchInterval:candleSummaryInterval, refetchIntervalInBackground:true});
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('warming retry did not run')), 8000);
      observer.subscribe(result => { if (result.isSuccess) { clearTimeout(timeout); resolve(); } });
    });
    assert.equal(calls.length, 2);
    assert.ok(calls[1] - calls[0] >= 4900 && calls[1] - calls[0] < 8000);
  } finally {
    observer.destroy(); client.clear(); globalThis.fetch = originalFetch; delete globalThis.window;
  }
});
