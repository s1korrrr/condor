import test from 'node:test';
import assert from 'node:assert/strict';
import { frontendModules } from './helpers/frontend-module.mjs';

const { projectControllerPnl } = frontendModules().load('features/bots/controller-pnl.ts');
const now = Date.parse('2026-09-29T10:00:00Z');
const payload = (changes = {}) => {
  const observed = now / 1000 - 1;
  return {
    bots: [{ bot_name: 'v2', status: 'running', num_controllers: 1, controller_count_current: true,
      status_received_at: observed, status_stale_after_seconds: 30, performance_received_at: observed, performance_stale_after_seconds: 30 }],
    controllers: [{ bot_name: 'v2', controller_id: 'eth-core', trading_pair: 'ETH-USDC',
      realized_pnl_quote: 1.2, unrealized_pnl_quote: 0.8, global_pnl_quote: 2, volume_traded: 15 }],
    ...changes,
  };
};

test('controller PnL requires complete current identity and reconciled components', () => {
  const current = projectControllerPnl(payload(), 'v2', now);
  assert.equal(current.total, 2);
  assert.equal(current.realized, 1.2);
  assert.equal(current.unrealized, 0.8);
  assert.equal(current.quote, 'USDC');
  assert.equal(current.rows[0].id, 'eth-core');
  assert.equal(current.rows[0].volume, 15);
  assert.equal(projectControllerPnl(payload(), 'other', now).total, null);
  assert.equal(projectControllerPnl(payload({ controllers: [{ ...payload().controllers[0], global_pnl_quote: 9 }] }), 'v2', now).total, null);
  assert.equal(projectControllerPnl(payload({ controllers: [payload().controllers[0], payload().controllers[0]] }), 'v2', now).total, null);
  assert.equal(projectControllerPnl(payload({ bots: [{ ...payload().bots[0], num_controllers: 2 }] }), 'v2', now).total, null);
  assert.equal(projectControllerPnl(payload(), 'v2', now + 31_000).total, null, 'cached metrics expire by source timestamp');
});
