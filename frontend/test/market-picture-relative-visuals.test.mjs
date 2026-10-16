import test from "node:test";
import assert from "node:assert/strict";
import { placeScatterLabels, projectRelativeStrength, projectRelativeRankMovers } from "../src/features/market-picture/relative-visuals.mjs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { frontendModules } from "./helpers/frontend-module.mjs";

const chartStub = (name) => function ChartStub({ children }) {
  return React.createElement("div", { "data-chart-component": name }, children);
};
const { niceTicks, axisFormatter } = frontendModules().load("features/quant-ops/kit/series.ts");
const { load } = frontendModules({
  "./relative-visuals.mjs": { placeScatterLabels, projectRelativeStrength, projectRelativeRankMovers },
  "@/features/quant-ops/kit/series": { CHART: { blue: "blue", warning: "yellow", positive: "green", negative: "red", grid: "gray", muted: "gray", neutral: "gray", text: "white" }, niceTicks, axisFormatter },
  "./Primitives": { Empty: ({ children }) => React.createElement("p", null, children) },
  recharts: Object.fromEntries(["Bar", "BarChart", "CartesianGrid", "Cell", "LabelList", "ReferenceLine", "ResponsiveContainer", "Scatter", "ScatterChart", "Tooltip", "XAxis", "YAxis"].map(name => [name, chartStub(name)])),
}, { "features/market-picture/RelativeStrengthVisuals.tsx": ["RelativeStrengthVisuals"] });

// Owner metric timing: available before the 10_000_000 cutoff's assessment, expiring well after it.
const timing = { available: 9_000_000, expires: 20_000_000 };
const AS_OF = 10_000_500;
const current = { cutoff_ms: 10_000_000, available_at_ms: 10_000_100, expires_at_ms: 20_000_000 };
function asset(id, { oneHour = 0, oneHourStatus = "VALID", relative = 0, relativeStatus = "VALID", oneHourTiming = timing, relativeTiming = timing } = {}) {
  return {
    instrument_id: `venue:spot:${id}-USDC`, symbol: id,
    returns: { "60": { status: oneHourStatus, value: oneHour, ...oneHourTiming } },
    relative: { BTC: { status: relativeStatus, value: relative, ...relativeTiming } },
  };
}
const strength = (assets, benchmark, asOf = AS_OF, frame = current) => projectRelativeStrength(assets, benchmark, frame, asOf);

test("relative scatter keeps genuine zeros, omits unavailable fields, and marks owner pullbacks", () => {
  const result = strength([
    asset("ZERO", { oneHour: 0, relative: 0 }),
    asset("PULL", { oneHour: -1.25, relative: 2.5 }),
    asset("MISSING", { oneHour: null, relative: 1 }),
    asset("WARM", { oneHour: -1, oneHourStatus: "WARMING", relative: 2 }),
    asset("RS-MISSING", { oneHour: 1, relative: null, relativeStatus: "UNAVAILABLE" }),
  ], "BTC");

  assert.equal(result.expected, 5);
  assert.equal(result.valid, 2);
  assert.deepEqual(result.points.map(point => point.symbol), ["ZERO", "PULL"]);
  assert.equal(result.points[0].oneHourReturn, 0);
  assert.equal(result.points[0].relativeReturn, 0);
  assert.equal(result.points[0].pullback, false);
  assert.equal(result.points[1].pullback, true);
});

test("relative scatter uses the selected benchmark's validated owner excess-return field", () => {
  const row = asset("PAIR", { oneHour: -0.5, relative: 1.25 });
  row.relative.ETH = { status: "VALID", value: -3.5, ...timing };

  const result = strength([row], "ETH");
  assert.equal(result.points[0].relativeReturn, -3.5);
  assert.equal(result.points[0].pullback, false);
});

test("rank movers require an exact complete 1h owner cohort and retain bounded totals", () => {
  const assets = Array.from({ length: 12 }, (_, index) => asset(`A${String(index).padStart(2, "0")}`));
  const rankDeltas = Object.fromEntries(assets.map((row, index) => [row.instrument_id, index < 6 ? 6 - index : index === 6 ? 0 : [-7, -5, -4, -3, -2][index - 7]]));
  const frame = {
    ...current,
    assets,
    expected: assets.length,
    relativeStrengthChanges: {
      baselineSnapshotId: "a".repeat(64), baselineCutoff: 6_400_000,
      currentCutoff: 10_000_000, interval: 3_600_000,
      definitionId: "relative_return", expected: 12, valid: 12,
      cohortHash: "b".repeat(64), rankDeltas,
    },
  };

  const result = projectRelativeRankMovers(frame, AS_OF, 2);
  assert.equal(result.available, true);
  assert.equal(result.totalImproving, 6);
  assert.equal(result.totalWeakening, 5);
  assert.equal(result.unchanged, 1);
  assert.equal(result.displayed, 4);
  assert.deepEqual(result.rows.map(row => row.delta), [6, 5, -7, -5]);
});

test("rank movement is unavailable for missing baseline or any partial/null rank cohort", () => {
  const assets = [asset("A"), asset("B")];
  const valid = {
    baselineSnapshotId: "a".repeat(64), baselineCutoff: 6_400_000,
    currentCutoff: 10_000_000, interval: 3_600_000,
    definitionId: "relative_return", expected: 2, valid: 2,
    cohortHash: "b".repeat(64),
    rankDeltas: Object.fromEntries(assets.map((row, index) => [row.instrument_id, index ? -1 : 1])),
  };
  const frame = { ...current, assets, expected: 2, relativeStrengthChanges: valid };

  assert.equal(projectRelativeRankMovers({ ...frame, relativeStrengthChanges: null }, AS_OF).available, false);
  assert.equal(projectRelativeRankMovers({ ...frame, relativeStrengthChanges: { ...valid, valid: 1 } }, AS_OF).available, false);
  assert.equal(projectRelativeRankMovers({ ...frame, relativeStrengthChanges: { ...valid, rankDeltas: { ...valid.rankDeltas, [assets[1].instrument_id]: null } } }, AS_OF).available, false);
  assert.equal(projectRelativeRankMovers({ ...frame, relativeStrengthChanges: { ...valid, baselineSnapshotId: null } }, AS_OF).available, false);
});

function* walk(node) {
  if (Array.isArray(node)) { for (const child of node) yield* walk(child); return; }
  if (!node || typeof node !== "object" || !node.props) return;
  yield node;
  yield* walk(node.props.children);
}

test("scatter and rank values have a keyboard-accessible table path into the existing instrument drawer", () => {
  const assets = [
    asset("PULL", { oneHour: -1, relative: 2 }),
    asset("ZERO", { oneHour: 0, relative: 0 }),
  ];
  const frame = { ...current, assets, expected: 2, relativeStrengthChanges: null };
  const selected = [];
  const component = load("features/market-picture/RelativeStrengthVisuals.tsx").RelativeStrengthVisuals({
    frame, benchmark: "BTC", asOf: AS_OF, selected: null, select: id => selected.push(id),
  });
  const buttons = [...walk(component)].filter(node => node.type === "button");
  assert.deepEqual(buttons.map(node => node.props.children), ["PULL", "ZERO"]);
  for (const button of buttons) button.props.onClick();
  assert.deepEqual(selected, assets.map(row => row.instrument_id));
  const html = renderToStaticMarkup(component);
  assert.match(html, /Horizontal axis is one-hour asset return in percent/);
  assert.match(html, /PULLBACK|pullback candidates/i);
  assert.match(html, /<th scope="col">1h \(%\)<\/th><th scope="col">24h excess \(pp\)<\/th>/);
  assert.match(html, /measured against BTC\. Values are exact owner values/);
  assert.match(html, /<td>-1<\/td><td>\+2<\/td><td>Pullback<\/td>/, 'the table keeps exact owner values');
  assert.match(html, /mp-visual-card--full[\s\S]*mp-visual-card--status/, 'the populated scatter takes the row; unavailable rank movement is a compact status card');
  assert.match(html, /aria-pressed="false"/);
});

test("scatter axes are rounded quadrants and small sets name every point on the chart", () => {
  const render = count => load("features/market-picture/RelativeStrengthVisuals.tsx").RelativeStrengthVisuals({
    frame: { assets: Array.from({ length: count }, (_, index) => asset(`A${index}`, { oneHour: 0.83 - index * 0.01, relative: -8.08 + index * 0.1 })), expected: count, ...current, relativeStrengthChanges: null },
    benchmark: "BTC", asOf: AS_OF, selected: null, select: () => {},
  });
  const plot = [...walk(render(3))].find(node => node.props?.labelCandidates);
  const { xAxis: x, yAxis: y } = plot.props;
  assert.deepEqual(x.ticks, [0, 0.25, 0.5, 0.75, 1], "the x axis spans zero and the largest 1h return on rounded ticks");
  assert.deepEqual(y.ticks, [-10, -7.5, -5, -2.5, 0]);
  assert.ok(x.domain[0] < 0 && x.domain[1] > 1, "a margin beyond the outer ticks keeps edge points off the frame");
  assert.equal(y.format(-7.5), "-7.5");
  assert.equal(plot.props.labelCandidates.length, 3, "small sets are offered for direct labels");
  assert.equal([...walk(render(25))].find(node => node.props?.labelCandidates).props.labelCandidates.length, 0, "dense sets rely on the table instead of overlapping labels");
  assert.match(renderToStaticMarkup(render(3)), /Horizontal axis is one-hour asset return/, "the plot renders through React with its own width state");
});

test("relative views qualify only observations current at the assessment time", () => {
  const rows = [
    asset("LIVE", { oneHour: 1, relative: 2 }),
    asset("OLD-1H", { oneHour: 1, relative: 2, oneHourTiming: { available: 9_000_000, expires: 10_000_000 } }),
    asset("OLD-RS", { oneHour: 1, relative: 2, relativeTiming: { available: 9_000_000, expires: 10_000_500 } }),
    asset("EARLY", { oneHour: 1, relative: 2, oneHourTiming: { available: 10_000_600, expires: 20_000_000 } }),
    asset("UNTIMED", { oneHour: 1, relative: 2, relativeTiming: {} }),
  ];
  const result = strength(rows, "BTC");
  assert.deepEqual(result.points.map(point => point.symbol), ["LIVE"], "expired, not-yet-available and untimed metrics are omitted");
  assert.equal(result.omitted, 4);
  assert.equal(result.reason, null);

  const expiredFrame = strength(rows, "BTC", 20_000_000);
  assert.deepEqual(expiredFrame.points, [], "an expired frame qualifies no point");
  assert.equal(expiredFrame.reason, "FRAME_EXPIRED");
  assert.equal(strength(rows, "BTC", 10_000_050).reason, "FRAME_NOT_YET_AVAILABLE");
  assert.equal(strength(rows, "BTC", Number.NaN).reason, "INVALID_AS_OF");
  assert.equal(strength(rows, "BTC", 9_999_999, { ...current, available_at_ms: 9_999_000 }).reason, "FRAME_CUTOFF_NOT_YET_AVAILABLE");

  const historical = strength([asset("THEN", { oneHour: 1, relative: 2, oneHourTiming: { available: 1_000, expires: 2_000 }, relativeTiming: { available: 1_000, expires: 2_000 } })],
    "BTC", 1_500, { cutoff_ms: 1_000, available_at_ms: 1_100, expires_at_ms: 2_000 });
  assert.deepEqual(historical.points.map(point => point.symbol), ["THEN"], "historical inspection assesses at its own recorded time");
});

test("rank movement needs a current frame at the assessment time", () => {
  const assets = [asset("A"), asset("B")];
  const frame = { ...current, assets, expected: 2, relativeStrengthChanges: {
    baselineSnapshotId: "a".repeat(64), baselineCutoff: 6_400_000, currentCutoff: 10_000_000, interval: 3_600_000,
    definitionId: "relative_return", expected: 2, valid: 2, cohortHash: "b".repeat(64),
    rankDeltas: Object.fromEntries(assets.map((row, index) => [row.instrument_id, index ? -1 : 1])),
  } };
  assert.equal(projectRelativeRankMovers(frame, AS_OF).available, true);
  const expired = projectRelativeRankMovers(frame, 20_000_000);
  assert.equal(expired.available, false);
  assert.match(expired.reason, /FRAME_EXPIRED/);
  assert.deepEqual(expired.rows, []);
  assert.equal(projectRelativeRankMovers(frame, 10_000_050).available, false, "not yet available");
});

test("rendered relative views explain a frame that is not current instead of plotting it", () => {
  const component = load("features/market-picture/RelativeStrengthVisuals.tsx").RelativeStrengthVisuals({
    frame: { ...current, assets: [asset("LIVE", { oneHour: 1, relative: 2 })], expected: 1, relativeStrengthChanges: null },
    benchmark: "BTC", asOf: 20_000_000, selected: null, select: () => {},
  });
  const html = renderToStaticMarkup(component);
  assert.match(html, /0\/1 qualified; 1 missing, unavailable or not current/);
  assert.match(html, /not current at this assessment time \(FRAME_EXPIRED\)/);
  assert.equal([...walk(component)].some(node => node.props?.["data-chart-component"] === "ScatterChart" || node.type?.name === "ChartStub"), false, "no chart is drawn");
});

test("scatter labels flip away from the right edge and never overlap", () => {
  const point = (id, x, y, pullback = false) => ({ instrumentId: id, symbol: id, oneHourReturn: x, relativeReturn: y, pullback });
  const box = { width: 300, height: 200 };
  const placed = placeScatterLabels([
    point("EDGE", 0.99, 0), point("SAME-A", -0.5, 0.5), point("SAME-B", -0.5, 0.5), point("PULL", -0.5, 0.5, true), point("FREE", 0, -0.8),
  ], [-1, 1], [-1, 1], box);
  assert.equal(placed.get("EDGE"), "left", "a label that would leave the plot flips left");
  assert.equal(placed.get("PULL"), "right", "pullback candidates are labelled first");
  assert.equal(placed.get("SAME-A"), "left", "a coincident point takes the free side");
  assert.equal(placed.has("SAME-B"), false, "a third coincident label is suppressed instead of overlapping");
  assert.equal(placed.get("FREE"), "right");
  assert.equal(placeScatterLabels([point("X", 0, 0)], [0, 0], [-1, 1], box).size, 0, "a degenerate domain places nothing");
});
