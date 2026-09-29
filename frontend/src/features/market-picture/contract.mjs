/** Wire validation and lossless display projection. Calculations remain in the owner. */
const HASH = /^[0-9a-f]{64}$/;
const DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const HORIZONS = [1, 5, 15, 60, 240, 1440];
const ASSET_UNITS = {
  price: "price_quote", ema21: "price_quote", rsi14: "rsi_0_100", adx14: "adx_0_100",
  atr14_percent: "atr_percent", atr14_percentile: "percentile_0_100", rvol20: "ratio", rvol_24h: "ratio",
  realized_volatility_24h: "volatility_fraction_annualized",
  ...Object.fromEntries([...HORIZONS, 10080].map(h => [`return_${h}m`, "return_percent"])),
  ...Object.fromEntries(["btc", "eth", "bnb", "sol"].map(b => [`relative_24h_${b}`, "percentage_points"])),
};
const PREDICATES = ["above_ema21", "compression", "elevated_rvol", "high_volatility", "rsi_above_50", "rsi_above_70", "rsi_below_30", "trending"];
const SUMMARY_BINDINGS = {
  market_participation: ["market_participation", "share_fraction", "above_ema21"],
  relative_volume_24h: ["relative_volume_24h", "ratio", "median_relative_volume_24h"],
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
function unique(values) {
  return values.length === new Set(values).size;
}
function exactKeys(value, keys) {
  require(Object.keys(object(value)).sort().join("|") === [...keys].sort().join("|"), "Invalid semantic binding keys");
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
  exactKeys(frame.asset_metric_refs, Object.keys(ASSET_UNITS));
  exactKeys(frame.asset_predicate_refs, PREDICATES);
  for (const [key, ref] of Object.entries(frame.asset_metric_refs))
    require(byId[ref.metric_id]?.series_unit === ASSET_UNITS[key], "Asset metric unit differs from semantic binding");
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
  for (const [key, [metricId, unit, definitionId]] of Object.entries(SUMMARY_BINDINGS))
    binding(frame.summary.metric_refs[key].metric_id, metricId, unit, definitionId);
  for (const row of frame.breadth)
    for (const [key, [unit, definitionId]] of Object.entries(BREADTH_BINDINGS))
      binding(row.metric_refs[key].metric_id, `breadth_${row.horizon_minutes}_${key}`, unit, definitionId);
  for (const row of frame.pressure)
    binding(row.metric_id, `pressure_${row.horizon_minutes}`, "index_minus3_to3", "breadth_pressure");
  for (const row of frame.participation)
    binding(row.metric_id, `participation_${row.predicate_id}`, "share_fraction",
      PARTICIPATION_DEFINITIONS[row.predicate_id]);
  for (const row of frame.distribution)
    require(row.definition_ref.definition_id === "return_distribution_40_bins" &&
      row.definition_ref.unit === "return_percent", "Distribution semantic definition mismatch");
  if (frame.comparisons) {
    const summaryDeltas = {
      market_participation: ["percentage_points", "share_delta"],
      relative_volume_24h: ["ratio_points", "rvol_delta"],
      trend_strength: ["index_points", "trend_strength_delta"],
      realized_volatility_24h: ["percentage_points", "volatility_delta"],
    };
    for (const [key, ref] of Object.entries(frame.comparisons.metric_refs)) {
      const [family, semantic] = key.split("/");
      const [unit, definitionId] = family === "summary" ? summaryDeltas[semantic]
        : family === "pressure" ? ["index_points", "breadth_pressure_delta"]
          : ["percentage_points", "share_delta"];
      binding(ref.metric_id, `delta.${family}.${semantic}`, unit, definitionId);
    }
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
  summary.rvol_24h = summary.relative_volume_24h;
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
    summary,
    flow: {
      status: frame.flow_ref?.status ?? "unavailable",
      reasons: frame.flow_ref?.reason_codes ?? ["SOURCE_UNAVAILABLE"],
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
