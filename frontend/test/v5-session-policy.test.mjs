import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmLogout } from '../src/v5/session-policy.mjs';

test('failed logout keeps the authenticated UI and exposes failure', async () => {
  let cleared = 0, errors = 0;
  assert.equal(await confirmLogout(async () => { throw new Error('network or forbidden'); }, () => cleared++, () => errors++), false);
  assert.equal(cleared, 0);
  assert.equal(errors, 1);
});

test('confirmed logout clears the authenticated UI once', async () => {
  let cleared = 0, errors = 0;
  assert.equal(await confirmLogout(async () => {}, () => cleared++, () => errors++), true);
  assert.equal(cleared, 1);
  assert.equal(errors, 0);
});

test('logout updates the mounted auth observer while clearing owner data', async () => {
  const { QueryClient, QueryObserver } = await import('@tanstack/query-core');
  const { clearSessionCache } = await import('../src/v5/session-policy.mjs');
  const client = new QueryClient();
  client.setQueryData(['v5-auth'], {authenticated:true});
  client.setQueryData(['v5-workspace'], {private:'cached owner data'});
  const observer = new QueryObserver(client, {queryKey:['v5-auth'], enabled:false});
  const stop = observer.subscribe(() => {});
  clearSessionCache(client);
  assert.equal(observer.getCurrentResult().data.authenticated, false);
  assert.equal(client.getQueryData(['v5-workspace']), undefined);
  stop(); client.clear();
});

test('sign-out and auth loss also clear what the session registered, and keep the auth observer', async () => {
  const { QueryClient } = await import('@tanstack/query-core');
  const { clearSessionCache, dropSessionReads, onSessionEnd } = await import('../src/v5/session-policy.mjs');
  let retained = 0;
  onSessionEnd(() => { retained = 0; });
  for (const end of [clearSessionCache, dropSessionReads]) {
    const client = new QueryClient();
    client.setQueryData(['v5-auth'], {authenticated:true});
    client.setQueryData(['v5-workspace'], {private:'cached owner data'});
    retained = 1;
    end(client);
    assert.equal(retained, 0);
    assert.equal(client.getQueryData(['v5-workspace']), undefined);
    assert.ok(client.getQueryData(['v5-auth']));
    client.clear();
  }
});
