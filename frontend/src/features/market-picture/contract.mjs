/** Wire validation and lossless display projection. Calculations remain in the owner. */
const HASH = /^[0-9a-f]{64}$/;
const DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const HORIZONS = [1, 5, 15, 60, 240, 1440];
const RELATIVE_RETURN_DEFINITION_HASH = "54936e39a1c8ba50b1226d16efd45aa683165fe82a958e9b577f2856849f3259";
const COMMON_ASSET_UNITS = {
  price: "price_quote", ema21: "price_quote", rsi14: "rsi_0_100", adx14: "adx_0_100",
  atr14_percent: "atr_percent", atr14_percentile: "percentile_0_100", rvol20: "ratio",
  realized_volatility_24h: "volatility_fraction_annualized",
  ...Object.fromEntries([...HORIZONS, 10080].map(h => [`return_${h}m`, "return_percent"])),
  ...Object.fromEntries(["btc", "eth", "bnb", "sol"].map(b => [`relative_24h_${b}`, "percentage_points"])),
};
// Frames stored before the hourly definition carry the single-minute `rvol_24h` keys. They stay
// readable (immutable history); a frame belongs to exactly one generation and never mixes the two.
export const RVOL_GENERATIONS = {
  current: {
    asset: "rvol_1h", series: "asset_rvol_1h", assetDefinition: "rvol1h",
    summary: "relative_volume_1h", summaryDefinition: "median_relative_volume_1h",
  },
  legacy: {
    asset: "rvol_24h", series: "asset_rvol_24h", assetDefinition: "rvol24h",
    summary: "relative_volume_24h", summaryDefinition: "median_relative_volume_24h",
  },
};
function rvolGeneration(frame) {
  const refs = object(frame.asset_metric_refs);
  const present = Object.values(RVOL_GENERATIONS).filter(g => Object.hasOwn(refs, g.asset));
  require(present.length === 1, "Invalid semantic binding keys");
  return present[0];
}
/** Hourly owner correlation windows (hours) and their definition ids; 90D keeps its original id. */
export const CORRELATION_WINDOW_HOURS = [24, 72, 168, 336, 720, 2160];
export const correlationDefinitionId = hours => {
  require(CORRELATION_WINDOW_HOURS.includes(hours), "Correlation sample window is invalid");
  return hours === 2160 ? "pearson_log_1h_90d" : `pearson_log_1h_${hours}h`;
};
const PREDICATES = ["above_ema21", "compression", "elevated_rvol", "high_volatility", "rsi_above_50", "rsi_above_70", "rsi_below_30", "trending"];
const COMMON_SUMMARY_BINDINGS = {
  market_participation: ["market_participation", "share_fraction", "above_ema21"],
  trend_strength: ["trend_strength", "adx_0_100", "mean_adx14"],
  realized_volatility_24h: ["realized_volatility_24h", "volatility_fraction_annualized", "median_realized_volatility_24h"],
  new_highs_24h: ["new_highs_24h", "instruments", "market_high_break_count_24h"],
  new_lows_24h: ["new_lows_24h", "instruments", "market_low_break_count_24h"],
  highs_52w: ["highs_52w", "instruments", "market_high_break_count_52w"],
  lows_52w: ["lows_52w", "instruments", "market_low_break_count_52w"],
  coverage: ["coverage", "share_fraction", "instrument_coverage"],
  above_ema21: ["participation_above_ema21", "share_fraction", "above_ema21_membership"],
};
const BREADTH_BINDINGS = {
  advances: ["instruments", "breadth_instrument_count"],
  declines: ["instruments", "breadth_instrument_count"],
  unchanged: ["instruments", "breadth_instrument_count"],
  advance_share: ["share_fraction", "breadth_share"],
  decline_share: ["share_fraction", "breadth_share"],
  unchanged_share: ["share_fraction", "breadth_share"],
  mean_return: ["return_percent", "breadth_return_mean"],
  median_return: ["return_percent", "breadth_return_median"],
  dispersion: ["percentage_points", "breadth_return_dispersion"],
  downside_magnitude: ["return_percent", "breadth_downside_magnitude"],
};
const PARTICIPATION_DEFINITIONS = {
  above_ema21: "above_ema21_membership",
  compression: "atr14_compression_p20_membership",
  elevated_rvol: "rvol20_above_1_5_membership",
  high_volatility: "rv24h_above_80pct_membership",
  rsi_above_50: "rsi_above_50_membership",
  rsi_above_70: "rsi_above_70_membership",
  rsi_below_30: "rsi_below_30_membership",
  trending: "adx14_above_25_membership",
};
const UNIT_BOUNDS = {
  share_fraction: [0, 1],
  rsi_0_100: [0, 100],
  adx_0_100: [0, 100],
  percentile_0_100: [0, 100],
  correlation_minus1_to1: [-1, 1],
  index_minus3_to3: [-3, 3],
  index_minus1_to1: [-1, 1],
};
const STATUSES = ["VALID", "WARMING", "MISSING", "INVALID", "UNAVAILABLE"];
const FRAME_KEYS = [
  "schema_version",
  "encoding",
  "feature_set_version",
  "snapshot_id",
  "stream_id",
  "epoch",
  "sequence",
  "revision",
  "cutoff_ms",
  "cutoff_policy_id",
  "available_at_ms",
  "published_at_ms",
  "expires_at_ms",
  "source_kind",
  "fixture_marker",
  "universe",
  "providers",
  "definition_registry_hash",
  "coverage",
  "metric_series",
  "market_metrics",
  "breadth",
  "summary",
  "assets",
  "asset_metric_refs",
  "asset_predicate_refs",
  "regime_observations",
  "distribution",
  "participation",
  "pressure",
  "relationship_ref",
  "flow_ref",
  "event_cursor",
  "canonical_context_ref",
  "comparisons",
  "normalized_breadth",
  "breadth_trajectory",
  "breadth_divergence",
  "contribution_summaries",
  "source_capabilities",
  "microstructure",
  "microstructure_ref",
  "daily_internals",
  "hourly_internals",
  "candle_anomalies",
  "relative_strength_changes",
  "payload_digest",
];

function require(condition, message = "Invalid Market Picture contract") {
  if (!condition) throw new Error(message);
}
function object(value) {
  require(value !== null && typeof value === "object" && !Array.isArray(value));
  return value;
}
function array(value, max = 500) {
  require(Array.isArray(value) && value.length <= max);
  return value;
}
function integer(value, min = 0) {
  require(Number.isSafeInteger(value) && value >= min);
  return value;
}
function text(value, max = 256) {
  require(typeof value === "string" && value.length <= max);
  return value;
}
export function decimal(value) {
  require(typeof value === "string" &&
    value.length <= 128 &&
    DECIMAL.test(value) &&
    Number.isFinite(Number(value)), "Invalid decimal observation");
  return Number(value);
}
function reconciles(actual, expected) {
  return Math.abs(actual - expected) <= Math.max(Math.abs(actual), Math.abs(expected)) * 1e-12;
}
function unique(values) {
  return values.length === new Set(values).size;
}
// The owner serves compact frames (pydantic exclude_none/exclude_defaults): fields equal to their
// schema default are absent on the wire. Read them through the owner defaults, never as missing.
const RELATIVE_STRENGTH_CHANGE_DEFAULTS = Object.freeze({
  baseline_snapshot_id: null, baseline_cutoff_ms: null, interval_ms: 3_600_000,
  definition_id: "relative_return", source_hash: null, cohort_hash: null, reason_codes: [],
});
const CANDLE_ANOMALY_METRIC_DEFAULTS = Object.freeze({ high_count: null, share_fraction: null, reason_codes: [] });
function relativeStrengthChanges(value) {
  return { ...RELATIVE_STRENGTH_CHANGE_DEFAULTS, ...object(value) };
}
function exactKeys(value, keys, optional = []) {
  const actual = Object.keys(object(value));
  const required = keys.filter(key => !optional.includes(key));
  require(actual.every(key => keys.includes(key)) && required.every(key => actual.includes(key)), "Invalid semantic binding keys");
}
function timing(metric, provider, series = metric) {
  const available = metric.available_at_ms ?? series.available_at_ms;
  const expires = metric.expires_at_ms ?? series.expires_at_ms;
  const end = metric.window_end_ms ?? series.window_end_ms;
  integer(available); integer(expires);
  require(available >= provider.available_at_ms && available < expires &&
    expires <= provider.expires_at_ms && expires <= series.expires_at_ms &&
    (end == null || end <= available), "Metric effective timing exceeds its source");
}
function safeNumbers(value, depth = 0) {
  require(depth <= 32);
  if (typeof value === "number")
    require(Number.isSafeInteger(value), "JSON decimals must use strings");
  else if (value && typeof value === "object")
    Object.values(value).forEach((v) => safeNumbers(v, depth + 1));
}
export function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => canonical(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  const encoded = JSON.stringify(value);
  require(encoded !== undefined);
  return encoded.replace(
    /[\u007f-\uffff]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}
export async function digest(value) {
  const bytes = new TextEncoder().encode(canonical(value));
  return Array.from(
    new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
function without(value, ...keys) {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key)),
  );
}
function compactSeries(value) {
  if (Array.isArray(value)) return value.map(compactSeries);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key, child]) =>
            child !== null && !(key === "fixture_only" && child === false),
        )
        .map(([key, child]) => [key, compactSeries(child)]),
    );
  return value;
}
export async function seriesDigest(series) {
  const compact = compactSeries(without(series, "payload_digest"));
  if (Array.isArray(compact.cells))
    compact.cells = compact.cells.map((cell) => {
      const normalized = { ...cell };
      if (normalized.computation_status === "VALID") delete normalized.computation_status;
      if (normalized.coverage_status === "COMPLETE") delete normalized.coverage_status;
      if (Array.isArray(normalized.reason_codes) && normalized.reason_codes.length === 0)
        delete normalized.reason_codes;
      return normalized;
    });
  return digest(compact);
}

export function validateMetric(metric, inheritedUnit) {
  object(metric);
  require(
    STATUSES.includes(metric.computation_status) &&
      ["COMPLETE", "PARTIAL"].includes(metric.coverage_status),
  );
  const reasons = array(metric.reason_codes, 32);
  require(
    unique(reasons) &&
      reasons.every((r) => typeof r === "string" && /^[A-Z_]+$/.test(r)),
  );
  const value = metric.value ?? null;
  require((metric.computation_status === "VALID") === (value !== null));
  require(value !== null || reasons.length > 0);
  const number = value === null ? null : decimal(value),
    unit = metric.unit ?? inheritedUnit;
  text(unit, 64);
  if (number !== null && ["count", "instruments"].includes(unit))
    require(Number.isSafeInteger(number) && !/[1-9]/.test(value.split(".")[1] ?? ""), "Fractional count observation");
  if (number !== null && UNIT_BOUNDS[unit])
    require(number >= UNIT_BOUNDS[unit][0] && number <= UNIT_BOUNDS[unit][1]);
  if (number !== null && ["price_quote", "volume_quote", "quote_volume", "ratio", "volatility_fraction_annualized", "instruments", "count", "milliseconds", "atr_percent"].includes(unit))
    require(number >= 0);
  integer(metric.sample_count);
  if (metric.required_samples != null) integer(metric.required_samples);
  if (metric.numerator != null) {
    integer(metric.numerator);
    integer(metric.denominator);
    require(metric.numerator <= metric.denominator);
  }
  if (metric.denominator != null && metric.expected_denominator != null)
    require(metric.denominator <= metric.expected_denominator);
  return number;
}

export function resolveSeries(series) {
  object(series);
  require(series.encoding === "metric-series.v1");
  const cells = array(series.cells),
    ids = cells.map((c) => text(c.instrument_id, 128));
  require(unique(ids) && ids.join("|") === [...ids].sort().join("|"));
  require(series.series_unit === series.definition_ref.unit);
  require(cells.length === series.expected_denominator);
  timing(series, series.provider_ref);
  return Object.fromEntries(
    cells.map((cell) => {
      const quality = { computation_status: "VALID", coverage_status: "COMPLETE", reason_codes: [], ...cell };
      validateMetric(quality, series.series_unit);
      timing(cell, series.provider_ref, series);
      const metric = {
        metric_id: series.metric_id,
        value: cell.value ?? null,
        unit: series.series_unit,
        computation_status: quality.computation_status,
        coverage_status: quality.coverage_status,
        reason_codes: quality.reason_codes,
        definition: series.definition_ref,
        source_ref: series.provider_ref,
        horizon_minutes: series.horizon_minutes,
        window_start_ms: cell.window_start_ms ?? series.window_start_ms ?? null,
        window_end_ms: cell.window_end_ms ?? series.window_end_ms ?? null,
        observation_interval_ms:
          cell.observation_interval_ms ??
          series.observation_interval_ms ??
          null,
        available_at_ms: cell.available_at_ms ?? series.available_at_ms,
        expires_at_ms: cell.expires_at_ms ?? series.expires_at_ms,
        sample_count: cell.sample_count,
        required_samples: cell.required_samples ?? series.required_samples,
        numerator: cell.numerator ?? null,
        denominator: cell.denominator ?? null,
        expected_denominator:
          cell.expected_denominator ?? series.expected_denominator,
      };
      require(metric.available_at_ms < metric.expires_at_ms);
      require(
        metric.window_start_ms == null ||
          metric.window_end_ms == null ||
          metric.window_start_ms <= metric.window_end_ms,
      );
      return [cell.instrument_id, metric];
    }),
  );
}

async function validateMicrostructureData(frame) {
  if (frame.source_capabilities !== undefined) {
    const rows = array(frame.source_capabilities, 16);
    const families = ["candles", "spot_flow", "spot_liquidity", "derivatives", "liquidations", "options", "external_context", "private_exposure", "conditional_outcomes"];
    const qualifications = ["not_probed", "probed", "collecting", "not_qualified", "qualified"];
    const operational = ["healthy", "unsupported_region", "permission_required", "disabled", "rate_limited", "degraded", "unavailable"];
    const identity = /^[a-z0-9][a-z0-9_.:-]{0,127}$/;
    const orderedIds = rows.map(row => row.source_id);
    require(unique(orderedIds) && orderedIds.join("|") === [...orderedIds].sort().join("|"), "Source capabilities must be sorted and unique");
    for (const row of rows) {
      require(identity.test(row.source_id) && identity.test(row.venue_profile) && families.includes(row.family), "Invalid source capability identity");
      require(typeof row.endpoint === "string" && row.endpoint.length > 0 && row.endpoint.length <= 256 && !/^https?:/i.test(row.endpoint) && !/[?#@\n]/.test(row.endpoint), "Invalid source capability endpoint");
      require(qualifications.includes(row.qualification) && operational.includes(row.operational), "Invalid source capability state");
      require(HASH.test(row.source_contract_hash) && Array.isArray(row.instrument_ids) && row.instrument_ids.length <= 300 && row.instrument_ids.join("|") === [...row.instrument_ids].sort().join("|") && unique(row.instrument_ids), "Invalid source capability scope");
      require(Array.isArray(row.units) && row.units.length >= 1 && row.units.length <= 32 && row.units.every(unit => identity.test(unit)) && row.units.join("|") === [...row.units].sort().join("|") && unique(row.units), "Invalid source capability units");
      require(typeof row.history_semantics === "string" && row.history_semantics.length > 0 && row.history_semantics.length <= 256 && ["anonymous", "separately_authorized_private"].includes(row.access), "Invalid source capability provenance");
      require(row.access === "anonymous" && row.family !== "private_exposure", "Private source metadata cannot enter the public market frame");
      integer(row.cadence_ms, 1); integer(row.max_records, 1);
      require(row.cadence_ms <= 604800000 && row.max_records <= 100000 && typeof row.license_basis === "string" && row.license_basis.length > 0 && row.license_basis.length <= 256, "Invalid source capability bounds");
      require((row.probe_receipt_hash == null) === (row.probed_at_ms == null) && (row.probe_receipt_hash == null || HASH.test(row.probe_receipt_hash)) && (row.probed_at_ms == null || (Number.isSafeInteger(row.probed_at_ms) && row.probed_at_ms >= 0)), "Invalid probe receipt");
      for (const key of ["collection_receipt_hash", "qualification_receipt_hash", "qualification_contract_hash"])
        require(row[key] == null || HASH.test(row[key]), "Invalid capability receipt");
      require(((row.collection_receipt_hash ?? null) == null) === ((row.collected_at_ms ?? null) == null) && ((row.qualification_receipt_hash ?? null) == null) === ((row.qualified_at_ms ?? null) == null), "Capability receipt time is missing");
      for (const key of ["probed_at_ms", "collected_at_ms", "qualified_at_ms"])
        require(row[key] == null || (Number.isSafeInteger(row[key]) && row[key] >= 0 && row[key] <= frame.available_at_ms), "Capability receipt occurs after bundle decision time");
      require(row.collected_at_ms == null || row.probed_at_ms == null || row.collected_at_ms >= row.probed_at_ms, "Collection receipt predates probe");
      require(row.qualified_at_ms == null || row.collected_at_ms == null || row.qualified_at_ms >= row.collected_at_ms, "Qualification receipt predates collection");
      const reasons = row.reasons ?? []; // schema default
      require(Array.isArray(reasons) && reasons.length <= 32 && reasons.every(reason => /^[A-Z][A-Z0-9_]{0,63}$/.test(reason)) && reasons.join("|") === [...reasons].sort().join("|") && unique(reasons), "Invalid capability reasons");
      require(row.qualification !== "not_probed" || (row.probe_receipt_hash == null && row.operational !== "healthy"), "Unprobed capability cannot claim a healthy probe");
      require(row.qualification === "not_probed" || row.qualification === "not_qualified" || row.probe_receipt_hash != null, "Capability qualification lacks probe receipt");
      require(!["collecting", "qualified"].includes(row.qualification) || (row.collection_receipt_hash != null && row.collected_at_ms != null), "Collection capability lacks receipt");
      require(row.qualification !== "qualified" || (row.qualification_receipt_hash != null && row.qualified_at_ms != null && row.qualification_contract_hash === row.source_contract_hash), "Qualified capability lacks contract-bound receipt");
      require(row.qualification !== "not_qualified" || reasons.length > 0, "Unqualified capability needs evidence limits");
    }
  }
  if (frame.microstructure != null) {
    const component = object(frame.microstructure);
    require(component.schema_version === "market-picture.microstructure.v1" &&
      HASH.test(component.component_id) && component.source_kind === frame.source_kind &&
      component.cutoff_ms === frame.cutoff_ms && component.available_at_ms <= frame.available_at_ms &&
      component.replay_class === "snapshot_only" && component.raw_inputs_retained === false,
    "Invalid microstructure component provenance");
    const flows = array(component.flows, 300), books = array(component.liquidity, 1200);
    const capById = new Map((frame.source_capabilities ?? []).map(row => [row.source_id, row]));
    const members = new Set(frame.universe.member_instrument_ids);
    const memberQuotes = new Map(frame.assets.map(asset => [asset.instrument_id, asset.quote_asset_id]));
    const flowKeys = flows.map(row => `${row.instrument_id}|${row.source_id}`);
    require(unique(flowKeys) && flowKeys.join("\n") === [...flowKeys].sort().join("\n"), "Flow rows must be sorted and unique");
    const flowWindowsByInstrument = new Map();
    for (const row of flows) {
      const cap = capById.get(row.source_id);
      require(memberQuotes.get(row.instrument_id) === frame.universe.selected_numeraire, "Microstructure instrument quote differs from the selected numeraire");
      for (const key of ["window_start_ms", "window_end_ms", "available_at_ms", "expires_at_ms"]) integer(row[key]);
      require(members.has(row.instrument_id) && cap?.family === "spot_flow" &&
        cap.source_contract_hash === row.source_contract_hash && cap.qualification === "qualified" && cap.operational === "healthy" && cap.access === "anonymous" && cap.instrument_ids.includes(row.instrument_id) &&
        row.quote_asset === frame.universe.selected_numeraire &&
        row.window_end_ms === component.cutoff_ms && row.window_end_ms - row.window_start_ms === 60_000 &&
        row.window_end_ms % 60_000 === 0 && row.available_at_ms >= row.window_end_ms &&
        row.available_at_ms <= component.available_at_ms && row.available_at_ms <= frame.available_at_ms &&
        row.expires_at_ms > row.available_at_ms && typeof row.complete === "boolean" &&
        Number.isSafeInteger(row.trade_records) && row.trade_records >= 0 &&
        Number.isSafeInteger(row.duplicate_records) && row.duplicate_records >= 0 &&
        Array.isArray(row.reason_codes) && row.reason_codes.length <= 16,
      "Invalid executed-flow identity or decision-time bounds");
      require(HASH.test(row.input_digest) && typeof row.reset_id === "string" && row.reset_id.length > 0 && row.reset_id.length <= 128,
        "Invalid executed-flow input or reset identity");
      const windows = flowWindowsByInstrument.get(row.instrument_id) ?? [];
      require(windows.every(([start, end]) => row.window_start_ms >= end || start >= row.window_end_ms), "Flow source windows overlap for one instrument");
      windows.push([row.window_start_ms, row.window_end_ms]);
      flowWindowsByInstrument.set(row.instrument_id, windows);
      for (const key of ["reset_at_ms", "coverage_start_ms", "coverage_end_ms"]) integer(row[key]);
      require(row.reset_at_ms <= row.window_start_ms && row.coverage_start_ms <= row.coverage_end_ms && row.coverage_end_ms <= row.available_at_ms,
        "Invalid executed-flow coverage timing");
      const gaps = array(row.gap_intervals, 64);
      let previousGapEnd = row.window_start_ms - 1;
      for (const gap of gaps) {
        require(Array.isArray(gap) && gap.length === 2, "Invalid executed-flow gap interval");
        integer(gap[0]); integer(gap[1]);
        require(row.window_start_ms <= gap[0] && gap[0] < gap[1] && gap[1] <= row.window_end_ms && gap[0] > previousGapEnd,
          "Executed-flow gaps are not ordered within the window");
        previousGapEnd = gap[1];
      }
      require(row.complete === !row.reason_codes.includes("INCOMPLETE_STREAM") &&
        (!row.complete || (!gaps.length && row.coverage_start_ms <= row.window_start_ms && row.coverage_end_ms >= row.window_end_ms)),
      "Executed-flow completeness contradicts collector coverage");
      for (const key of ["buy_quote", "sell_quote", "unknown_quote"]) require(decimal(row[key]) >= 0, "Negative flow notional");
      for (const key of ["known_imbalance", "confirmation_imbalance"]) if (row[key] != null) require(Math.abs(decimal(row[key])) <= 1, "Invalid flow imbalance");
      if (row.confirmation_imbalance != null) require(row.complete && decimal(row.unknown_quote) === 0 && row.reason_codes.length === 0, "Unqualified flow cannot confirm price");
    }
    const bookKeys = books.map(row => `${row.instrument_id}|${row.source_id}|${row.side}|${row.size_unit}|${row.requested_size}`);
    require(unique(bookKeys) && bookKeys.join("\n") === [...bookKeys].sort().join("\n"), "Liquidity rows must be sorted and unique");
    for (const row of books) {
      const cap = capById.get(row.source_id);
      require(memberQuotes.get(row.instrument_id) === frame.universe.selected_numeraire, "Microstructure instrument quote differs from the selected numeraire");
      for (const key of ["observed_at_ms", "available_at_ms", "expires_at_ms"]) integer(row[key]);
      require(members.has(row.instrument_id) && cap?.family === "spot_liquidity" &&
        cap.source_contract_hash === row.source_contract_hash && cap.qualification === "qualified" && cap.operational === "healthy" && cap.access === "anonymous" && cap.instrument_ids.includes(row.instrument_id) &&
        Number.isSafeInteger(row.sequence) && row.sequence >= 0 && row.available_at_ms >= row.observed_at_ms &&
        row.available_at_ms <= component.available_at_ms && row.available_at_ms <= frame.available_at_ms &&
        row.observed_at_ms <= frame.cutoff_ms &&
        row.expires_at_ms > row.observed_at_ms && ["buy", "sell"].includes(row.side) &&
        ["base", "quote"].includes(row.size_unit) && decimal(row.requested_size) > 0 &&
        decimal(row.uncovered_size) >= 0 && decimal(row.uncovered_size) <= decimal(row.requested_size) &&
        ["non_rpi", "rpi_authorized", "unknown"].includes(row.access_basis) &&
        Array.isArray(row.reason_codes) && row.reason_codes.length <= 16,
      "Invalid displayed-liquidity identity or decision-time bounds");
      require(HASH.test(row.input_digest), "Invalid displayed-liquidity input digest");
      for (const key of ["covered_base", "covered_quote", "band_bid_covered_quote", "band_ask_covered_quote", "band_bps"])
        require(decimal(row[key]) >= 0, "Negative displayed-liquidity quantity");
      const base = decimal(row.covered_base), quote = decimal(row.covered_quote);
      const uncovered = decimal(row.uncovered_size), requested = decimal(row.requested_size);
      const covered = row.size_unit === "base" ? base : quote;
      require(reconciles(covered + uncovered, requested), "Displayed-liquidity covered size does not reconcile");
      require((base === 0) === (quote === 0) && (base === 0) === (row.covered_vwap == null), "Covered book VWAP requires positive covered quantities");
      if (row.covered_vwap != null) require(decimal(row.covered_vwap) > 0 && reconciles(decimal(row.covered_vwap), quote / base), "Covered book VWAP does not reconcile");
      if (uncovered === 0) require(row.vwap != null && row.cost_bps != null && row.covered_vwap != null && decimal(row.vwap) > 0 && reconciles(decimal(row.vwap), decimal(row.covered_vwap)), "Full-size book cost requires the covered VWAP and cost");
      if (decimal(row.uncovered_size) > 0) require(row.vwap == null && row.cost_bps == null && row.total_cost_bps == null, "Partial depth cannot describe full-size cost");
      if (row.cost_bps != null) require(decimal(row.cost_bps) >= 0 && (row.side !== "sell" || decimal(row.cost_bps) < 10_000), "Book cost is outside its side-specific range");
      if (row.spread_bps != null) require(decimal(row.spread_bps) > 0 && decimal(row.spread_bps) < 20_000, "Book spread is outside its positive-price range");
      if (row.fee_bps != null) require(decimal(row.fee_bps) >= 0 && decimal(row.fee_bps) <= 10_000, "Fee scenario is outside [0,10000] bps");
      const percentile = row.cost_percentile_7d ?? null;
      const percentileSamples = row.cost_percentile_sample_count ?? 0;
      const percentileExpected = row.cost_percentile_expected_samples ?? 10080;
      const percentileReasons = row.cost_percentile_reason_codes ?? (percentile == null ? ["INSUFFICIENT_HISTORY"] : []);
      const percentileReference = row.cost_percentile_reference_digest ?? null;
      require(Number.isSafeInteger(percentileSamples) && percentileSamples >= 0 && percentileSamples <= 10080 &&
        percentileExpected === 10080 && Array.isArray(percentileReasons) && percentileReasons.length <= 16 &&
        percentileReasons.every(reason => /^[A-Z][A-Z0-9_]{0,63}$/.test(reason)) &&
        (percentileReference == null || HASH.test(percentileReference)), "Invalid seven-day book-cost percentile provenance");
      if (percentile == null) require(percentileReasons.length > 0, "Unavailable book-cost percentile needs a reason");
      else require(decimal(percentile) >= 0 && decimal(percentile) <= 1 && percentileSamples >= 9072 &&
        percentileReference != null && row.cost_bps != null && decimal(row.uncovered_size) === 0 && row.access_basis !== "unknown" &&
        percentileReasons.length === 0, "Book-cost percentile lacks comparable full-size history");
      if (row.fee_bps == null) require(row.fee_source == null && row.total_cost_bps == null, "Total cost requires fee provenance");
      else require(typeof row.fee_source === "string" && row.fee_source.length > 0, "Known fee lacks provenance");
      if (row.fee_bps != null && row.cost_bps != null) {
        const cost = decimal(row.cost_bps), fee = decimal(row.fee_bps);
        const priceRatio = row.side === "buy" ? 1 + cost / 10_000 : 1 - cost / 10_000;
        require(row.total_cost_bps != null && reconciles(decimal(row.total_cost_bps), cost + fee * priceRatio), "Total cost does not reconcile with side-specific quote fee");
      } else require(row.total_cost_bps == null, "Total cost requires a full-size cost and known fee");
      const bid = decimal(row.band_bid_covered_quote), ask = decimal(row.band_ask_covered_quote);
      require(row.band_bps > 0 && row.band_bps <= 10_000, "Invalid depth band");
      if (!row.band_complete) require(row.band_imbalance == null, "Partial band cannot describe full-band imbalance");
      const expectedBand = !row.band_complete || bid + ask === 0 ? null : (bid - ask) / (bid + ask);
      require((row.band_imbalance == null) === (expectedBand === null) &&
        (expectedBand === null || (decimal(row.band_imbalance) >= -1 && decimal(row.band_imbalance) <= 1 && reconciles(decimal(row.band_imbalance), expectedBand))),
      "Band imbalance does not reconcile with covered band quantities");
      if (row.access_basis === "unknown") require(base === 0 && quote === 0 && row.covered_vwap == null && row.vwap == null && row.cost_bps == null && row.spread_bps == null && !row.band_complete && row.band_imbalance == null && decimal(row.band_bid_covered_quote) === 0 && decimal(row.band_ask_covered_quote) === 0 && percentile == null, "Unknown book access cannot qualify visible execution or depth");
    }
    if (frame.flow_ref?.status === "available") require(flows.length > 0 && frame.flow_ref.snapshot_id === component.component_id, "Flow pointer does not identify the embedded observation component");
    require((await digest(without(component, "component_id"))) === component.component_id, "Microstructure component hash mismatch");
  }
}

function validateMicrostructureReference(frame) {
  if (frame.microstructure_ref == null) return;
  const ref = object(frame.microstructure_ref);
  const optional = ["component_id", "cutoff_ms", "available_at_ms", "expires_at_ms"];
  exactKeys(ref, ["status", "reason_codes", ...optional], optional);
  require(["available", "unavailable"].includes(ref.status), "Invalid microstructure reference status");
  require(Array.isArray(ref.reason_codes) && ref.reason_codes.length <= 64 &&
    ref.reason_codes.every(reason => typeof reason === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(reason)),
  "Invalid microstructure reference reasons");
  require(frame.microstructure == null && !(frame.source_capabilities ?? []).length,
    "Microstructure companion cannot coexist with inline content");
  if (ref.status === "available") {
    require(HASH.test(ref.component_id) && ref.cutoff_ms === frame.cutoff_ms &&
      ref.available_at_ms === frame.available_at_ms && Number.isSafeInteger(ref.expires_at_ms) &&
      ref.expires_at_ms >= 0 && ref.expires_at_ms <= frame.expires_at_ms &&
      ref.reason_codes.length === 0, "Microstructure reference does not match its frame");
  } else {
    require(ref.reason_codes.length > 0 && ["component_id", "cutoff_ms", "available_at_ms", "expires_at_ms"].every(key => ref[key] == null),
      "Unavailable microstructure reference cannot carry an identity");
    require(frame.flow_ref?.status !== "available", "Unavailable microstructure cannot claim available flow");
  }
}

export async function projectMicrostructureResponse(body, displayFrame) {
  require(new TextEncoder().encode(JSON.stringify(body)).byteLength <= 2 * 1024 * 1024,
    "Microstructure response exceeds the size limit");
  object(body);
  safeNumbers(body);
  exactKeys(body, ["schema_version", "snapshot_id", "stream_id", "frame_payload_digest", "read_at_ms", "companion"]);
  const frame = displayFrame.raw;
  require(body.schema_version === "market-picture.v1" && body.snapshot_id === frame.snapshot_id &&
    body.stream_id === frame.stream_id && body.frame_payload_digest === frame.payload_digest,
  "Mixed-frame microstructure response rejected");
  integer(body.read_at_ms);
  validateMicrostructureReference(frame);
  const ref = frame.microstructure_ref, companion = object(body.companion);
  exactKeys(companion, ["schema_version", "component_id", "scope", "capabilities", "microstructure"]);
  require(ref?.status === "available" && companion.schema_version === "market-picture.microstructure-companion.v1" &&
    companion.component_id === ref.component_id &&
    await digest(without(companion, "component_id")) === companion.component_id,
  "Microstructure companion digest or reference mismatch");
  const scope = object(companion.scope);
  const expectedScope = {
    ...Object.fromEntries(["stream_id", "epoch", "sequence", "revision", "source_kind", "cutoff_ms", "available_at_ms", "expires_at_ms"].map(key => [key, frame[key]])),
    universe_id: frame.universe.universe_id, universe_revision: frame.universe.revision,
    membership_hash: frame.universe.membership_hash, member_instrument_ids: frame.universe.member_instrument_ids,
    selected_numeraire: frame.universe.selected_numeraire,
  };
  require(canonical(scope) === canonical(expectedScope), "Microstructure companion scope differs from its frame");
  const componentFrame = {
    ...frame, source_capabilities: companion.capabilities, microstructure: companion.microstructure,
  };
  await validateMicrostructureData(componentFrame);
  require(ref.expires_at_ms === Math.min(frame.expires_at_ms,
    ...companion.microstructure.flows.map(row => row.expires_at_ms),
    ...companion.microstructure.liquidity.map(row => row.expires_at_ms)),
  "Microstructure reference expiry differs from its observations");
  return {
    ...projectMicrostructureData(componentFrame),
    flow: {
      status: frame.flow_ref?.status ?? "unavailable",
      reasons: frame.flow_ref?.reason_codes ?? ["SOURCE_UNAVAILABLE"],
    },
  };
}

export async function validateFrame(frame, { allowFixture = false } = {}) {
  object(frame);
  safeNumbers(frame);
  require(Object.keys(frame).every((k) =>
    FRAME_KEYS.includes(k),
  ), "Unsupported frame extension");
  require(
    frame.schema_version === "market-picture.v1" &&
      frame.encoding === "metric-series.v1" &&
      frame.feature_set_version === "market-picture.observation.v1",
  );
  require(HASH.test(frame.snapshot_id) && HASH.test(frame.payload_digest));
  require(["observed", "reconstructed"].includes(frame.source_kind));
  require(allowFixture ||
    !frame.fixture_marker, "Fixture observations cannot be a production source");
  integer(frame.sequence, 1);
  integer(frame.revision);
  integer(frame.cutoff_ms);
  require(frame.cutoff_ms % 60_000 === 0);
  require(
    frame.cutoff_ms <= frame.available_at_ms &&
      frame.available_at_ms <= frame.published_at_ms &&
      frame.published_at_ms < frame.expires_at_ms,
  );
  if (frame.flow_ref !== undefined) {
    const flow = object(frame.flow_ref);
    require(
      Object.keys(flow).every((key) =>
        ["status", "snapshot_id", "cutoff_ms", "expires_at_ms", "reason_codes"].includes(key)) &&
      ["available", "unavailable"].includes(flow.status) &&
      Array.isArray(flow.reason_codes) && flow.reason_codes.length <= 64 &&
      flow.reason_codes.every((reason) => typeof reason === "string") &&
      (flow.snapshot_id === undefined || flow.snapshot_id === null ||
        (typeof flow.snapshot_id === "string" && HASH.test(flow.snapshot_id))) &&
      ["cutoff_ms", "expires_at_ms"].every((key) =>
        flow[key] === undefined || flow[key] === null ||
          (Number.isSafeInteger(flow[key]) && flow[key] >= 0)) &&
      (flow.status !== "available" ||
        (typeof flow.snapshot_id === "string" && HASH.test(flow.snapshot_id) &&
          Number.isSafeInteger(flow.cutoff_ms) && flow.cutoff_ms >= 0 &&
          Number.isSafeInteger(flow.expires_at_ms) && flow.expires_at_ms >= 0)) &&
      (flow.status !== "unavailable" || flow.reason_codes.length > 0),
    "Invalid flow reference");
  }
  validateMicrostructureReference(frame);
  await validateMicrostructureData(frame);
  require((await digest(without(frame, "payload_digest"))) ===
    frame.payload_digest, "Market Picture content hash mismatch");
  require((await digest(without(frame, "snapshot_id", "payload_digest"))) ===
    frame.snapshot_id, "Market Picture snapshot identity mismatch");
  const universe = object(frame.universe),
    assets = array(frame.assets),
    ids = array(universe.member_instrument_ids);
  require(
    ids.length > 0 &&
      unique(ids) &&
      ids.join("|") === [...ids].sort().join("|"),
  );
  require(
    ids.length === universe.expected_instrument_count &&
      assets.map((a) => a.instrument_id).join("|") === ids.join("|"),
  );
  require(
    unique(assets.map((a) => a.asset_id)) &&
      new Set(assets.map((a) => a.quote_asset_id)).size === 1 &&
      assets.every(
        (a) =>
          a.instrument_id.split("-").at(-1) === universe.selected_numeraire,
      ),
  );
  const regimes = array(frame.regime_observations, 1000);
  require(unique(regimes.map((r) => r.regime_id)), "Regime IDs must be unique");
  const regimeById = new Map(regimes.map((r) => [r.regime_id, r]));
  const registeredProviders = Object.values(object(frame.providers)).map((p) => canonical(p));
  for (const regime of regimes) {
    const provider = object(regime.provider_ref);
    require(ids.includes(regime.instrument_id) &&
      registeredProviders.includes(canonical(provider)) &&
      provider.source_kind === frame.source_kind &&
      regime.source_bar_close_ms === frame.cutoff_ms &&
      regime.available_at_ms <= frame.available_at_ms &&
      regime.expires_at_ms > frame.published_at_ms &&
      regime.source_epoch === provider.epoch &&
      regime.source_sequence === provider.sequence &&
      regime.available_at_ms >= Math.max(regime.source_bar_close_ms, provider.available_at_ms) &&
      regime.expires_at_ms <= provider.expires_at_ms,
    "Regime source or decision time differs from frame");
  }
  for (const asset of assets)
    require(array(asset.regime_refs, 8).every((ref) =>
      regimeById.get(ref)?.instrument_id === asset.instrument_id),
    "Regime reference belongs to another asset");
  const series = array(frame.metric_series, 128),
    seriesIds = series.map((s) => s.metric_id);
  require(unique(seriesIds) && seriesIds.join("|") === [...seriesIds].sort().join("|"));
  await Promise.all(
    series.map(async (s) => {
      require(allowFixture || !s.fixture_only);
      require(s.cells.map((c) => c.instrument_id).join("|") === ids.join("|"));
      require(s.provider_ref.source_kind === frame.source_kind &&
        Object.values(frame.providers).some(p => canonical(p) === canonical(s.provider_ref)));
      require(s.available_at_ms <= frame.available_at_ms && s.window_end_ms <= frame.cutoff_ms);
      require(s.cells.every(c => (c.available_at_ms ?? s.available_at_ms) <= frame.available_at_ms &&
        (c.window_end_ms ?? s.window_end_ms) <= frame.cutoff_ms));
      require((await seriesDigest(s)) ===
        s.payload_digest, "Metric series hash mismatch");
      resolveSeries(s);
    }),
  );
  const aggregates = object(frame.market_metrics);
  const byId = Object.fromEntries(series.map(s => [s.metric_id, s]));
  const generation = rvolGeneration(frame);
  const assetUnits = { ...COMMON_ASSET_UNITS, [generation.asset]: "ratio" };
  exactKeys(frame.asset_metric_refs, Object.keys(assetUnits));
  exactKeys(frame.asset_predicate_refs, PREDICATES);
  for (const [key, ref] of Object.entries(frame.asset_metric_refs))
    require(byId[ref.metric_id]?.series_unit === assetUnits[key], "Asset metric unit differs from semantic binding");
  const rvolRef = frame.asset_metric_refs[generation.asset].metric_id;
  require(rvolRef === generation.series && byId[rvolRef].definition_ref?.definition_id === generation.assetDefinition,
    "Semantic metric binding mismatch");
  for (const ref of Object.values(frame.asset_predicate_refs))
    require(byId[ref.metric_id]?.series_unit === "count", "Predicate binding unit must be count");
  for (const [key, metric] of Object.entries(aggregates)) {
    require(key === metric.metric_id);
    validateMetric(metric);
    require(metric.unit === metric.definition.unit);
    timing(metric, metric.source_ref);
  }
  const refs = [...Object.values(frame.summary.metric_refs), ...frame.breadth.flatMap(b => Object.values(b.metric_refs)),
    ...frame.pressure, ...frame.participation, ...Object.values(frame.comparisons?.metric_refs ?? {})];
  require(refs.every(r => Object.hasOwn(aggregates, r.metric_id)), "Unresolved aggregate reference");
  const binding = (actualId, expectedId, unit, definitionId) => {
    const metric = aggregates[actualId];
    require(actualId === expectedId && metric?.unit === unit &&
      metric?.definition?.definition_id === definitionId, "Semantic metric binding mismatch");
  };
  const summaryBindings = {
    ...COMMON_SUMMARY_BINDINGS,
    [generation.summary]: [generation.summary, "ratio", generation.summaryDefinition],
  };
  exactKeys(frame.summary.metric_refs, Object.keys(summaryBindings));
  for (const [key, [metricId, unit, definitionId]] of Object.entries(summaryBindings))
    binding(frame.summary.metric_refs[key].metric_id, metricId, unit, definitionId);
  for (const row of frame.breadth)
    for (const [key, [unit, definitionId]] of Object.entries(BREADTH_BINDINGS))
      binding(row.metric_refs[key].metric_id, `breadth_${row.horizon_minutes}_${key}`, unit, definitionId);
  for (const row of frame.pressure)
    binding(row.metric_id, `pressure_${row.horizon_minutes}`, "index_minus3_to3", "breadth_pressure");
  for (const row of frame.participation)
    binding(row.metric_id, `participation_${row.predicate_id}`, "share_fraction",
      PARTICIPATION_DEFINITIONS[row.predicate_id]);
  if (frame.relative_strength_changes != null) {
    const changes = relativeStrengthChanges(frame.relative_strength_changes);
    exactKeys(changes, ["baseline_snapshot_id", "baseline_cutoff_ms", "current_cutoff_ms", "interval_ms", "definition_id", "definition_hash", "source_hash", "cohort_hash", "expected_count", "valid_count", "reason_codes", "rank_deltas"]);
    require(changes.baseline_snapshot_id === null || HASH.test(changes.baseline_snapshot_id), "Invalid relative-strength baseline identity");
    require(changes.baseline_cutoff_ms === null || Number.isSafeInteger(changes.baseline_cutoff_ms), "Invalid relative-strength baseline cutoff");
    integer(changes.current_cutoff_ms); integer(changes.interval_ms, 1);
    integer(changes.expected_count, 1); integer(changes.valid_count);
    require(changes.current_cutoff_ms === frame.cutoff_ms && changes.interval_ms === 3_600_000 && changes.expected_count === ids.length && changes.valid_count <= changes.expected_count, "Relative-strength changes do not match the frozen frame");
    require(changes.definition_id === "relative_return" && changes.definition_hash === RELATIVE_RETURN_DEFINITION_HASH, "Relative-strength changes use a different definition");
    require(changes.source_hash === null || HASH.test(changes.source_hash), "Invalid relative-strength source hash");
    require(changes.cohort_hash === null || HASH.test(changes.cohort_hash), "Invalid relative-strength cohort hash");
    const reasons = array(changes.reason_codes, 8);
    require(reasons.every(reason => typeof reason === "string"), "Invalid relative-strength reasons");
    const deltas = array(changes.rank_deltas, 300);
    require(deltas.length === ids.length && deltas.filter(value => value !== null).length === changes.valid_count, "Relative-strength rank vector differs from the frozen asset order");
    if (changes.baseline_snapshot_id === null) {
      require(changes.baseline_cutoff_ms === null && changes.source_hash === null && changes.cohort_hash === null && changes.valid_count === 0 && reasons.length > 0 && deltas.every(value => value === null), "Rank changes without a baseline must be explicitly unavailable");
    } else {
      require(changes.baseline_cutoff_ms !== null && changes.source_hash !== null, "Rank changes require baseline time and source identity");
      if (changes.valid_count === changes.expected_count) {
        require(changes.baseline_cutoff_ms === changes.current_cutoff_ms - changes.interval_ms && changes.cohort_hash !== null && reasons.length === 0, "Complete rank changes require an exact one-hour cohort");
        require(deltas.every(value => Number.isSafeInteger(value) && Math.abs(value) < changes.expected_count) && deltas.reduce((sum, value) => sum + value, 0) === 0, "Relative-strength ranks must be a bounded permutation delta");
      } else {
        require(changes.valid_count === 0 && reasons.length > 0 && changes.cohort_hash === null && deltas.every(value => value === null), "Partial-cohort ranks must be suppressed");
      }
    }
  }
  for (const row of frame.distribution)
    require(row.definition_ref.definition_id === "return_distribution_40_bins" &&
      row.definition_ref.unit === "return_percent", "Distribution semantic definition mismatch");
  if (frame.comparisons) {
    const summaryDeltas = {
      market_participation: ["percentage_points", "share_delta"],
      [generation.summary]: ["ratio_points", "rvol_delta"],
      trend_strength: ["index_points", "trend_strength_delta"],
      realized_volatility_24h: ["percentage_points", "volatility_delta"],
    };
    for (const [key, ref] of Object.entries(frame.comparisons.metric_refs)) {
      const [family, semantic] = key.split("/");
      require(family !== "summary" || Object.hasOwn(summaryDeltas, semantic), "Invalid semantic binding keys");
      require(family !== "relative_strength" || ["btc", "eth", "bnb", "sol"].includes(semantic), "Invalid semantic binding keys");
      const [unit, definitionId] = family === "summary" ? summaryDeltas[semantic]
        : family === "relative_strength" ? ["percentage_points", "relative_return_delta"]
        : family === "pressure" ? ["index_points", "breadth_pressure_delta"]
          : ["percentage_points", "share_delta"];
      binding(ref.metric_id, `delta.${family}.${semantic}`, unit, definitionId);
    }
  }
  const aggregateBinding = (ref, metricId, unit, definitionId) => {
    require(ref?.metric_id === metricId, "Semantic metric binding mismatch");
    const metric = aggregates[ref.metric_id];
    require(metric?.unit === unit, "Aggregate metric unit differs from semantic binding");
    require(metric?.definition?.definition_id === definitionId, "Aggregate metric definition differs from semantic binding");
  };
  if (frame.normalized_breadth !== undefined && frame.normalized_breadth.length) {
    const rows = array(frame.normalized_breadth, 6);
    require(rows.map(row => row.horizon_minutes).join(",") === HORIZONS.join(","), "Invalid normalized breadth horizons");
    for (const row of rows) {
      integer(row.valid_count); integer(row.expected_count, 1); integer(row.cutoff_ms);
      require(row.valid_count <= row.expected_count && row.expected_count === ids.length, "Invalid normalized breadth coverage");
      exactKeys(row.metric_refs, ["advances", "declines", "unchanged", "pressure"]);
      for (const field of ["advances", "declines", "unchanged"])
        aggregateBinding(row.metric_refs[field], `breadth_1bp_${row.horizon_minutes}_${field}`, "instruments", "breadth_instrument_count");
      aggregateBinding(row.metric_refs.pressure, `breadth_pressure_1bp_${row.horizon_minutes}`, "index_minus1_to1", "breadth_pressure_1bp");
    }
  }
  if (frame.breadth_trajectory !== undefined && frame.breadth_trajectory.length) {
    const rows = array(frame.breadth_trajectory, 9);
    const pairs = [5, 15, 60].flatMap(h => [5, 15, 60].map(t => `${h}/${t}`));
    require(rows.map(row => `${row.horizon_minutes}/${row.interval_minutes}`).join("|") === pairs.join("|"), "Invalid breadth trajectory ordering");
    const trajectoryUnits = { level: ["index_minus1_to1", "breadth_pressure_1bp"], change: ["index_points", "breadth_pressure_change"], velocity: ["index_points_per_minute", "breadth_pressure_velocity"], acceleration: ["index_points_per_minute_squared", "breadth_pressure_acceleration"] };
    for (const row of rows) {
      integer(row.cutoff_ms); integer(row.matched_count); integer(row.expected_count, 1);
      require(row.matched_count <= row.expected_count && row.expected_count === ids.length, "Invalid trajectory coverage");
      const trajectoryMembership = row.matched_membership_hash ?? null; // schema default
      require(trajectoryMembership === null || HASH.test(trajectoryMembership), "Invalid trajectory membership hash");
      require((row.matched_count === 0) === (trajectoryMembership === null), "Trajectory membership hash must exist exactly when instruments are matched");
      const referenceKeys = Object.keys(row.metric_refs).sort();
      require(referenceKeys.join("|") === [...Object.keys(trajectoryUnits), ...(row.metric_refs.share_change ? ["share_change"] : [])].sort().join("|"), "Invalid trajectory metric references");
      for (const [field, [unit, definitionId]] of Object.entries(trajectoryUnits))
        aggregateBinding(row.metric_refs[field], `breadth_pressure_${field}_${row.horizon_minutes}_${row.interval_minutes}m`, unit, definitionId);
      if (row.metric_refs.share_change !== undefined)
        aggregateBinding(row.metric_refs.share_change, `breadth_advance_share_change_${row.horizon_minutes}_${row.interval_minutes}m`, "percentage_points", "breadth_advancing_share_change");
    }
  }
  if (frame.breadth_divergence !== undefined && frame.breadth_divergence.length) {
    const rows = array(frame.breadth_divergence, 3);
    require(rows.map(row => row.interval_minutes).join(",") === "5,15,60" && rows.every(row => row.benchmark === "btc" && row.horizon_minutes === 15), "Invalid breadth divergence rows");
    for (const row of rows) {
      integer(row.cutoff_ms); integer(row.matched_count); integer(row.expected_count, 1);
      require(row.matched_count <= row.expected_count && row.expected_count === ids.length, "Invalid divergence coverage");
      const divergenceMembership = row.matched_membership_hash ?? null; // schema default
      require(divergenceMembership === null || HASH.test(divergenceMembership), "Invalid divergence membership hash");
      require((row.matched_count === 0) === (divergenceMembership === null), "Divergence membership hash must exist exactly when instruments are matched");
      aggregateBinding(row.metric_ref, `breadth_divergence_btc_15_${row.interval_minutes}m`, "count", "breadth_price_divergence");
    }
  }
  if (frame.contribution_summaries !== undefined && frame.contribution_summaries.length) {
    const rows = array(frame.contribution_summaries, 4);
    require(rows.map(row => row.horizon_minutes).join(",") === "5,15,60,1440", "Invalid contribution horizons");
    for (const row of rows) {
      integer(row.expected_count, 1); integer(row.valid_count);
      require(row.valid_count <= row.expected_count && row.expected_count === ids.length && typeof row.start_cohort_available === "boolean" && typeof row.prior_liquidity_weights_available === "boolean", "Invalid contribution coverage");
      const h = row.horizon_minutes;
      aggregateBinding(row.equal_weight_return_ref, `cohort_equal_return_${h}`, "return_percent", "cohort_equal_weight_return");
      aggregateBinding(row.capped_liquidity_return_ref, `cohort_capped_liquidity_return_${h}`, "return_percent", "cohort_capped_liquidity_return");
      aggregateBinding(row.top5_abs_equal_ref, `contribution_top5_abs_equal_${h}`, "share_fraction", "return_concentration_abs_top5_equal");
      aggregateBinding(row.top5_abs_capped_ref, `contribution_top5_abs_capped_${h}`, "share_fraction", "return_concentration_abs_top5_capped_liquidity");
      if (row.median_return_ref != null) {
        const breadthRow = frame.breadth.find(item => item.horizon_minutes === h);
        const ref = row.median_return_ref;
        require(row.start_cohort_available && row.valid_count === ids.length &&
          frame.universe.effective_at_ms <= Math.max(0, frame.cutoff_ms - h * 60_000) &&
          ref.metric_id === breadthRow.metric_refs.median_return.metric_id, "Median requires the complete frozen same-horizon cohort");
        aggregateBinding(ref, `breadth_${h}_median_return`, "return_percent", "breadth_return_median");
        const metric = aggregates[ref.metric_id];
        require(metric.computation_status === "VALID" && metric.coverage_status === "COMPLETE" &&
          metric.sample_count === ids.length && metric.required_samples === ids.length && metric.expected_denominator === ids.length &&
          metric.horizon_minutes === h && metric.window_end_ms === frame.cutoff_ms && metric.window_start_ms === Math.max(0, frame.cutoff_ms - h * 60_000),
        "Median lacks full same-horizon owner coverage");
        const returns = series.find(item => item.metric_id === frame.asset_metric_refs[`return_${h}m`].metric_id);
        require(returns.cells.every(cell => (cell.computation_status ?? "VALID") === "VALID" && cell.value !== null), "Median contains a missing member");
      }
    }
  }
  if (frame.daily_internals !== undefined && frame.daily_internals.length) {
    const rows = array(frame.daily_internals, 300);
    require(rows.map(row => row.instrument_id).join("|") === ids.join("|"), "Daily internals must follow the frozen universe");
    const bindings = [
      ["high_break", "daily_high_break_20d", "count", 21],
      ["low_break", "daily_low_break_20d", "count", 21],
      ["close_break_high", "daily_close_break_high_20d", "count", 21],
      ["close_break_low", "daily_close_break_low_20d", "count", 21],
      ...[20, 50, 200].flatMap(period => [
        ["sma", `daily_sma_${period}`, "price_quote", period],
        ["above_close", `daily_sma_${period}_above_close`, "share_fraction", period],
        ["slope_percent_per_day", `daily_sma_${period}_slope_pct_per_day`, "return_percent", period + 1],
        ["cross", `daily_sma_${period}_cross`, "index_points", period + 1],
      ]),
    ];
    const validateValue = (value, unit) => {
      if (value === null) return;
      const numeric = decimal(value);
      if (["count", "share_fraction"].includes(unit)) require(Number.isInteger(numeric) && numeric >= 0 && numeric <= 1, "Daily boolean feature must be zero or one");
      if (unit === "index_points") require(Number.isInteger(numeric) && numeric >= -1 && numeric <= 1, "Daily cross must be minus one, zero, or one");
      if (unit === "price_quote") require(numeric > 0, "Daily price must be positive");
    };
    for (const row of rows) {
      integer(row.cutoff_ms);
      require(row.cutoff_ms === Math.floor(frame.cutoff_ms / 86_400_000) * 86_400_000, "Daily internals use a different day cutoff");
      const coverage = object(row.source_coverage);
      integer(coverage.expected_daily_bars, 1); integer(coverage.valid_daily_bars); integer(coverage.gap_count);
      require(coverage.valid_daily_bars <= coverage.expected_daily_bars, "Invalid daily source coverage");
      require(["COMPLETE", "PARTIAL", "UNAVAILABLE"].includes(row.source_coverage_status), "Invalid daily source coverage state");
      const sourceReasons = row.source_reason_codes ?? [];
      require(Array.isArray(sourceReasons) && sourceReasons.length <= 8, "Invalid daily source reasons");
      if (row.source != null) {
        const source = object(row.source);
        require(source.cutoff_ms === row.cutoff_ms && source.available_at_ms <= frame.available_at_ms && source.expires_at_ms > frame.available_at_ms && source.source_kind === frame.source_kind, "Daily source is stale or belongs to another instrument/frame");
      } else require(row.source_coverage_status === "UNAVAILABLE" && sourceReasons.length > 0, "Daily source identity missing without unavailable status");
      integer(row.contiguous_daily_bars);
      require(row.contiguous_daily_bars <= 201, "Daily suffix exceeds its bound");
      const values = array(row.values, 16), featureReasons = object(row.feature_reasons ?? {});
      require(values.length === 16 && Object.keys(featureReasons).every(key => /^(?:[0-9]|1[0-5])$/.test(key)), "Daily internals fixed feature vector is invalid");
      const usedReasonKeys = [];
      values.forEach((value, index) => {
        const [, , unit, requiredSamples] = bindings[index];
        const reasons = featureReasons[String(index)] ?? sourceReasons;
        require(value === null || typeof value === "string", "Daily feature value must be decimal text or null");
        if (value === null) {
          require(Array.isArray(reasons) && reasons.length > 0, "Unavailable daily value lacks its owner reason");
          if (featureReasons[String(index)] !== undefined) usedReasonKeys.push(String(index));
        } else require(row.source !== null && !sourceReasons.length && row.contiguous_daily_bars >= requiredSamples && featureReasons[String(index)] === undefined, "Valid daily value lacks complete contiguous source samples");
        if (featureReasons[String(index)] !== undefined) {
          const codes = array(featureReasons[String(index)], 8);
          require(unique(codes) && codes.join("|") === [...codes].sort().join("|") && codes.every(reason => /^[A-Z][A-Z0-9_]{0,63}$/.test(reason)), "Daily feature reasons are invalid");
        }
        validateValue(value, unit);
      });
      require(usedReasonKeys.sort().join("|") === Object.keys(featureReasons).sort().join("|"), "Feature reasons must point to null vector values");
    }
  }
  if (frame.hourly_internals !== undefined && frame.hourly_internals !== null) {
    const hourly = object(frame.hourly_internals);
    require(hourly.interval_minutes === 60 && hourly.cutoff_ms === Math.floor(frame.cutoff_ms / 3_600_000) * 3_600_000, "Invalid hourly internals cutoff");
    require(hourly.decision_available_at_ms === frame.available_at_ms && hourly.cutoff_ms <= hourly.decision_available_at_ms && (hourly.expires_at_ms == null || (Number.isSafeInteger(hourly.expires_at_ms) && hourly.expires_at_ms > frame.available_at_ms)), "Hourly internals time bounds are invalid");
    require(hourly.source_kind === frame.source_kind && HASH.test(hourly.source_digest), "Hourly internals source identity is invalid");
    integer(hourly.source_count); integer(hourly.expected_count, 1);
    require(hourly.source_count <= hourly.expected_count && hourly.expected_count === ids.length, "Hourly internals coverage is invalid");
    require((hourly.source_count === 0) === (hourly.expires_at_ms == null), "Hourly source expiry must match source coverage");
    const hourlyUnits = {
      above_sma20_share: ["share_fraction", "above_sma20_share"],
      above_sma50_share: ["share_fraction", "above_sma50_share"],
      above_sma200_share: ["share_fraction", "above_sma200_share"],
      sma20_slope_pct_per_hour_median: ["return_percent", "sma20_slope_pct_per_hour_median"],
      sma50_slope_pct_per_hour_median: ["return_percent", "sma50_slope_pct_per_hour_median"],
      sma200_slope_pct_per_hour_median: ["return_percent", "sma200_slope_pct_per_hour_median"],
      sma20_cross_up_count: ["instruments", "sma20_cross_up_count"],
      sma20_cross_down_count: ["instruments", "sma20_cross_down_count"],
      sma50_cross_up_count: ["instruments", "sma50_cross_up_count"],
      sma50_cross_down_count: ["instruments", "sma50_cross_down_count"],
      sma200_cross_up_count: ["instruments", "sma200_cross_up_count"],
      sma200_cross_down_count: ["instruments", "sma200_cross_down_count"],
      trend_class_bullish_count: ["instruments", "trend_class_bullish_count"],
      trend_class_bearish_count: ["instruments", "trend_class_bearish_count"],
      trend_class_neutral_count: ["instruments", "trend_class_neutral_count"],
      efficiency_ratio_20_median: ["ratio", "efficiency_ratio_20_median"],
    };
    const metrics = object(hourly.metrics);
    exactKeys(metrics, Object.keys(hourlyUnits));
    for (const [key, [unit, definitionId]] of Object.entries(hourlyUnits)) {
      const metric = object(metrics[key]);
      const metricKeys = Object.keys(metric).sort();
      const requiredMetricKeys = ["definition_id", "unit", "valid_count", "expected_count"].sort();
      require(requiredMetricKeys.every(key => metricKeys.includes(key)) && metricKeys.every(key => [...requiredMetricKeys, "reason_codes", "value"].includes(key)), "Invalid hourly metric keys");
      require(metric.definition_id === definitionId && metric.unit === unit, "Hourly internals metric definition mismatch");
      integer(metric.valid_count); integer(metric.expected_count, 1);
      require(metric.valid_count <= metric.expected_count && metric.expected_count === hourly.expected_count, "Hourly metric coverage mismatch");
      const reasons = array(metric.reason_codes ?? [], 8);
      require(unique(reasons) && reasons.every(reason => /^[A-Z][A-Z0-9_]{0,63}$/.test(reason)), "Hourly metric reasons are invalid");
      if (metric.value == null) require(reasons.length > 0, "Unavailable hourly metric needs a reason");
      else {
        const value = decimal(metric.value);
        require(!reasons.length, "Valid hourly metric cannot carry an unavailable reason");
        if (unit === "share_fraction" || unit === "ratio") require(value >= 0 && value <= 1, "Hourly share or ratio is out of range");
        if (unit === "instruments") require(Number.isInteger(value) && value >= 0 && value <= metric.valid_count, "Hourly instrument count is out of range");
        if (metric.valid_count === 0) require(false, "Valid hourly aggregate needs samples");
        if (metric.valid_count < metric.expected_count) require(reasons.includes("INSUFFICIENT_COVERAGE"), "Partial hourly aggregate needs a coverage reason");
        else require(reasons.length === 0, "Complete hourly aggregate cannot carry partial-input reasons");
      }
    }
  }
  if (frame.candle_anomalies !== undefined && frame.candle_anomalies !== null) {
    const anomalies = { expires_at_ms: null, ...object(frame.candle_anomalies) }; // schema default
    exactKeys(anomalies, ["interval_ms", "cutoff_ms", "decision_available_at_ms", "expires_at_ms", "source_kind", "source_hash", "source_count", "expected_count", "metrics"]);
    require(anomalies.interval_ms === 3_600_000 && anomalies.cutoff_ms === Math.floor(frame.cutoff_ms / 3_600_000) * 3_600_000, "Invalid hourly candle-anomaly cutoff");
    require(anomalies.decision_available_at_ms === frame.available_at_ms && anomalies.cutoff_ms <= anomalies.decision_available_at_ms, "Candle-anomaly decision time is invalid");
    require(anomalies.expires_at_ms === null || (Number.isSafeInteger(anomalies.expires_at_ms) && anomalies.expires_at_ms > frame.available_at_ms), "Candle-anomaly source expiry is invalid");
    require(anomalies.source_kind === frame.source_kind && HASH.test(anomalies.source_hash), "Candle-anomaly source identity is invalid");
    integer(anomalies.source_count); integer(anomalies.expected_count, 1);
    require(anomalies.expected_count === ids.length && anomalies.source_count <= anomalies.expected_count, "Candle-anomaly coverage differs from the frozen assets");
    require((anomalies.source_count === 0) === (anomalies.expires_at_ms === null), "Candle-anomaly expiry must match source coverage");
    const anomalyDefinitions = {
      dictionary_rvol_1h_high: "a135842c5f5f1b10ab1c00409120df65075433b4f886a9e2accc104e7dcd4a53",
      bollinger_inside_ema_atr_compression_1h: "6ddb769fd95517e7b72809bf771aca5774eb16007b7611212f8c48b2ce0ae9e4",
      extreme_realized_volatility_1h_95p: "2c2911d4a45369b6143b7f9616bb9c94b0307216447383b1327db26704460e9c",
    };
    const metrics = object(anomalies.metrics);
    exactKeys(metrics, Object.keys(anomalyDefinitions));
    for (const [metricId, definitionHash] of Object.entries(anomalyDefinitions)) {
      const metric = { ...CANDLE_ANOMALY_METRIC_DEFAULTS, ...object(metrics[metricId]) };
      exactKeys(metric, ["definition_id", "definition_hash", "valid_count", "expected_count", "high_count", "share_fraction", "values", "reason_codes"]);
      require(metric.definition_id === metricId && metric.definition_hash === definitionHash, "Candle-anomaly definition identity mismatch");
      integer(metric.valid_count); integer(metric.expected_count, 1);
      require(metric.expected_count === anomalies.expected_count && metric.valid_count <= metric.expected_count, "Candle-anomaly metric coverage mismatch");
      const values = array(metric.values, 300);
      require(values.length === ids.length && values.every(value => value === null || value === 0 || value === 1), "Candle-anomaly vector must align with frozen binary values");
      const validValues = values.filter(value => value !== null);
      const highCount = validValues.filter(value => value === 1).length;
      require(validValues.length === metric.valid_count, "Candle-anomaly valid count differs from its vector");
      const reasons = array(metric.reason_codes ?? [], 8);
      require(unique(reasons) && reasons.join("|") === [...reasons].sort().join("|") && reasons.every(reason => /^[A-Z][A-Z0-9_]{0,63}$/.test(reason)), "Candle-anomaly reason codes are invalid");
      if (metric.valid_count === 0) {
        require(metric.high_count === null && metric.share_fraction === null && reasons.length > 0, "Unavailable candle anomaly must remain null with a reason");
      } else {
        integer(metric.high_count);
        require(metric.high_count === highCount && metric.high_count <= metric.valid_count, "Candle-anomaly high count differs from binary vector");
        const share = decimal(metric.share_fraction);
        require(share >= 0 && share <= 1 && reconciles(share, highCount / metric.valid_count), "Candle-anomaly share differs from high count");
        require((metric.valid_count < metric.expected_count) === (reasons.length > 0), "Partial candle anomaly must disclose missing-source reasons");
      }
    }
    const contributingInstruments = ids.filter((_, index) => Object.values(metrics).some(metric => metric.values[index] !== null)).length;
    require(anomalies.source_count === contributingInstruments, "Candle-anomaly source coverage differs from contributing instruments");
  }
  for (const key of ["breadth", "distribution", "pressure"])
    require(
      array(frame[key], 6)
        .map((r) => r.horizon_minutes)
        .join(",") === HORIZONS.join(","),
    );
  for (const b of frame.breadth) {
    require(b.expected_count === ids.length);
    integer(b.valid_count);
    const values = ["advances", "declines", "unchanged"].map((k) =>
      validateMetric(aggregates[b.metric_refs[k].metric_id]),
    );
    require(
      values.every((v) => Number.isSafeInteger(v) && v >= 0) &&
        values.reduce((a, b) => a + b, 0) === b.valid_count,
    );
    require(
      Object.values(b.omission_reasons).reduce((a, b) => a + integer(b), 0) +
        b.valid_count ===
        ids.length,
    );
  }
  for (const d of frame.distribution) {
    const edges = array(d.edges, 129).map(decimal),
      counts = array(d.counts, 128).map((v) => integer(v));
    require(
      edges.length === 41 && counts.length === 40 &&
        edges.every((v, i) => !i || v > edges[i - 1]),
    );
    require(d.unit === "return_percent" && d.expected_count === ids.length);
    require(
      counts.reduce((a, b) => a + b, 0) +
        d.underflow_count +
        d.overflow_count ===
        d.valid_count,
    );
  }
  const predicates = array(frame.participation, 8);
  require(
    predicates.map(p => p.predicate_id).join("|") === PREDICATES.join("|"),
  );
  for (const p of predicates) {
    require(
      0 <= p.numerator &&
        p.numerator <= p.denominator &&
        p.denominator <= p.expected_denominator &&
        p.expected_denominator === ids.length,
    );
    require(frame.asset_predicate_refs[p.predicate_id].metric_id === p.membership_metric_id);
    const cells = byId[p.membership_metric_id].cells.filter(c => (c.computation_status ?? "VALID") === "VALID");
    require(cells.length === p.denominator && cells.every(c => c.value === "0" || c.value === "1") &&
      cells.reduce((sum, c) => sum + Number(c.value), 0) === p.numerator);
    const metric = aggregates[p.metric_id];
    validateMetric(metric);
    require(metric.unit === "share_fraction" && metric.numerator === p.numerator &&
      metric.denominator === p.denominator && metric.expected_denominator === p.expected_denominator);
  }
  require(
    frame.summary.metric_refs.above_ema21.metric_id ===
      predicates.find((p) => p.predicate_id === "above_ema21").metric_id,
  );
  return frame;
}

function displayMetric(metric) {
  if (!metric)
    return {
      value: null,
      original: null,
      unit: "",
      status: "UNAVAILABLE",
      reasons: ["SOURCE_UNAVAILABLE"],
      valid: 0,
      expected: 0,
      available: null,
      expires: null,
      definition: "",
    };
  return {
    value: metric.value == null ? null : Number(metric.value),
    original: metric.value ?? null,
    unit: metric.unit,
    status: metric.computation_status,
    reasons: metric.reason_codes,
    valid: metric.denominator ?? metric.source_ref?.coverage?.valid_count ?? 0,
    expected: metric.expected_denominator,
    available: metric.available_at_ms,
    expires: metric.expires_at_ms,
    definition: `${metric.definition.definition_id} v${metric.definition.definition_version}`,
  };
}

function displayDailyCell(value, metricId, unit, requiredSamples, samples, reasons) {
  const definitionId = metricId;
  const status = value == null ? "UNAVAILABLE" : "VALID";
  const label = metricId.endsWith("_cross") && value != null
    ? ({ "-1": "cross_down", "0": "none", "1": "cross_up" }[value] ?? null)
    : null;
  return {
    metricId,
    definitionId,
    samples,
    required: requiredSamples,
    label,
    metric: {
      value: value == null ? null : Number(value),
      original: value ?? null,
      unit,
      status,
      reasons,
      valid: samples,
      expected: requiredSamples,
      available: null,
      expires: null,
      definition: definitionId,
    },
  };
}

function projectMicrostructureData(frame) {
  return {
    sourceCapabilities: (frame.source_capabilities ?? []).map(row => ({
      sourceId: row.source_id, family: row.family, venueProfile: row.venue_profile,
      endpoint: row.endpoint, qualification: row.qualification, operational: row.operational,
      sourceContractHash: row.source_contract_hash, instrumentIds: row.instrument_ids,
      units: row.units, historySemantics: row.history_semantics, access: row.access,
      cadenceMs: row.cadence_ms, maxRecords: row.max_records, licenseBasis: row.license_basis,
      probeReceiptHash: row.probe_receipt_hash ?? null, probedAtMs: row.probed_at_ms ?? null,
      collectionReceiptHash: row.collection_receipt_hash ?? null, collectedAtMs: row.collected_at_ms ?? null,
      qualificationReceiptHash: row.qualification_receipt_hash ?? null,
      qualificationContractHash: row.qualification_contract_hash ?? null, qualifiedAtMs: row.qualified_at_ms ?? null, reasons: row.reasons ?? [],
    })),
    microstructure: frame.microstructure ? {
      componentId: frame.microstructure.component_id, sourceKind: frame.microstructure.source_kind,
      cutoff: frame.microstructure.cutoff_ms, available: frame.microstructure.available_at_ms,
      replayClass: frame.microstructure.replay_class, rawInputsRetained: frame.microstructure.raw_inputs_retained,
      flows: frame.microstructure.flows.map(row => {
        const cap = (frame.source_capabilities ?? []).find(item => item.source_id === row.source_id);
        return {
          instrumentId: row.instrument_id, sourceId: row.source_id, inputDigest: row.input_digest,
          quoteAsset: row.quote_asset, channel: row.channel,
          windowStart: row.window_start_ms, windowEnd: row.window_end_ms, available: row.available_at_ms, expires: row.expires_at_ms,
          resetId: row.reset_id, resetAt: row.reset_at_ms,
          coverageStart: row.coverage_start_ms, coverageEnd: row.coverage_end_ms,
          gaps: row.gap_intervals,
          buyQuote: row.buy_quote, sellQuote: row.sell_quote, unknownQuote: row.unknown_quote,
          knownImbalance: row.known_imbalance, confirmationImbalance: row.confirmation_imbalance, unknownShare: row.unknown_share,
          cumulativeBefore: row.cumulative_delta_before_quote, cumulativeAfter: row.cumulative_delta_quote,
          trades: row.trade_records, duplicates: row.duplicate_records, complete: row.complete, reasons: row.reason_codes,
          capabilityUsable: cap?.qualification === "qualified" && cap?.operational === "healthy",
        };
      }),
      liquidity: frame.microstructure.liquidity.map(row => {
        const cap = (frame.source_capabilities ?? []).find(item => item.source_id === row.source_id);
        return {
          instrumentId: row.instrument_id, sourceId: row.source_id, channel: row.channel, sequence: row.sequence,
          observed: row.observed_at_ms, available: row.available_at_ms, expires: row.expires_at_ms, access: row.access_basis,
          side: row.side, requestedSize: row.requested_size, sizeUnit: row.size_unit, coveredBase: row.covered_base,
          coveredQuote: row.covered_quote, uncovered: row.uncovered_size, coveredVwap: row.covered_vwap,
          vwap: row.vwap, costBps: row.cost_bps,
          costPercentile7d: row.cost_percentile_7d == null ? null : Number(row.cost_percentile_7d),
          costPercentileSampleCount: row.cost_percentile_sample_count ?? 0,
          costPercentileExpectedSamples: row.cost_percentile_expected_samples ?? 10080,
          costPercentileReasons: row.cost_percentile_reason_codes ?? (row.cost_percentile_7d == null ? ["INSUFFICIENT_HISTORY"] : []),
          costPercentileReferenceDigest: row.cost_percentile_reference_digest ?? null,
          feeBps: row.fee_bps, feeSource: row.fee_source,
          totalCostBps: row.total_cost_bps, spreadBps: row.spread_bps, bandBps: row.band_bps,
          bidCovered: row.band_bid_covered_quote, askCovered: row.band_ask_covered_quote,
          bandComplete: row.band_complete, bandImbalance: row.band_imbalance, reasons: row.reason_codes,
          capabilityUsable: cap?.qualification === "qualified" && cap?.operational === "healthy",
        };
      }),
    } : null,
  };
}

export function projectFrame(frame) {
  const resolved = new Map(
    frame.metric_series.map((s) => [s.metric_id, resolveSeries(s)]),
  );
  const aggregate = (ref) =>
    displayMetric(
      frame.market_metrics[typeof ref === "string" ? ref : ref?.metric_id],
    );
  const assets = frame.assets.map((asset) => {
    const metrics = Object.fromEntries(
      Object.entries(frame.asset_metric_refs).map(([key, ref]) => [
        key,
        displayMetric(resolved.get(ref.metric_id)?.[asset.instrument_id]),
      ]),
    );
    return {
      instrument_id: asset.instrument_id,
      symbol: asset.instrument_id.split(":").at(-1).split("-")[0],
      quote: frame.universe.selected_numeraire,
      sector: asset.sector_ref?.sector_id ?? "Unknown",
      price: metrics.price ?? displayMetric(null),
      returns: Object.fromEntries(
        [...HORIZONS, 10080].map((h) => [
          String(h),
          metrics[`return_${h}m`] ?? displayMetric(null),
        ]),
      ),
      indicators: metrics,
      predicates: Object.fromEntries(
        Object.entries(frame.asset_predicate_refs).map(([key, ref]) => [
          key,
          displayMetric(resolved.get(ref.metric_id)?.[asset.instrument_id]),
        ]),
      ),
      relative: Object.fromEntries(
        ["BTC", "ETH", "BNB", "SOL"].map((b) => [
          b,
          metrics[`relative_24h_${b.toLowerCase()}`] ?? displayMetric(null),
        ]),
      ),
      weight:
        asset.heatmap_weight?.value == null
          ? null
          : decimal(asset.heatmap_weight.value),
      regimes: (asset.regime_refs ?? [])
        .map((id) => frame.regime_observations.find((r) => r.regime_id === id))
        .filter(Boolean)
        .map((r) => ({
          label: r.regime_label,
          origin: r.origin,
          confidence:
            r.confidence_value == null
              ? null
              : `${r.confidence_value}${r.confidence_unit === "percent" ? "%" : r.confidence_unit === "fraction" ? " fraction" : ` ${r.confidence_unit ?? ""}`}`,
          confidenceKind: r.confidence_kind,
          calibration: r.calibration_status,
          trend: r.trend_direction,
          context: r.context_bias,
          available: r.available_at_ms,
          model: r.model_id,
        })),
    };
  });
  const breadth = Object.fromEntries(
    frame.breadth.map((b) => [
      String(b.horizon_minutes),
      {
        advancing: Number(
          frame.market_metrics[b.metric_refs.advances.metric_id].value,
        ),
        declining: Number(
          frame.market_metrics[b.metric_refs.declines.metric_id].value,
        ),
        unchanged: Number(
          frame.market_metrics[b.metric_refs.unchanged.metric_id].value,
        ),
        valid: b.valid_count,
        expected: b.expected_count,
        positive: aggregate(b.metric_refs.advance_share),
        negative: aggregate(b.metric_refs.decline_share),
        flat: aggregate(b.metric_refs.unchanged_share),
      },
    ]),
  );
  const summary = Object.fromEntries(
    Object.entries(frame.summary.metric_refs).map(([key, ref]) => [
      key,
      aggregate(ref),
    ]),
  );
  summary.realized_volatility = summary.realized_volatility_24h;
  return {
    snapshot_id: frame.snapshot_id,
    stream_id: frame.stream_id,
    epoch: frame.epoch,
    sequence: frame.sequence,
    payload_digest: frame.payload_digest,
    cutoff_ms: frame.cutoff_ms,
    available_at_ms: frame.available_at_ms,
    expires_at_ms: frame.expires_at_ms,
    source_kind: frame.source_kind,
    ...(frame.fixture_marker ? { fixture_marker: frame.fixture_marker } : {}),
    universeId: frame.universe.universe_id,
    universeRevision: frame.universe.revision,
    membershipHash: frame.universe.membership_hash,
    quote: frame.universe.selected_numeraire,
    expected: frame.universe.expected_instrument_count,
    valid: frame.coverage.valid_instruments,
    assets,
    breadth,
    normalizedBreadth: Object.fromEntries((frame.normalized_breadth ?? []).map(row => [String(row.horizon_minutes), {
      horizon: row.horizon_minutes, cutoff: row.cutoff_ms, valid: row.valid_count, expected: row.expected_count,
      advances: aggregate(row.metric_refs.advances), declines: aggregate(row.metric_refs.declines),
      unchanged: aggregate(row.metric_refs.unchanged), pressure: aggregate(row.metric_refs.pressure),
    }])),
    breadthTrajectory: (frame.breadth_trajectory ?? []).map(row => ({
      horizon: row.horizon_minutes, interval: row.interval_minutes, cutoff: row.cutoff_ms,
      matched: row.matched_count, expected: row.expected_count, membership: row.matched_membership_hash ?? null,
      level: aggregate(row.metric_refs.level), change: aggregate(row.metric_refs.change),
      velocity: aggregate(row.metric_refs.velocity), acceleration: aggregate(row.metric_refs.acceleration),
      ...(row.metric_refs.share_change ? { shareChange: aggregate(row.metric_refs.share_change) } : {}),
    })),
    hourlyInternals: frame.hourly_internals ? {
      interval: frame.hourly_internals.interval_minutes, cutoff: frame.hourly_internals.cutoff_ms,
      decisionAvailable: frame.hourly_internals.decision_available_at_ms,
      expires: frame.hourly_internals.expires_at_ms ?? null, sourceKind: frame.hourly_internals.source_kind,
      sourceDigest: frame.hourly_internals.source_digest, sourceCount: frame.hourly_internals.source_count,
      expected: frame.hourly_internals.expected_count,
      metrics: Object.fromEntries(Object.entries(frame.hourly_internals.metrics).map(([key, metric]) => [key, {
        value: metric.value == null ? null : Number(metric.value), original: metric.value ?? null,
        unit: metric.unit, status: metric.value == null ? "UNAVAILABLE" : metric.valid_count < metric.expected_count ? "PARTIAL" : "VALID",
        reasons: metric.reason_codes ?? [], valid: metric.valid_count, expected: metric.expected_count,
        available: frame.hourly_internals.decision_available_at_ms, expires: frame.hourly_internals.expires_at_ms,
        definition: metric.definition_id,
      }]))
    } : null,
    candleAnomalies: frame.candle_anomalies ? {
      interval: frame.candle_anomalies.interval_ms,
      cutoff: frame.candle_anomalies.cutoff_ms,
      decisionAvailable: frame.candle_anomalies.decision_available_at_ms,
      expires: frame.candle_anomalies.expires_at_ms ?? null,
      sourceKind: frame.candle_anomalies.source_kind,
      sourceHash: frame.candle_anomalies.source_hash,
      sourceCount: frame.candle_anomalies.source_count,
      expected: frame.candle_anomalies.expected_count,
      metrics: Object.fromEntries(Object.entries(frame.candle_anomalies.metrics).map(([key, metric]) => [key, {
        definitionId: metric.definition_id,
        definitionHash: metric.definition_hash,
        valid: metric.valid_count,
        expected: metric.expected_count,
        high: metric.high_count ?? CANDLE_ANOMALY_METRIC_DEFAULTS.high_count,
        share: metric.share_fraction == null ? null : Number(metric.share_fraction),
        values: Object.fromEntries(frame.assets.map((asset, index) => [asset.instrument_id, metric.values[index]])),
        reasons: metric.reason_codes ?? [],
      }]))
    } : null,
    breadthDivergence: (frame.breadth_divergence ?? []).map(row => ({
      benchmark: row.benchmark, horizon: row.horizon_minutes, interval: row.interval_minutes,
      cutoff: row.cutoff_ms, matched: row.matched_count, expected: row.expected_count,
      membership: row.matched_membership_hash ?? null, metric: aggregate(row.metric_ref),
    })),
    contributions: Object.fromEntries((frame.contribution_summaries ?? []).map(row => [String(row.horizon_minutes), {
      horizon: row.horizon_minutes, expected: row.expected_count, valid: row.valid_count,
      startCohortAvailable: row.start_cohort_available,
      priorWeightsAvailable: row.prior_liquidity_weights_available,
      equalReturn: aggregate(row.equal_weight_return_ref), cappedReturn: aggregate(row.capped_liquidity_return_ref),
      medianReturn: aggregate(row.median_return_ref),
      equalTop5: aggregate(row.top5_abs_equal_ref), cappedTop5: aggregate(row.top5_abs_capped_ref),
    }])),
    ...projectMicrostructureData(frame),
    dailyInternals: (frame.daily_internals ?? []).map(row => {
      const bindings = [
        ["high_break", "daily_high_break_20d", "count", 21],
        ["low_break", "daily_low_break_20d", "count", 21],
        ["close_break_high", "daily_close_break_high_20d", "count", 21],
        ["close_break_low", "daily_close_break_low_20d", "count", 21],
        ...[20, 50, 200].flatMap(period => [
          ["sma", `daily_sma_${period}`, "price_quote", period],
          ["above_close", `daily_sma_${period}_above_close`, "share_fraction", period],
          ["slope_percent_per_day", `daily_sma_${period}_slope_pct_per_day`, "return_percent", period + 1],
          ["cross", `daily_sma_${period}_cross`, "index_points", period + 1],
        ]),
      ];
      const displayCell = (index) => {
        const [, metricId, unit, required] = bindings[index];
        const value = row.values[index];
        const samples = Math.min(row.contiguous_daily_bars, required);
        const reasons = value === null
          ? (row.feature_reasons?.[String(index)] ?? row.source_reason_codes)
          : [];
        return displayDailyCell(value, metricId, unit, required, samples, reasons);
      };
      return {
      instrumentId: row.instrument_id, interval: "1d", cutoff: row.cutoff_ms,
      frameCutoff: frame.cutoff_ms, sourceReasons: row.source_reason_codes ?? [],
      decisionAvailable: frame.available_at_ms,
      source: row.source ? {
        providerId: row.source.provider_id, pair: row.instrument_id.split(":spot:").at(-1),
        streamEpoch: row.source.stream_epoch, streamSequence: row.source.stream_sequence,
        sourceEpoch: row.source.source_epoch, sourceSequence: row.source.source_sequence,
        sourceKind: row.source.source_kind, cutoff: row.source.cutoff_ms,
        available: row.source.available_at_ms, expires: row.source.expires_at_ms,
      } : null,
      sourceCoverageStatus: row.source_coverage_status,
      sourceCoverage: {
        expectedBars: row.source_coverage.expected_daily_bars,
        validBars: row.source_coverage.valid_daily_bars,
        gaps: row.source_coverage.gap_count,
      },
      contiguousBars: row.contiguous_daily_bars,
      breaks: Object.fromEntries([["high_break", 0], ["low_break", 1], ["close_break_high", 2], ["close_break_low", 3]].map(([key, index]) => [key, displayCell(index)])),
      averages: Object.fromEntries([20, 50, 200].map((period, periodIndex) => [
        String(period), Object.fromEntries(["sma", "above_close", "slope_percent_per_day", "cross"].map((key, featureIndex) => [key, displayCell(4 + periodIndex * 4 + featureIndex)])),
      ])),
      };
    }),
    summary,
    flow: {
      status: frame.microstructure_ref?.status === "available" ? "unavailable" : (frame.flow_ref?.status ?? "unavailable"),
      reasons: frame.microstructure_ref?.status === "available" ? ["SOURCE_UNAVAILABLE"] : (frame.flow_ref?.reason_codes ?? ["SOURCE_UNAVAILABLE"]),
    },
    pressure: Object.fromEntries(
      frame.pressure.map((p) => [
        String(p.horizon_minutes),
        aggregate(p.metric_id),
      ]),
    ),
    participation: Object.fromEntries(
      frame.participation.map((p) => [
        p.predicate_id,
        {
          ...aggregate(p.metric_id),
          valid: p.denominator,
          expected: p.expected_denominator,
        },
      ]),
    ),
    comparisons: Object.fromEntries(
      Object.entries(frame.comparisons?.metric_refs ?? {}).map(([key, ref]) => [
        key,
        aggregate(ref),
      ]),
    ),
    comparisonContext: frame.comparisons ? {
      baselineSnapshotId: frame.comparisons.baseline_snapshot_id ?? null,
      baselineCutoff: frame.comparisons.baseline_cutoff_ms ?? null,
      interval: frame.comparisons.interval_ms,
      common: frame.comparisons.common_count,
      current: frame.comparisons.current_count,
      baseline: frame.comparisons.baseline_count,
      membership: frame.comparisons.common_membership_hash,
    } : null,
    relativeStrengthChanges: frame.relative_strength_changes ? (changes => ({
      baselineSnapshotId: changes.baseline_snapshot_id,
      baselineCutoff: changes.baseline_cutoff_ms,
      currentCutoff: changes.current_cutoff_ms,
      interval: changes.interval_ms,
      definitionId: changes.definition_id,
      definitionHash: changes.definition_hash,
      sourceHash: changes.source_hash,
      cohortHash: changes.cohort_hash,
      expected: changes.expected_count,
      valid: changes.valid_count,
      reasons: changes.reason_codes,
      rankDeltas: Object.fromEntries(frame.assets.map((asset, index) => [asset.instrument_id, changes.rank_deltas[index]])),
    }))(relativeStrengthChanges(frame.relative_strength_changes)) : null,
    distribution: Object.fromEntries(
      frame.distribution.map((d) => {
        const b = frame.breadth.find(
          (b) => b.horizon_minutes === d.horizon_minutes,
        );
        return [
          String(d.horizon_minutes),
          {
            edges: d.edges.map(Number),
            counts: [d.underflow_count, ...d.counts, d.overflow_count],
            total: d.valid_count,
            median: aggregate(b.metric_refs.median_return),
            mean: aggregate(b.metric_refs.mean_return),
            dispersion: aggregate(b.metric_refs.dispersion),
            downside: aggregate(b.metric_refs.downside_magnitude),
            bestInstrument: d.best_instrument_id ?? null,
            worstInstrument: d.worst_instrument_id ?? null,
          },
        ];
      }),
    ),
    raw: frame,
  };
}
