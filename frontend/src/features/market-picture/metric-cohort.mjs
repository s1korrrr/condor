const HORIZONS = new Set(["1", "5", "15", "60", "240", "1440"]);
const PREDICATE_KEYS = new Set([
  "above_ema21", "compression", "elevated_rvol", "high_volatility",
  "rsi_above_50", "rsi_above_70", "rsi_below_30", "trending",
]);
const BREAK_KEYS = new Set(["high_break", "low_break", "close_break_high", "close_break_low"]);
const DAILY_PERIODS = new Set(["20", "50", "200"]);

const finite = value => typeof value === "number" && Number.isFinite(value);
const metricUsable = metric => metric && finite(metric.value) &&
  (metric.status === "VALID" || metric.status === "PARTIAL");
/** Why a frame cannot supply current observations at `asOf`, or null when it can. */
export const frameReason = (frame, asOf) => {
  if (!finite(asOf)) return "INVALID_AS_OF";
  if (!frame || !finite(frame.cutoff_ms) || !finite(frame.available_at_ms) || !finite(frame.expires_at_ms))
    return "FRAME_TIMING_UNAVAILABLE";
  if (frame.cutoff_ms > asOf) return "FRAME_CUTOFF_NOT_YET_AVAILABLE";
  if (frame.available_at_ms > asOf) return "FRAME_NOT_YET_AVAILABLE";
  if (frame.expires_at_ms <= asOf) return "FRAME_EXPIRED";
  return null;
};
/** Why one owner metric is not usable at `asOf` (value, status, availability, expiry), or null. */
export const metricReason = (metric, asOf, { partial = false } = {}) => {
  if (!metric || !finite(metric.value)) return "METRIC_VALUE_UNAVAILABLE";
  if (metric.status !== "VALID" && !(partial && metric.status === "PARTIAL")) return "METRIC_NOT_VALID";
  if (!finite(metric.available) || !finite(metric.expires)) return "METRIC_TIMING_UNAVAILABLE";
  if (metric.available > asOf) return "METRIC_NOT_YET_AVAILABLE";
  if (metric.expires <= asOf) return "METRIC_EXPIRED";
  return null;
};
const resultBase = (frame, request, label, definition = null, valid = 0, expected = 0) => ({
  request,
  label,
  definition,
  snapshotId: typeof frame?.snapshot_id === "string" ? frame.snapshot_id : null,
  cutoff: finite(frame?.cutoff_ms) ? frame.cutoff_ms : null,
  status: "unavailable",
  reasons: [],
  instrumentIds: [],
  valid,
  expected,
});
const unavailable = (result, ...reasons) => {
  result.status = "unavailable";
  result.reasons = [...new Set([...result.reasons, ...reasons.filter(Boolean)])];
  result.instrumentIds = [];
  return result;
};
const available = (result, ids) => {
  result.status = "available";
  result.instrumentIds = ids;
  return result;
};
const definitionMismatch = (result, expectedDefinition) => expectedDefinition !== undefined &&
  expectedDefinition !== result.definition;

function breadthSelection(frame, request, asOf, expectedDefinition, result) {
  const breadth = frame?.breadth?.[request.horizon];
  const metricKey = { advancing: "positive", declining: "negative", unchanged: "flat" }[request.side];
  const metric = breadth?.[metricKey];
  result.definition = metric?.definition ?? null;
  result.valid = Number.isInteger(breadth?.valid) ? breadth.valid : 0;
  result.expected = Number.isInteger(breadth?.expected) ? breadth.expected : 0;
  const currentFrameIssue = frameReason(frame, asOf);
  if (currentFrameIssue) return unavailable(result, currentFrameIssue);
  if (!HORIZONS.has(request.horizon) || !metricKey) return unavailable(result, "INVALID_BREADTH_REQUEST");
  if (!breadth || !Number.isInteger(breadth.valid) || !Number.isInteger(breadth.expected) ||
      breadth.valid < 0 || breadth.expected < breadth.valid || breadth.expected !== frame.expected ||
      frame.assets?.length !== breadth.expected)
    return unavailable(result, "BREADTH_POPULATION_UNAVAILABLE");
  if (!metricUsable(metric)) return unavailable(result, "BREADTH_AGGREGATE_UNAVAILABLE");
  const reason = metricReason(metric, asOf, { partial: true });
  if (reason) return unavailable(result, reason);
  if (metric.valid !== breadth.valid || metric.expected !== breadth.expected)
    return unavailable(result, "BREADTH_AGGREGATE_COVERAGE_MISMATCH");
  const candidates = [];
  const counts = { advancing: 0, declining: 0, unchanged: 0 };
  const contributorDefinitions = new Set();
  for (const asset of frame.assets) {
    const cell = asset?.returns?.[request.horizon];
    const cellIssue = metricReason(cell, asOf);
    if (cellIssue) continue;
    if (typeof cell.definition !== "string" || !cell.definition)
      return unavailable(result, "BREADTH_CONTRIBUTOR_DEFINITION_UNAVAILABLE");
    contributorDefinitions.add(cell.definition);
    counts[cell.value > 0 ? "advancing" : cell.value < 0 ? "declining" : "unchanged"] += 1;
    if ((request.side === "advancing" && cell.value > 0) ||
        (request.side === "declining" && cell.value < 0) ||
        (request.side === "unchanged" && cell.value === 0)) candidates.push(asset.instrument_id);
  }
  const aggregateCounts = {
    advancing: breadth.advancing,
    declining: breadth.declining,
    unchanged: breadth.unchanged,
  };
  if (Object.values(aggregateCounts).some(value => !Number.isInteger(value) || value < 0) ||
      Object.keys(counts).some(key => counts[key] !== aggregateCounts[key]) ||
      Object.values(counts).reduce((sum, value) => sum + value, 0) !== breadth.valid ||
      Math.round(metric.value * breadth.valid) !== aggregateCounts[request.side] ||
      contributorDefinitions.size !== 1)
    return unavailable(result, "BREADTH_CONTRIBUTORS_UNRECONCILED");
  result.definition = `${metric.definition}; ${[...contributorDefinitions][0]}`;
  if (definitionMismatch(result, expectedDefinition)) return unavailable(result, "DEFINITION_MISMATCH");
  return available(result, candidates);
}

function predicateSelection(frame, request, asOf, expectedDefinition, result) {
  const aggregate = frame?.participation?.[request.key];
  result.definition = aggregate?.definition ?? null;
  result.valid = Number.isInteger(aggregate?.valid) ? aggregate.valid : 0;
  result.expected = Number.isInteger(aggregate?.expected) ? aggregate.expected : 0;
  const currentFrameIssue = frameReason(frame, asOf);
  if (currentFrameIssue) return unavailable(result, currentFrameIssue);
  if (!PREDICATE_KEYS.has(request.key)) return unavailable(result, "INVALID_PREDICATE_REQUEST");
  if (!aggregate || !Number.isInteger(aggregate.valid) || !Number.isInteger(aggregate.expected) ||
      aggregate.valid < 0 || aggregate.expected < aggregate.valid || aggregate.expected !== frame.expected ||
      frame.assets?.length !== aggregate.expected)
    return unavailable(result, "PREDICATE_POPULATION_UNAVAILABLE");
  if (!metricUsable(aggregate)) return unavailable(result, "PREDICATE_AGGREGATE_UNAVAILABLE");
  const reason = metricReason(aggregate, asOf, { partial: true });
  if (reason) return unavailable(result, reason);
  if (definitionMismatch(result, expectedDefinition)) return unavailable(result, "DEFINITION_MISMATCH");

  const candidates = [];
  let valid = 0;
  let positive = 0;
  for (const asset of frame.assets) {
    const cell = asset?.predicates?.[request.key];
    if (metricReason(cell, asOf)) continue;
    if (cell.definition !== aggregate.definition)
      return unavailable(result, "PREDICATE_CONTRIBUTOR_DEFINITION_MISMATCH");
    if (cell.value !== 0 && cell.value !== 1) return unavailable(result, "PREDICATE_VALUE_INVALID");
    valid += 1;
    if (cell.value === 1) {
      positive += 1;
      candidates.push(asset.instrument_id);
    }
  }
  result.valid = valid;
  if (valid !== aggregate.valid || Math.round(aggregate.value * aggregate.valid) !== positive)
    return unavailable(result, "PREDICATE_CONTRIBUTORS_UNRECONCILED");
  return available(result, candidates);
}

function dailySelection(frame, request, asOf, expectedDefinition, result) {
  const isAbove = request.kind === "daily-above";
  const label = isAbove ? `Daily close above SMA ${request.period}` : `Daily ${request.key.replaceAll("_", " ")}`;
  result.label = label;
  const definitionId = isAbove ? `daily_sma_${request.period}_above_close` : ({
    high_break: "daily_high_break_20d",
    low_break: "daily_low_break_20d",
    close_break_high: "daily_close_break_high_20d",
    close_break_low: "daily_close_break_low_20d",
  })[request.key];
  result.definition = definitionId ?? null;
  result.expected = Number.isInteger(frame?.expected) ? frame.expected : 0;
  const currentFrameIssue = frameReason(frame, asOf);
  if (currentFrameIssue) return unavailable(result, currentFrameIssue);
  if ((isAbove && !DAILY_PERIODS.has(request.period)) || (!isAbove && !BREAK_KEYS.has(request.key)))
    return unavailable(result, "INVALID_DAILY_REQUEST");
  if (definitionMismatch(result, expectedDefinition)) return unavailable(result, "DEFINITION_MISMATCH");
  if (!Number.isInteger(frame.expected) || frame.expected < 1 || !Array.isArray(frame.assets) ||
      frame.assets.length !== frame.expected || !Array.isArray(frame.dailyInternals) ||
      frame.dailyInternals.length > frame.expected)
    return unavailable(result, "DAILY_POPULATION_UNAVAILABLE");

  const memberIds = new Set();
  for (const asset of frame.assets) {
    if (typeof asset?.instrument_id !== "string" || !asset.instrument_id)
      return unavailable(result, "DAILY_FRAME_INSTRUMENT_ID_INVALID");
    if (memberIds.has(asset.instrument_id)) return unavailable(result, "DAILY_FRAME_DUPLICATE_INSTRUMENT_ID");
    memberIds.add(asset.instrument_id);
  }

  const rows = new Map();
  for (const row of frame.dailyInternals) {
    if (typeof row?.instrumentId !== "string" || !row.instrumentId || !memberIds.has(row.instrumentId))
      return unavailable(result, "DAILY_UNKNOWN_INSTRUMENT_ID");
    if (rows.has(row.instrumentId)) return unavailable(result, "DAILY_DUPLICATE_INSTRUMENT_ID");
    rows.set(row.instrumentId, row);
  }
  if (rows.size < memberIds.size) result.reasons.push("DAILY_ROWS_MISSING");

  const candidates = [];
  let valid = 0;
  for (const row of rows.values()) {
    const source = row?.source;
    const cell = isAbove ? row?.averages?.[request.period]?.above_close : row?.breaks?.[request.key];
    if (row.frameCutoff !== frame.cutoff_ms || !finite(row.cutoff) || row.cutoff > row.frameCutoff ||
        (source && (!finite(source.cutoff) || source.cutoff !== row.cutoff || source.cutoff > frame.cutoff_ms)))
      return unavailable(result, "DAILY_FRAME_CUTOFF_MISMATCH");
    if (cell && (cell.metricId !== definitionId || cell.definitionId !== definitionId ||
        cell.metric?.definition !== definitionId))
      return unavailable(result, "DAILY_DEFINITION_MISMATCH");
    if (cell?.metric?.value != null && cell.metric.value !== 0 && cell.metric.value !== 1)
      return unavailable(result, "DAILY_BINARY_VALUE_INVALID");

    if (!source || !finite(row.decisionAvailable) || !finite(source.available) || !finite(source.expires)) {
      result.reasons.push("DAILY_SOURCE_TIMING_UNAVAILABLE");
      continue;
    }
    if (row.decisionAvailable !== frame.available_at_ms)
      return unavailable(result, "DAILY_DECISION_TIME_MISMATCH");
    if (source.expires <= source.available)
      return unavailable(result, "DAILY_SOURCE_EXPIRY_MISMATCH");
    if (row.decisionAvailable > asOf || source.available > asOf) {
      result.reasons.push("DAILY_SOURCE_NOT_YET_AVAILABLE");
      continue;
    }
    if (source.available > row.decisionAvailable) {
      result.reasons.push("DAILY_SOURCE_AFTER_DECISION");
      continue;
    }
    if (source.cutoff > row.decisionAvailable || row.cutoff > row.decisionAvailable) {
      result.reasons.push("DAILY_SOURCE_NOT_YET_AVAILABLE");
      continue;
    }
    if (source.expires <= asOf) {
      result.reasons.push("DAILY_SOURCE_EXPIRED");
      continue;
    }
    if (!cell || !cell.metric || cell.metric.status !== "VALID" || !finite(cell.metric.value)) {
      result.reasons.push("DAILY_METRIC_UNAVAILABLE");
      continue;
    }
    if (!Number.isInteger(cell.samples) || !Number.isInteger(cell.required) ||
        cell.metric.valid !== cell.samples || cell.metric.expected !== cell.required)
      return unavailable(result, "DAILY_SAMPLE_COVERAGE_MISMATCH");
    if (cell.samples < cell.required) {
      result.reasons.push("DAILY_INSUFFICIENT_SAMPLES");
      continue;
    }
    if (cell.metric.value !== 0 && cell.metric.value !== 1)
      return unavailable(result, "DAILY_BINARY_VALUE_INVALID");
    valid += 1;
    if (cell.metric.value === 1) candidates.push(row.instrumentId);
  }
  result.valid = valid;
  if (valid === 0) return unavailable(result, "NO_QUALIFIED_DAILY_METRICS");
  if (valid < result.expected) result.reasons.push("DAILY_PARTIAL_COVERAGE");
  return available(result, candidates);
}

/** Select a display-only cohort from fresh, owner-computed frame observations. */
export function selectMetricCohort(frame, request, asOf, expectedDefinition) {
  const label = request?.kind === "breadth"
    ? `${request.horizon}m ${request.side}`
    : request?.kind === "predicate"
      ? String(request.key ?? "predicate")
      : request?.kind === "daily-above"
        ? `Daily close above SMA ${request.period}`
        : request?.kind === "daily-break"
          ? `Daily ${String(request.key ?? "break").replaceAll("_", " ")}`
          : "Metric cohort";
  const result = resultBase(frame, request, label);
  if (!request || typeof request !== "object") return unavailable(result, "INVALID_REQUEST");
  if (request.kind === "breadth") return breadthSelection(frame, request, asOf, expectedDefinition, result);
  if (request.kind === "predicate") return predicateSelection(frame, request, asOf, expectedDefinition, result);
  if (request.kind === "daily-above" || request.kind === "daily-break")
    return dailySelection(frame, request, asOf, expectedDefinition, result);
  return unavailable(result, "INVALID_REQUEST");
}
