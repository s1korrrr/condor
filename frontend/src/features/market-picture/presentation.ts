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
  pressure: Record<string, DisplayMetric>;
  summary: Record<string, DisplayMetric>;
  participation: Record<string, DisplayMetric>;
  comparisons: Record<string, DisplayMetric>;
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
export interface DisplayCorrelation {
  instrument_id: string;
  benchmark_id: string;
  value: number | null;
  samples: number;
  expected: number;
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
  if (value == null || !Number.isFinite(value)) return "Unavailable";
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
    return metric?.status === "WARMING" ? "Warming" : "Unavailable";
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
              : "";
  return (
    numberText(percent ? metric.value * 100 : metric.value, digits, signed) +
    suffix
  );
}
