import { useQuery } from "@tanstack/react-query";
import type { RecordedMinute } from "@/components/charts/RecordedCandleChart";
import { readCandleStore } from "./candle-store-api";

export const PAIRS = ["BNB-USDC", "BTC-USDC", "ETH-USDC", "SOL-USDC", "XRP-USDC"];
export type Candles = { pair: string; venue: string; volume_unit: string; start: number; end: number; buckets: RecordedMinute[] };
export type Symbols = { rows: { lane: string; pair: string }[] };

export function hasPaperCandlePair(symbols: Symbols | undefined, pair: string) {
  return Array.isArray(symbols?.rows) && symbols.rows.some(row => row?.lane === "okx__spot" && row?.pair === pair);
}

export function latestFinalCandle(buckets: RecordedMinute[] | undefined) {
  if (!Array.isArray(buckets)) return null;
  let latest: { close: number; at: number } | null = null;
  for (const row of buckets) {
    if (!Array.isArray(row) || row[6] !== 1 || typeof row[4] !== "number" || !Number.isFinite(row[4]) || row[4] <= 0 || !Number.isSafeInteger(row[0])) continue;
    const at = (row[0] + 60) * 1000;
    if (Number.isSafeInteger(at) && (!latest || at > latest.at)) latest = { close: row[4], at };
  }
  return latest;
}

export function usePaperCandleSymbols(enabled: boolean) {
  return useQuery({ queryKey: ["v5-bots-candle-symbols"], queryFn: () => readCandleStore<Symbols>("symbols"), enabled, retry: false, staleTime: 55_000, refetchInterval: 60_000 });
}

export function paperCandleQuery(pair: string, range: string, enabled: boolean) {
  return { queryKey: ["v5-bots-candles", pair, range], queryFn: () => readCandleStore<Candles>("candles", { lane: "okx__spot", pair, range }), enabled, retry: false, staleTime: 55_000, refetchInterval: 60_000 };
}
