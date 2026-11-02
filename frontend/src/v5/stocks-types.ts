import type { RecordedMinute } from '@/components/charts/RecordedCandleChart';

export type StockRegion = 'eea' | 'global';
export type StockProduct = 'SPOT' | 'SWAP' | 'FUTURES';
export type StockFilter = 'ALL' | StockProduct;
export type StockState = 'disabled' | 'starting' | 'empty' | 'live' | 'stale' | 'error';
export type StockRange = '1h' | '6h' | '24h' | '7d';
export type SummaryDataset = 'ticker' | 'mark_price' | 'index_price' | 'funding' | 'open_interest';
export type PublicDataset = SummaryDataset | 'books' | 'trades';
export type ChannelState = 'waiting' | 'live' | 'stale' | 'gap' | 'error' | 'unavailable';

export interface StockInstrument {
  instId: string;
  instType: StockProduct;
  instCategory: '3';
  state?: string | null;
  ruleType?: string | null;
  baseCcy?: string | null;
  quoteCcy?: string | null;
  settleCcy?: string | null;
  uly?: string | null;
  ctVal?: string | null;
  ctMult?: string | null;
  ctValCcy?: string | null;
  lotSz?: string | null;
  tickSz?: string | null;
  minSz?: string | null;
  listTime?: string | null;
  expTime?: string | null;
  [field: string]: unknown;
}

export interface PublicEvent {
  region: StockRegion;
  instId: string;
  instType: StockProduct;
  dataset: PublicDataset;
  event_time_ms: number | null;
  received_at_ms: number;
  source: 'rest' | 'ws';
  data: Record<string, unknown>;
  action?: 'snapshot' | 'update';
  projection?: 'top50_from_standard_books';
}

export interface StockChannel {
  state: ChannelState;
  event_time_ms: number | null;
  received_at_ms: number | null;
  age_s: number | null;
  reason: string | null;
}

export interface StockCoverage {
  capture_started_at: number | null;
  candle_start: number | null;
  candle_end: number | null;
  historical_trades: false;
  historical_books: false;
}

export interface StockDiscovery {
  complete: boolean;
  families: Partial<Record<StockProduct, { total: number; classified: number; unclassified: number; stocks: number }>>;
  warnings: string[];
}

export interface StockRow {
  instrument: StockInstrument;
  latest: Record<SummaryDataset, PublicEvent | null>;
  channels: Record<string, StockChannel>;
  coverage: StockCoverage;
}

export interface StockEnvelope {
  now: number;
  region: StockRegion;
  state: StockState;
  catalog_at: number | null;
  updated_at: number | null;
  reason: string | null;
  discovery?: StockDiscovery | null;
}

export interface StockCatalog extends StockEnvelope {
  format: 'okx-stocks-v1';
  rows: StockRow[];
}

export interface StockMarket extends StockEnvelope {
  format: 'okx-stock-market-v1';
  instId: string;
  instType: StockProduct;
  latest: Record<SummaryDataset | 'books', PublicEvent | null>;
  recent_trades: PublicEvent[];
  book_depth: { bids: number; asks: number } | null;
  channels: Record<string, StockChannel>;
  coverage: StockCoverage;
}

export interface StockCandles {
  format: 'okx-stock-candles-v1';
  now: number;
  region: StockRegion;
  instId: string;
  instType: StockProduct;
  state: StockState;
  reason: string | null;
  range: StockRange;
  res_s: 60;
  start: number;
  end: number;
  volume_unit: string;
  price_basis: 'trade';
  adjustment: 'raw';
  buckets: RecordedMinute[];
  totals: Record<'final' | 'no_trade' | 'unrecoverable' | 'missing' | 'pending' | 'corrections', number>;
}

export interface ObservationSource {
  state: StockState;
  now: number;
  latest: Partial<Record<PublicDataset, PublicEvent | null>>;
  channels: Record<string, StockChannel>;
}
