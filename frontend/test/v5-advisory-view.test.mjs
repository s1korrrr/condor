import test from "node:test";
import assert from "node:assert/strict";
import { projectV5Advisory } from "../src/features/market-picture/v5-advisory-view.mjs";

const now = 1_800_000_000_000;

function payload({ snapshotId = "snap-a", availableAt = now - 10_000, expiresAt = now + 20_000 } = {}) {
  return {
    "v1/context": {
      snapshot_id: snapshotId,
      cutoff_ms: availableAt - 1000,
      available_at_ms: availableAt,
      features: {
        "spot.pressure_15m": { value: 0.6, unit: "score", status: "QUALIFIED" },
        "quality.venue_coverage": { value: 0.8, unit: "ratio", status: "QUALIFIED" },
        "quality.missing_venues": { value: null, unit: "venues", status: "UNAVAILABLE" },
      },
    },
    "v1/advice/status": { mode: "reports-only", effect: "NONE", enabled: false, model: "fixture-model", native_v5_parity: "NOT_RUN", journal_status: "AVAILABLE", spent_usd: "0.001000", reserved_usd: "0.009000", calls_today: 1 },
    "v1/advice/latest": {
      status: "CURRENT_REPORT",
      record: {
        input: { snapshot_id: "snap-a" },
        result: {
          status: "ACCEPTED",
          received_at_ms: now - 5_000,
          expires_at_ms: expiresAt,
          advice: { assessment: "CAUTION", summary: "Venue readings disagree.", reason_codes: ["VENUE_DISAGREEMENT"] },
        },
      },
    },
    "v1/advice/history": { records: [] },
  };
}

test("projects current advice only when it matches a fresh context snapshot", () => {
  const view = projectV5Advisory(payload(), now);
  assert.equal(view.freshness, "CURRENT");
  assert.equal(view.mode, "reports-only");
  assert.equal(view.enabled, false);
  assert.equal(view.assessment, "CAUTION");
  assert.equal(view.features[0].value, 0.6);
  assert.equal(view.features.length, 1);
  assert.deepEqual(view.quality, [
    { id: "quality.venue_coverage", value: "0.8" },
    { id: "quality.missing_venues", value: null },
  ]);
  assert.equal(view.spentUsd, 0.001);
  assert.equal(view.reservedUsd, 0.009);
});

test("stale, future and mismatched context cannot show advice as current", () => {
  for (const input of [
    payload({ availableAt: now - 16 * 60_000 }),
    payload({ availableAt: now + 1_000 }),
    { ...payload(), "v1/context": { ...payload()["v1/context"], snapshot_id: "newer" } },
  ]) {
    const view = projectV5Advisory(input, now);
    assert.notEqual(view.freshness, "CURRENT");
    assert.equal(view.assessment, null);
    assert.deepEqual(view.reasons, []);
  }
});

test("expired or future advisor reports remain unavailable while mode and effect stay descriptive", () => {
  const expired = projectV5Advisory(payload({ expiresAt: now - 1 }), now);
  assert.equal(expired.freshness, "STALE");
  assert.equal(expired.assessment, null);
  assert.equal(expired.mode, "reports-only");
  const unavailable = projectV5Advisory({}, now);
  assert.equal(unavailable.freshness, "UNAVAILABLE");
  assert.equal(unavailable.assessment, null);
  assert.equal(unavailable.spentUsd, null);
});

test("an unqualified value stays unavailable even when it is fresh and numeric", () => {
  const input = payload();
  input["v1/context"].features["spot.pressure_15m"].status = "UNAVAILABLE";
  const view = projectV5Advisory(input, now);
  assert.equal(view.features[0].value, null);
  assert.equal(view.features[0].status, "UNAVAILABLE");
});

test("large untrusted collections and text are bounded", () => {
  const input = payload();
  input["v1/context"].features = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`feature-${i}`, { value: i, unit: "x", status: "AVAILABLE" }]));
  input["v1/advice/latest"].record.result.advice.summary = "x".repeat(501);
  const view = projectV5Advisory(input, now);
  assert.equal(view.features.length, 32);
  assert.equal(view.summary, null);
});

test("the API quality object and full component bundle remain inspectable", () => {
  const input = payload();
  input["v1/context"].features = Object.fromEntries(Array.from({ length: 22 }, (_, index) => [
    index === 21 ? "derivatives.venue_dispersion_range_median_pct.1m" : `spot.component_${index}`,
    { value: index, unit: "percent", status: "QUALIFIED" },
  ]));
  input["v1/context"].quality = { spot_venue_coverage_fraction: 1, target_row_states: { final: 135, missing: 1 } };
  const view = projectV5Advisory(input, now);
  assert.ok(view.quality.some((item) => item.id === "spot_venue_coverage_fraction" && item.value === "1"));
  assert.ok(view.quality.some((item) => item.id === "target_row_states.missing" && item.value === "1"));
  assert.ok(view.features.some((item) => item.id === "derivatives.venue_dispersion_range_median_pct.1m"));
});

test("a missing expiry cannot qualify a model report", () => {
  const input = payload();
  delete input["v1/advice/latest"].record.result.expires_at_ms;
  assert.equal(projectV5Advisory(input, now).assessment, null);
});

test("recorded seven-venue API evidence retains source missingness and both dispersion components", async () => {
  const { readFile } = await import("node:fs/promises");
  const context = JSON.parse(await readFile(new URL("./fixtures/v5-market-evidence.v1.json", import.meta.url), "utf8"));
  const view = projectV5Advisory({ "v1/context": context }, context.available_at_ms);
  assert.ok(view.quality.some((item) => item.id === "target_row_states.missing" && item.value === "1"));
  assert.ok(view.quality.some((item) => item.id === "quote_cohort_by_market.spot" && item.value === "USDT"));
  assert.ok(view.features.some((item) => item.id === "spot.venue_dispersion_range_median_pct.1m" && item.value !== null));
  assert.ok(view.features.some((item) => item.id === "derivatives.venue_dispersion_range_median_pct.1m" && item.value !== null));
  assert.equal(view.assessment, null);
});
