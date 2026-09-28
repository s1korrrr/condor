const FEATURE_STATUSES = new Set([
  "VALID",
  "WARMUP_INCOMPLETE",
  "INPUT_MISSING",
  "INPUT_STALE",
  "MODEL_UNAVAILABLE",
  "INVALID",
]);
const ENVELOPE_STATUSES = new Set(["READY", "DEGRADED", "WARMING", "INVALID"]);
const SOURCE_KINDS = new Set(["observed", "modeled_availability", "synthetic"]);
const REASONS = new Set([
  "INPUT_UNCONFIRMED", "INPUT_GAP", "INPUT_STALE", "INPUT_REVISION_CONFLICT",
  "INPUT_NONFINITE", "INPUT_MISSING", "INPUT_INVALID", "CUTOFF_NOT_MONOTONIC",
  "MEMBERSHIP_UNAVAILABLE", "QUOTE_MISMATCH", "DUPLICATE_UNDERLYING",
  "CLASSIFICATION_UNKNOWN", "CLASSIFICATION_EXCLUDED", "LISTING_UNKNOWN",
  "LISTING_TOO_RECENT", "TURNOVER_UNAVAILABLE", "COVERAGE_LOW",
  "BENCHMARK_MISSING", "WARMUP_INCOMPLETE", "SCALE_DEGENERATE",
  "FACTOR_VARIANCE_LOW", "MODEL_UNAVAILABLE", "RANK_POPULATION_LOW",
  "STORE_UNAVAILABLE", "WRITER_FENCED", "PAYLOAD_TOO_LARGE", "CAPACITY_EXCEEDED",
  "SNAPSHOT_CONFLICT", "CONTEXT_EXPIRED", "CONTEXT_FUTURE", "VERSION_MISMATCH",
  "SOURCE_KIND_REJECTED", "SNAPSHOT_HASH_MISMATCH", "STREAM_MISMATCH",
  "VENUE_MISMATCH", "PROVENANCE_MISMATCH", "FEATURE_UNAVAILABLE",
  "EPOCH_UNCONFIRMED", "CONTEXT_UNAVAILABLE", "PAYLOAD_INVALID",
]);
const FEATURE_KEYS = [
  "name", "value", "unit", "horizon_minutes", "status", "reasons",
  "valid_count", "expected_count", "valid_weight_fraction", "model_id",
  "input_available_at_ms",
];
const FIT_KEYS = [
  "horizon_minutes", "status", "reasons", "training_samples",
  "history_cutoff_ms", "factor_id",
];
const MAX_TIMESTAMP_MS = 253402300799000;
const DIGEST = /^[0-9a-f]{64}$/;
const ASSET = /^[A-Z0-9]{1,32}$/;
const INSTRUMENT = /^[A-Z0-9]{1,32}-[A-Z0-9]{1,32}$/;
const STREAM = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const EPOCH = /^[A-Za-z0-9_-]{1,128}$/;
const FEATURE = /^[a-z][a-z0-9_]{0,63}$/;
const VENUE = /^[a-z0-9_]{1,32}$/;
const UNITS = new Set([
  "return_fraction", "share", "share_change", "ordinal",
  "regression_coefficient", "standard_score",
]);

function exactKeys(value, keys) {
  return (
    value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => key in value)
  );
}

function validReasons(value, required = false) {
  return (
    validTextArray(value) && value.every((reason) => REASONS.has(reason)) &&
    [...value].sort().every((reason, index) => reason === value[index]) &&
    (!required || value.length > 0)
  );
}

function validTimestamp(value, nullable = false) {
  return (
    (nullable && value === null) ||
    (Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMESTAMP_MS)
  );
}

function validTextArray(value, maximum = 64) {
  return (
    Array.isArray(value) &&
    value.length <= maximum &&
    value.every(
      (item) =>
        typeof item === "string" && item.length > 0 && item.length <= 64,
    ) && value.every((item, index) => index === 0 || value[index - 1] < item)
  );
}

function validFeature(feature) {
  if (!exactKeys(feature, FEATURE_KEYS))
    return false;
  if (
    typeof feature.name !== "string" || !FEATURE.test(feature.name) ||
    !UNITS.has(feature.unit) ||
    !Number.isInteger(feature.horizon_minutes) ||
    feature.horizon_minutes < 1 || feature.horizon_minutes > 1440 ||
    !Number.isInteger(feature.valid_count) ||
    !Number.isInteger(feature.expected_count) ||
    feature.valid_count < 0 || feature.expected_count > 500 ||
    feature.valid_count > feature.expected_count ||
    !FEATURE_STATUSES.has(feature.status) ||
    !validReasons(feature.reasons, feature.status !== "VALID") ||
    (feature.valid_weight_fraction !== null &&
      (!Number.isFinite(feature.valid_weight_fraction) ||
        feature.valid_weight_fraction < 0 || feature.valid_weight_fraction > 1)) ||
    (feature.model_id !== null &&
      (typeof feature.model_id !== "string" || !DIGEST.test(feature.model_id))) ||
    !validTimestamp(feature.input_available_at_ms, true)
  )
    return false;
  if (feature.status === "VALID") {
    return typeof feature.value === "number" && Number.isFinite(feature.value);
  }
  return feature.value === null && feature.reasons.length > 0;
}

function validFit(fit) {
  return (
    exactKeys(fit, FIT_KEYS) &&
    Number.isInteger(fit.horizon_minutes) && fit.horizon_minutes >= 1 &&
    fit.horizon_minutes <= 1440 && FEATURE_STATUSES.has(fit.status) &&
    validReasons(fit.reasons, fit.status !== "VALID") &&
    Number.isSafeInteger(fit.training_samples) && fit.training_samples >= 0 &&
    validTimestamp(fit.history_cutoff_ms, true) &&
    (fit.factor_id === null || (typeof fit.factor_id === "string" && DIGEST.test(fit.factor_id))) &&
    ((fit.history_cutoff_ms !== null && fit.factor_id !== null) === (fit.status === "VALID"))
  );
}

function validSnapshot(snapshot) {
  return (
    exactKeys(snapshot, [
      "schema_version", "snapshot_id", "stream_id", "epoch", "sequence",
      "source_kind", "available_at_ms", "expires_at_ms", "supersedes", "venue",
      "numeraire", "cutoff_ms", "max_input_available_at_ms", "provenance",
      "coverage", "status", "reasons", "market", "assets",
    ]) &&
    typeof snapshot.schema_version === "string" &&
    /^[0-9]{1,3}\.[0-9]{1,3}$/.test(snapshot.schema_version) &&
    snapshot.schema_version.split(".", 1)[0] === "1" &&
    typeof snapshot.snapshot_id === "string" &&
    DIGEST.test(snapshot.snapshot_id) &&
    typeof snapshot.stream_id === "string" &&
    STREAM.test(snapshot.stream_id) &&
    typeof snapshot.epoch === "string" &&
    EPOCH.test(snapshot.epoch) &&
    Number.isSafeInteger(snapshot.sequence) &&
    snapshot.sequence > 0 &&
    typeof snapshot.venue === "string" &&
    VENUE.test(snapshot.venue) &&
    typeof snapshot.numeraire === "string" &&
    ASSET.test(snapshot.numeraire) &&
    Number.isSafeInteger(snapshot.cutoff_ms) &&
    validTimestamp(snapshot.cutoff_ms) && snapshot.cutoff_ms % 60000 === 0 &&
    validTimestamp(snapshot.available_at_ms) &&
    validTimestamp(snapshot.expires_at_ms) &&
    snapshot.expires_at_ms > snapshot.available_at_ms &&
    snapshot.available_at_ms >= snapshot.cutoff_ms &&
    validTimestamp(snapshot.max_input_available_at_ms, true) &&
    (snapshot.max_input_available_at_ms === null || snapshot.available_at_ms >= snapshot.max_input_available_at_ms) &&
    (snapshot.supersedes === null || (typeof snapshot.supersedes === "string" && DIGEST.test(snapshot.supersedes))) &&
    validReasons(snapshot.reasons, snapshot.status !== "READY") &&
    ENVELOPE_STATUSES.has(snapshot.status) &&
    SOURCE_KINDS.has(snapshot.source_kind) &&
    (snapshot.status === "READY") === (snapshot.reasons.length === 0) &&
    exactKeys(snapshot.provenance, ["code_digest", "config_digest", "universe_hash", "input_manifest_digest", "model_digest", "serializer_version", "artifact_refs"]) &&
    [snapshot.provenance.code_digest, snapshot.provenance.config_digest, snapshot.provenance.universe_hash, snapshot.provenance.input_manifest_digest, snapshot.provenance.model_digest].every((digest) => typeof digest === "string" && DIGEST.test(digest)) &&
    snapshot.provenance.serializer_version === "mc-json-1" &&
    Array.isArray(snapshot.provenance.artifact_refs) && snapshot.provenance.artifact_refs.length <= 32 &&
    snapshot.provenance.artifact_refs.every((ref) => typeof ref === "string" && ref.length >= 1 && ref.length <= 256) &&
    exactKeys(snapshot.coverage, ["expected_count", "valid_count", "valid_weight_fraction", "missing"]) &&
    Number.isInteger(snapshot.coverage.expected_count) &&
    Number.isInteger(snapshot.coverage.valid_count) &&
    snapshot.coverage.valid_count >= 0 &&
    snapshot.coverage.expected_count >= snapshot.coverage.valid_count &&
    snapshot.coverage.expected_count <= 500 &&
    Number.isFinite(snapshot.coverage.valid_weight_fraction) &&
    snapshot.coverage.valid_weight_fraction >= 0 &&
    snapshot.coverage.valid_weight_fraction <= 1 &&
    Array.isArray(snapshot.coverage.missing) &&
    snapshot.coverage.missing.length === snapshot.coverage.expected_count - snapshot.coverage.valid_count &&
    snapshot.coverage.missing.length <= 500 &&
    snapshot.coverage.missing.every((item) => exactKeys(item, ["asset_id", "reasons"]) && typeof item.asset_id === "string" && ASSET.test(item.asset_id) && validReasons(item.reasons, true)) &&
    snapshot.coverage.missing.map((item) => item.asset_id).every((id, index, ids) => index === 0 || ids[index - 1] < id) &&
    Array.isArray(snapshot.market) &&
    snapshot.market.length <= 256 &&
    snapshot.market.every(validFeature) &&
    snapshot.market.map((feature) => feature.name).every((name, index, names) => index === 0 || names[index - 1] < name) &&
    Array.isArray(snapshot.assets) &&
    snapshot.assets.length <= 500 &&
    snapshot.assets.every((asset) => exactKeys(asset, ["asset_id", "instrument_id", "reasons", "features", "fits"]) && ASSET.test(asset.asset_id) && INSTRUMENT.test(asset.instrument_id) && validReasons(asset.reasons) && Array.isArray(asset.features) && asset.features.every(validFeature) && asset.features.map((feature) => feature.name).every((name, index, names) => index === 0 || names[index - 1] < name) && Array.isArray(asset.fits) && asset.fits.length <= 16 && asset.fits.every(validFit) && asset.fits.map((fit) => fit.horizon_minutes).every((horizon, index, horizons) => index === 0 || horizons[index - 1] < horizon)) &&
    snapshot.assets.map((asset) => asset.asset_id).every((id, index, ids) => index === 0 || ids[index - 1] < id)
  );
}

export function parseCanonicalContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Market context response is malformed.");
  }
  if (value.availability === "unavailable") {
    if (
      typeof value.reason !== "string" || !REASONS.has(value.reason) ||
      ![404, 503].includes(value.source_status)
    ) {
      throw new TypeError("Market context unavailable response is malformed.");
    }
    return {
      availability: "unavailable",
      reason: value.reason,
      sourceStatus: Number.isInteger(value.source_status)
        ? value.source_status
        : null,
    };
  }
  if (value.availability !== "available" || !validSnapshot(value.payload)) {
    throw new TypeError(
      "Market context envelope is invalid or uses an unsupported schema.",
    );
  }
  return { availability: "available", payload: value.payload };
}

export function canonicalContextExpiry(snapshot, now) {
  if (!snapshot || !Number.isFinite(now)) return "unknown";
  if (now < snapshot.available_at_ms) return "future";
  return now >= snapshot.expires_at_ms ? "expired" : "current";
}

export function mergeCanonicalContext(currentSnapshot, incoming) {
  return {
    response: incoming,
    snapshot:
      incoming?.availability === "available" ? incoming.payload : currentSnapshot,
  };
}
