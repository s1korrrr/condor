import assert from 'node:assert/strict';
import { test } from 'node:test';
import { helmHeadline } from '../src/v5/helm-model.mjs';

const READY = [{ id: 'modular_spot_helm_v5_paper', gate: 'ready', note: '' }];
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
  assert.deepEqual(helmHeadline({ state: 'FRESH', status: status({ symbols: coins, gates: READY }) }),
    { text: 'Running, waiting for a signal', good: true, detail: 'Every coin idle: no rebound · coin status portfolio grant required.' });
  assert.deepEqual(helmHeadline({ state: 'FRESH', status: status({ symbols: [coins[0], { pair: 'X-USDC', status: 'active', candidate_hold: null }] }) }), { text: 'Running', good: true });
  assert.deepEqual(helmHeadline({ state: 'FRESH', status: status({ entries_held: 'operator_entry_pause', symbols: coins }) }), { text: 'Running, not buying: operator entry pause', good: false });
  assert.equal(helmHeadline({ state: 'FRESH', status: status({ operator_entry_paused: true }) }).text, 'Running, not buying: new entries paused by the operator');
});

test('a fault or unknown hold is never shown as normal waiting', () => {
  const coin = (pair, hold) => ({ pair, status: 'portfolio_grant_required', candidate_hold: hold });
  assert.deepEqual(helmHeadline({ state: 'FRESH', status: status({ symbols: [coin('BNB-USDC', 'symbol_fault'), coin('BTC-USDC', 'symbol_fault')] }) }),
    { text: 'Running, not buying on any coin: symbol fault', good: false });
  assert.deepEqual(helmHeadline({ state: 'FRESH', status: status({ symbols: [coin('BNB-USDC', 'no_rebound'), coin('BTC-USDC', 'observation_checkpoint_required')] }) }),
    { text: 'Running, not buying on BTC-USDC: observation checkpoint required', good: false });
  assert.equal(helmHeadline({ state: 'FRESH', status: status({ symbols: [coin('BNB-USDC', 'something_new')] }) }).good, false);
  assert.equal(helmHeadline({ state: 'FRESH', status: status({ gates: READY, symbols: [coin('BNB-USDC', 'low_volatility'), coin('BTC-USDC', 'no_rebound')] }) }).text, 'Running, waiting for a signal');
});

test('a controller gate other than ready holds buys even when every coin only waits for a signal (Sol R2)', () => {
  const coins = ['BNB-USDC', 'BTC-USDC'].map(pair => ({ pair, status: 'portfolio_grant_required', candidate_hold: 'no_rebound' }));
  assert.deepEqual(helmHeadline({ state: 'FRESH', status: status({ symbols: coins, gates: [{ id: 'c', gate: 'symbol_fault', note: 'BNB-USDC' }] }) }),
    { text: 'Running, not buying: symbol fault (BNB-USDC)', good: false });
  // A gate that is not published is never read as ready, so idle coins are not called "waiting for a signal".
  assert.equal(helmHeadline({ state: 'FRESH', status: status({ symbols: coins, gates: [{ id: 'c', gate: null, note: null }] }) }).text, 'Running, not buying: gate not published');
  assert.deepEqual(helmHeadline({ state: 'FRESH', status: status({ symbols: coins }) }), { text: 'Running', good: true });
});
