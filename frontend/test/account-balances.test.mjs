import test from 'node:test';
import assert from 'node:assert/strict';
import { accountFreshness } from '../src/lib/account-balances.ts';

const now = Date.parse('2026-09-08T20:00:30Z');
const account = {status:'fresh',observed_at:'2026-09-08T20:00:10Z'};

test('account observations expire on the browser clock during request outages', () => {
  assert.equal(accountFreshness(account, now).current, true);
  assert.equal(accountFreshness(account, now + 10000).current, false);
  assert.equal(accountFreshness(account, now, true).current, false);
  assert.equal(accountFreshness({...account, status:'stale'}, now).current, false);
});

test('missing, invalid and future account timestamps do not establish freshness', () => {
  for (const observed_at of [null,'invalid','2026-09-08T21:00:00Z']) {
    assert.equal(accountFreshness({...account,observed_at},now).current,false);
  }
});
