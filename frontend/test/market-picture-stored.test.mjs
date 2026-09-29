import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { projectFrame } from "../src/features/market-picture/contract.mjs";
import {
  projectHistory,
  projectCorrelations,
  projectEvents,
} from "../src/features/market-picture/stored.mjs";
const raw = JSON.parse(
  fs.readFileSync(
    new URL("../../tests/fixtures/market-picture.v1.json", import.meta.url),
    "utf8",
  ),
);
const frame = projectFrame(raw);
const envelope = (items) => ({
  schema_version: "market-picture.v1",
  snapshot_id: frame.snapshot_id,
  read_at_ms: frame.available_at_ms,
  items,
});
const point = (overrides) => ({
  snapshot_id: frame.snapshot_id,
  cutoff_ms: frame.cutoff_ms,
  available_at_ms: frame.available_at_ms,
  expires_at_ms: frame.expires_at_ms,
  source_kind: "observed",
  coverage: raw.coverage,
  membership_hash: frame.membershipHash,
  breadth: Object.fromEntries(
    ["1", "5", "15", "60", "240", "1440"].map((h) => [
      h,
      { positive: "0.5", negative: "0.5", flat: "0", pressure: "0" },
    ]),
  ),
  summary: { trend_strength: "25" },
  ...overrides,
});

test("history resolves canonical coverage and ascends in source time", () => {
  const first = point({
    cutoff_ms: frame.cutoff_ms - 60000,
    available_at_ms: frame.available_at_ms - 60000,
    snapshot_id: "a".repeat(64),
  });
  const rows = projectHistory(envelope([point(), first]), frame);
  assert.equal(rows[0].snapshot_id, first.snapshot_id);
  assert.equal(rows[1].valid, raw.coverage.valid_instruments);
  assert.equal(rows[1].summary.trend_strength, 25);
});
test("history rejects late revisions, mixed frames and nonnumeric shares", () => {
  assert.throws(
    () =>
      projectHistory(
        envelope([point({ available_at_ms: frame.available_at_ms + 1 })]),
        frame,
      ),
    /future/,
  );
  assert.throws(
    () =>
      projectHistory({ ...envelope([]), snapshot_id: "0".repeat(64) }, frame),
    /Mixed-snapshot/,
  );
  const p = point();
  p.breadth["1"].positive = "NaN";
  assert.throws(() => projectHistory(envelope([p]), frame));
  assert.throws(
    () => projectHistory(envelope([point(), point()]), frame),
    /Ambiguous/,
  );
});
test("correlations require admitted identities, exact sample coverage and bounded coefficients", () => {
  const row = {
    instrument_a_id: frame.assets[0].instrument_id,
    instrument_b_id: frame.assets[1].instrument_id,
    correlation: "0.75",
    paired_sample_count: 2160,
    expected_sample_count: 2160,
    reason_codes: [],
    window_end_ms: frame.cutoff_ms,
    trend: [],
  };
  assert.equal(projectCorrelations(envelope([row]), frame)[0].value, 0.75);
  for (const changes of [
    { expected_sample_count: undefined },
    { paired_sample_count: 100 },
    { correlation: "1.1" },
    { instrument_a_id: "okx:spot:UNKNOWN-USDC" },
  ])
    assert.throws(() =>
      projectCorrelations(envelope([{ ...row, ...changes }]), frame),
    );
});
test("events cannot appear in decision replay before their availability", () => {
  const event = {
    event_id: "event-a",
    instrument_id: null,
    event_type: "breadth_crossing",
    severity: "info",
    observed_at_ms: frame.cutoff_ms,
    available_at_ms: frame.available_at_ms,
    status: "original",
    is_historical_reconstruction: false,
    snapshot_id: frame.snapshot_id,
    value: { share: "0.6" },
  };
  assert.equal(projectEvents(envelope([event]), frame)[0].value, "share: 0.6");
  assert.throws(
    () =>
      projectEvents(
        envelope([{ ...event, available_at_ms: frame.available_at_ms + 1 }]),
        frame,
      ),
    /arrived after/,
  );
});
