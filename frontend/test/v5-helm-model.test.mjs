import assert from 'node:assert/strict';
import { test } from 'node:test';
import { helmHeadline } from '../src/v5/helm-model.mjs';

const READY = [{ gate: 'ready', note: '' }];
const status = (extra = {}) => ({ generated_at: 1793929882.6, reasons: [], ready: true, ...extra });

test('a missing status file says only that, other unreadable files stay unreadable', () => {
  assert.deepEqual(helmHeadline({ state: 'UNAVAILABLE', reason: 'HELM_STATUS_MISSING', status: null }), { text: 'No status file published; current state unknown', good: false });
  assert.equal(helmHeadline({ state: 'UNAVAILABLE', reason: 'HELM_STATUS_SCHEMA', status: null }).text, 'Status file unreadable (HELM STATUS SCHEMA)');
  assert.equal(helmHeadline({ state: 'UNBOUND', reason: 'x', status: null }).text, 'Not connected to this dashboard');
});

test('only the runtime says stopped; an old status is unknown; running needs fresh and ready', () => {
  assert.equal(helmHeadline({ state: 'STALE', status: status({ reasons: ['runtime_stopped'] }) }).text, 'Stopped (last status 2026-11-06 01:51Z)');
  assert.match(helmHeadline({ state: 'STALE', status: status() }).text, /current state unknown/);
  assert.deepEqual(helmHeadline({ state: 'FRESH', status: status({ gates: READY }) }), { text: 'Running, entry gate ready', good: null, detail: undefined });
  assert.equal(helmHeadline({ state: 'FRESH', status: status({ ready: null }) }).text, 'Publishing status, ready: not published');
  assert.equal(helmHeadline(null).text, '');
});

// States the engine can produce (helm_v5.get_status_summary gate + portfolio candidate holds), per the Fable 5.2
// escalation: red comes only from owner gate fields; coin holds only upgrade a ready gate to "waiting for a signal".
const coin = (pair, hold) => ({ pair, status: 'portfolio_grant_required', candidate_hold: hold });
const rows = [
  ['ready gate, every coin no_rebound', { gates: READY, symbols: [coin('BNB-USDC', 'no_rebound'), coin('ETH-USDC', 'no_rebound')] },
    { text: 'Running, waiting for a signal', good: true, detail: 'Every coin idle: no rebound.' }],
  ['ready gate, mixed signal waits', { gates: READY, symbols: [coin('BNB-USDC', 'low_volatility'), coin('ETH-USDC', 'no_rebound')] },
    { text: 'Running, waiting for a signal', good: true, detail: 'Every coin idle: low volatility, no rebound.' }],
  ['ready gate, a planner code on one coin (normal operation)', { gates: READY, symbols: [coin('BNB-USDC', 'no_rebound'), coin('ETH-USDC', 'bag_gap_not_met')] },
    { text: 'Running, entry gate ready', good: null, detail: 'ETH-USDC: bag gap not met' }],
  ['ready gate, one coin without an entry check this tick', { gates: READY, symbols: [coin('BNB-USDC', 'no_rebound'), coin('ETH-USDC', null)] },
    { text: 'Running, entry gate ready', good: null, detail: 'ETH-USDC: no entry check published this tick' }],
  ['symbol_fault gate while every coin reads no_rebound', { gates: [{ gate: 'symbol_fault', note: 'BNB-USDC' }], symbols: [coin('BNB-USDC', 'no_rebound'), coin('ETH-USDC', 'no_rebound')] },
    { text: 'Running, not buying: symbol fault (BNB-USDC)', good: false }],
  ['ENTRY_HOLD gate', { gates: [{ gate: 'ENTRY_HOLD', note: 'operator_entry_pause' }], symbols: [coin('BNB-USDC', 'operator_entry_pause')] },
    { text: 'Running, not buying: ENTRY HOLD (operator_entry_pause)', good: false }],
  ['no gate published', { symbols: [coin('BNB-USDC', 'no_rebound')] },
    { text: 'Running; entry gate not published', good: null }],
  ['operator pause flag', { gates: READY, operator_entry_paused: true, symbols: [coin('BNB-USDC', 'no_rebound')] },
    { text: 'Running, not buying: new entries paused by the operator', good: false }],
  ['entries held', { gates: READY, entries_held: 'operator_entry_pause', symbols: [coin('BNB-USDC', 'no_rebound')] },
    { text: 'Running, not buying: operator entry pause', good: false }],
];
for (const [name, extra, expected] of rows) {
  test(`Helm headline: ${name}`, () => assert.deepEqual(helmHeadline({ state: 'FRESH', status: status(extra) }), expected));
}
