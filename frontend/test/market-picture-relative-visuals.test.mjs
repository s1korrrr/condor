import test from "node:test";
import assert from "node:assert/strict";
import { projectRelativeStrength, projectRelativeRankMovers } from "../src/features/market-picture/relative-visuals.mjs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { frontendModules } from "./helpers/frontend-module.mjs";

const chartStub = (name) => function ChartStub({ children }) {
  return React.createElement("div", { "data-chart-component": name }, children);
};
const { load } = frontendModules({
  "./relative-visuals.mjs": { projectRelativeStrength, projectRelativeRankMovers },
  "@/features/quant-ops/kit/series": { CHART: { blue: "blue", warning: "yellow", positive: "green", negative: "red", grid: "gray", muted: "gray", neutral: "gray" } },
  "./Primitives": { Empty: ({ children }) => React.createElement("p", null, children) },
  recharts: Object.fromEntries(["Bar", "BarChart", "CartesianGrid", "Cell", "ReferenceLine", "ResponsiveContainer", "Scatter", "ScatterChart", "Tooltip", "XAxis", "YAxis"].map(name => [name, chartStub(name)])),
}, { "features/market-picture/RelativeStrengthVisuals.tsx": ["RelativeStrengthVisuals"] });

function asset(id, { oneHour = 0, oneHourStatus = "VALID", relative = 0, relativeStatus = "VALID" } = {}) {
  return {
    instrument_id: `venue:spot:${id}-USDC`, symbol: id,
    returns: { "60": { status: oneHourStatus, value: oneHour } },
    relative: { BTC: { status: relativeStatus, value: relative } },
  };
}

test("relative scatter keeps genuine zeros, omits unavailable fields, and marks owner pullbacks", () => {
  const result = projectRelativeStrength([
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
  row.relative.ETH = { status: "VALID", value: -3.5 };

  const result = projectRelativeStrength([row], "ETH");
  assert.equal(result.points[0].relativeReturn, -3.5);
  assert.equal(result.points[0].pullback, false);
});

test("rank movers require an exact complete 1h owner cohort and retain bounded totals", () => {
  const assets = Array.from({ length: 12 }, (_, index) => asset(`A${String(index).padStart(2, "0")}`));
  const rankDeltas = Object.fromEntries(assets.map((row, index) => [row.instrument_id, index < 6 ? 6 - index : index === 6 ? 0 : [-7, -5, -4, -3, -2][index - 7]]));
  const frame = {
    assets,
    expected: assets.length,
    cutoff_ms: 10_000_000,
    relativeStrengthChanges: {
      baselineSnapshotId: "a".repeat(64), baselineCutoff: 6_400_000,
      currentCutoff: 10_000_000, interval: 3_600_000,
      definitionId: "relative_return", expected: 12, valid: 12,
      cohortHash: "b".repeat(64), rankDeltas,
    },
  };

  const result = projectRelativeRankMovers(frame, 2);
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
  const frame = { assets, expected: 2, cutoff_ms: 10_000_000, relativeStrengthChanges: valid };

  assert.equal(projectRelativeRankMovers({ ...frame, relativeStrengthChanges: null }).available, false);
  assert.equal(projectRelativeRankMovers({ ...frame, relativeStrengthChanges: { ...valid, valid: 1 } }).available, false);
  assert.equal(projectRelativeRankMovers({ ...frame, relativeStrengthChanges: { ...valid, rankDeltas: { ...valid.rankDeltas, [assets[1].instrument_id]: null } } }).available, false);
  assert.equal(projectRelativeRankMovers({ ...frame, relativeStrengthChanges: { ...valid, baselineSnapshotId: null } }).available, false);
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
  const frame = { assets, expected: 2, cutoff_ms: 10_000_000, relativeStrengthChanges: null };
  const selected = [];
  const component = load("features/market-picture/RelativeStrengthVisuals.tsx").RelativeStrengthVisuals({
    frame, benchmark: "BTC", selected: null, select: id => selected.push(id),
  });
  const buttons = [...walk(component)].filter(node => node.type === "button");
  assert.deepEqual(buttons.map(node => node.props.children), ["PULL", "ZERO"]);
  for (const button of buttons) button.props.onClick();
  assert.deepEqual(selected, assets.map(row => row.instrument_id));
  const html = renderToStaticMarkup(component);
  assert.match(html, /Horizontal axis is one-hour asset return in percent/);
  assert.match(html, /PULLBACK|pullback candidates/i);
  assert.match(html, /1h return \(%\)/);
  assert.match(html, /24h excess vs BTC \(pp\)/);
  assert.match(html, /aria-pressed="false"/);
});
