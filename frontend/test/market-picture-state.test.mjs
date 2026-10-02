import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptFrame,
  ageState,
  parseView,
  viewQuery,
  rankAssets,
  csvCell,
  normalizeView,
  heatmapColor,
  heatmapAreas,
  histogramMembers,
  histogramBinIndex,
  stableAssetOrder,
  pollDelay,
  rankEmptyLabel,
  rankCoverageLabel,
  rankSideEmptyLabel,
} from "../src/features/market-picture/model.mjs";

test("ranking distinguishes warming coverage from a valid zero-return population", () => {
  const assets = [1, 2, 3].map((id) => ({ instrument_id: `asset-${id}` }));
  const warming = rankAssets(assets, () => null);
  assert.equal(warming.qualified, 0);
  assert.equal(warming.expected, 3);
  const zero = rankAssets(assets, () => 0);
  assert.equal(zero.qualified, 3);
  assert.equal(zero.leaders.length, 0);
  assert.equal(zero.laggards.length, 0);
  assert.equal(rankAssets(assets, (asset) => asset.instrument_id.endsWith("1") ? 2 : -1).leaders.length, 1);
  assert.equal(rankEmptyLabel(0, 3, 3), "Warming · 3/3 instruments");
  assert.equal(rankEmptyLabel(0, 3, 0), "No qualified observations · 0/3 available");
  assert.equal(rankEmptyLabel(3, 3, 0), null, "a valid zero-only population gets its observed empty-rank label");
  const mixedAssets = [1, 2, 3, 4, 5].map((id) => ({ instrument_id: `asset-${id}` }));
  const mixed = rankAssets(mixedAssets, (asset) => asset.instrument_id.endsWith("1") ? 2 : null);
  assert.equal(mixed.qualified, 1);
  assert.equal(rankCoverageLabel(mixed.qualified, mixed.expected, 4), "1/5 qualified · 4 warming");
  assert.equal(rankSideEmptyLabel("negative laggards", mixed.qualified, mixed.expected, 4), "No negative laggards · 1/5 qualified");
});

const frame = (more = {}) => ({
  stream_id: "observation",
  epoch: "epoch-a",
  sequence: 1,
  snapshot_id: "a".repeat(64),
  payload_digest: "b".repeat(64),
  cutoff_ms: 60_000,
  available_at_ms: 62_000,
  expires_at_ms: 122_000,
  ...more,
});

test("histogram marker honors horizon edges, strict overflow, and inclusive final bin", () => {
  const edges = [-.5, -.25, 0, .25, .5];
  assert.equal(histogramBinIndex(-.51, edges), 0);
  assert.equal(histogramBinIndex(-.5, edges), 1);
  assert.equal(histogramBinIndex(0, edges), 3);
  assert.equal(histogramBinIndex(.5, edges), 4);
  assert.equal(histogramBinIndex(.51, edges), 5);
});

test("heatmap uses square-root area and a disclosed median floor without inventing volume", () => {
  const layout = heatmapAreas([.01, .04, .16, null, 0]);
  assert.equal(layout.equalSize, false);
  assert.ok(Math.abs(layout.minimum - .01) < 1e-12);
  assert.deepEqual(layout.areas.slice(0, 3), [.1, .2, .4]);
  assert.ok(layout.areas.slice(3).every(value => Math.abs(value - .01) < 1e-12));
  assert.deepEqual(heatmapAreas([null, 0]).areas, [1, 1]);
  assert.equal(heatmapAreas([null, 0]).equalSize, true);
  assert.deepEqual(heatmapAreas([.01, .9], true).areas, [1, 1]);
});

test("revalidation preserves a frame; mutations and sequence regressions fail closed", () => {
  const prior = frame();
  assert.equal(acceptFrame(prior, structuredClone(prior)), prior);
  assert.throws(
    () => acceptFrame(prior, frame({ payload_digest: "c".repeat(64) })),
    /mutation/,
  );
  assert.throws(() => acceptFrame(prior, frame({ sequence: 0 })), /sequence/);
  assert.throws(
    () => acceptFrame(prior, frame({ stream_id: "different" })),
    /source/,
  );
  assert.throws(
    () => acceptFrame(prior, frame({ epoch: "new", available_at_ms: 61_000 })),
    /availability/,
  );
});

test("freezing does not freeze source age or extend expiry", () => {
  assert.equal(ageState(frame(), 70_000, true).mode, "FROZEN");
  assert.equal(ageState(frame(), 123_000, true).freshness, "STALE");
  assert.equal(ageState(frame(), 123_000, false).ageMs, 63_000);
  assert.equal(ageState(null, 1, false).mode, "UNAVAILABLE");
  assert.equal(ageState(frame(), 60_000, false).freshness, "FUTURE");
});

test("a new producer epoch cannot silently move the displayed cutoff backwards", () => {
  assert.throws(() => acceptFrame(frame(), frame({epoch: 'restarted', cutoff_ms: 0, available_at_ms: 63_000})), /cutoff regressed/);
});

test("safe shared views round trip without source credentials or arbitrary URLs", () => {
  const selected = "okx:spot:BTC-USDC";
  const view = {
    horizon: "15",
    window: "24h",
    benchmark: "BTC",
    sector: "All",
    selected,
  };
  assert.deepEqual(parseView(viewQuery(view)), normalizeView(view));
  const hostile = parseView(
    "?horizon=900&window=forever&benchmark=https://evil&sector=<svg>&selected=../api",
  );
  assert.equal(hostile.horizon, "60", "an invalid horizon falls back to the stable hourly default");
  assert.equal(parseView("").horizon, "60");
  assert.equal(hostile.benchmark, "BTC");
  assert.equal(hostile.selected, null);
});

test("ranking keeps positive and negative populations distinct; zero and missing are neither", () => {
  const assets = [
    { instrument_id: "c", returns: { 1440: -1 } },
    { instrument_id: "z", returns: { 1440: 0 } },
    { instrument_id: "b", returns: { 1440: 2 } },
    { instrument_id: "a", returns: { 1440: 2 } },
    { instrument_id: "n", returns: {} },
  ];
  const { leaders, laggards } = rankAssets(
    assets,
    (a) => a.returns["1440"] ?? null,
  );
  assert.deepEqual(
    leaders.map((a) => a.instrument_id),
    ["a", "b"],
  );
  assert.deepEqual(
    laggards.map((a) => a.instrument_id),
    ["c"],
  );
  assert.equal(
    rankAssets([assets[0]], (a) => a.returns["1440"]).leaders.length,
    0,
  );
});

test("CSV neutralizes spreadsheet formulas including leading whitespace", () => {
  for (const input of ["=1+2", "+cmd", "-cmd", "@SUM(1)", "\t=2", "\r=2"])
    assert.match(csvCell(input), /^"'/);
  assert.equal(csvCell("BTC"), '"BTC"');
  assert.equal(csvCell('a"b'), '"a""b"');
});

test("heatmap has fixed ±10 percent saturation and missing is distinct from zero", () => {
  assert.equal(heatmapColor(10), heatmapColor(80));
  assert.equal(heatmapColor(-10), heatmapColor(-80));
  assert.notEqual(heatmapColor(null), heatmapColor(0));
});

test("histogram selection highlights a cohort without changing frame denominator", () => {
  const assets = [0, 1, 2, null].map((value, i) => ({
    instrument_id: String(i),
    value,
  }));
  assert.deepEqual(
    histogramMembers(assets, (a) => a.value, 0, 1, false),
    ["0"],
  );
  assert.deepEqual(
    histogramMembers(assets, (a) => a.value, 1, 2, true),
    ["1", "2"],
  );
  assert.equal(assets.length, 4);
});

test("histogram overflow excludes the exact upper edge owned by the interior bin", () => {
  const assets = [9.9, 10, 10.1].map((value, i) => ({
    instrument_id: String(i),
    value,
  }));
  assert.deepEqual(
    histogramMembers(assets, (a) => a.value, 9.5, 10, true),
    ["0", "1"],
  );
  assert.deepEqual(
    histogramMembers(assets, (a) => a.value, 10, Infinity, false),
    ["2"],
  );
});

test("interacting with the table pins order while values update and missing stays last", () => {
  const rows = [
    ["a", 2],
    ["b", 1],
    ["c", null],
  ].map(([id, value]) => ({ instrument_id: id, returns: { 1440: { value } } }));
  const previous = stableAssetOrder(rows, "return").map((a) => a.instrument_id);
  rows[1].returns[1440].value = 3;
  assert.deepEqual(
    stableAssetOrder(rows, "return", previous).map((a) => a.instrument_id),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    stableAssetOrder(rows, "return").map((a) => a.instrument_id),
    ["b", "a", "c"],
  );
});

test("poll jitter cannot exceed the thirty second backoff ceiling", () => {
  assert.equal(pollDelay(0, 1), 2000);
  assert.equal(pollDelay(20, 1), 30000);
  assert.ok(pollDelay(1, 0) < pollDelay(1, 1));
});

test('new Market Picture controls do not become invalid native screener inputs; legacy links are retained', async () => {
  const {nativeViewSearch}=await import('../src/features/market-picture/model.mjs');
  assert.equal(nativeViewSearch('?horizon=15&window=7d&benchmark=BTC'), '');
  assert.equal(nativeViewSearch('?screen=oversold&server=v2&bot=rsi_modular_v2'), '?screen=oversold&server=v2&bot=rsi_modular_v2');
  assert.equal(nativeViewSearch('?screen=all&screen=oversold'), '?screen=all&screen=oversold'); // Existing parser rejects duplicates.
});
