import test from "node:test";
import assert from "node:assert/strict";
import { marketPulseWindow } from "../src/features/market-picture/model.mjs";
import { breadthTimeline } from "../src/features/market-picture/breadth-timeline.mjs";

test("pulse marks every change in valid count, expected count, or membership", () => {
  const base = Date.parse("2026-10-16T00:00:00Z");
  const history = [
    { time: base, membership: "same", valid: 220, expected: 240 },
    { time: base + 60_000, membership: "same", valid: 180, expected: 240 },
    { time: base + 120_000, membership: "same", valid: 180, expected: 240 },
    { time: base + 180_000, membership: "same", valid: 180, expected: 250 },
    { time: base + 240_000, membership: "changed", valid: 180, expected: 250 },
  ];
  const timeline = breadthTimeline(history, ["15"], { maxColumns: 10 });
  assert.deepEqual(timeline.columns.filter((column) => column.coverageChanged).map((column) => column.time), [base + 60_000, base + 180_000, base + 240_000]);
});

test("pulse labels requested coverage and filters only to the selected window", () => {
  const history = [0, 8, 16].map((hours) => ({ time: Date.parse("2026-09-30T00:00:00Z") + hours * 3600000 }));
  const result = marketPulseWindow(history, "7d");
  assert.equal(result.samples.length, 3);
  assert.equal(result.label, "Last 7d · 16h retained");
  const short = marketPulseWindow(history, "6h");
  assert.equal(short.samples.length, 1);
  assert.equal(short.label, "Last 6h · single retained observation");
  assert.equal(marketPulseWindow(history.slice(2), "24h").label, "Last 24h · single retained observation");
});

test("pulse discloses sub-hour history without rounding it to zero hours", () => {
  const start = Date.parse("2026-09-30T00:00:00Z");
  for (const [span, duration] of [[30_000, "<1m"], [120_000, "2m"], [3_599_000, "59m"], [3_600_000, "1h"]]) {
    const result = marketPulseWindow([{ time: start }, { time: start + span }], "24h");
    assert.equal(result.label, `Last 24h · ${duration} retained`);
    assert.equal(result.samples.length, 2);
  }
});

test("pulse distinguishes no observations from one observation and retained days", () => {
  assert.equal(marketPulseWindow([], "24h").label, "Last 24h · no retained observations");
  assert.equal(marketPulseWindow([{ time: 0 }], "24h").label, "Last 24h · single retained observation");
  assert.equal(marketPulseWindow([{ time: 0 }, { time: 36 * 3_600_000 }], "7d").label, "Last 7d · 1.5d retained");
  // A window covered to within one downsampling step reads as the window, not as a second duration.
  assert.equal(marketPulseWindow([{ time: 0 }, { time: 23.5 * 3_600_000 }], "24h").label, "Last 24h");
  assert.equal(marketPulseWindow([{ time: 0 }, { time: 23 * 3_600_000 }], "24h").label, "Last 24h · 23h retained");
});

test("timeline momentum follows the owner trajectory, never averages across a gap, and keeps divergence states distinct", async () => {
  const { breadthTimeline, momentumHorizon, momentumRetained, qualifiedDivergence } = await import("../src/features/market-picture/breadth-timeline.mjs");
  const base = Date.parse("2026-10-17T00:00:00Z");
  const hash = "a".repeat(64);
  const trajectory = (change, matched = 5) => ({ "15/5": { level: 0.2, change, velocity: change / 5, acceleration: 0, shareChange: change * 50, matched, expected: 5, membership: hash } });
  const divergence = (value) => ({ "15": { value, matched: 5, expected: 5, membership: hash,
    provenance: { horizon: 15, interval: 15, benchmarkInstrumentId: "okx:spot:BTC-USDC", quoteAsset: "USDC", definitionId: "breadth_price_divergence", definitionHash: hash, referenceWindowMinutes: 1440, windowStart: 0, windowEnd: 0 } } });
  const samples = [
    { time: base + 60_000, breadthTrajectory: trajectory(1.2), breadthDivergence: divergence(1) },
    { time: base + 120_000, gapBefore: true, breadthTrajectory: trajectory(-0.4, 4), breadthDivergence: divergence(0) },
    { time: base + 240_000, breadthTrajectory: trajectory(-0.8), breadthDivergence: { "15": { value: 1, matched: 5, expected: 5, membership: hash, provenance: null } } },
  ];
  assert.equal(momentumHorizon("240"), "15");
  assert.equal(momentumHorizon("5"), "5");
  assert.equal(momentumRetained(samples), true);
  assert.equal(momentumRetained([{ time: base, breadthTrajectory: { "15/5": { change: null } } }]), false);
  // A legacy row without provenance is unavailable, not "observed".
  assert.equal(qualifiedDivergence(samples[2], "15"), null);
  const one = breadthTimeline(samples, ["15"], { maxColumns: 1, trajectoryHorizon: "15" });
  assert.equal(one.columns.length, 1);
  const [column] = one.columns;
  // The bucket averages only the frames after the gap: (-0.4 + -0.8) / 2.
  assert.ok(Math.abs(column.momentum["5"].change - -0.6) < 1e-12);
  assert.equal(column.momentum["5"].matched, 4, "the weakest matched cohort is disclosed");
  assert.equal(column.momentum["15"], null);
  assert.deepEqual(column.divergence, { observed: [] }, "post-gap frames: one not observed, one unavailable");
  const fine = breadthTimeline(samples, ["15"], { maxColumns: 10, trajectoryHorizon: "15" });
  const own = fine.columns.filter((c) => c.frames > 0);
  assert.deepEqual(own.map((c) => c.divergence), [{ observed: ["15"] }, { observed: [] }, null]);
  assert.deepEqual(own.map((c) => c.momentum["5"]?.change ?? null), [1.2, -0.4, -0.8]);
  // The minute without its own frame repeats the previous frame (sampling spacing, labelled carried).
  assert.deepEqual(fine.columns.filter((c) => c.carried).map((c) => c.momentum["5"].change), [-0.4]);
});
