import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readStockOwner } from '../src/v5/stocks-api.ts';

test('read uses fixed authenticated owner route and exact identity', async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    return { ok: true, status: 200, json: async () => ({ state: 'AVAILABLE', data: { instId: 'EXAMPLE-USDT-270101' } }) };
  };
  try {
    const result = await readStockOwner('stock-market', { region: 'eea', instId: 'EXAMPLE-USDT-270101', instType: 'FUTURES' }, controller.signal);
    assert.equal(result.instId, 'EXAMPLE-USDT-270101');
    assert.equal(request.url, '/api/v5/candle-store/stock-market?region=eea&instId=EXAMPLE-USDT-270101&instType=FUTURES');
    assert.equal(request.init.credentials, 'include');
    assert.equal(request.init.cache, 'no-store');
    assert.equal(request.init.method, undefined);
    controller.abort();
    assert.equal(request.init.signal.aborted, true);
  } finally { globalThis.fetch = original; }
});

test('HTTP or owner-envelope error rejects even when a cached-looking price is attached', async () => {
  const original = globalThis.fetch;
  try {
    for (const response of [
      { ok: false, status: 503, json: async () => ({ state: 'UNAVAILABLE', reason: 'owner_unreachable', data: { last: '123.45' } }) },
      { ok: true, status: 200, json: async () => ({ state: 'UNAVAILABLE', reason: 'owner_invalid_stock_identity', data: { last: '123.45' } }) },
      { ok: true, status: 200, json: async () => ({ state: 'AVAILABLE', data: null }) },
    ]) {
      globalThis.fetch = async () => response;
      await assert.rejects(readStockOwner('stocks', { region: 'eea' }));
    }
  } finally { globalThis.fetch = original; }
});
