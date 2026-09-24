import test from 'node:test';
import assert from 'node:assert/strict';
import { frontendModules } from './helpers/frontend-module.mjs';

const { load } = frontendModules();
const { projectFleetHealth, fleetCardState, serviceRollup, tradingVisualsHref } = load('fleet/native-fleet.ts');
const { projectQuantBotSummary } = load('features/bots/quant-roster.ts');
const now = Date.parse('2026-09-24T14:00:00Z');
const at = new Date(now - 1000).toISOString();

const operations = (health = {}) => ({ schema_version: 1, bot_name: 'rsi_modular_v2', generated_at: at, health: {
  schema_version: 1, generated_at: at, bot_name: 'rsi_modular_v2', state: 'unavailable', mode: 'running',
  heartbeat: { state: 'healthy', boot_id: 'fa3b7a25-4557', instance_id: 'rsibot-v2-rsi', lifecycle_state: 'running', sequence: 281 },
  services: [
    { id: 'api', state: 'healthy', detail: 'Container running', restart_count: 0, started_at: at, observed_at: at },
    { id: 'research', state: 'unavailable', detail: 'No container observed for this service', restart_count: null, started_at: null, observed_at: at },
    { id: 'execution-rsi', state: 'degraded', detail: 'Container exited', restart_count: 0, started_at: at, observed_at: at },
    { state: 'healthy' },
  ],
  expected_services: ['api', 'research', 'execution-rsi'], ...health,
}, service_history: { samples: [] }, service_logs: { services: [] }, incidents: { events: [] }, recovery: { services: [] } });

test('fleet health keeps only stamped rows for the requested bot', () => {
  const health = projectFleetHealth(operations(), 'rsi_modular_v2', now);
  assert.equal(health.heartbeat.bootId, 'fa3b7a25-4557');
  assert.deepEqual(health.services.map(row => row.id), ['api', 'research', 'execution-rsi']);
  assert.equal(projectFleetHealth(operations(), 'ok_rsi', now), null, 'another bot is never presented');
  assert.equal(projectFleetHealth(operations({ generated_at: new Date(now + 60_000).toISOString() }), 'rsi_modular_v2', now), null, 'a future generation is rejected');
  const rollup = serviceRollup(health);
  assert.equal(rollup.total, 3); assert.equal(rollup.healthy, 1);
  assert.deepEqual(rollup.attention.map(row => row.id), ['execution-rsi', 'research'], 'degraded outranks unavailable');
});

test('card state follows owner freshness, then the stack heartbeat', () => {
  const summary = payload => projectQuantBotSummary(payload, 'rsi_modular_v2', now);
  const base = { schema_version: 'rsibot.quant_ops.v1', execution_authorized: false, generated_at: at, source_times: { runtime_status: at }, scope: { bot_key: 'rsi_modular_v2', execution_mode: 'live', ownership_basis: 'native_verified' },
    data: { bot_id: 'rsi_modular_v2', operational_label: 'HOLDING', heartbeat: at, pairs: [], owned_value: { value: '1', unit: 'USDC', availability: 'available', freshness: 'fresh', observed_at: at }, net_lifecycle: { value: '0', unit: 'USDC', availability: 'available', freshness: 'fresh', observed_at: at }, cycle_counts: {}, risk_rails: { availability: 'unavailable', rails: [] } } };
  const health = projectFleetHealth(operations(), 'rsi_modular_v2', now);
  assert.equal(fleetCardState(summary(base), health, null).kind, 'fresh');
  assert.equal(fleetCardState(summary(base), projectFleetHealth(operations({ heartbeat: { state: 'stale' } }), 'rsi_modular_v2', now), null).kind, 'incomplete');
  const stale = summary({ ...base, data: { ...base.data, heartbeat: new Date(now - 120_000).toISOString(), last_known: { observed_at: at, pairs: [], operational_label: 'HOLDING' } } });
  assert.equal(fleetCardState(stale, health, null).kind, 'stale');
  assert.equal(fleetCardState(null, health, 'Access denied (403)').kind, 'unauthorized');
  assert.equal(fleetCardState(null, health, null).kind, 'unavailable');
  assert.equal(tradingVisualsHref('rsi_modular_v2', 'BTC-USDC'), '/trading-visuals?bot=rsi_modular_v2&view=charts&pair=BTC-USDC');
});
