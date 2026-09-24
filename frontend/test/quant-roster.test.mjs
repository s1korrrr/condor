import test from 'node:test';
import assert from 'node:assert/strict';
import { frontendModules } from './helpers/frontend-module.mjs';

const { load } = frontendModules();
const { projectQuantBotSummary, projectRecordedDecisions, projectQuantExecution, validDraftPairSyntax } = load('features/bots/quant-roster.ts');
const now = Date.parse('2026-09-24T12:00:00Z');
const at = new Date(now - 1000).toISOString();

function summary(overrides = {}) {
  const baseData = {
    bot_id: 'rsi_modular_v2', operational_state: 'MIXED', operational_label: 'MIXED: FLAT / HOLDING',
    heartbeat: at,
    pairs: [{ controller_id: 'eth-core', pair: 'ETH-USDC', state: 'HOLDING', regime: 'oversold', units: '0.04', entry_cost: '99', mark: '2500', marked_value: '100', unrealized: '1', fees: '0.1' }],
    owned_value: { value: '100', unit: 'USDC', availability: 'available', freshness: 'fresh', observed_at: at },
    net_lifecycle: { value: '0.9', unit: 'USDC', availability: 'available', freshness: 'fresh', observed_at: at, fee_basis: 'net_incurred' },
    cycle_counts: { open: 1, closed_scored: 0, ownership_transfer: 1, unclassified: 2 },
  };
  return {
    schema_version: 'rsibot.quant_ops.v1', execution_authorized: false,
    generated_at: at, source_times: { runtime_status: at },
    scope: { bot_key: 'rsi_modular_v2', execution_mode: 'live', ownership_basis: 'native_verified' },
    ...overrides,
    scope: { bot_key: 'rsi_modular_v2', execution_mode: 'live', ownership_basis: 'native_verified', ...overrides.scope },
    source_times: { runtime_status: at, ...overrides.source_times },
    data: { ...baseData, ...overrides.data },
  };
}

test('quant bot summary admits only same-bot current native data and preserves real fields', () => {
  const view = projectQuantBotSummary(summary(), 'rsi_modular_v2', now);
  assert.equal(view.freshness, 'current');
  assert.equal(view.ownershipBasis, 'native_verified');
  assert.equal(view.pairs[0].regime, 'oversold');
  assert.equal(view.pairs[0].units, '0.04');
  assert.equal(view.netLifecycle.value, '0.9');
  assert.equal(view.netLifecycle.feeBasis, 'net_incurred');
  assert.equal(view.cycleCounts.ownershipTransfer, 1);
});

test('wrong owner and future generated source are rejected; stale runtime cannot look current', () => {
  assert.equal(projectQuantBotSummary(summary({ scope: { bot_key: 'other' } }), 'rsi_modular_v2', now), null);
  assert.equal(projectQuantBotSummary(summary({ generated_at: new Date(now + 60_000).toISOString() }), 'rsi_modular_v2', now), null);
  const stale = projectQuantBotSummary(summary({ data: { heartbeat: new Date(now - 31_000).toISOString() } }), 'rsi_modular_v2', now);
  assert.equal(stale.freshness, 'stale');
  assert.equal(stale.pairs.length, 0);
  assert.equal(stale.ownedValue.value, null);
});

test('recorded decisions require stable event identity and never synthesize rows from current conditions', () => {
  const payload = {
    schema_version: 'rsibot.quant_ops.v1', execution_authorized: false, generated_at: at,
    scope: { bot_key: 'rsi_modular_v2', execution_mode: 'live' },
    data: { bot_id: 'rsi_modular_v2', current_conditions: [{ pair: 'BTC-USDC', state: 'HOLDING' }], decisions: [
      { decision_id: 'd-1', owner_boot_id: 'boot-1', controller_id: 'btc', config_revision: 'cfg-9', action: 'HOLD', pair: 'BTC-USDC', sequence: 2, occurred_at: at, reason_codes: ['risk_clear'], order_ids: [], fill_ids: [], linkage: 'unlinked' },
      { decision_id: 'd-2', controller_id: 'btc', action: 'BUY', occurred_at: at },
      { decision_id: 'd-1', owner_boot_id: 'boot-1', controller_id: 'btc', config_revision: 'cfg-9', action: 'HOLD', pair: 'BTC-USDC', sequence: 2, occurred_at: at },
    ] },
  };
  const decisions = projectRecordedDecisions(payload, 'rsi_modular_v2', now);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].decisionId, 'd-1');
  assert.equal(decisions[0].linkage, 'unlinked');
  assert.equal(projectRecordedDecisions({ ...payload, data: { ...payload.data, decisions: undefined } }, 'rsi_modular_v2'), null);
  assert.equal(projectRecordedDecisions(payload, 'ok_rsi'), null);
  assert.equal(projectRecordedDecisions({ ...payload, generated_at: new Date(now + 60_000).toISOString() }, 'rsi_modular_v2', now), null);
  assert.equal(projectRecordedDecisions({ ...payload, scope: { bot_key: 'rsi_modular_v2', execution_mode: 'unknown' } }, 'rsi_modular_v2', now), null);
});

test('execution histogram requires matching owner, an available cohort, and reconciling sample counts', () => {
  const bins = [{ from: -5, to: 0, count: 1 }, { from: 0, to: 5, count: 2 }];
  const payload = { bot_id: 'rsi_modular_v2', execution_authorized: false, histogram: { availability: 'available', unit: 'bps', bins, sample_count: 3, excluded_count: 1, paper_excluded: 2 } };
  assert.equal(projectQuantExecution(payload, 'rsi_modular_v2').sampleCount, 3);
  assert.equal(projectQuantExecution(payload, 'other'), null);
  assert.equal(projectQuantExecution({ ...payload, histogram: { ...payload.histogram, sample_count: 4 } }, 'rsi_modular_v2'), null);
  assert.equal(projectQuantExecution({ ...payload, histogram: { availability: 'unavailable', unit: 'bps', bins: Array.from({ length: 20 }, (_, i) => ({ from: i, to: i + 1, count: 0 })), sample_count: 0, excluded_count: 0, paper_excluded: 0 } }, 'rsi_modular_v2'), null);
});

test('draft pair syntax rejects empty, malformed and duplicate symbols without claiming venue support', () => {
  assert.equal(validDraftPairSyntax('BTC-USDC ETH-USDC'), true);
  assert.equal(validDraftPairSyntax(''), false);
  assert.equal(validDraftPairSyntax('BTC-USDC bad/pair'), false);
  assert.equal(validDraftPairSyntax('BTC-USDC BTC-USDC'), false);
});

test('fresh heartbeat cannot refresh an independently stale metric',()=>{
 const payload=summary();
 payload.data.net_lifecycle.observed_at=new Date(now-31_000).toISOString();
 const view=projectQuantBotSummary(payload,'rsi_modular_v2',now);
 assert.equal(view.freshness,'current');
 assert.equal(view.netLifecycle.value,null);
 assert.equal(view.ownedValue.value,'100');
});
