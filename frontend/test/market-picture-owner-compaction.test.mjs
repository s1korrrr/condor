import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { projectFrame, validateFrame } from "../src/features/market-picture/contract.mjs";

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
