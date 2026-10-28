const MAX_AGE_MS = 15 * 60 * 1000;

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function timestamp(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8.64e15)
    return value;
  if (typeof value === "string" && value.length <= 64) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function finite(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length <= 32 && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asEntries(value) {
  if (Array.isArray(value))
    return value.slice(0, 32).map((item, index) => [String(index), item]);
  if (record(value) === value)
    return Object.entries(value).slice(0, 32);
  return [];
}

function featureValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length <= 48) return value;
  return null;
}

function adviceRecord(value) {
  const root = record(value);
  for (const key of ["record", "advice", "latest", "assessment"]) {
    if (record(root[key]) === root[key]) return root[key];
  }
  return root;
}

function projectHistory(value) {
  const root = record(value);
  const rows = Array.isArray(root.records) ? root.records : Array.isArray(root.items) ? root.items : Array.isArray(root.assessments) ? root.assessments : Array.isArray(value) ? value : [];
  return rows.slice(0, 10).map((raw) => {
    const item = record(raw);
    const result = record(item.result);
    const advice = record(result.advice);
    return {
      assessment: typeof advice.assessment === "string" && advice.assessment.length <= 32 ? advice.assessment : "Unavailable",
      availableAtMs: timestamp(result.received_at_ms ?? item.available_at_ms ?? item.received_at_ms ?? item.created_at),
    };
  });
}

export function projectV5Advisory(payload, nowMs = Date.now()) {
  const root = record(payload);
  const context = record(root["v1/context"]);
  const status = record(root["v1/advice/status"]);
  const latestEnvelope = record(root["v1/advice/latest"]);
  const latestSource = adviceRecord(latestEnvelope);
  const latestResult = record(latestSource.result);
  const latest = record(latestResult.advice);
  const latestRecordStatus = typeof latestEnvelope.status === "string" ? latestEnvelope.status : latestSource.status;
  const mode = typeof status.mode === "string" ? status.mode : typeof latestResult.mode === "string" ? latestResult.mode : "UNAVAILABLE";
  const contextAvailableAtMs = timestamp(context.available_at_ms ?? context.available_at ?? context.cutoff_ms ?? context.timestamp);
  const latestAvailableAtMs = timestamp(latestResult.received_at_ms ?? latest.available_at_ms ?? latest.received_at_ms ?? latest.created_at);
  const expiresAtMs = timestamp(latestResult.expires_at_ms ?? latest.expires_at_ms ?? latest.expires_at);
  const inputSnapshotId = record(latestSource.input).snapshot_id;
  const snapshotMatches = typeof context.snapshot_id === "string" && context.snapshot_id.length > 0 &&
    typeof inputSnapshotId === "string" && inputSnapshotId === context.snapshot_id;
  const contextFresh = contextAvailableAtMs !== null && contextAvailableAtMs <= nowMs && nowMs - contextAvailableAtMs <= MAX_AGE_MS;
  const adviceCurrent = contextFresh && latestRecordStatus === "CURRENT_REPORT" && latestResult.status === "ACCEPTED" &&
    latestAvailableAtMs !== null && latestAvailableAtMs <= nowMs &&
    (expiresAtMs === null || nowMs < expiresAtMs) && nowMs - latestAvailableAtMs <= MAX_AGE_MS && snapshotMatches;
  const featureEntries = asEntries(context.features);
  const features = featureEntries.filter(([id]) => !String(id).startsWith("quality.")).slice(0, 8).map(([id, raw]) => {
    const feature = record(raw);
    const value = featureValue(feature.value);
    const qualified = feature.status === "QUALIFIED" && value !== null;
    return {
      id: String(id).slice(0, 80),
      value: contextFresh && qualified ? value : null,
      unit: typeof feature.unit === "string" ? feature.unit.slice(0, 24) : "",
      status: !contextFresh ? (contextAvailableAtMs === null ? "UNAVAILABLE" : "STALE") :
        typeof feature.status === "string" ? feature.status.slice(0, 32) : "UNAVAILABLE",
    };
  });
  const quality = featureEntries.filter(([id]) => String(id).startsWith("quality.")).slice(0, 8).map(([id, raw]) => {
    const item = record(raw);
    const value = item.status === "QUALIFIED" ? featureValue(item.value) : null;
    return { id: String(id).slice(0, 80), value: value === null ? null : String(value).slice(0, 48) };
  });
  const rawReasons = latest.reason_codes ?? latest.reasons;
  const reasons = Array.isArray(rawReasons)
    ? rawReasons.filter((item) => typeof item === "string").slice(0, 8).map((item) => item.slice(0, 64))
    : [];
  const rawAssessment = latest.assessment;
  const rawSummary = latest.summary;
  return {
    freshness: !contextFresh ? contextAvailableAtMs === null ? "UNAVAILABLE" : "STALE" :
      latestRecordStatus === "HISTORICAL_REPORT" ? "HISTORICAL" : adviceCurrent ? "CURRENT" : latestAvailableAtMs === null ? "NO ASSESSMENT" : "STALE",
    mode,
    enabled: typeof status.enabled === "boolean" ? status.enabled : null,
    model: typeof status.model === "string" && status.model.length <= 96 ? status.model : null,
    nativeV5Parity: typeof status.native_v5_parity === "string" ? status.native_v5_parity.slice(0, 32) : "UNAVAILABLE",
    journalStatus: typeof status.journal_status === "string" ? status.journal_status.slice(0, 32) : "UNAVAILABLE",
    assessment: adviceCurrent && typeof rawAssessment === "string" && rawAssessment.length <= 32 ? rawAssessment : null,
    summary: adviceCurrent && typeof rawSummary === "string" && rawSummary.length <= 500 ? rawSummary : null,
    availableAtMs: contextAvailableAtMs,
    expiresAtMs,
    features,
    quality,
    reasons: adviceCurrent ? reasons : [],
    spentUsd: finite(status.spent_usd),
    reservedUsd: finite(status.reserved_usd),
    callsToday: Number.isInteger(status.calls_today) && status.calls_today >= 0 ? status.calls_today : null,
    history: projectHistory(root["v1/advice/history"]),
  };
}
