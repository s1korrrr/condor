import type { SeriesPoint } from "@/features/quant-ops/kit/series";

export type MarketCoin = "BTC" | "ETH" | "BNB" | "SOL" | "XRP";
export const MARKET_COINS: MarketCoin[];
export const REFERENCE: { venue: string; quote: string; spot: string; perpetual: string };
export const MINUTES_PER_YEAR: number;

export type CandleRead = { buckets: (number | null)[][]; columns?: string[] } | null | undefined;
export type CoinTile = {
  coin: string; last: number; lastTime: number; firstTime: number; changePct: number; high: number; low: number;
  volatilityPct: number | null; premiumBps: number | null; spark: SeriesPoint[];
};
export type CrossCell = { venue: string; coin: string; pair: string; bps: number; time: number; close: number | null };
export type LaneTile = {
  lane: string; venue: string; segment: string; available: boolean | null; pairs_listed: number | null; pairs_held: number | null;
  coverage_24h: number | null; coverage_7d: number | null; gaps_7d: number | null; last_minute_age_s: number | null; ws_connected?: number | null;
  unavailable_reason?: string | null;
};
export type StoreHealth = {
  lanes: number; lanesLive: number; pairsHeld: number; pairsListed: number;
  coverage7d: number | null; gaps7d: number | null; oldestMinuteAge: number | null;
};

export function closes(read: CandleRead): { t: number; close: number; high: number; low: number }[];
export function coinTile(coin: string, spotRead: CandleRead, perpetualRead: CandleRead): CoinTile | null;
export function indexedReturns(spotRead: CandleRead, step?: number): SeriesPoint[];
export function premiumSeries(spotRead: CandleRead, perpetualRead: CandleRead): SeriesPoint[];
export function averaged(points: SeriesPoint[], bucket?: number): SeriesPoint[];
export function breadth(tiles: (CoinTile | null)[], returnsByCoin: Record<string, SeriesPoint[]>): {
  coins: number; up24h: number; up1h: number; measured1h: number; averagePct: number | null;
};
export function crossLatest(coin: string, view: { series: { venue: string; pair: string; close: [number, number][]; deviation_bps: [number, number][] }[] } | null | undefined): CrossCell[];
export function venueGrid<T extends LaneTile>(tiles: T[]): { venue: string; spot: T | null; perpetual: T | null }[];
export function storeHealth(tiles: LaneTile[]): StoreHealth;

export type CoinStats = {
  minutes: number; windowMinutes: number; return1hPct: number | null; return6hPct: number | null; returnWindowPct: number;
  rangePct: number; maxDrawdownPct: number; volumeQuote: number;
  premium: { mean: number; min: number; max: number; minutes: number } | null;
};
export function coinStats(spotRead: CandleRead, perpetualRead: CandleRead): CoinStats | null;
export const FEATURE_GROUPS: string[];
export type FeatureRow = { id: string; group: string; label: string; unit: string; status: string; value: unknown; numeric: number | null; text: string };
export function featureText(value: unknown, unit: string | undefined): string;
export function featureRows(features: Record<string, { status?: string; unit?: string; value?: unknown }> | null | undefined): FeatureRow[];
