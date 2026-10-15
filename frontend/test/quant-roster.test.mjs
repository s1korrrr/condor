import test from 'node:test';
import fs from 'node:fs';
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
    net_lifecycle: { value: null, unit: 'USDC', availability: 'unavailable', freshness: 'unknown', observed_at: at, reason_code: 'QUALIFIED_LIFECYCLE_SOURCE_UNAVAILABLE' },
    retained_position_net_pnl: { value: '0.9', unit: 'USDC', availability: 'available', freshness: 'fresh', observed_at: at, fee_basis: 'net_incurred', metric_scope: 'retained_positions', calculation_version: 'retained_position_v1' },
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
  assert.equal(view.netLifecycle.value, null);
  assert.equal(view.retainedPositionNetPnl.value, '0.9');
  assert.equal(view.retainedPositionNetPnl.feeBasis, 'net_incurred');
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

test('fresh UNKNOWN operational state is current without promoting unavailable or last-known metrics', () => {
  const lastKnown = { observed_at: new Date(now - 60_000).toISOString(), operational_label: 'HOLDING',
    owned_value_value: '777', pairs: [{ controller_id: 'old', pair: 'BTC-USDC', state: 'HOLDING' }],
    risk_rails: { rails: [{ name: 'old_limit', limit: '50' }] },
    wallet: { availability: 'available', currency: 'USDC', value: '999', observed_at: new Date(now - 60_000).toISOString() } };
  const payload = summary({ data: {
    operational_state: 'UNKNOWN', operational_label: 'UNKNOWN',
    pairs: [{ controller_id: 'meridian', pair: 'BTC-USDC', units: '9', marked_value: '900' }],
    owned_value: { value: '900', unit: 'USDC', availability: 'available', freshness: 'stale', observed_at: new Date(now - 60_000).toISOString() },
    retained_position_net_pnl: { value: '12', unit: 'USDC', availability: 'available', freshness: 'stale', observed_at: new Date(now - 60_000).toISOString() },
    risk_rails: { availability: 'available', rails: [{ name: 'old_limit', limit: '50' }] },
    wallet: { availability: 'available', currency: 'USDC', value: '500', observed_at: new Date(now - 60_000).toISOString() },
    last_known: lastKnown,
  } });
  const current = projectQuantBotSummary(payload, 'rsi_modular_v2', now);
  assert.equal(current.freshness, 'current');
  assert.equal(current.state, 'UNKNOWN');
  assert.deepEqual(current.pairs, []);
  assert.equal(current.ownedValue.value, null);
  assert.equal(current.ownedValue.lastKnown, null);
  assert.equal(current.ownedValue.reason, 'OPERATIONAL_STATE_UNAVAILABLE');
  assert.equal(current.ownedValue.freshness, 'unknown');
  assert.equal(current.retainedPositionNetPnl.value, null);
  assert.equal(current.retainedPositionNetPnl.reason, 'OPERATIONAL_STATE_UNAVAILABLE');
  assert.equal(current.riskRails.availability, 'unavailable');
  assert.equal(current.wallet, null);
  assert.equal(current.lastKnown, false);

  payload.data.heartbeat = new Date(now - 31_000).toISOString();
  const stale = projectQuantBotSummary(payload, 'rsi_modular_v2', now);
  assert.equal(stale.freshness, 'stale');
  assert.equal(stale.ownedValue.value, null);
  assert.equal(stale.ownedValue.lastKnown, '777');
  assert.equal(stale.pairs[0].pair, 'BTC-USDC');
  assert.equal(stale.wallet.availability, 'stale');
  assert.equal(stale.lastKnown, true);
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
  const bins = [{ from: null, to: -5, label: '< -5', count: 1 }, { from: -5, to: 0, label: '-5–0', count: 1 }, { from: 0, to: 5, label: '0–5', count: 0 }, { from: 5, to: null, label: '>= 5', count: 1 }];
  const payload = { bot_id: 'rsi_modular_v2', execution_authorized: false, histogram: { availability: 'available', unit: 'bps', bins, sample_count: 3, excluded_count: 1, paper_excluded: 2 } };
  assert.equal(projectQuantExecution(payload, 'rsi_modular_v2').sampleCount, 3);
  assert.deepEqual(projectQuantExecution(payload, 'rsi_modular_v2').bins.map(bin => bin.label), ['< -5', '-5–0', '0–5', '>= 5']);
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

// Real reporting envelopes for meridian_v3 (shared with the Python fleet summary tests). The unified controller
// publishes no per-pair state, so the owner admits the source through `coverage` while the label stays UNKNOWN.
const v3Fixture = name => JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/fleet_summary/${name}`, import.meta.url), 'utf8'));

test('owner coverage, not the UNKNOWN label sentinel, admits a current V3 summary', () => {
  const admitted = v3Fixture('quant_summary_meridian_v3_admitted.json');
  const clock = Date.parse(admitted.generated_at) + 1000;
  const view = projectQuantBotSummary(admitted, 'meridian_v3', clock);
  assert.equal(admitted.data.operational_label, 'UNKNOWN', 'fixture proves the label sentinel is present');
  assert.equal(view.admitted, true);
  assert.deepEqual(view.pairs.map(pair => pair.pair), ['BNB-USDC', 'BTC-USDC', 'ETH-USDC', 'SOL-USDC', 'XRP-USDC']);
  assert.ok(view.pairs.every(pair => pair.units !== null && pair.markedValue !== null));
  assert.equal(view.ownedValue.availability, 'available');
  assert.equal(view.riskRails.availability, 'available');
  assert.equal(view.cycleCounts.open, 10);
  const stale = projectQuantBotSummary(admitted, 'meridian_v3', clock + 120_000);
  assert.equal(stale.freshness, 'stale', 'consumer freshness still gates an owner-admitted envelope');
  assert.equal(stale.admitted, false);
  assert.deepEqual(stale.pairs, [], 'no last_known block means nothing is shown as current');
});

test('an owner-declared unverified scope stays unadmitted even with a fresh heartbeat', () => {
  const unverified = v3Fixture('quant_summary_meridian_v3_unverified.json');
  assert.deepEqual(unverified.coverage.reasons, ['SOURCE_SCOPE_UNVERIFIED']);
  const view = projectQuantBotSummary(unverified, 'meridian_v3', Date.parse(unverified.generated_at) + 1000);
  assert.equal(view.freshness, 'current');
  assert.equal(view.admitted, false);
  assert.deepEqual(view.pairs, []);
  const forged = { ...unverified, data: { ...unverified.data, operational_label: 'HOLDING', pairs: [{ pair: 'ETH-USDC', units: '1' }] } };
  assert.deepEqual(projectQuantBotSummary(forged, 'meridian_v3', Date.parse(unverified.generated_at) + 1000).pairs, [], 'a label cannot override the owner coverage verdict');
});
