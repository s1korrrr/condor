import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { projectFrame, validateFrame } from "../src/features/market-picture/contract.mjs";
import { selectMetricCohort } from "../src/features/market-picture/metric-cohort.mjs";

const rawFixture = () => JSON.parse(fs.readFileSync(
  new URL("../../tests/fixtures/market-picture.m1-components.fixture.json", import.meta.url),
  "utf8",
));
async function ownerFrame() {
  return projectFrame(await validateFrame(rawFixture(), { allowFixture: true }));
}
function select(frame, request, asOf, expectedDefinition) {
  return selectMetricCohort(frame, request, asOf, expectedDefinition);
}

test("breadth selection uses the owner horizon, counts, and sign convention", async () => {
  const frame = await ownerFrame();
  const asOf = frame.available_at_ms + 1;
  const owner = frame.breadth["60"];
  const result = select(frame, { kind: "breadth", horizon: "60", side: "declining" }, asOf);
  const expectedIds = frame.assets.filter(asset => asset.returns["60"].value < 0).map(asset => asset.instrument_id);

  assert.deepEqual(result.instrumentIds, expectedIds);
  assert.equal(result.valid, owner.valid);
  assert.equal(result.expected, owner.expected);
  assert.equal(result.definition, `${owner.negative.definition}; ${frame.assets[0].returns["60"].definition}`);
  assert.equal(result.snapshotId, frame.snapshot_id);
  assert.equal(result.cutoff, frame.cutoff_ms);
  assert.equal(result.status, "available");
  assert.deepEqual(result.reasons, []);
});

test("a measured zero breadth side is an available empty cohort", async () => {
  const frame = await ownerFrame();
  for (const asset of frame.assets) asset.returns["1"].value = 1;
  Object.assign(frame.breadth["1"], { advancing: frame.assets.length, declining: 0, unchanged: 0 });
  const result = select(frame, { kind: "breadth", horizon: "1", side: "unchanged" }, frame.available_at_ms + 1);

  assert.equal(result.status, "available");
  assert.deepEqual(result.instrumentIds, []);
  assert.equal(result.valid, frame.expected);
  assert.ok(result.definition);
});

test("breadth contributor counts must reconcile with the owner aggregate", async () => {
  const frame = await ownerFrame();
  frame.breadth["1"].advancing += 1;
  const result = select(frame, { kind: "breadth", horizon: "1", side: "advancing" }, frame.available_at_ms + 1);

  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.instrumentIds, []);
  assert.ok(result.reasons.some(reason => /reconcil/i.test(reason)));
});

test("breadth valid count must match the selected owner share metric", async () => {
  const frame = await ownerFrame();
  frame.breadth["1"].positive.valid -= 1;
  const result = select(frame, { kind: "breadth", horizon: "1", side: "advancing" }, frame.available_at_ms + 1);

  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.instrumentIds, []);
  assert.ok(result.reasons.some(reason => /coverage.*mismatch/i.test(reason)));
});

test("breadth contributor definition changes fail closed", async () => {
  const frame = await ownerFrame();
  frame.assets[0].returns["1"].definition = "changed-return-definition";
  const result = select(frame, { kind: "breadth", horizon: "1", side: "advancing" }, frame.available_at_ms + 1);

  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.instrumentIds, []);
  assert.ok(result.reasons.some(reason => /unreconcil/i.test(reason)));
});

test("predicate selection uses only its owner-qualified per-asset values", async () => {
  const frame = await ownerFrame();
  const result = select(frame, { kind: "predicate", key: "trending" }, frame.available_at_ms + 1);
  const expectedIds = frame.assets.filter(asset => asset.predicates.trending.value === 1).map(asset => asset.instrument_id);

  assert.deepEqual(result.instrumentIds, expectedIds);
  assert.equal(result.valid, frame.participation.trending.valid);
  assert.equal(result.expected, frame.participation.trending.expected);
  assert.equal(result.definition, frame.participation.trending.definition);
  assert.equal(result.status, "available");
});

test("predicate count mismatch fails closed and never selects every asset", async () => {
  const frame = await ownerFrame();
  const expectedIds = frame.assets.filter(asset => asset.predicates.trending.value === 1).map(asset => asset.instrument_id);
  frame.participation.trending.value = 0;
  const result = select(frame, { kind: "predicate", key: "trending" }, frame.available_at_ms + 1);

  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.instrumentIds, []);
  assert.notDeepEqual(result.instrumentIds, expectedIds);
  assert.ok(result.reasons.some(reason => /reconcil/i.test(reason)));
});

test("predicate contributor definition changes fail closed", async () => {
  const frame = await ownerFrame();
  frame.assets[0].predicates.trending.definition = "changed-membership-definition";
  const result = select(frame, { kind: "predicate", key: "trending" }, frame.available_at_ms + 1);

  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.instrumentIds, []);
  assert.ok(result.reasons.some(reason => /definition/i.test(reason)));
});

test("definition pinning rejects a changed owner definition", async () => {
  const frame = await ownerFrame();
  const result = select(frame, { kind: "predicate", key: "trending" }, frame.available_at_ms + 1,
    "retired-definition");

  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.instrumentIds, []);
  assert.equal(result.definition, frame.participation.trending.definition);
  assert.ok(result.reasons.some(reason => /definition/i.test(reason)));
});

test("future and expired frames are unavailable with no contributor fallback", async () => {
  const frame = await ownerFrame();
  const request = { kind: "predicate", key: "trending" };
  const future = select(frame, request, frame.available_at_ms - 1);
  const expired = select(frame, request, frame.expires_at_ms);
  const futureCutoff = select({ ...frame, cutoff_ms: frame.available_at_ms + 10 }, request, frame.available_at_ms + 1);

  for (const result of [future, expired, futureCutoff]) {
    assert.equal(result.status, "unavailable");
    assert.deepEqual(result.instrumentIds, []);
    assert.ok(result.reasons.length > 0);
  }
});

test("a metric that is missing, expired, or future cannot contribute", async () => {
  const frame = await ownerFrame();
  const request = { kind: "predicate", key: "trending" };
  const asOf = frame.available_at_ms + 1;
  const validCell = frame.assets[0].predicates.trending;
  const missing = structuredClone(frame);
  missing.assets[0].predicates.trending = { ...validCell, value: null, status: "MISSING" };
  const expired = structuredClone(frame);
  expired.assets[0].predicates.trending = { ...validCell, expires: asOf - 1 };
  const future = structuredClone(frame);
  future.assets[0].predicates.trending = { ...validCell, available: asOf + 1 };

  for (const changed of [missing, expired, future]) {
    const result = select(changed, request, asOf);
    assert.equal(result.status, "unavailable");
    assert.deepEqual(result.instrumentIds, []);
    assert.ok(result.reasons.length > 0);
  }
});

test("daily-above uses owner daily SMA observations and their source timing", async () => {
  const frame = await ownerFrame();
  const result = select(frame, { kind: "daily-above", period: "20" }, frame.available_at_ms + 1);
  const expectedIds = frame.dailyInternals.filter(row => row.averages["20"].above_close.metric.value === 1)
    .map(row => row.instrumentId);

  assert.deepEqual(result.instrumentIds, expectedIds);
  assert.equal(result.valid, frame.dailyInternals.length);
  assert.equal(result.expected, frame.expected);
  assert.equal(result.definition, "daily_sma_20_above_close");
  assert.equal(result.status, "available");
});

test("daily-break reuses owner breakout cells and preserves zero contributors", async () => {
  const frame = await ownerFrame();
  for (const row of frame.dailyInternals) {
    row.breaks.high_break.metric.value = 0;
    row.breaks.high_break.metric.original = "0";
  }
  const result = select(frame, { kind: "daily-break", key: "high_break" }, frame.available_at_ms + 1);
  const expectedIds = frame.dailyInternals.filter(row => row.breaks.high_break.metric.value === 1)
    .map(row => row.instrumentId);

  assert.deepEqual(result.instrumentIds, expectedIds);
  assert.equal(result.valid, frame.dailyInternals.length);
  assert.equal(result.expected, frame.expected);
  assert.equal(result.definition, "daily_high_break_20d");
  assert.equal(result.status, "available");
  assert.deepEqual(result.instrumentIds, [], "valid zero cells form an empty cohort");
});

test("missing daily source timing excludes that row instead of borrowing intraday evidence", async () => {
  const frame = await ownerFrame();
  frame.dailyInternals[0].source = null;
  const result = select(frame, { kind: "daily-above", period: "20" }, frame.available_at_ms + 1);

  assert.equal(result.status, "available");
  assert.equal(result.valid, 4);
  assert.equal(result.expected, 5);
  assert.ok(result.reasons.includes("DAILY_SOURCE_TIMING_UNAVAILABLE"));
});

test("future or expired daily sources are excluded from the qualified daily population", async () => {
  const frame = await ownerFrame();
  const request = { kind: "daily-break", key: "close_break_low" };
  const asOf = frame.available_at_ms + 1;
  const future = structuredClone(frame);
  future.dailyInternals[0].source.available = asOf + 1;
  const expired = structuredClone(frame);
  expired.dailyInternals[0].source.expires = asOf;

  const futureResult = select(future, request, asOf);
  const expiredResult = select(expired, request, asOf);
  assert.equal(futureResult.status, "available");
  assert.equal(futureResult.valid, 4);
  assert.ok(futureResult.reasons.includes("DAILY_SOURCE_NOT_YET_AVAILABLE"));
  assert.equal(expiredResult.status, "available");
  assert.equal(expiredResult.valid, 4);
  assert.ok(expiredResult.reasons.includes("DAILY_SOURCE_EXPIRED"));
});

test("daily selection reports the qualified population when some owner rows are absent", async () => {
  const frame = await ownerFrame();
  frame.dailyInternals = frame.dailyInternals.slice(0, 2);
  const result = select(frame, { kind: "daily-above", period: "20" }, frame.available_at_ms + 1);
  const expectedIds = frame.dailyInternals.filter(row => row.averages["20"].above_close.metric.value === 1)
    .map(row => row.instrumentId);

  assert.equal(result.status, "available");
  assert.equal(result.valid, 2);
  assert.equal(result.expected, 5);
  assert.deepEqual(result.instrumentIds, expectedIds);
  assert.ok(result.reasons.includes("DAILY_ROWS_MISSING"));
});

test("partial daily warmup excludes only cells below their own required sample count", async () => {
  const frame = await ownerFrame();
  const cell = frame.dailyInternals[0].averages["20"].above_close;
  cell.samples = 10;
  cell.metric.valid = 10;
  cell.metric.value = 1;
  cell.metric.original = "1";
  const result = select(frame, { kind: "daily-above", period: "20" }, frame.available_at_ms + 1);

  assert.equal(result.status, "available");
  assert.equal(result.valid, 4);
  assert.equal(result.expected, 5);
  assert.ok(!result.instrumentIds.includes(frame.dailyInternals[0].instrumentId));
  assert.ok(result.reasons.includes("DAILY_INSUFFICIENT_SAMPLES"));
});

test("a warming daily cell is excluded while current daily cells remain selectable", async () => {
  const frame = await ownerFrame();
  const row = frame.dailyInternals[0];
  const cell = row.breaks.close_break_high;
  cell.metric.status = "WARMING";
  cell.metric.value = null;
  cell.metric.original = null;
  const result = select(frame, { kind: "daily-break", key: "close_break_high" }, frame.available_at_ms + 1);

  assert.equal(result.status, "available");
  assert.equal(result.valid, 4);
  assert.equal(result.expected, 5);
  assert.ok(result.reasons.includes("DAILY_METRIC_UNAVAILABLE"));
  assert.ok(!result.instrumentIds.includes(row.instrumentId));
});

test("a source available after the frame decision is excluded even when asOf is later", async () => {
  const frame = await ownerFrame();
  const row = frame.dailyInternals[0];
  row.source.available = frame.available_at_ms + 30_000;
  const result = select(frame, { kind: "daily-above", period: "50" }, frame.available_at_ms + 60_000);

  assert.equal(result.status, "available");
  assert.equal(result.valid, 4);
  assert.ok(result.reasons.includes("DAILY_SOURCE_AFTER_DECISION"));
  assert.ok(!result.instrumentIds.includes(row.instrumentId));
});

test("daily selection is unavailable when no source-qualified cell remains", async () => {
  const frame = await ownerFrame();
  for (const row of frame.dailyInternals) row.source = null;
  const result = select(frame, { kind: "daily-break", key: "high_break" }, frame.available_at_ms + 1);

  assert.equal(result.status, "unavailable");
  assert.equal(result.valid, 0);
  assert.equal(result.expected, 5);
  assert.deepEqual(result.instrumentIds, []);
  assert.ok(result.reasons.includes("DAILY_SOURCE_TIMING_UNAVAILABLE"));
});

test("duplicate and unknown daily instrument IDs fail closed", async () => {
  const frame = await ownerFrame();
  const duplicate = structuredClone(frame);
  duplicate.dailyInternals[1].instrumentId = duplicate.dailyInternals[0].instrumentId;
  const unknown = structuredClone(frame);
  unknown.dailyInternals[0].instrumentId = "unknown:spot:NOT-IN-UNIVERSE";

  for (const [changed, reason] of [[duplicate, "DAILY_DUPLICATE_INSTRUMENT_ID"], [unknown, "DAILY_UNKNOWN_INSTRUMENT_ID"]]) {
    const result = select(changed, { kind: "daily-above", period: "20" }, frame.available_at_ms + 1);
    assert.equal(result.status, "unavailable");
    assert.deepEqual(result.instrumentIds, []);
    assert.ok(result.reasons.includes(reason));
  }
});

test("unexpected daily definitions, binary values, or frame cutoffs fail closed", async () => {
  const frame = await ownerFrame();
  const changedDefinition = structuredClone(frame);
  changedDefinition.dailyInternals[0].breaks.high_break.definitionId = "another-definition";
  const malformedBinary = structuredClone(frame);
  malformedBinary.dailyInternals[0].breaks.high_break.metric.value = 2;
  const incompatibleCutoff = structuredClone(frame);
  incompatibleCutoff.dailyInternals[0].frameCutoff -= 60_000;

  for (const [changed, reason] of [
    [changedDefinition, "DAILY_DEFINITION_MISMATCH"],
    [malformedBinary, "DAILY_BINARY_VALUE_INVALID"],
    [incompatibleCutoff, "DAILY_FRAME_CUTOFF_MISMATCH"],
  ]) {
    const result = select(changed, { kind: "daily-break", key: "high_break" }, frame.available_at_ms + 1);
    assert.equal(result.status, "unavailable");
    assert.deepEqual(result.instrumentIds, []);
    assert.ok(result.reasons.includes(reason));
  }
});
