import test from 'node:test';
import assert from 'node:assert/strict';
import { frontendModules } from './helpers/frontend-module.mjs';

const { load } = frontendModules();
const { projectQuantBotSummary, projectQuantCycles, projectExecutionStats, projectLifecycleDecisions, projectFills } = load('features/bots/quant-roster.ts');
const now = Date.parse('2026-09-24T12:00:00Z');
const at = new Date(now - 1000).toISOString();

function summary(data = {}) {
  return {
    schema_version: 'rsibot.quant_ops.v1', execution_authorized: false, generated_at: at, source_times: { runtime_status: at },
    scope: { bot_key: 'rsi_modular_v2', execution_mode: 'live', ownership_basis: 'native_verified' },
    data: {
      bot_id: 'rsi_modular_v2', operational_label: 'HOLDING', heartbeat: at,
      pairs: [{ controller_id: 'bnb', pair: 'BNB-USDC', state: 'HOLDING', regime: 'NEUTRAL', units: '0.08', marked_value: '61', plan_mode: 'EXITS', plan_target: '4.00%', plan_anchor: 'min 797', plan_next: 'arm 813', gate: 'ready', score: '0/1', execs: 'A0', unrealized_pct: '-0.0170' }],
      owned_value: { value: '61', unit: 'USDC', availability: 'available', freshness: 'fresh', observed_at: at },
      net_lifecycle: { value: '-3.1', unit: 'USDC', availability: 'available', freshness: 'fresh', observed_at: at, fee_basis: 'net_incurred' },
      cycle_counts: { open: 3, closed_scored: 0, ownership_transfer: 3, unclassified: 0 },
      risk_rails: { availability: 'available', rails: [{ name: 'max_daily_loss_quote', scope: 'bot', limit: '50', used: '2.3', remaining: '47.7', utilization: '0.046', unit: 'USDC', state: 'ok', observed_at: at, source: 'runtime_status.daily_entry_risk' }, { name: 'max_global_drawdown_quote', scope: 'bot', limit: null, used: null, remaining: null, utilization: null, unit: 'USDC', state: 'absent' }], tightest: { name: 'max_daily_loss_quote', limit: '50', used: '2.3', utilization: '0.046', state: 'ok' } },
      wallet: { availability: 'available', reason_code: null, value: '20691.94', currency: 'USDT', scope: 'account_wallet', observed_at: at, balances: [{ asset: 'BNB', total: '8.49', available: '8.49', value: '6530.78' }] },
      ...data,
    },
  };
}

test('summary carries rails, wallet with declared currency, and plan fields', () => {
  const view = projectQuantBotSummary(summary(), 'rsi_modular_v2', now);
  assert.equal(view.riskRails.availability, 'available');
  assert.equal(view.riskRails.rails[0].utilization, 0.046);
  assert.equal(view.riskRails.rails[1].state, 'absent');
  assert.equal(view.riskRails.tightest.name, 'max_daily_loss_quote');
  assert.equal(view.wallet.currency, 'USDT');
  assert.equal(view.wallet.balances[0].value, '6530.78');
  assert.equal(view.pairs[0].planMode, 'EXITS');
  assert.equal(view.pairs[0].unrealizedPct, '-0.0170');
});

test('wallet without a declared currency is unavailable, and stale runtime withholds rails', () => {
  const undeclared = projectQuantBotSummary(summary({ wallet: { availability: 'unavailable', reason_code: 'VALUATION_CURRENCY_UNDECLARED', value: null, currency: null, balances: [] } }), 'rsi_modular_v2', now);
  assert.equal(undeclared.wallet.availability, 'unavailable');
  assert.equal(undeclared.wallet.reason, 'VALUATION_CURRENCY_UNDECLARED');
  const stale = projectQuantBotSummary(summary({ heartbeat: new Date(now - 31_000).toISOString() }), 'rsi_modular_v2', now);
  assert.equal(stale.riskRails.rails.length, 0);
  assert.equal(stale.wallet.availability, 'unavailable');
});

test('cycles projection keeps unscored cycles out of wins and losses', () => {
  const payload = {
    bot_id: 'rsi_modular_v2', execution_authorized: false, source: 'executor_lifecycle', quote_currency: 'USDC',
    cycle_counts: { open: 3, closed_scored: 1, ownership_transfer: 3, entry_pending: 0, entry_unfilled: 4, unclassified: 0 },
    cycles: [{ cycle_id: 'a', pair: 'BTC-USDC', outcome: 'closed_scored', result: 'win', opened_at: at, closed_at: at, holding_seconds: 3600, net_pnl_quote: '1.2', fees_quote: '0.01', gross_volume_quote: '40', fill_count: 1, close_type: 'TAKE_PROFIT' }, { outcome: 'open' }],
    statistics: { scored: 1, min_sample: 10, sufficient: false, wins: 1, losses: 0, breakeven: 0, win_rate: '1', profit_factor: null, profit_factor_reason: 'NO_LOSING_CYCLE', expectancy_quote: '1.2', fees_quote: '0.21', gross_volume_quote: '264.19', fill_count: 9 },
    inventory_age: { availability: 'available', reason_code: null, oldest_at: at, oldest_seconds: 78577.6, value_weighted_seconds: 59052.5, lots: [{ executor_id: 'x', pair: 'BTC-USDC', acquired_at: at, acquired_basis: 'first_fill', age_seconds: 3.6, value_quote: '39.88' }] },
  };
  const view = projectQuantCycles(payload, 'rsi_modular_v2');
  assert.equal(view.cycles.length, 1, 'rows without an id are dropped');
  assert.equal(view.stats.winRate, 1);
  assert.equal(view.stats.profitFactor, null);
  assert.equal(view.stats.profitFactorReason, 'NO_LOSING_CYCLE');
  assert.equal(view.stats.sufficient, false);
  assert.equal(view.inventoryAge.lots[0].basis, 'first_fill');
  assert.equal(view.counts.entry_unfilled, 4);
  assert.equal(projectQuantCycles({ ...payload, source: 'guess' }, 'rsi_modular_v2'), null);
  assert.equal(projectQuantCycles(payload, 'ok_rsi'), null);
});

test('execution stats are present without a slippage cohort and reject a foreign bot', () => {
  const payload = { bot_id: 'rsi_modular_v2', execution_authorized: false, histogram: { availability: 'unavailable', sample_count: 0, excluded_reasons: { NO_DECISION_MARK: 9 }, min_sample: 20 }, mean_bps: null, latency: { median_seconds: 17.97, sample_count: 9 }, fill_ratio: '0.538', cancel_rate: '0.46', reject_rate: '0', order_sample_sufficient: false, maker_count: 8, taker_count: 0, funnel: [{ stage: 'decisions', count: 10 }, { stage: 'orders_created', count: 13 }], benchmark_basis: 'decision marks' };
  const view = projectExecutionStats(payload, 'rsi_modular_v2');
  assert.equal(view.sampleCount, 0);
  assert.deepEqual(view.excludedReasons, { NO_DECISION_MARK: 9 });
  assert.equal(view.latencyMedianSeconds, 17.97);
  assert.equal(view.fillRatio, 0.538);
  assert.equal(view.funnel[1].count, 13);
  assert.equal(projectExecutionStats(payload, 'other'), null);
  assert.equal(projectExecutionStats({ ...payload, execution_authorized: true }, 'rsi_modular_v2'), null);
});

test('lifecycle decisions need executor identity, an owner source and a time no later than generation', () => {
  const payload = { schema_version: 'rsibot.quant_ops.v1', execution_authorized: false, generated_at: at, scope: { bot_key: 'rsi_modular_v2', execution_mode: 'live' }, data: { bot_id: 'rsi_modular_v2', lifecycle_decisions: [
    { decision_id: 'e1:entry', executor_id: 'e1', action: 'BUY', occurred_at: at, pair: 'BTC-USDC', order_ids: ['o1'], fill_ids: ['f1'], linkage: 'owner', source: 'executor_lifecycle', reason_codes: ['down_only_maker_v1'], outcome: 'filled', decision_price: '84115.5' },
    { decision_id: 'e1:entry', executor_id: 'e1', action: 'BUY', occurred_at: at, source: 'executor_lifecycle' },
    { decision_id: 'e2:entry', executor_id: 'e2', action: 'BUY', occurred_at: new Date(now + 60_000).toISOString(), source: 'executor_lifecycle' },
    { decision_id: 'e3:entry', executor_id: 'e3', action: 'BUY', occurred_at: at, source: 'nearest_time' },
  ] } };
  const rows = projectLifecycleDecisions(payload, 'rsi_modular_v2', now);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].linkage, 'owner');
  assert.equal(rows[0].decisionPrice, '84115.5');
  assert.equal(projectLifecycleDecisions(payload, 'ok_rsi', now), null);
});

test('fills keep exact receipt strings and ignore other bots', () => {
  const rows = projectFills({ rows: [
    { fill_id: '1', bot_name: 'rsi_modular_v2', pair: 'BTC-USDC', side: 'buy', exact_amount: '0.00011', exact_price: '84105.6', gross_volume_quote: 9.251616, exact_trade_fee_in_quote: '0.0074012928', order_type: 'LIMIT_MAKER', timestamp: at, order_id: 'o' },
    { fill_id: '2', bot_name: 'ok_rsi', pair: 'ETH-USDC' },
  ] }, 'rsi_modular_v2');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].price, '84105.6');
  assert.equal(rows[0].fee, '0.0074012928');
  assert.deepEqual(projectFills(null, 'rsi_modular_v2'), []);
});
