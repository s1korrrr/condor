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
