import assert from 'node:assert/strict';
import { test } from 'node:test';
import { helmHeadline } from '../src/v5/helm-model.mjs';

const status = (extra = {}) => ({ generated_at: 1793929882.6, reasons: [], ready: true, ...extra });

test('a missing status file says only that, other unreadable files stay unreadable', () => {
  assert.deepEqual(helmHeadline({ state: 'UNAVAILABLE', reason: 'HELM_STATUS_MISSING', status: null }), { text: 'No status file published; current state unknown', good: false });
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

test('running with every coin idle says it is waiting for a signal; held entries say not buying and why', () => {
  const coins = ['BNB-USDC', 'BTC-USDC'].map(pair => ({ pair, status: 'portfolio_grant_required', candidate_hold: 'no_rebound' }));
  assert.deepEqual(helmHeadline({ state: 'FRESH', status: status({ symbols: coins }) }),
    { text: 'Running, waiting for a signal', good: true, detail: 'Every coin idle: no rebound · coin status portfolio grant required.' });
  assert.deepEqual(helmHeadline({ state: 'FRESH', status: status({ symbols: [coins[0], { pair: 'X-USDC', status: 'active', candidate_hold: null }] }) }), { text: 'Running', good: true });
  assert.deepEqual(helmHeadline({ state: 'FRESH', status: status({ entries_held: 'operator_entry_pause', symbols: coins }) }), { text: 'Running, not buying: operator entry pause', good: false });
  assert.equal(helmHeadline({ state: 'FRESH', status: status({ operator_entry_paused: true }) }).text, 'Running, not buying: new entries paused by the operator');
});
