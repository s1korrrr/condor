import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { frontendModules } from "./helpers/frontend-module.mjs";
import * as model from "../src/features/market-picture/model.mjs";
import * as pulse from "../src/features/market-picture/pulse.mjs";
import { projectFrame, validateFrame } from "../src/features/market-picture/contract.mjs";

const { load } = frontendModules({ "./model.mjs": model, "./pulse.mjs": pulse,
  react: { ...React, useMemo: callback => callback() },
}, { "features/market-picture/MarketPulse.tsx": ["MarketSnapshotTilesView"] });
const missing = (frame, horizon = "60", asOf = frame.available_at_ms) =>
  new Map(load("features/market-picture/availability.ts").availabilityItems(frame, asOf, horizon).map(item => [item.key, item]));
const readFrame = async name => projectFrame(await validateFrame(JSON.parse(fs.readFileSync(
  new URL(`../../tests/fixtures/market-picture.${name}.fixture.json`, import.meta.url), "utf8")), { allowFixture: true }));
function* walk(node) {
  if (Array.isArray(node)) { for (const child of node) yield* walk(child); return; }
  if (!node || typeof node !== "object" || !node.props) return;
  yield node;
  yield* walk(node.props.children);
}
function summary(frame, horizon = "60", asOf = frame.available_at_ms, historical = false) {
  const { MarketSnapshotTilesView } = load("features/market-picture/MarketPulse.tsx");
  const selected = [];
  const tree = MarketSnapshotTilesView({ frame, history: [], window: "24h", horizon, asOf, historical,
    onInspect: tile => selected.push(tile) });
  for (const node of walk(tree)) if (node.type === "button" && node.props["aria-haspopup"] === "dialog") node.props.onClick();
  return { tiles: new Map(selected.map(tile => [tile.key, tile])), html: renderToStaticMarkup(tree) };
}

test("summary exposes the selected owner return and qualified source-family readings", async () => {
  const frame = await readFrame("m1-components");
  const { tiles, html } = summary(frame);
  assert.ok(tiles.has("equal_weight_return"), "equal-weight return is a first-view reading");
  assert.equal(tiles.get("equal_weight_return").metric, frame.contributions["60"].equalReturn);
  assert.equal(tiles.get("equal_weight_return").value, "-0.10%");
  assert.equal(tiles.get("equal_weight_return").label, "Equal-weight return (1h)");
  assert.match(tiles.get("equal_weight_return").hint, /5\/5/);
  assert.deepEqual(tiles.get("equal_weight_return").points, [], "retained summary rows do not contain frozen-cohort return history");
  for (const key of ["spot_flow", "spot_liquidity"]) assert.equal(tiles.get(key)?.value, "Observed", key);
  // An unqualified family is not a tile; the availability line names it with its owner state.
  assert.equal(tiles.has("derivatives"), false);
  assert.match(missing(frame).get("derivatives").reason, /not probed/);
  assert.ok([...tiles.values()].every(tile => tile.freshness), "freshness accompanies every reading");
  assert.match(html, /Frame observed at/);
  assert.equal(summary(frame, "15").tiles.get("equal_weight_return").metric, frame.contributions["15"].equalReturn);
});

test("missing owner return and absent observations stay unavailable even with capability receipts", async () => {
  const frame = await readFrame("m1-components");
  frame.contributions = {};
  frame.microstructure = null;
  const { tiles } = summary(frame);
  for (const key of ["equal_weight_return", "spot_flow", "spot_liquidity"]) assert.equal(tiles.has(key), false, key);
  const items = missing(frame);
  assert.ok(items.has("equal_return"));
  assert.match(items.get("spot_flow").detail, /Source status alone does not qualify a frame metric/);
  assert.ok(items.has("spot_liquidity"));
  assert.doesNotMatch(items.get("equal_return").detail, /observed-subset/);
  const unavailable = await readFrame("240");
  assert.equal(summary(unavailable).tiles.has("derivatives"), false);
  assert.match(missing(unavailable).get("derivatives").detail, /No owner source-capability receipt/);
});

test("summary readings preserve zero and gate future, expired and recorded observations", async () => {
  const frame = await readFrame("m1-components");
  const metric = frame.contributions["60"].equalReturn;
  Object.assign(metric, { value: 0, original: "0.000000000000" });
  const current = summary(frame);
  assert.equal(current.tiles.get("equal_weight_return")?.value, "0.00%");
  const future = summary(frame, "60", frame.available_at_ms - 1);
  assert.equal(future.tiles.has("equal_weight_return"), false, "a future return is not shown as current");
  assert.equal(missing(frame, "60", frame.available_at_ms - 1).get("equal_return").reason, "not yet available");
  assert.equal(future.tiles.has("spot_flow"), false);
  const expired = summary(frame, "60", frame.expires_at_ms);
  assert.equal(expired.tiles.get("equal_weight_return")?.freshness, "EXPIRED");
  assert.equal(expired.tiles.has("spot_flow"), false);
  assert.match(summary(frame, "60", frame.available_at_ms, true).html, /Recorded ·/);
});

test("a daily measure the grid leaves out is named in the availability line", async () => {
  const frame = await readFrame("m1-components");
  for (const row of frame.dailyInternals) for (const cell of Object.values(row.averages["200"] ?? {}))
    Object.assign(cell.metric, { value: null, status: "UNAVAILABLE", reasons: ["INSUFFICIENT_HISTORY"] });
  const daily = missing(frame).get("daily");
  assert.ok(daily, "partially missing daily measures are listed");
  assert.match(daily.label, /Daily · 4 of 16 measures/);
  assert.match(daily.detail, /SMA200 slope/);
  assert.match(daily.reason, /building history/);
  const { DailyInternalsPanel } = load("features/market-picture/MarketPulse.tsx");
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(DailyInternalsPanel, { frame })), /SMA200 slope/, "the grid and the line use one rule");
});

test("an SMA price never stands in for a missing above-SMA fact", async () => {
  const frame = await readFrame("m1-components");
  for (const row of frame.dailyInternals) Object.assign(row.averages["200"].above_close.metric, { value: null, status: "UNAVAILABLE", reasons: ["INSUFFICIENT_HISTORY"] });
  const daily = missing(frame).get("daily");
  assert.match(daily.detail, /Above SMA200/, "the missing predicate is named");
  const html = renderToStaticMarkup(React.createElement(load("features/market-picture/MarketPulse.tsx").DailyInternalsPanel, { frame }));
  assert.doesNotMatch(html, /Above SMA200/, "no above-SMA200 column or filter without the fact");
});

test("absent hourly and candle-tag projections are named, not silently dropped", async () => {
  const frame = await readFrame("240");
  assert.equal(frame.hourlyInternals, null);
  assert.equal(frame.candleAnomalies, null);
  const items = missing(frame);
  assert.equal(items.get("hourly")?.reason, "not attached");
  assert.equal(items.get("anomaly")?.reason, "not attached");
});

test("absent trajectory, divergence and one-basis-point breadth projections are named", async () => {
  const frame = await readFrame("240");
  assert.deepEqual([frame.breadthTrajectory, frame.breadthDivergence, frame.normalizedBreadth], [[], [], {}]);
  const items = missing(frame);
  assert.match(items.get("trajectory").label, /Breadth trajectory & divergence/);
  assert.match(items.get("trajectory").detail, /No owner trajectory projection is attached/);
  assert.equal(items.get("normalized")?.reason, "not attached");
});

test("history panels the page leaves out are named from the same retention rules", async () => {
  const frame = await readFrame("m1-components");
  const { availabilityItems, flowHistoryRetained } = load("features/market-picture/availability.ts");
  const items = new Map(availabilityItems(frame, frame.available_at_ms, "60", "BTC", { samples: [], fault: null }).map(item => [item.key, item]));
  assert.ok(items.has("flow_history"), "current flow does not stand in for retained flow history");
  assert.ok(items.has("returns_history"));
  assert.equal(flowHistoryRetained([]), false);
  const faulted = new Map(availabilityItems(frame, frame.available_at_ms, "60", "BTC", { samples: [], fault: "timeout" }).map(item => [item.key, item]));
  assert.equal(faulted.has("flow_history"), false, "a read fault is shown by the flow panel itself");
  assert.equal(faulted.get("returns_history").reason, "read degraded");
});
