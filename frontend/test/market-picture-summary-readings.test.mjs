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

test("summary exposes the selected owner return and independent source-family readings", async () => {
  const frame = await readFrame("m1-components");
  const { tiles, html } = summary(frame);
  assert.ok(tiles.has("equal_weight_return"), "equal-weight return is a first-view reading");
  assert.equal(tiles.get("equal_weight_return").metric, frame.contributions["60"].equalReturn);
  assert.equal(tiles.get("equal_weight_return").value, "-0.10%");
  assert.match(tiles.get("equal_weight_return").hint, /1h.*5\/5/);
  assert.deepEqual(tiles.get("equal_weight_return").points, [], "retained summary rows do not contain frozen-cohort return history");
  for (const key of ["spot_flow", "spot_liquidity", "derivatives"]) assert.ok(tiles.has(key), key);
  assert.match(tiles.get("spot_flow").value, /Observed/);
  assert.match(tiles.get("spot_liquidity").value, /Observed/);
  assert.match(tiles.get("derivatives").value, /Unavailable/);
  assert.match(html, /NOT PROBED/);
  assert.ok([...tiles.values()].every(tile => tile.freshness), "freshness accompanies every reading");
  assert.match(html, /Frame observed at/);
  assert.equal(summary(frame, "15").tiles.get("equal_weight_return").metric, frame.contributions["15"].equalReturn);
});

test("missing owner return and absent observations stay unavailable even with capability receipts", async () => {
  const frame = await readFrame("m1-components");
  frame.contributions = {};
  frame.microstructure = null;
  const { tiles, html } = summary(frame);
  assert.equal(tiles.get("equal_weight_return")?.value, "Unavailable");
  assert.equal(tiles.get("spot_flow")?.value, "Unavailable");
  assert.equal(tiles.get("spot_liquidity")?.value, "Unavailable");
  assert.match(html, /Source status alone does not qualify a frame metric/);
  assert.doesNotMatch(tiles.get("equal_weight_return").hint, /observed-subset/);
  const unavailable = summary(await readFrame("240"));
  assert.equal(unavailable.tiles.get("derivatives")?.value, "Unavailable");
  assert.match(unavailable.html, /No owner source-capability receipt/);
});

test("summary readings preserve zero and gate future, expired and recorded observations", async () => {
  const frame = await readFrame("m1-components");
  const metric = frame.contributions["60"].equalReturn;
  Object.assign(metric, { value: 0, original: "0.000000000000" });
  const current = summary(frame);
  assert.equal(current.tiles.get("equal_weight_return")?.value, "0.00%");
  const future = summary(frame, "60", frame.available_at_ms - 1);
  assert.equal(future.tiles.get("equal_weight_return")?.value, "Unavailable");
  assert.equal(future.tiles.get("equal_weight_return")?.freshness, "FUTURE");
  assert.doesNotMatch(future.tiles.get("spot_flow")?.value ?? "", /Observed/);
  const expired = summary(frame, "60", frame.expires_at_ms);
  assert.equal(expired.tiles.get("equal_weight_return")?.freshness, "EXPIRED");
  assert.equal(expired.tiles.get("spot_flow")?.value, "Unavailable");
  assert.match(summary(frame, "60", frame.available_at_ms, true).html, /Recorded ·/);
});
