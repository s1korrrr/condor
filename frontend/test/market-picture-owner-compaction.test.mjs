import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as contract from "../src/features/market-picture/contract.mjs";
import * as model from "../src/features/market-picture/model.mjs";
import * as pulseModule from "../src/features/market-picture/pulse.mjs";
import * as stored from "../src/features/market-picture/stored.mjs";
import { frontendModules } from "./helpers/frontend-module.mjs";

const { projectFrame, validateFrame } = contract;
const { load } = frontendModules({
  "./model.mjs": model, "./pulse.mjs": pulseModule, "./contract.mjs": contract, "./stored.mjs": stored, "@/lib/api": { api: {} },
});

// The owner serves compact frames: null and default-valued fields are absent on the wire
// (see tests/fixtures/owner-compact/README.md). The browser must accept exactly those bytes.
const dir = new URL("../../tests/fixtures/owner-compact/", import.meta.url);
const files = fs.readdirSync(dir).filter(name => name.endsWith(".owner-compact.json")).sort();

test("the owner-compact fixture set is present", () => {
  assert.equal(files.length, 8);
});

for (const file of files) {
  test(`owner-compacted frame validates and projects in the browser: ${file}`, async () => {
    const frame = await validateFrame(JSON.parse(fs.readFileSync(new URL(file, dir), "utf8")), { allowFixture: true });
    assert.ok(projectFrame(frame).assets.length > 0);
  });
}

test("an unavailable anomaly's omitted counts project as unavailable, not as zero", async () => {
  const raw = JSON.parse(fs.readFileSync(new URL("market-picture.m1-components.fixture.unavailable-anomaly.owner-compact.json", dir), "utf8"));
  assert.equal("high_count" in raw.candle_anomalies.metrics.extreme_realized_volatility_1h_95p, false);
  const metric = projectFrame(await validateFrame(raw, { allowFixture: true })).candleAnomalies.metrics.extreme_realized_volatility_1h_95p;
  assert.equal(metric.valid, 0);
  assert.equal(metric.high, null);
  assert.equal(metric.share, null);
});

for (const file of files) {
  test(`every Market panel renders an owner-compacted frame: ${file}`, async () => {
    const frame = projectFrame(await validateFrame(JSON.parse(fs.readFileSync(new URL(file, dir), "utf8")), { allowFixture: true }));
    const pulse = load("features/market-picture/MarketPulse.tsx");
    const asOf = frame.available_at_ms;
    const rendered = {};
    for (const [name, props] of [
      ["EvidenceMatrixPanel", { frame, horizon: "15", asOf }],
      ["MicrostructurePanel", { frame, asOf }],
      ["BreadthContextPanel", { frame }],
      ["DailyInternalsPanel", { frame, asOf }],
    ]) rendered[name] = renderToStaticMarkup(React.createElement(pulse[name], props));
    // A panel with no qualified value renders nothing; the availability line must then name it.
    const availability = renderToStaticMarkup(React.createElement(pulse.AvailabilityLine, { frame, asOf, horizon: "15" }));
    assert.ok(rendered.EvidenceMatrixPanel.length > 0, "evidence families always render");
    if (!rendered.MicrostructurePanel) {
      assert.equal(frame.microstructure, null, "an attached microstructure component is never hidden");
      assert.match(availability, /Executed spot flow|Displayed liquidity/);
    }
    if (!rendered.DailyInternalsPanel) assert.match(availability, /Daily range &amp; SMAs/);
    if (!rendered.BreadthContextPanel) assert.ok(availability.length > 0, "hidden internals leave a visible availability line");
  });
}
