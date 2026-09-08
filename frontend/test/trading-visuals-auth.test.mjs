import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchTailscaleLogin, safeLoginRedirect } from '../src/lib/auth-login.ts';
import { parseTradingVisualsSources } from '../src/features/trading-visuals/sources.ts';
import { authFetch, TOKEN_KEY } from '../src/lib/auth-token.ts';

test('native authenticated monitor and download requests carry JWT only in the header', async () => {
  const previousFetch = globalThis.fetch;
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: key => key === TOKEN_KEY ? 'test-session' : null };
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return Response.json({}); };
  try {
    await authFetch('/api/v1/trading-visuals/bootstrap?bot=ok_rsi', { method: 'GET' });
    await authFetch('/api/v1/trading-visuals/export/orders.csv?bot=ok_rsi', { method: 'GET' });
    assert.equal(calls.length, 2);
    for (const { url, init } of calls) {
      assert.equal(init.headers.Authorization, 'Bearer test-session');
      assert.equal(init.method, 'GET');
      assert.ok(!url.includes('test-session'));
    }
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.localStorage = previousStorage;
  }
});

test('Tailscale sign-in is a dedicated POST and accepts only a real session', async () => {
  const session = { token: 'jwt', user: { id: 1, username: 'operator', first_name: 'Operator', role: 'user' } };
  const result = await fetchTailscaleLogin(async (url, init) => {
    assert.equal(url, '/api/v1/auth/tailscale');
    assert.equal(init.method, 'POST');
    return Response.json(session);
  });
  assert.deepEqual(result, session);
  assert.equal(await fetchTailscaleLogin(async () => new Response(null, { status: 404 })), null);
  await assert.rejects(fetchTailscaleLogin(async () => Response.json({ detail: 'Identity denied' }, { status: 403 })), /403.*Identity denied/);
  await assert.rejects(fetchTailscaleLogin(async () => Response.json({ user: {} })), /invalid/i);
});

test('login redirects preserve internal destinations and reject external forms', () => {
  assert.equal(safeLoginRedirect('/trading-visuals?bot=ok_rsi', '/'), '/trading-visuals?bot=ok_rsi');
  for (const value of ['https://evil.test', '//evil.test', '/\\evil.test', '', null]) {
    assert.equal(safeLoginRedirect(value, '/trading-visuals'), '/trading-visuals');
  }
});

test('source discovery preserves declared server identity and rejects unsupported or duplicate bots', () => {
  assert.deepEqual(parseTradingVisualsSources({ sources: [{ bot: 'ok_rsi', server: 'native-owner' }] }), [{ bot: 'ok_rsi', server: 'native-owner' }]);
  assert.deepEqual(parseTradingVisualsSources({ sources: [] }), []);
  for (const value of [{}, { sources: [{ bot: 'unknown', server: 'x' }] }, { sources: [{ bot: 'ok_rsi', server: '' }] }, { sources: [{ bot: 'ok_rsi', server: 'a' }, { bot: 'ok_rsi', server: 'b' }] }]) {
    assert.throws(() => parseTradingVisualsSources(value), /invalid|duplicated/);
  }
});
