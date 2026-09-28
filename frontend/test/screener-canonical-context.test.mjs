import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalContextExpiry,
  mergeCanonicalContext,
  parseCanonicalContext,
} from "../src/features/screener/canonical-context.mjs";

const validFeature = (overrides = {}) => ({
  name: "breadth_positive_eq_h5",
  value: 0,
  unit: "share",
  horizon_minutes: 5,
  status: "VALID",
  reasons: [],
  valid_count: 5,
  expected_count: 5,
  valid_weight_fraction: 1,
  model_id: null,
  input_available_at_ms: 1_800_000_000_000,
  ...overrides,
});

const snapshot = (overrides = {}) => ({
  schema_version: "1.0",
  snapshot_id: "a".repeat(64),
  stream_id: "market-context-v1",
  epoch: "epoch-1",
  sequence: 1,
  source_kind: "observed",
  venue: "okx",
  numeraire: "USDC",
  cutoff_ms: 1_800_000_000_000,
  available_at_ms: 1_800_000_000_000,
  expires_at_ms: 1_800_000_060_000,
  supersedes: null,
  max_input_available_at_ms: 1_800_000_000_000,
  status: "READY",
  reasons: [],
  provenance: {
    code_digest: "b".repeat(64),
    config_digest: "c".repeat(64),
    universe_hash: "d".repeat(64),
    input_manifest_digest: "e".repeat(64),
    model_digest: "f".repeat(64),
    serializer_version: "mc-json-1",
    artifact_refs: [],
  },
  coverage: {
    expected_count: 5,
    valid_count: 5,
    valid_weight_fraction: 1,
    missing: [],
  },
  market: [validFeature()],
  assets: [],
  ...overrides,
});

test("canonical context accepts a measured numeric zero and preserves the owner payload", () => {
  const payload = snapshot();
  const parsed = parseCanonicalContext({ availability: "available", payload });
  assert.equal(parsed.availability, "available");
  assert.equal(parsed.payload.market[0].value, 0);
  assert.equal(parsed.payload.snapshot_id, "a".repeat(64));
});

test("canonical context requires unavailable feature values to remain null with a status reason", () => {
  const payload = snapshot({
    market: [
      validFeature({
        value: 0,
        status: "WARMUP_INCOMPLETE",
        reasons: ["WARMUP_INCOMPLETE"],
      }),
    ],
  });
  assert.throws(
    () => parseCanonicalContext({ availability: "available", payload }),
    /invalid or uses an unsupported schema/i,
  );
});

test("canonical context rejects unknown schema versions", () => {
  assert.throws(
    () =>
      parseCanonicalContext({
        availability: "available",
        payload: snapshot({ schema_version: "2.0" }),
      }),
    /unsupported schema/i,
  );
});

test("canonical context unavailable response carries only the typed owner reason", () => {
  assert.deepEqual(
    parseCanonicalContext({
      availability: "unavailable",
      reason: "STORE_UNAVAILABLE",
      source_status: 503,
    }),
    {
      availability: "unavailable",
      reason: "STORE_UNAVAILABLE",
      sourceStatus: 503,
    },
  );
});

test("typed provider outage retains the last good snapshot and its expiry", () => {
  const good = snapshot();
  const outage = parseCanonicalContext({
    availability: "unavailable",
    reason: "STORE_UNAVAILABLE",
    source_status: 503,
  });
  const merged = mergeCanonicalContext(good, outage);
  assert.equal(merged.response.availability, "unavailable");
  assert.equal(merged.snapshot, good);
  assert.equal(canonicalContextExpiry(merged.snapshot, good.expires_at_ms), "expired");
});

test("canonical parser rejects missing nullable fields, overlong horizons, and malformed fits", () => {
  const missing = snapshot({ market: [validFeature()] });
  delete missing.market[0].model_id;
  assert.throws(
    () => parseCanonicalContext({ availability: "available", payload: missing }),
    /invalid or uses an unsupported schema/i,
  );
  assert.throws(
    () =>
      parseCanonicalContext({
        availability: "available",
        payload: snapshot({ market: [validFeature({ horizon_minutes: 1441 })] }),
      }),
    /invalid or uses an unsupported schema/i,
  );
  const badFit = {
    horizon_minutes: 60,
    status: "VALID",
    reasons: [],
    training_samples: 8,
    history_cutoff_ms: null,
    factor_id: "a".repeat(64),
  };
  assert.throws(
    () =>
      parseCanonicalContext({
        availability: "available",
        payload: snapshot({
          assets: [{ asset_id: "BTC", instrument_id: "BTC-USDC", reasons: [], features: [], fits: [badFit] }],
        }),
      }),
    /invalid or uses an unsupported schema/i,
  );
});

test("snapshot expiry stays truthful while a view is paused", () => {
  const payload = snapshot();
  assert.equal(
    canonicalContextExpiry(payload, payload.expires_at_ms - 1),
    "current",
  );
  assert.equal(
    canonicalContextExpiry(payload, payload.expires_at_ms),
    "expired",
  );
  assert.equal(
    canonicalContextExpiry(payload, payload.available_at_ms - 1),
    "future",
  );
  assert.equal(canonicalContextExpiry(null, Date.now()), "unknown");
});
