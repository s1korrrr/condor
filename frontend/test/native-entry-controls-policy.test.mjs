import test from 'node:test';
import assert from 'node:assert/strict';
import { frontendModules } from './helpers/frontend-module.mjs';

const { load } = frontendModules();
const { entryStatusRefetchInterval, ENTRY_CONTROLS_UNSUPPORTED } = load('lib/native-entry-controls.ts');

test('only an owner that does not permit entry controls stops polling; transient conflicts keep polling', () => {
  // Live 2026-10-05: V1 and V3 answered 409 "Registered owner does not permit native entry controls" every 5 s.
  assert.equal(entryStatusRefetchInterval({ status: 409, capability: ENTRY_CONTROLS_UNSUPPORTED }), false);
  // The upstream also answers 409 while a supported owner restarts or its reports are stale: keep polling.
  assert.equal(entryStatusRefetchInterval({ status: 409, capability: null }), 5000);
  assert.equal(entryStatusRefetchInterval({ status: 503 }), 5000);
  assert.equal(entryStatusRefetchInterval(new Error('network')), 5000);
  assert.equal(entryStatusRefetchInterval(null), 5000);
});
