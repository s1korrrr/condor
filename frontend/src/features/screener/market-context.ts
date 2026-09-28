import type { MetricValue, MetricStatus } from "./contracts";

export interface ContextStatus {
  status: MetricStatus;
  reason_codes: string[];
}
export interface BreadthHorizon extends ContextStatus {
  advancing: number;
  declining: number;
  unchanged: number;
  denominator: number;
  subscribed_denominator: number;
  omitted: number;
  positive_percent: string | null;
  median_return_pct: string | null;
  equal_weight_mean_return_pct: string | null;
  dispersion_population_std_pct: string | null;
  systemic_downside_pct: string | null;
  best: { instrument_id: string; return_pct: string } | null;
  worst: { instrument_id: string; return_pct: string } | null;
  cutoff: string | null;
}
export interface MarketContext {
  schema_version: "market-context.v1";
  feature_set_version: string;
  source: {
    source_id: string;
    source_revision: string;
    interval: string;
    observed_at: string | null;
    common_cutoff: string | null;
    cutoff_policy: "newest_fresh_recorded_close";
    venue: string;
    lane: string;
    quote_asset: string;
    subscribed_count: number;
    aligned_count: number;
    omitted_count: number;
    completeness: string;
    reason_codes: string[];
  };
  definitions: Record<string, unknown>;
  breadth: {
    horizons: Record<string, BreadthHorizon>;
    participation: Record<
      string,
      ContextStatus & {
        count: number;
        denominator: number;
        subscribed_denominator: number;
        omitted: number;
        percent: string | null;
      }
    >;
  };
  correlations: {
    window_returns: number;
    edge_threshold_abs: string;
    matrix: Record<
      string,
      Record<
        string,
        ContextStatus & { value: string | null; sample_count: number }
      >
    >;
    summary: ContextStatus & {
      pair_count: number;
      valid_pair_count: number;
      mean_off_diagonal: string | null;
      dense_pair_count: number;
    };
  };
  assets: Array<{
    instrument_id: string;
    relative_strength: {
      vs_benchmarks: Record<
        string,
        Record<
          string,
          ContextStatus & { difference_percentage_points: string | null }
        >
      >;
    };
    trend_snapshot: {
      alignment: { value: string | boolean | null; status: MetricStatus };
      adx_14: MetricValue;
      plus_di_14: MetricValue;
      minus_di_14: MetricValue;
      rsi_14: MetricValue;
      atr_pct_14: MetricValue;
      realized_volatility_20: MetricValue;
    };
    producer_context: ContextStatus & {
      observed_at: string | null;
      fields: {
        regime_label: string | null;
        regime_confidence: string | null;
        trend_direction: string | null;
        trend_confidence: string | null;
        buy_context_bias: string | null;
      };
    };
  }>;
  capabilities: Array<{
    id: string;
    availability: string;
    source_id?: string;
    reason_codes?: string[];
  }>;
}
