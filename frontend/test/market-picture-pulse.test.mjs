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
  assert.equal(result.label, "Requested 7d · available 16h");
  const short = marketPulseWindow(history, "6h");
  assert.equal(short.samples.length, 1);
  assert.equal(short.label, "Requested 6h · single retained observation");
  assert.equal(marketPulseWindow(history.slice(2), "24h").label, "Requested 24h · single retained observation");
});

test("pulse discloses sub-hour history without rounding it to zero hours", () => {
  const start = Date.parse("2026-09-30T00:00:00Z");
  for (const [span, duration] of [[30_000, "<1m"], [120_000, "2m"], [3_599_000, "59m"], [3_600_000, "1h"]]) {
    const result = marketPulseWindow([{ time: start }, { time: start + span }], "24h");
    assert.equal(result.label, `Requested 24h · available ${duration}`);
    assert.equal(result.samples.length, 2);
  }
});

test("pulse distinguishes no observations from one observation and retained days", () => {
  assert.equal(marketPulseWindow([], "24h").label, "Requested 24h · no retained observations");
  assert.equal(marketPulseWindow([{ time: 0 }], "24h").label, "Requested 24h · single retained observation");
  assert.equal(marketPulseWindow([{ time: 0 }, { time: 36 * 3_600_000 }], "7d").label, "Requested 7d · available 1.5d");
});
