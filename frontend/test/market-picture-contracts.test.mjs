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
    summary: f => { f.summary.metric_refs.relative_volume_24h = f.breadth[0].metric_refs.advances; },
    breadthHorizon: f => { f.breadth[0].metric_refs.advance_share = f.breadth[1].metric_refs.advance_share; },
    pressureHorizon: f => { f.pressure[0].metric_id = f.pressure[1].metric_id; },
    distribution: f => { f.distribution[0].definition_ref.definition_id = "breadth_share"; },
    comparison: f => { f.comparisons.metric_refs["summary/relative_volume_24h"] = f.comparisons.metric_refs["summary/trend_strength"]; },
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
  assert.equal(view.raw.snapshot_id, frame.snapshot_id);
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
