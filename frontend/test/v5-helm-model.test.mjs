import assert from 'node:assert/strict';
import { test } from 'node:test';
import { helmHeadline } from '../src/v5/helm-model.mjs';

const status = (extra = {}) => ({ generated_at: 1793929882.6, reasons: [], ready: true, ...extra });

test('a missing status file reads as not running, other unreadable files as unreadable', () => {
  assert.deepEqual(helmHeadline({ state: 'UNAVAILABLE', reason: 'HELM_STATUS_MISSING', status: null }), { text: 'Not running (no status published yet)', good: false });
  assert.equal(helmHeadline({ state: 'UNAVAILABLE', reason: 'HELM_STATUS_SCHEMA', status: null }).text, 'Status file unreadable (HELM STATUS SCHEMA)');
  assert.equal(helmHeadline({ state: 'UNBOUND', reason: 'x', status: null }).text, 'Not connected to this dashboard');
});

test('only the runtime says stopped; an old status is unknown; running needs fresh and ready', () => {
  assert.equal(helmHeadline({ state: 'STALE', status: status({ reasons: ['runtime_stopped'] }) }).text, 'Stopped (last status 2026-11-06 01:51Z)');
  assert.match(helmHeadline({ state: 'STALE', status: status() }).text, /current state unknown/);
  assert.deepEqual(helmHeadline({ state: 'FRESH', status: status() }), { text: 'Running', good: true });
  assert.equal(helmHeadline({ state: 'FRESH', status: status({ ready: null }) }).text, 'Publishing status, ready: not published');
  assert.equal(helmHeadline(null).text, '');
});
