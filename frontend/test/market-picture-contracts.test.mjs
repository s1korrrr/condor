import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  validateFrame,
  projectFrame,
  digest,
  canonical,
  resolveSeries,
  seriesDigest,
  validateMetric,
} from "../src/features/market-picture/contract.mjs";

const read = (file) =>
  JSON.parse(
    fs.readFileSync(
      new URL(`../../tests/fixtures/${file}`, import.meta.url),
      "utf8",
    ),
  );
const fixture = () => read("market-picture.v1.json");
const legacyFixture = () => read("market-picture.legacy-rvol24h.v1.json");
test("compact valid cell quality defaults preserve series hash and resolved meaning", async () => {
  const series = read("market-picture-series.v1.json");
  const compact = structuredClone(series);
  const valid = compact.cells.find((cell) => cell.computation_status === "VALID");
  assert.equal(valid.coverage_status, "COMPLETE");
  assert.deepEqual(valid.reason_codes, []);
  delete valid.computation_status;
  delete valid.coverage_status;
  delete valid.reason_codes;
  assert.equal(await seriesDigest(series), await seriesDigest(compact));
  assert.deepEqual(resolveSeries(series), resolveSeries(compact));
  const unavailable = structuredClone(compact);
  const missing = unavailable.cells.find((cell) => cell.value === null);
  delete missing.computation_status;
  assert.throws(() => resolveSeries(unavailable));
  const noReason = structuredClone(compact);
  delete noReason.cells.find((cell) => cell.value === null).reason_codes;
  assert.throws(() => resolveSeries(noReason));
  const aggregate = structuredClone(resolveSeries(series)[series.cells[0].instrument_id]);
  delete aggregate.computation_status;
  delete aggregate.coverage_status;
  delete aggregate.reason_codes;
  assert.throws(() => validateMetric(aggregate));
});
test("compact quality defaults remain valid inside a resealed frame", async () => {
  const frame = fixture();
  const series = frame.metric_series.find((row) => row.metric_id === "asset_price");
  const cell = series.cells[0];
  delete cell.computation_status;
  delete cell.coverage_status;
  delete cell.reason_codes;
  series.payload_digest = await seriesDigest(series);
  const parsed = await validateFrame(await seal(frame), { allowFixture: true });
  assert.equal(resolveSeries(parsed.metric_series.find((row) => row.metric_id === "asset_price"))
    [frame.assets[0].instrument_id].value, "100");
});
test("optional flow reference is validated and projected", async () => {
  const oldFrame = fixture();
  delete oldFrame.flow_ref;
  assert.deepEqual(projectFrame(oldFrame).flow,
    { status: "unavailable", reasons: ["SOURCE_UNAVAILABLE"] });
  const frame = fixture();
  frame.flow_ref = { status: "unavailable", reason_codes: ["SOURCE_DISABLED"] };
  assert.equal((await validateFrame(await seal(frame), { allowFixture: true })).flow_ref.status,
    "unavailable");
  assert.deepEqual(projectFrame(frame).flow,
    { status: "unavailable", reasons: ["SOURCE_DISABLED"] });
  frame.flow_ref = {
    status: "available", snapshot_id: "a".repeat(64),
    cutoff_ms: frame.cutoff_ms, expires_at_ms: frame.expires_at_ms,
    reason_codes: [],
  };
  await validateFrame(await seal(frame), { allowFixture: true });
  assert.deepEqual(projectFrame(frame).flow, { status: "available", reasons: [] });
  for (const ref of [
    { status: "available", reason_codes: [] },
    { status: "unavailable", reason_codes: [] },
    { status: "unavailable", snapshot_id: 7, reason_codes: ["SOURCE_DISABLED"] },
  ]) {
    frame.flow_ref = ref;
    await assert.rejects(validateFrame(await seal(frame), { allowFixture: true }), /flow/i);
  }
});
function withRegime(frame) {
  const provider = frame.providers.observation;
  const regime = {
    regime_id: "regime-btc-1", instrument_id: frame.assets[0].instrument_id,
    source_bar_close_ms: frame.cutoff_ms, origin: "market_observation",
    producer_id: "market-picture", controller_id: null,
    regime_label: "up", regime_definition_id: "observed-trend-v1",
    calibration_status: "unknown", provider_ref: provider,
    available_at_ms: frame.available_at_ms, expires_at_ms: frame.expires_at_ms,
    source_epoch: provider.epoch, source_sequence: provider.sequence,
  };
  frame.regime_observations = [regime];
  frame.assets[0].regime_refs = [regime.regime_id];
  return frame;
}
test("resealed regimes bind their asset, provider and decision time", async () => {
  for (const mutation of ["cross_asset", "provider", "bar", "availability", "expiry"]) {
    const frame = withRegime(fixture());
    await validateFrame(await seal(frame), { allowFixture: true });
    const regime = frame.regime_observations[0];
    if (mutation === "cross_asset") {
      frame.assets[0].regime_refs = [];
      frame.assets[1].regime_refs = [regime.regime_id];
    } else if (mutation === "provider") {
      regime.provider_ref = { ...frame.providers.observation, source_digest: "a".repeat(64) };
    } else if (mutation === "bar") regime.source_bar_close_ms -= 60_000;
    else if (mutation === "availability") regime.available_at_ms += 1;
    else regime.expires_at_ms = frame.published_at_ms;
    await assert.rejects(validateFrame(await seal(frame), { allowFixture: true }), /Regime/, mutation);
  }
});
test("binary-float rounding cannot admit fractional instrument counts", async () => {
  const frame = fixture();
  const metric = frame.market_metrics[frame.breadth[0].metric_refs.unchanged.metric_id];
  metric.value += '.0000000000000000001';
  await assert.rejects(validateFrame(await seal(frame), {allowFixture:true}), /Fractional/);
});

test("resealed references cannot relabel summary, horizon, distribution or comparison values", async () => {
  const mutations = {
    summary: f => { f.summary.metric_refs.relative_volume_1h = f.breadth[0].metric_refs.advances; },
    breadthHorizon: f => { f.breadth[0].metric_refs.advance_share = f.breadth[1].metric_refs.advance_share; },
    pressureHorizon: f => { f.pressure[0].metric_id = f.pressure[1].metric_id; },
    distribution: f => { f.distribution[0].definition_ref.definition_id = "breadth_share"; },
    comparison: f => { f.comparisons.metric_refs["summary/relative_volume_1h"] = f.comparisons.metric_refs["summary/trend_strength"]; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const frame = fixture();
    mutate(frame);
    await assert.rejects(validateFrame(await seal(frame), { allowFixture: true }), undefined, name);
  }
});
async function seal(frame) {
  delete frame.payload_digest;
  delete frame.snapshot_id;
  frame.snapshot_id = await digest(frame);
  frame.payload_digest = await digest(frame);
  return frame;
}

test("resealed payloads cannot change semantic units, availability, expiry, predicates or histogram shape", async () => {
  for (const mutation of ["unit_ref", "early_cell", "late_expiry", "binary_predicate", "histogram_shape"]) {
    const frame = fixture();
    let series = frame.metric_series[0];
    if (mutation === "unit_ref") frame.asset_metric_refs.price = frame.asset_metric_refs.rsi14;
    else if (mutation === "early_cell") series.cells[0].available_at_ms = series.provider_ref.available_at_ms - 1;
    else if (mutation === "late_expiry") series.cells[0].expires_at_ms = series.expires_at_ms + 1;
    else if (mutation === "binary_predicate") {
      series = frame.metric_series.find(s => s.metric_id === frame.asset_predicate_refs.above_ema21.metric_id);
      Object.assign(series.cells[0], {value: "2", computation_status: "VALID"});
    } else frame.distribution[0].counts = Array(39).fill(0);
    series.payload_digest = await seriesDigest(series);
    await assert.rejects(validateFrame(await seal(frame), {allowFixture:true}), undefined, mutation);
  }
});

test("full API fixture validates with explicit fixture authority and resolves all panels", async () => {
  const frame = await validateFrame(fixture(), { allowFixture: true });
  const view = projectFrame(frame);
  assert.equal(view.assets.length, 2);
  assert.equal(view.valid, 2);
  assert.equal(Object.keys(view.breadth).length, 6);
  assert.equal(Object.keys(view.participation).length, 8);
  assert.equal(view.assets[0].symbol, "BTC");
  assert.equal(view.assets[0].quote, "USDC");
  assert.equal(view.candleAnomalies, null, "older frames without candle anomalies remain supported");
  assert.equal(view.raw.snapshot_id, frame.snapshot_id);
});

test("owner-produced candle-context fixture projects trajectories, cohorts, and source states", async () => {
  const frame = await validateFrame(read("market-picture.m1.fixture.json"), { allowFixture: true });
  const display = projectFrame(frame);
  assert.equal(display.normalizedBreadth["15"].pressure.unit, "index_minus1_to1");
  assert.equal(display.breadthTrajectory.length, 9);
  assert.equal(display.breadthTrajectory[0].acceleration.unit, "index_points_per_minute_squared");
  assert.equal(display.breadthDivergence.length, 3);
  assert.equal(display.contributions["5"].startCohortAvailable, true);
  assert.deepEqual(display.sourceCapabilities, []);
});

test("owner-produced combined fixture projects daily and microstructure components", async () => {
  const frame = await validateFrame(read("market-picture.m1-components.fixture.json"), { allowFixture: true });
  const display = projectFrame(frame);
  assert.equal(display.assets.length, 5);
  assert.equal(display.dailyInternals.length, 5);
  assert.equal(display.dailyInternals[0].contiguousBars, 201);
  assert.equal(display.dailyInternals[0].averages["200"].sma.required, 200);
  assert.equal(display.dailyInternals[0].averages["200"].sma.samples, 200);
  assert.ok(display.dailyInternals.every(row => row.source !== null), "daily rows retain owner source provenance");
  assert.equal(display.microstructure?.replayClass, "snapshot_only");
  assert.equal(display.microstructure?.rawInputsRetained, false);
  assert.ok(display.microstructure?.flows.length);
  assert.ok(display.microstructure?.liquidity.length);
});

test("future daily source receipt stays unavailable across the gateway boundary", async () => {
  const frame = await validateFrame(read("market-picture.delayed-daily.fixture.json"), { allowFixture: true });
  const daily = projectFrame(frame).dailyInternals;
  assert.equal(daily.length, frame.assets.length);
  assert.ok(daily.every(row => row.source === null));
  assert.ok(daily.every(row => row.sourceCoverageStatus === "UNAVAILABLE"));
  assert.ok(daily.find(row => row.instrumentId === "okx:spot:BTC-USDC").sourceReasons.includes("BAR_UNCONFIRMED"));
  assert.ok(daily.find(row => row.instrumentId === "okx:spot:ETH-USDC").sourceReasons.includes("SOURCE_UNAVAILABLE"));
  assert.equal(daily.find(row => row.instrumentId === "okx:spot:BTC-USDC").averages["200"].sma.metric.value, null);
});

test("owner-produced hourly internals preserve aggregate timing, definitions, and coverage", async () => {
  const frame = await validateFrame(read("market-picture.m1-components.fixture.json"), { allowFixture: true });
  const display = projectFrame(frame);
  assert.equal(display.hourlyInternals.interval, 60);
  assert.equal(display.hourlyInternals.decisionAvailable, frame.available_at_ms);
  assert.equal(display.hourlyInternals.sourceCount, 5);
  assert.equal(display.hourlyInternals.metrics.above_sma20_share.value, 0.6);
  assert.equal(display.hourlyInternals.metrics.above_sma20_share.definition, "above_sma20_share");
  const invalid = structuredClone(frame);
  invalid.hourly_internals.metrics.above_sma20_share.definition_id = "share_delta";
  await assert.rejects(validateFrame(await seal(invalid), { allowFixture: true }), /Hourly internals metric definition mismatch/);
});

test("owner-produced hourly candle anomalies keep frozen binary vectors, counts and definitions coherent", async () => {
  const raw = read("market-picture.m1-components.fixture.json");
  assert.ok(raw.candle_anomalies, "owner fixture includes the optional hourly anomaly projection");
  const frame = await validateFrame(raw, { allowFixture: true });
  const projected = projectFrame(frame).candleAnomalies;
  assert.equal(projected.interval, 3_600_000);
  assert.equal(projected.cutoff, Math.floor(frame.cutoff_ms / 3_600_000) * 3_600_000);
  assert.equal(projected.decisionAvailable, frame.available_at_ms);
  assert.equal(projected.expected, frame.assets.length);
  assert.deepEqual(Object.keys(projected.metrics).sort(), [
    "bollinger_inside_ema_atr_compression_1h",
    "dictionary_rvol_1h_high",
    "extreme_realized_volatility_1h_95p",
  ].sort());
  for (const mutate of [
    anomaly => { anomaly.cutoff_ms += 3_600_000; },
    anomaly => { anomaly.source_count -= 1; },
    anomaly => { anomaly.metrics.dictionary_rvol_1h_high.values.pop(); },
    anomaly => { anomaly.metrics.dictionary_rvol_1h_high.values[0] = 2; },
    anomaly => { anomaly.metrics.dictionary_rvol_1h_high.high_count += 1; },
    anomaly => { anomaly.metrics.bollinger_inside_ema_atr_compression_1h.definition_hash = "f".repeat(64); },
    anomaly => { anomaly.metrics.extreme_realized_volatility_1h_95p.share_fraction = "1.1"; },
    anomaly => { anomaly.metrics.dictionary_rvol_1h_high.unreviewed = true; },
  ]) {
    const invalid = structuredClone(raw);
    mutate(invalid.candle_anomalies);
    await assert.rejects(validateFrame(await seal(invalid), { allowFixture: true }));
  }
});

test("matched trajectory share change keeps its metric-specific definition", async () => {
  const frame = await validateFrame(read("market-picture.m1-components.fixture.json"), { allowFixture: true });
  const trajectory = projectFrame(frame).breadthTrajectory.find(row => row.horizon === 15 && row.interval === 5);
  assert.equal(trajectory.shareChange.definition, "breadth_advancing_share_change v1.0.0");
  assert.equal(trajectory.shareChange.unit, "percentage_points");
  assert.equal(trajectory.shareChange.value, 0);
});

test("owner-produced exact one-hour rank changes preserve aligned improving and weakening movements", async () => {
  const frame = await validateFrame(read("market-picture.relative-ranks.1h.fixture.json"), { allowFixture: true });
  const display = projectFrame(frame);
  const changes = display.relativeStrengthChanges;
  assert.equal(changes.interval, 3_600_000);
  assert.equal(changes.currentCutoff - changes.baselineCutoff, 3_600_000);
  assert.equal(changes.expected, frame.assets.length);
  assert.equal(changes.valid, frame.assets.length);
  assert.deepEqual(frame.assets.map(asset => changes.rankDeltas[asset.instrument_id]), [-1, 1]);
  assert.equal(changes.definitionId, "relative_return");
  assert.equal(changes.definitionHash, "54936e39a1c8ba50b1226d16efd45aa683165fe82a958e9b577f2856849f3259");

  for (const mutate of [
    value => { value.rank_deltas = [0, 1]; },
    value => { value.baseline_cutoff_ms += 60_000; },
    value => { value.definition_hash = "f".repeat(64); },
    value => { value.rank_deltas = [1]; },
    value => {
      value.valid_count = 0;
      value.rank_deltas = [null, null];
      value.reason_codes = ["INSUFFICIENT_COVERAGE"];
      value.cohort_hash = "a".repeat(64);
    },
  ]) {
    const invalid = structuredClone(frame);
    mutate(invalid.relative_strength_changes);
    await assert.rejects(validateFrame(await seal(invalid), { allowFixture: true }));
  }
});

test("book-cost percentile is independent of fee provenance and requires matched historical coverage", async () => {
  const frame = read("market-picture.m1-components.fixture.json");
  const book = frame.microstructure.liquidity.find(row => row.fee_bps == null && row.cost_bps != null);
  assert.ok(book, "fixture includes a full-size book walk without fee provenance");
  Object.assign(book, {
    cost_percentile_7d: "0.75", cost_percentile_sample_count: 9500,
    cost_percentile_expected_samples: 10080, cost_percentile_reason_codes: [],
    cost_percentile_reference_digest: "c".repeat(64),
  });
  const component = { ...frame.microstructure };
  delete component.component_id;
  frame.microstructure.component_id = await digest(component);
  if (frame.flow_ref?.status === "available") frame.flow_ref.snapshot_id = frame.microstructure.component_id;
  const parsed = await validateFrame(await seal(frame), { allowFixture: true });
  const display = projectFrame(parsed).microstructure.liquidity.find(row => row.sourceId === book.source_id && row.requestedSize === book.requested_size);
  assert.equal(display.costPercentile7d, 0.75);
  assert.equal(display.costPercentileSampleCount, 9500);
  assert.equal(display.feeBps, null, "book-only percentile does not require fee provenance");

  const insufficient = read("market-picture.m1-components.fixture.json");
  const invalid = insufficient.microstructure.liquidity.find(row => row.fee_bps == null && row.cost_bps != null);
  Object.assign(invalid, {
    cost_percentile_7d: "0.75", cost_percentile_sample_count: 9000,
    cost_percentile_expected_samples: 10080, cost_percentile_reason_codes: [],
    cost_percentile_reference_digest: "c".repeat(64),
  });
  const invalidComponent = { ...insufficient.microstructure };
  delete invalidComponent.component_id;
  insufficient.microstructure.component_id = await digest(invalidComponent);
  if (insufficient.flow_ref?.status === "available") insufficient.flow_ref.snapshot_id = insufficient.microstructure.component_id;
  await assert.rejects(validateFrame(await seal(insufficient), { allowFixture: true }), /comparable full-size history/);
});

test("public Market Picture rejects separately authorized private source metadata", async () => {
  const frame = read("market-picture.m1-components.fixture.json");
  frame.source_capabilities[0].family = "private_exposure";
  frame.source_capabilities[0].access = "separately_authorized_private";
  await assert.rejects(validateFrame(await seal(frame), { allowFixture: true }), /Private source metadata/);
});

test("source capability probe receipt cannot occur after the frame decision", async () => {
  const frame = read("market-picture.m1-components.fixture.json");
  delete frame.microstructure;
  const capability = frame.source_capabilities[0];
  capability.qualification = "probed";
  capability.operational = "unavailable";
  delete capability.collection_receipt_hash;
  delete capability.collected_at_ms;
  delete capability.qualification_receipt_hash;
  delete capability.qualification_contract_hash;
  delete capability.qualified_at_ms;
  capability.probed_at_ms = frame.available_at_ms + 1;
  await assert.rejects(validateFrame(await seal(frame), { allowFixture: true }), /Capability receipt occurs after bundle decision/);
});

test("microstructure observations cannot become available after their component or frame decision", async () => {
  for (const mutation of ["flow_after_component", "book_after_frame", "book_observed_after_cutoff"]) {
    const frame = read("market-picture.m1-components.fixture.json");
    const component = frame.microstructure;
    if (mutation === "flow_after_component") {
      component.available_at_ms -= 1;
      component.flows[0].available_at_ms = frame.available_at_ms;
    } else if (mutation === "book_after_frame") {
      component.liquidity[0].available_at_ms = frame.available_at_ms + 1;
      component.liquidity[0].expires_at_ms += 1;
    } else {
      component.liquidity[0].observed_at_ms = frame.cutoff_ms + 1;
    }
    const componentBody = { ...component };
    delete componentBody.component_id;
    component.component_id = await digest(componentBody);
    await assert.rejects(validateFrame(await seal(frame), { allowFixture: true }), /decision-time bounds/, mutation);
  }
});

test("microstructure flow windows cannot overlap and quote units stay tied to the selected numeraire", async () => {
  const rehashComponent = async frame => {
    const body = { ...frame.microstructure };
    delete body.component_id;
    frame.microstructure.component_id = await digest(body);
    if (frame.flow_ref?.status === "available") frame.flow_ref.snapshot_id = frame.microstructure.component_id;
    return frame;
  };
  const quoteMismatch = read("market-picture.m1-components.fixture.json");
  quoteMismatch.microstructure.flows[0].quote_asset = "USDT";
  await assert.rejects(validateFrame(await seal(await rehashComponent(quoteMismatch)), { allowFixture: true }), /executed-flow identity/);

  const overlap = read("market-picture.m1-components.fixture.json");
  const original = overlap.microstructure.flows.find(row => row.instrument_id === "okx:spot:BTC-USDC");
  const capability = structuredClone(overlap.source_capabilities.find(row => row.source_id === original.source_id));
  capability.source_id = "synthetic-spot_flow-alt";
  overlap.source_capabilities.push(capability);
  overlap.source_capabilities.sort((a, b) => a.source_id.localeCompare(b.source_id));
  const duplicate = { ...original, source_id: capability.source_id };
  overlap.microstructure.flows.push(duplicate);
  overlap.microstructure.flows.sort((a, b) => `${a.instrument_id}|${a.source_id}`.localeCompare(`${b.instrument_id}|${b.source_id}`));
  await assert.rejects(validateFrame(await seal(await rehashComponent(overlap)), { allowFixture: true }), /Flow source windows overlap/);
});

test("displayed-liquidity size, VWAP, cost, fee, and band values must reconcile", async () => {
  const mutations = {
    quantity: row => { row.uncovered_size = "0.1"; },
    coveredVwap: row => { row.covered_vwap = "22"; },
    fullVwap: row => { row.vwap = "22"; },
    missingCost: row => { row.cost_bps = null; },
    negativeCost: row => { row.cost_bps = "-1"; },
    sellCostBound: row => { row.cost_bps = "10000"; },
    zeroSpread: row => { row.spread_bps = "0"; },
    feeBound: row => { row.fee_bps = "10001"; },
    totalCost: row => { row.total_cost_bps = "30"; },
    bandImbalance: row => { row.band_imbalance = "0.5"; },
    unknownAccess: row => { row.access_basis = "unknown"; },
    unknownSpread: row => {
      makeUnknownBook(row);
      row.spread_bps = "1";
    },
    unknownBand: row => {
      makeUnknownBook(row);
      row.band_bid_covered_quote = "1";
    },
    unknownPercentile: row => {
      makeUnknownBook(row);
      Object.assign(row, {
        cost_percentile_7d: "0.5", cost_percentile_sample_count: 9500,
        cost_percentile_expected_samples: 10080, cost_percentile_reason_codes: [], cost_percentile_reference_digest: "c".repeat(64),
      });
    },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const frame = read("market-picture.m1-components.fixture.json");
    const row = frame.microstructure.liquidity.find(item => item.uncovered_size === "0");
    assert.ok(row, "fixture contains complete displayed depth");
    mutate(row);
    const component = { ...frame.microstructure };
    delete component.component_id;
    frame.microstructure.component_id = await digest(component);
    if (frame.flow_ref?.status === "available") frame.flow_ref.snapshot_id = frame.microstructure.component_id;
    await assert.rejects(validateFrame(await seal(frame), { allowFixture: true }), undefined, name);
  }
});

function makeUnknownBook(row) {
  Object.assign(row, {
    access_basis: "unknown", covered_base: "0", covered_quote: "0", uncovered_size: row.requested_size,
    covered_vwap: null, vwap: null, cost_bps: null, fee_bps: null, fee_source: null, total_cost_bps: null,
    spread_bps: null, band_bid_covered_quote: "0", band_ask_covered_quote: "0", band_complete: false,
    band_imbalance: null, cost_percentile_7d: null, cost_percentile_sample_count: 0,
    cost_percentile_expected_samples: 10080, cost_percentile_reason_codes: ["INSUFFICIENT_HISTORY"],
    cost_percentile_reference_digest: null,
  });
}

test("both relative-volume generations validate and project under their own keys", async () => {
  const current = projectFrame(await validateFrame(fixture(), { allowFixture: true }));
  const legacy = projectFrame(await validateFrame(legacyFixture(), { allowFixture: true }));
  assert.ok("rvol_1h" in current.assets[0].indicators && !("rvol_24h" in current.assets[0].indicators));
  assert.ok("relative_volume_1h" in current.summary && !("relative_volume_24h" in current.summary));
  assert.ok("summary/relative_volume_1h" in current.comparisons);
  assert.equal(current.assets[0].indicators.rvol_1h.definition, "rvol1h v1.0.0");
  assert.ok("rvol_24h" in legacy.assets[0].indicators && !("rvol_1h" in legacy.assets[0].indicators));
  assert.ok("relative_volume_24h" in legacy.summary && !("relative_volume_1h" in legacy.summary));
  assert.ok("summary/relative_volume_24h" in legacy.comparisons);
  assert.equal(legacy.assets[0].indicators.rvol_24h.definition, "rvol24h v1.0.0");
  assert.notEqual(current.raw.definition_registry_hash, legacy.raw.definition_registry_hash);
});

test("a frame cannot mix or misbind the two relative-volume generations", async () => {
  const mutations = {
    bothAssetKeys: f => { f.asset_metric_refs.rvol_24h = f.asset_metric_refs.rvol_1h; },
    neitherAssetKey: f => { delete f.asset_metric_refs.rvol_1h; },
    legacySummaryKey: f => { f.summary.metric_refs.relative_volume_24h = f.summary.metric_refs.relative_volume_1h; delete f.summary.metric_refs.relative_volume_1h; },
    droppedSummaryKey: f => { delete f.summary.metric_refs.relative_volume_1h; },
    legacyComparisonKey: f => { f.comparisons.metric_refs["summary/relative_volume_24h"] = f.comparisons.metric_refs["summary/relative_volume_1h"]; delete f.comparisons.metric_refs["summary/relative_volume_1h"]; },
    summaryDefinition: f => { f.market_metrics.relative_volume_1h.definition.definition_id = "median_relative_volume_24h"; },
    seriesBinding: f => { f.asset_metric_refs.rvol_1h = f.asset_metric_refs.rvol20; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const frame = fixture();
    mutate(frame);
    await assert.rejects(validateFrame(await seal(frame), { allowFixture: true }), undefined, name);
  }
  const legacy = legacyFixture();
  legacy.summary.metric_refs.relative_volume_1h = legacy.summary.metric_refs.relative_volume_24h;
  delete legacy.summary.metric_refs.relative_volume_24h;
  await assert.rejects(validateFrame(await seal(legacy), { allowFixture: true }), undefined, "legacy frame with current key");
  const wrongSeries = fixture();
  const series = wrongSeries.metric_series.find(s => s.metric_id === "asset_rvol_1h");
  series.definition_ref.definition_id = "rvol24h";
  series.payload_digest = await seriesDigest(series);
  await assert.rejects(validateFrame(await seal(wrongSeries), { allowFixture: true }), /binding/);
});

test("a zero-baseline relative volume is a null with its reason, and a null without one is rejected", async () => {
  const frame = fixture();
  const series = frame.metric_series.find(s => s.metric_id === "asset_rvol_1h");
  series.cells[0] = {
    instrument_id: series.cells[0].instrument_id, computation_status: "UNAVAILABLE",
    coverage_status: "PARTIAL", reason_codes: ["ZERO_BASELINE"], sample_count: 1500,
  };
  series.payload_digest = await seriesDigest(series);
  const view = projectFrame(await validateFrame(await seal(structuredClone(frame)), { allowFixture: true }));
  const cell = view.assets[0].indicators.rvol_1h;
  assert.equal(cell.value, null);
  assert.deepEqual(cell.reasons, ["ZERO_BASELINE"]);
  delete series.cells[0].reason_codes;
  series.payload_digest = await seriesDigest(series);
  await assert.rejects(validateFrame(await seal(frame), { allowFixture: true }));
});

test("production parser rejects synthetic fixtures even with valid digests", async () => {
  await assert.rejects(validateFrame(fixture()), /Fixture/);
});

test("content mutation is rejected before display", async () => {
  const f = fixture();
  f.sequence += 1;
  await assert.rejects(validateFrame(f, { allowFixture: true }), /hash/);
});

test("resealing a frame cannot hide mutation of a source metric series", async () => {
  const f = fixture();
  f.metric_series[0].cells[0].value = "12";
  await assert.rejects(
    validateFrame(await seal(f), { allowFixture: true }),
    /series hash/,
  );
});

test("canonical bytes use the same sorted ASCII serialization as the owner", () => {
  assert.equal(
    canonical({ z: "Ł🚀", a: [1, null] }),
    '{"a":[1,null],"z":"\\u0141\\ud83d\\ude80"}',
  );
});

test("invalid numeric and status combinations do not survive a valid frame checksum", async () => {
  for (const value of [true, "", "NaN", "Infinity", 0]) {
    const f = fixture();
    f.metric_series[0].cells[0].value = value;
    await assert.rejects(validateFrame(await seal(f), { allowFixture: true }));
  }
  const f = fixture();
  f.metric_series[0].cells[0].computation_status = "MISSING";
  await assert.rejects(validateFrame(await seal(f), { allowFixture: true }));
});

test("duplicate identities, unknown extensions and mixed quote universes are rejected", async () => {
  const change = [
    (f) => {
      f.assets[1].asset_id = f.assets[0].asset_id;
    },
    (f) => {
      f.unsupported = true;
    },
    (f) => {
      f.assets[0].quote_asset_id = "asset:usdt";
    },
  ];
  for (const mutate of change) {
    const f = fixture();
    mutate(f);
    await assert.rejects(validateFrame(await seal(f), { allowFixture: true }));
  }
});

test("breadth partition and histogram population are verified independently of their digest", async () => {
  const f = fixture();
  f.breadth[0].valid_count = 1;
  await assert.rejects(validateFrame(await seal(f), { allowFixture: true }));
  const h = fixture();
  h.distribution[0].counts[0] += 1;
  await assert.rejects(validateFrame(await seal(h), { allowFixture: true }));
});

test("lossless JS metric resolver matches the engine golden output", () => {
  assert.deepEqual(
    resolveSeries(read("market-picture-series.v1.json")),
    read("market-picture-series-resolved.v1.json"),
  );
});

test("an unavailable candle anomaly may omit its null-default counts, as the owner schema allows", async () => {
  for (const omit of [false, true]) {
    const raw = read("market-picture.m1-components.fixture.json");
    const metric = raw.candle_anomalies.metrics.extreme_realized_volatility_1h_95p;
    metric.values = metric.values.map(() => null);
    metric.valid_count = 0;
    metric.reason_codes = ["BAR_GAP", "INSUFFICIENT_HISTORY"];
    if (omit) { delete metric.high_count; delete metric.share_fraction; } else { metric.high_count = null; metric.share_fraction = null; }
    const frame = await validateFrame(await seal(raw), { allowFixture: true });
    const projected = projectFrame(frame).candleAnomalies.metrics.extreme_realized_volatility_1h_95p;
    assert.equal(projected.high, null, `omitted=${omit}: unavailable high count projects as null`);
    assert.equal(projected.share, null);
    assert.equal(projected.valid, 0);
  }
  for (const key of ["high_count", "share_fraction"]) {
    const raw = read("market-picture.m1-components.fixture.json");
    delete raw.candle_anomalies.metrics.dictionary_rvol_1h_high[key];
    await assert.rejects(validateFrame(await seal(raw), { allowFixture: true }), undefined, `a valid anomaly without ${key} is rejected`);
  }
});

test("a candle-anomaly panel with no valid source may omit its null expiry and counts", async () => {
  const raw = read("market-picture.m1-components.fixture.json");
  const panel = raw.candle_anomalies;
  for (const metric of Object.values(panel.metrics)) {
    metric.values = metric.values.map(() => null);
    metric.valid_count = 0;
    metric.reason_codes = ["INSUFFICIENT_HISTORY"];
    delete metric.high_count; delete metric.share_fraction;
  }
  panel.source_count = 0;
  delete panel.expires_at_ms;
  const projected = projectFrame(await validateFrame(await seal(raw), { allowFixture: true })).candleAnomalies;
  assert.equal(projected.expires, null);
  assert.ok(Object.values(projected.metrics).every(metric => metric.high === null && metric.share === null));
});

test("a matched trajectory or divergence cohort keeps its membership hash even in compact frames", async () => {
  for (const family of ["breadth_trajectory", "breadth_divergence"]) {
    const raw = read("market-picture.m1-components.fixture.json");
    const row = raw[family].find(item => item.matched_count > 0);
    delete row.matched_membership_hash;
    await assert.rejects(validateFrame(await seal(raw), { allowFixture: true }), /membership hash must exist exactly when instruments are matched/, family);
  }
});

test("capability reasons may be omitted (schema default) but never null", async () => {
  const raw = read("market-picture.m1-components.fixture.json");
  const row = raw.source_capabilities[0];
  delete row.reasons;
  await validateFrame(await seal(raw), { allowFixture: true });
  row.reasons = null;
  await assert.rejects(validateFrame(await seal(raw), { allowFixture: true }), /Invalid capability reasons/);
});
