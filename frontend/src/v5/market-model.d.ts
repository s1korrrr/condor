import type { SeriesPoint } from "@/features/quant-ops/kit/series";

export type MarketCoin = "BTC" | "ETH" | "BNB" | "SOL" | "XRP";
export const MARKET_COINS: MarketCoin[];
export const REFERENCE: { venue: string; quote: string; spot: string; perpetual: string };
export const STALE_AFTER_S: number;

/** Owner candle window as the server forwards it: dense minutes, `end` = last closed minute, owner `now` and totals. */
export type CandleRead = { buckets: (number | null)[][]; start: number; end: number; now: number; totals?: Record<string, number> };
export type Minute = { t: number; high: number | null; low: number | null; close: number | null; volume: number | null };
export type CoinTile = {
  coin: string; last: number; lastTime: number; changePct: number | null; change1hPct: number | null;
  high: number; low: number; heldMinutes: number; windowMinutes: number; premiumBps: number | null; premiumTime: number | null; spark: SeriesPoint[];
};
export type LaneTile = {
  lane: string; venue: string; segment: string; available: boolean | null; pairs_listed: number | null; pairs_held: number | null;
  coverage_24h: number | null; coverage_7d: number | null; gaps_7d: number | null; last_minute_age_s: number | null; ws_connected?: number | null;
  unavailable_reason?: string | null;
};
export type StoreHealth = {
  lanes: number; lanesLive: number; lanesUnknown: number; pairsHeld: number | null; pairsListed: number | null;
  coverage7d: number | null; gaps7d: number | null; oldestMinuteAge: number | null;
  unreported: { pairs: number; coverage: number; gaps: number; age: number };
};
export type CoinStats = {
  heldMinutes: number; windowMinutes: number; returnWindowPct: number | null; return1hPct: number | null;
  rangePct: number; maxDrawdownPct: number | null; volumeQuote: number | null; volumeMissingMinutes: number;
  premium: { mean: number; min: number; max: number; minutes: number } | null;
};

export function grid(read: CandleRead | null | undefined): Minute[] | null;
export function pct(value: number | null | undefined, base: number | null | undefined): number | null;
export function ageSeconds(minuteT: number, read: CandleRead, receivedAtMs: number, nowMs: number): number;
export function coinTile(coin: string, spotRead: CandleRead | null | undefined, perpetualRead: CandleRead | null | undefined): CoinTile | null;
export function indexedReturns(spotRead: CandleRead | null | undefined): SeriesPoint[];
export function premiumSeries(spotRead: CandleRead | null | undefined, perpetualRead: CandleRead | null | undefined): SeriesPoint[];
export function breadth(tiles: (CoinTile | null)[]): { measured: number; up: number; measured1h: number; up1h: number; averagePct: number | null };
export function venueGrid<T extends LaneTile>(tiles: T[]): { venue: string; spot: T | null; perpetual: T | null }[];
export function storeHealth(tiles: LaneTile[]): StoreHealth;
export function coinStats(spotRead: CandleRead | null | undefined, perpetualRead: CandleRead | null | undefined): CoinStats | null;
export const FEATURE_GROUPS: string[];
export type FeatureRow = { id: string; group: string; label: string; unit: string; status: string; value: unknown; numeric: number | null; text: string };
export function featureText(value: unknown, unit: string | undefined): string;
export function featureRows(features: Record<string, { status?: string; unit?: string; value?: unknown }> | null | undefined): FeatureRow[];
