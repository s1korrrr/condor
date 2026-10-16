import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { frontendModules } from "./helpers/frontend-module.mjs";
import * as model from "../src/features/market-picture/model.mjs";
import * as pulse from "../src/features/market-picture/pulse.mjs";

const START = Date.parse("2026-10-01T00:00:00Z");
const metric = value => ({ value, original: String(value), unit: "count", status: "VALID", reasons: [], valid: 5, expected: 5, definition: "test v1" });
const summary = {
  market_participation: 0.6, trend_strength: 20, realized_volatility_24h: 0.5,
  relative_volume_1h: 1.2, new_highs_24h: 3, new_lows_24h: 2,
};
const point = (minute, values = summary, gapBefore = false) => ({
  time: START + minute * 60_000, summary: values, gapBefore, breadth: {},
});

function renderTiles(history, current = summary, window = "24h") {
  const charts = new Map();
  const { load } = frontendModules({
    "./model.mjs": model,
    "./pulse.mjs": pulse,
    // Inspect the real component's chart boundary. Browser evidence separately
    // exercises the actual SparkChart renderer and its null-segment behavior.
    "@/features/quant-ops/kit/charts": { SparkChart(props) {
      charts.set(props.ariaLabel, props.points);
      return React.createElement("span", { role: "img", "aria-label": props.ariaLabel });
    } },
  });
  const { MarketSnapshotTiles } = load("features/market-picture/MarketPulse.tsx");
  const frame = {
    summary: Object.fromEntries(Object.entries(current).map(([key, value]) => [key, metric(value)])),
    comparisons: {}, valid: 5, expected: 5, quote: "USD", universeId: "synthetic",
  };
  const html = renderToStaticMarkup(React.createElement(MarketSnapshotTiles, { frame, history, window }));
  return { charts, html };
}

test("historical high/low net requires both counts while preserving observed zero and signed values", () => {
  const values = [
    { new_highs_24h: 5, new_lows_24h: 2 },
    { new_highs_24h: 3, new_lows_24h: null },
    { new_highs_24h: null, new_lows_24h: 2 },
    { new_highs_24h: null, new_lows_24h: null },
    { new_highs_24h: 3 }, { new_lows_24h: 2 }, {},
    { new_highs_24h: 0, new_lows_24h: 0 },
    { new_highs_24h: 1, new_lows_24h: 3 },
  ];
  const { charts, html } = renderTiles(values.map((value, i) => point(i, value)));
  assert.match(html, /New highs \/ lows/);
  assert.deepEqual(charts.get("New highs / lows over 24h").map(p => p.value),
    [3, null, null, null, null, null, null, 0, -2]);
});

test("unavailable components cannot create enough historical observations to draw a sparkline", () => {
  const { charts, html } = renderTiles([
    point(0, { new_highs_24h: 0, new_lows_24h: 0 }),
    point(1, { new_highs_24h: 3 }), point(2, { new_lows_24h: 2 }), point(3, {}),
  ]);
  assert.match(html, /New highs \/ lows/);
  assert.equal(charts.has("New highs / lows over 24h"), false);
});

test("every summary sparkline breaks at a recorded gap and retains the observed values and times", () => {
  for (const volumeKey of ["relative_volume_1h", "relative_volume_24h"]) {
    const current = { ...summary, [volumeKey]: 1.2 };
    if (volumeKey === "relative_volume_24h") delete current.relative_volume_1h;
    const history = [point(0, current), point(5, current, true), point(6, current)];
    const before = structuredClone(history);
    const { charts } = renderTiles(history, current);
    assert.equal(charts.size, 5, "four scalar tiles and the high/low net");
    for (const [label, points] of charts) {
      assert.deepEqual(points.map(p => p.time), [START, START + 5 * 60_000 - 1, START + 5 * 60_000, START + 6 * 60_000], label);
      assert.equal(points[1].value, null, `${label}: explicit chart break`);
      assert.equal(points[0].value, points[2].value, `${label}: keep the first post-gap observation`);
      assert.equal(points[2].value, points[3].value, `${label}: keep subsequent observations`);
      assert.notEqual(points[0].value, null);
    }
    assert.deepEqual(history, before, "presentation does not rewrite stored observations");
  }
});

test("a gap before the selected window's first observation does not add a fictitious earlier sample", () => {
  const { charts } = renderTiles([point(0), point(400, summary, true), point(410)], summary, "6h");
  assert.equal(charts.size, 5);
  for (const [label, points] of charts)
    assert.deepEqual(points.map(p => p.time), [START + 400 * 60_000, START + 410 * 60_000], label);
});
