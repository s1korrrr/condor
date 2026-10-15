/** Display types resolve owner observations; no estimator or trading policy lives here. */
export type Horizon = "1" | "5" | "15" | "60" | "240" | "1440";
export interface DisplayMetric {
  value: number | null;
  original: string | null;
  unit: string;
  status: string;
  reasons: string[];
  valid: number;
  expected: number;
  available: number | null;
  expires: number | null;
  definition: string;
}
export interface DisplayRegime {
  label: string;
  origin: string;
  confidence: string | null;
  confidenceKind: string | null;
  calibration: string;
  trend: string | null;
  context: string | null;
  available: number;
  model: string | null;
}
export interface DisplayAsset {
  instrument_id: string;
  symbol: string;
  quote: string;
  sector: string;
  price: DisplayMetric;
  returns: Record<string, DisplayMetric>;
  indicators: Record<string, DisplayMetric>;
  predicates: Record<string, DisplayMetric>;
  relative: Record<string, DisplayMetric>;
  regimes: DisplayRegime[];
  weight: number | null;
}
export interface DisplayBreadth {
  advancing: number;
  declining: number;
  unchanged: number;
  valid: number;
  expected: number;
  positive: DisplayMetric;
  negative: DisplayMetric;
  flat: DisplayMetric;
}
export interface DisplayBreadthTrajectory {
  horizon: number;
  interval: number;
  cutoff: number;
  matched: number;
  expected: number;
  membership: string | null;
  level: DisplayMetric;
  change: DisplayMetric;
  velocity: DisplayMetric;
  acceleration: DisplayMetric;
  shareChange?: DisplayMetric | null;
}
export interface DisplayHourlyInternals {
  interval: number;
  cutoff: number;
  decisionAvailable: number;
  expires: number | null;
  sourceKind: string;
  sourceDigest: string;
  sourceCount: number;
  expected: number;
  metrics: Record<string, DisplayMetric>;
}
export interface DisplayCandleAnomalies {
  interval: number;
  cutoff: number;
  decisionAvailable: number;
  expires: number | null;
  sourceKind: string;
  sourceHash: string;
  sourceCount: number;
  expected: number;
  metrics: Record<string, {
    definitionId: string;
    definitionHash: string;
    valid: number;
    expected: number;
    high: number | null;
    share: number | null;
    values: Record<string, 0 | 1 | null>;
    reasons: string[];
  }>;
}
export interface DisplayRelativeStrengthChanges {
  baselineSnapshotId: string | null;
  baselineCutoff: number | null;
  currentCutoff: number;
  interval: number;
  definitionId: string;
  definitionHash: string;
  sourceHash: string | null;
  cohortHash: string | null;
  expected: number;
  valid: number;
  reasons: string[];
  rankDeltas: Record<string, number | null>;
}
export interface DisplayBreadthDivergence {
  benchmark: string;
  horizon: number;
  interval: number;
  cutoff: number;
  matched: number;
  expected: number;
  membership: string | null;
  metric: DisplayMetric;
}
export interface DisplayContribution {
  horizon: number;
  expected: number;
  valid: number;
  startCohortAvailable: boolean;
  priorWeightsAvailable: boolean;
  equalReturn: DisplayMetric;
  cappedReturn: DisplayMetric;
  equalTop5: DisplayMetric;
  cappedTop5: DisplayMetric;
}
export interface DisplayNormalizedBreadth {
  horizon: number;
  cutoff: number;
  valid: number;
  expected: number;
  advances: DisplayMetric;
  declines: DisplayMetric;
  unchanged: DisplayMetric;
  pressure: DisplayMetric;
}
export interface DisplaySourceCapability {
  sourceId: string;
  family: string;
  venueProfile: string;
  endpoint: string;
  qualification: "not_probed" | "probed" | "collecting" | "not_qualified" | "qualified";
  operational: string;
  sourceContractHash: string;
  instrumentIds: string[];
  units: string[];
  historySemantics: string;
  access: string;
  cadenceMs: number;
  maxRecords: number;
  licenseBasis: string;
  probeReceiptHash: string | null;
  probedAtMs: number | null;
  collectedAtMs: number | null;
  collectionReceiptHash: string | null;
  qualifiedAtMs: number | null;
  qualificationReceiptHash: string | null;
  qualificationContractHash: string | null;
  reasons: string[];
}
export interface DisplayDailyCell {
  metricId: string;
  definitionId: string;
  metric: DisplayMetric;
  samples: number;
  required: number;
  label: string | null;
}
export interface DisplayDailyInternals {
  instrumentId: string;
  interval: string;
  cutoff: number;
  frameCutoff: number;
  sourceReasons: string[];
  decisionAvailable: number;
  source: {
    providerId: string;
    pair: string;
    streamEpoch: string;
    streamSequence: number;
    sourceEpoch: string;
    sourceSequence: number;
    sourceKind: string;
    cutoff: number;
    available: number;
    expires: number;
  } | null;
  sourceCoverageStatus: string;
  sourceCoverage: { expectedBars: number; validBars: number; gaps: number };
  contiguousBars: number;
  breaks: Record<string, DisplayDailyCell>;
  averages: Record<string, Record<string, DisplayDailyCell>>;
}
export interface DisplayFlowObservation {
  instrumentId: string; sourceId: string; inputDigest: string; quoteAsset: string; channel: string;
  windowStart: number; windowEnd: number; available: number; expires: number;
  resetId: string; resetAt: number; coverageStart: number; coverageEnd: number;
  gaps: Array<[number, number]>;
  buyQuote: string; sellQuote: string; unknownQuote: string;
  knownImbalance: string | null; confirmationImbalance: string | null; unknownShare: string | null;
  cumulativeBefore: string | null; cumulativeAfter: string | null;
  trades: number; duplicates: number; complete: boolean; reasons: string[];
  capabilityUsable: boolean;
}
export interface DisplayLiquidityObservation {
  instrumentId: string; sourceId: string; channel: string; sequence: number;
  observed: number; available: number; expires: number; access: string;
  side: string; requestedSize: string; sizeUnit: string;
  coveredBase: string; coveredQuote: string; uncovered: string;
  coveredVwap: string | null; vwap: string | null; costBps: string | null;
  costPercentile7d: number | null; costPercentileSampleCount: number; costPercentileExpectedSamples: number;
  costPercentileReasons: string[]; costPercentileReferenceDigest: string | null;
  feeBps: string | null; feeSource: string | null; totalCostBps: string | null;
  spreadBps: string | null; bandBps: string; bidCovered: string; askCovered: string;
  bandComplete: boolean; bandImbalance: string | null; reasons: string[];
  capabilityUsable: boolean;
}
export interface DisplayMicrostructure {
  componentId: string; sourceKind: string; cutoff: number; available: number;
  replayClass: string; rawInputsRetained: false;
  flows: DisplayFlowObservation[]; liquidity: DisplayLiquidityObservation[];
}
export interface DisplayDistribution {
  edges: number[];
  counts: number[];
  total: number;
  median: DisplayMetric;
  mean: DisplayMetric;
  dispersion: DisplayMetric;
  downside: DisplayMetric;
  bestInstrument: string | null;
  worstInstrument: string | null;
}
export interface DisplayFrame {
  snapshot_id: string;
  stream_id: string;
  epoch: string;
  sequence: number;
  payload_digest: string;
  cutoff_ms: number;
  available_at_ms: number;
  expires_at_ms: number;
  source_kind: string;
  fixture_marker?: string;
  flow?: { status: string; reasons: string[] };
  universeId: string;
  universeRevision: string;
  membershipHash: string;
  quote: string;
  expected: number;
  valid: number;
  assets: DisplayAsset[];
  breadth: Record<string, DisplayBreadth>;
  normalizedBreadth: Record<string, DisplayNormalizedBreadth>;
  breadthTrajectory: DisplayBreadthTrajectory[];
  hourlyInternals: DisplayHourlyInternals | null;
  candleAnomalies: DisplayCandleAnomalies | null;
  breadthDivergence: DisplayBreadthDivergence[];
  contributions: Record<string, DisplayContribution>;
  sourceCapabilities: DisplaySourceCapability[];
  dailyInternals: DisplayDailyInternals[];
  microstructure: DisplayMicrostructure | null;
  pressure: Record<string, DisplayMetric>;
  summary: Record<string, DisplayMetric>;
  participation: Record<string, DisplayMetric>;
  comparisons: Record<string, DisplayMetric>;
  comparisonContext: {
    baselineSnapshotId: string | null;
    baselineCutoff: number | null;
    interval: number;
    common: number;
    current: number;
    baseline: number;
    membership: string | null;
  } | null;
  relativeStrengthChanges: DisplayRelativeStrengthChanges | null;
  distribution: Record<string, DisplayDistribution>;
  raw: Record<string, unknown>;
}
export interface HistoryPoint {
  time: number;
  snapshot_id: string | null;
  source_kind: string;
  valid: number;
  expected: number;
  membership: string;
  gapBefore: boolean;
  flowHistory: DisplayFlowHistory | null;
  normalizedBreadth: Record<string, { advances: number | null; declines: number | null; unchanged: number | null; pressure: number | null }>;
  breadthTrajectory: Record<string, {
    level: number | null; change: number | null; velocity: number | null; acceleration: number | null;
    shareChange: number | null; matched: number; expected: number; membership: string | null;
  }>;
  summary: Record<string, number | null>;
  breadth: Record<
    string,
    {
      positive: number | null;
      negative: number | null;
      flat: number | null;
      pressure: number | null;
    }
  >;
}
export interface DisplayFlowHistory {
  componentId: string;
  quoteAsset: string;
  scopeHash: string;
  expectedInstruments: number;
  observedInstruments: number;
  completeInstruments: number;
  buyQuote: string;
  sellQuote: string;
  unknownQuote: string;
  cumulativeDeltaQuote: string | null;
  resetAt: number | null;
  reasons: string[];
}
export interface DisplayCorrelation {
  instrument_id: string;
  benchmark_id: string;
  value: number | null;
  samples: number;
  expected: number;
  /** Owner definition id of the window, for example `pearson_log_1h_168h`. */
  definition?: string;
  cutoff: number;
  reasons: string[];
  trend: Array<{ time: number; value: number | null }>;
}
export interface DisplayEvent {
  event_id: string;
  instrument_id: string | null;
  type: string;
  severity: string;
  observed: number;
  available: number;
  status: string;
  reconstructed: boolean;
  snapshot_id: string;
  /** Breadth horizon of a threshold crossing, when the event states one. */
  horizon_minutes: number | null;
  value: string;
}
export interface ViewSettings {
  horizon: Horizon;
  window: string;
  benchmark: string;
  sector: string;
  selected: string | null;
}

export const missingMetric: DisplayMetric = Object.freeze({
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
});

export function metricTitle(metric: DisplayMetric) {
  return `${metric.original ?? metric.status} ${metric.unit} · ${metric.valid}/${metric.expected} · ${metric.definition} · ${metric.reasons.join(", ")}`;
}
export function numberText(value: number | null, digits = 1, signed = false) {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
    signDisplay: signed ? "exceptZero" : "auto",
  }).format(value);
}
export function metricText(
  metric: DisplayMetric | undefined,
  digits = 1,
  signed = false,
) {
  if (!metric || metric.value == null)
    return metric?.status === "WARMING" ? "Warming" : "—";
  const percent = ["share_fraction", "volatility_fraction_annualized"].includes(
    metric.unit,
  );
  const suffix =
    percent || metric.unit === "return_percent"
      ? "%"
      : metric.unit === "percentage_points"
        ? " pp"
        : metric.unit === "ratio"
          ? "×"
          : metric.unit === "ratio_points"
            ? "× points"
            : metric.unit === "index_points"
              ? " pts"
              : metric.unit === "index_points_per_minute"
                ? " pts/min"
                : metric.unit === "index_points_per_minute_squared"
                  ? " pts/min²"
                  : metric.unit === "index_minus1_to1"
                    ? ""
              : "";
  return (
    numberText(percent ? metric.value * 100 : metric.value, digits, signed) +
    suffix
  );
}
/** Format compact daily cells by their canonical fixed feature identity. */
export function dailyFeatureText(metric: DisplayMetric, metricId: string, label: string | null, quote: string) {
  if (metric.value == null)
    return `${metric.status}${metric.reasons.length ? ` · ${metric.reasons.join(", ")}` : ""}`;
  if (metricId.endsWith("_cross"))
    return label === "cross_up" ? "Crossed above" : label === "cross_down" ? "Crossed below" : label === "none" || metric.value === 0 ? "No cross" : "Unavailable";
  if (metricId.includes("_above_close") || metricId.includes("_break_"))
    return metric.value === 1 ? "Yes" : metric.value === 0 ? "No" : "Unavailable";
  if (/^daily_sma_(20|50|200)$/.test(metricId)) return `${quote} ${numberText(metric.value, 4)}`;
  if (metricId.endsWith("_slope_pct_per_day")) return `${numberText(metric.value, 2, true)}%/day`;
  return metricText(metric, 3, true);
}
