import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { projectFrame } from "../src/features/market-picture/contract.mjs";
import {
  projectHistory,
  projectCorrelations,
  projectEvents,
} from "../src/features/market-picture/stored.mjs";
const raw = JSON.parse(
  fs.readFileSync(
    new URL("../../tests/fixtures/market-picture.v1.json", import.meta.url),
    "utf8",
  ),
);
const frame = projectFrame(raw);
const envelope = (items) => ({
  schema_version: "market-picture.v1",
  snapshot_id: frame.snapshot_id,
  read_at_ms: frame.available_at_ms,
  items,
});
const point = (overrides) => ({
  snapshot_id: frame.snapshot_id,
  cutoff_ms: frame.cutoff_ms,
  available_at_ms: frame.available_at_ms,
  expires_at_ms: frame.expires_at_ms,
  source_kind: "observed",
  coverage: raw.coverage,
  membership_hash: frame.membershipHash,
  definition_registry_hash: raw.definition_registry_hash,
  breadth: Object.fromEntries(
    ["1", "5", "15", "60", "240", "1440"].map((h) => [
      h,
      { positive: "0.5", negative: "0.5", flat: "0", pressure: "0" },
    ]),
  ),
  summary: { trend_strength: "25" },
  ...overrides,
});

test("history resolves canonical coverage and ascends in source time", () => {
  const first = point({
    cutoff_ms: frame.cutoff_ms - 60000,
    available_at_ms: frame.available_at_ms - 60000,
    snapshot_id: "a".repeat(64),
  });
  const rows = projectHistory(envelope([point(), first]), frame);
  assert.equal(rows[0].snapshot_id, first.snapshot_id);
  assert.equal(rows[1].valid, raw.coverage.valid_instruments);
  assert.equal(rows[1].summary.trend_strength, 25);
  assert.equal(rows[1].flowHistory, null, "older history rows without the optional flow projection remain valid");
});

test("owner history keeps normalized counts separate from legacy shares and carries trajectory share change", () => {
  const ownerFrame = JSON.parse(fs.readFileSync(new URL("../../tests/fixtures/market-picture.m1-components.fixture.json", import.meta.url), "utf8"));
  const history = JSON.parse(fs.readFileSync(new URL("../../tests/fixtures/market-picture.m1-components.history.json", import.meta.url), "utf8"));
  const points = projectHistory(history, projectFrame(ownerFrame));
  assert.equal(points.length, 3);
  assert.deepEqual(points[0].normalizedBreadth["15"], { advances: 3, declines: 2, unchanged: 0, pressure: 0.2 });
  assert.deepEqual(points[0].breadth["15"], { positive: 0.6, negative: 0.4, flat: 0, pressure: 0.6 });
  assert.equal(points[0].breadthTrajectory["15/5"].shareChange, -20);
  assert.equal(points[0].flowHistory.cumulativeDeltaQuote, "10.811060122");
  assert.equal(points[2].flowHistory.cumulativeDeltaQuote, null);
  assert.ok(points[2].flowHistory.reasons.includes("UNKNOWN_AGGRESSOR"));
});

test("stored owner comparisons preserve benchmark timing, full-cohort median and divergence provenance", () => {
  const p = point({
    contribution_summaries: { '15': { equal_weight_return: '0', median_return: '-1', capped_liquidity_return: null,
      top5_abs_equal: '1', top5_abs_capped: null, expected_count: 5, valid_count: 5,
      start_cohort_available: true, prior_liquidity_weights_available: false } },
    benchmark_returns: { instrument_id: 'okx:spot:BTC-USDC', quote_asset: 'USDC', cutoff_ms: frame.cutoff_ms,
      definition_id: 'return_pct', definition_hash: 'e'.repeat(64),
      values: Object.fromEntries(['1','5','15','60','240','1440'].map(h => [h, '2'])),
      reason_codes: Object.fromEntries(['1','5','15','60','240','1440'].map(h => [h, []])) },
    breadth_divergence: { '15': { value: '1', matched_count: 5, expected_count: 5, matched_membership_hash: 'b'.repeat(64),
      benchmark_instrument_id: 'okx:spot:BTC-USDC', quote_asset: 'USDC', horizon_minutes: 15, interval_minutes: 15,
      cutoff_ms: frame.cutoff_ms, definition_id: 'breadth_price_divergence', definition_hash: 'f'.repeat(64),
      window_start_ms: frame.cutoff_ms - 86_400_000, window_end_ms: frame.cutoff_ms,
      reference_window_minutes: 1440, raw_inputs_available: false } },
  });
  const [shown] = projectHistory(envelope([p]), frame);
  assert.equal(shown.contributions['15'].medianReturn, -1);
  assert.equal(shown.contributions['15'].equalReturn, 0);
  assert.equal(shown.benchmarkReturns.values['15'], 2);
  assert.equal(shown.breadthDivergence['15'].provenance.interval, 15);
  const old = structuredClone(p);
  delete old.contribution_summaries['15'].median_return;
  delete old.benchmark_returns;
  old.breadth_divergence = { '15': { value: '1', matched_count: 5, expected_count: 5, matched_membership_hash: 'b'.repeat(64) } };
  const [legacy] = projectHistory(envelope([old]), frame);
  assert.equal(legacy.contributions['15'].medianReturn, null);
  assert.equal(legacy.benchmarkReturns, null);
  assert.equal(legacy.breadthDivergence['15'].provenance, null);
  for (const mutate of [
    item => { item.benchmark_returns.cutoff_ms++; },
    item => { item.benchmark_returns.values['15'] = null; },
    item => { item.contribution_summaries['15'].valid_count--; },
    item => { item.breadth_divergence['15'].window_start_ms++; },
    item => { delete item.breadth_divergence['15'].definition_hash; },
    item => { item.breadth_divergence['15'].matched_count = 0; },
    item => { item.breadth_divergence['15'].matched_membership_hash = null; },
  ]) {
    const invalid = structuredClone(p); mutate(invalid);
    assert.throws(() => projectHistory(envelope([invalid]), frame));
  }
});

test("stored flow history preserves owner scope, coverage, reset and nullable CVD", () => {
  const aggregate = {
    component_id: "a".repeat(64), quote_asset: "USDC", scope_hash: "b".repeat(64),
    expected_instruments: 2, observed_instruments: 2, complete_instruments: 2,
    buy_quote: "120.5", sell_quote: "100", unknown_quote: "0",
    cumulative_delta_quote: "20.5", reset_at_ms: frame.cutoff_ms - 300_000, reason_codes: [],
  };
  const projected = projectHistory(envelope([point({ flow_history: aggregate })]), frame)[0].flowHistory;
  assert.deepEqual(projected, {
    componentId: aggregate.component_id, quoteAsset: "USDC", scopeHash: aggregate.scope_hash,
    expectedInstruments: 2, observedInstruments: 2, completeInstruments: 2,
    buyQuote: "120.5", sellQuote: "100", unknownQuote: "0",
    cumulativeDeltaQuote: "20.5", resetAt: aggregate.reset_at_ms, reasons: [],
  });
  assert.throws(() => projectHistory(envelope([point({
    flow_history: { ...aggregate, observed_instruments: 1, complete_instruments: 1 },
  })]), frame), /Unqualified flow history/);
  assert.throws(() => projectHistory(envelope([point({
    flow_history: { ...aggregate, cumulative_delta_quote: null },
  })]), frame), /needs an owner reason/);
  assert.throws(() => projectHistory(envelope([point({
    flow_history: { ...aggregate, observed_instruments: 0, complete_instruments: 0 },
  })]), frame));
});
test("history rejects late revisions, mixed frames and nonnumeric shares", () => {
  assert.throws(
    () =>
      projectHistory(
        envelope([point({ available_at_ms: frame.available_at_ms + 1 })]),
        frame,
      ),
    /future/,
  );
  assert.throws(
    () =>
      projectHistory({ ...envelope([]), snapshot_id: "0".repeat(64) }, frame),
    /Mixed-snapshot/,
  );
  const p = point();
  p.breadth["1"].positive = "NaN";
  assert.throws(() => projectHistory(envelope([p]), frame));
  assert.throws(
    () => projectHistory(envelope([point(), point()]), frame),
    /Ambiguous/,
  );
});
test("correlations require admitted identities, exact sample coverage and bounded coefficients", () => {
  const row = {
    instrument_a_id: frame.assets[0].instrument_id,
    instrument_b_id: frame.assets[1].instrument_id,
    correlation: "0.75",
    paired_sample_count: 2160,
    expected_sample_count: 2160,
    reason_codes: [],
    window_end_ms: frame.cutoff_ms,
    trend: [],
  };
  assert.equal(projectCorrelations(envelope([row]), frame)[0].value, 0.75);
  for (const changes of [
    { expected_sample_count: undefined },
    { paired_sample_count: 100 },
    { correlation: "1.1" },
    { instrument_a_id: "okx:spot:UNKNOWN-USDC" },
  ])
    assert.throws(() =>
      projectCorrelations(envelope([{ ...row, ...changes }]), frame),
    );
});
test("correlations accept each owner window with its definition id and reject unlisted or mixed windows", () => {
  const row = {
    instrument_a_id: frame.assets[0].instrument_id,
    instrument_b_id: frame.assets[1].instrument_id,
    correlation: "0.5",
    paired_sample_count: 0,
    expected_sample_count: 0,
    reason_codes: [],
    window_end_ms: frame.cutoff_ms,
    trend: [],
  };
  const ids = {
    24: "pearson_log_1h_24h", 72: "pearson_log_1h_72h", 168: "pearson_log_1h_168h",
    336: "pearson_log_1h_336h", 720: "pearson_log_1h_720h", 2160: "pearson_log_1h_90d",
  };
  for (const [hours, definition] of Object.entries(ids)) {
    const window = Number(hours);
    const [shown] = projectCorrelations(envelope([{ ...row, expected_sample_count: window, paired_sample_count: window }]), frame);
    assert.equal(shown.expected, window);
    assert.equal(shown.definition, definition);
    const gate = Math.ceil(window * 0.95);
    assert.equal(projectCorrelations(envelope([{ ...row, expected_sample_count: window, paired_sample_count: gate }]), frame)[0].value, 0.5);
    assert.throws(() => projectCorrelations(envelope([{ ...row, expected_sample_count: window, paired_sample_count: gate - 1 }]), frame), undefined, `${window} below the gate`);
    // A pair below the gate is null with its reason and keeps its real sample size.
    const [withheld] = projectCorrelations(envelope([{ ...row, expected_sample_count: window, paired_sample_count: gate - 1, correlation: null, reason_codes: ["INSUFFICIENT_HISTORY"] }]), frame);
    assert.equal(withheld.value, null);
    assert.equal(withheld.samples, gate - 1);
  }
  for (const expected of [100, 1000, 2161])
    assert.throws(() => projectCorrelations(envelope([{ ...row, expected_sample_count: expected, paired_sample_count: expected }]), frame), undefined, String(expected));
  assert.throws(() => projectCorrelations(envelope([
    { ...row, expected_sample_count: 168, paired_sample_count: 168 },
    { ...row, expected_sample_count: 2160, paired_sample_count: 2160 },
  ]), frame), /mixes/);
});
test("history points keep either relative-volume key and never invent the other", () => {
  const retired = projectHistory(envelope([point({ summary: { relative_volume_24h: "0.004", trend_strength: "25" } })]), frame)[0];
  assert.equal(retired.summary.relative_volume_24h, 0.004);
  assert.ok(!("relative_volume_1h" in retired.summary));
  const hourly = projectHistory(envelope([point({ summary: { relative_volume_1h: "1.25", trend_strength: null } })]), frame)[0];
  assert.equal(hourly.summary.relative_volume_1h, 1.25);
  assert.ok(!("relative_volume_24h" in hourly.summary));
  assert.equal(hourly.summary.trend_strength, null);
  assert.throws(
    () => projectHistory(envelope([point({ summary: { relative_volume_24h: "1", relative_volume_1h: "1" } })]), frame),
    /mixes/,
  );
});
test("events cannot appear in decision replay before their availability", () => {
  const event = {
    event_id: "event-a",
    instrument_id: null,
    event_type: "breadth_crossing",
    severity: "info",
    observed_at_ms: frame.cutoff_ms,
    available_at_ms: frame.available_at_ms,
    status: "original",
    is_historical_reconstruction: false,
    snapshot_id: frame.snapshot_id,
    value: { share: "0.6" },
  };
  assert.equal(projectEvents(envelope([event]), frame)[0].value, "share: 0.6");
  assert.equal(projectEvents(envelope([event]), frame)[0].horizon_minutes, null);
  const crossing = { ...event, value: { share: "0.6", horizon_minutes: "5" } };
  assert.equal(projectEvents(envelope([crossing]), frame)[0].horizon_minutes, 5);
  assert.throws(
    () =>
      projectEvents(
        envelope([{ ...event, available_at_ms: frame.available_at_ms + 1 }]),
        frame,
      ),
    /arrived after/,
  );
});
