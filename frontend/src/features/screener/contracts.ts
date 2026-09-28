export type MetricStatus =
  | "valid"
  | "warming"
  | "stale"
  | "unavailable"
  | "invalid";
export type MarketLane = "spot" | "perpetual" | "dated_future" | "dex_spot";

export interface MetricValue {
  value: string | null;
  unit: string;
  definition_id: string;
  definition_version: string;
  status: MetricStatus;
  reason_codes: string[];
  observed_at: string | null;
  available_at: string | null;
  window_start: string | null;
  window_end: string | null;
  sample_count: number;
  required_samples: number;
  source_id: string;
  source_revision: string;
}

export interface ScreenerRow {
  instrument_id: string;
  venue: string;
  lane: MarketLane;
  exchange_symbol: string;
  base_asset: string;
  quote_asset: string;
  controller_id?: string | null;
  native_registry_reference?: {
    bot_name: string;
    controller_id: string | null;
    source_id: string;
  };
  metrics: Record<string, MetricValue>;
  descriptors: Record<
    string,
    {
      value: string | boolean | null;
      status: MetricStatus;
      reason_codes: string[];
    }
  >;
  match_reasons: string[];
  excluded_reasons: string[];
  rank: number | null;
}

export interface ScreenerEnvelope {
  schema_version: "condor-screener.v1";
  snapshot_id: string;
  server_id: string;
  source_id: string;
  source_revision: string;
  universe_id: string;
  universe_revision: string;
  lane: MarketLane;
  venue: string;
  quote_asset: string;
  interval: string;
  generated_at: string;
  observed_at: string | null;
  feature_set_version: string;
  query_hash: string;
  counts: {
    listed: number | null;
    subscribed: number;
    ready: number;
    stale: number;
    invalid: number;
    unavailable: number;
    warming: number;
    excluded: number;
    matched: number;
  };
  completeness: "complete" | "partial" | "unavailable";
  reason_codes: string[];
  rows: ScreenerRow[];
  next_cursor: string | null;
}

export interface ScreenerCapabilities {
  schema_version?: string;
  generated_at?: string;
  bot_name?: string;
  eligible?: boolean;
  availability?: "available" | "unavailable";
  source_id?: string | null;
  source_revision?: string | null;
  venue?: string | null;
  lane?: MarketLane | null;
  quote_asset?: string | null;
  universe_id?: string | null;
  universe_revision?: string | null;
  supported_intervals?: string[];
  default_interval?: string;
  screens?: Array<{ id: string; label: string }>;
  metrics?: Array<{
    id: string;
    unit: string;
    definition_id: string;
    definition_version: string;
    availability: string;
    reason_codes: string[];
  }>;
  limits?: {
    snapshot_default: number;
    snapshot_max: number;
    export_max: number;
    candles_default: number;
    candles_max: number;
    history_max: number;
    filters_max: number;
    snapshot_warmup_bars_per_instrument?: number;
    source_row_budget?: number;
    max_full_warmup_instruments?: number;
    source_response_max_bytes?: number;
  };
  reason_codes?: string[];
  optional_capabilities?: Record<
    string,
    { status: MetricStatus; reason_codes: string[] }
  >;
}
export interface ScreenerOwnerOption {
  bot_name: string;
  eligible: boolean;
  source_id: string | null;
  venue: string;
  lane: MarketLane;
  quote_asset: string;
  intervals: string[];
  reason_codes?: string[];
}
export interface ScreenerOwnerIndex {
  availability: "available" | "unavailable";
  owners: ScreenerOwnerOption[];
  default_bot: string | null;
  reason_codes: string[];
}

export interface ScreenerInstrumentResponse {
  snapshot_id: string;
  instrument: ScreenerRow;
}
export interface ScreenerCandle {
  timestamp: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string | null;
  quote_volume: string | null;
  closed_at: string;
  available_at: string | null;
}
export interface ScreenerCandlesEnvelope {
  schema_version: "condor-screener-candles.v1";
  snapshot_id: string;
  instrument_id: string;
  interval: string;
  generated_at: string;
  observed_at: string | null;
  availability: "reconstructed";
  source_id: string;
  source_revision: string;
  completeness: "complete" | "partial" | "unavailable";
  quote_asset?: string;
  reason_codes: string[];
  candles: ScreenerCandle[];
}
export interface ScreenerHistoryEnvelope {
  schema_version: "condor-screener-history.v1";
  instrument_id: string;
  venue: "okx";
  lane: "spot";
  quote_asset: "USDC";
  interval: string;
  availability: "reconstructed";
  kind: "candle_reconstruction";
  snapshot_history_available: false;
  generated_at: string;
  source_id: string;
  source_revision: string | null;
  observed_at: string | null;
  completeness: "complete" | "partial" | "unavailable";
  reason_codes: string[];
  records: Array<{
    record_id: string;
    instrument_id: string;
    timestamp: number;
    as_of: string;
    availability: "reconstructed";
    source_id: string;
    source_revision: string | null;
    feature_set_version: string;
    candle: ScreenerCandle;
    metrics: Record<string, MetricValue>;
  }>;
}

export interface ScreenPredicate {
  metric: string;
  operator: "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "is_unavailable";
  value?: string;
}
export interface ScreenFilter {
  op: "and" | "or";
  predicates: ScreenPredicate[];
}
export interface ScreenerQuery {
  screen: string;
  interval: string;
  limit: number;
  search: string;
  cursor?: string;
  filters?: ScreenFilter;
}

export interface SavedView {
  name: string;
  screen: string;
  interval: string;
  search: string;
  filters: ScreenFilter | null;
  columns: string[];
  sortMetric?: string;
  sortDirection?: "asc" | "desc";
  display?: "table" | "heatmap";
  compareIds?: string[];
}
export interface ScreenerNote {
  instrument_id: string;
  text: string;
  updated_at: string;
}
export interface ScreenerStorage {
  version: 1;
  views: SavedView[];
  watchlist: string[];
  notes: ScreenerNote[];
}
export interface SharedView {
  screen: string;
  interval: string;
  search: string;
  filters: ScreenFilter | null;
  server?: string | null;
  bot?: string | null;
  sort?: string;
  direction?: "asc" | "desc";
}
export interface ResearchQuery extends SharedView {
  watchlist_ids: string[];
}
