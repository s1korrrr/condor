import { readCandleStore } from "./candle-store-api";
import { BOT_MARKET, MARKET_COINS, type CandleRead } from "./market-model.mjs";
import { hasPaperCandlePair, type Symbols } from "./paper-candles";

/** The owner's candle response for one pair; `pair` and `venue` are what the owner says it served. */
export type BotCandles = CandleRead & { pair?: string; venue?: string };
export type BotCoin = { coin: string; pair: string; state: "ok" | "missing" | "error"; read: BotCandles | null; error: string | null; receivedAt: number };
type Reader = <T>(view: string, params?: Record<string, string>) => Promise<T>;

const VENUES: Record<string, string> = { binance: "Binance", okx: "OKX" };
export const venueTitle = (venue: string) => VENUES[venue] ?? venue.replace("_io", ".io");

/** "OKX spot · BNB-USDC": the venue and the pair a price is for, so no price is read as another market's. */
export const marketLabel = (venue: string, pair: string) => `${venueTitle(venue)} spot · ${pair}`;
export const botPair = (coin: string) => `${coin}-${BOT_MARKET.quote}`;

/** true / false from the store's symbol list; null when the list was not read (the price read then answers). */
export function botPresence(symbols: Symbols | undefined, pair: string): boolean | null {
  return Array.isArray(symbols?.rows) ? hasPaperCandlePair(symbols, pair) : null;
}

/**
 * The five bot coins' OKX -USDC candles, one read at a time (the candle owner serves two reads at once and the
 * Binance view and the cross-venue table share them). Each coin is reported as soon as it is read.
 * A pair the symbol list lacks is "missing" without a read; a read that fails or answers for another pair is an error.
 */
export async function readBotMarket({ range, symbols, signal, onCoin, read = readCandleStore }: { range: string; symbols?: Symbols; signal?: AbortSignal; onCoin?: (row: BotCoin) => void; read?: Reader }): Promise<BotCoin[]> {
  const rows: BotCoin[] = [];
  for (const coin of MARKET_COINS) {
    signal?.throwIfAborted();
    const pair = botPair(coin);
    let row: BotCoin = { coin, pair, state: "missing", read: null, error: null, receivedAt: Date.now() };
    if (botPresence(symbols, pair) !== false) {
      try {
        const candles = await read<BotCandles>("candles", { lane: BOT_MARKET.spot, pair, range });
        const wrong = candles.pair !== undefined && candles.pair !== pair ? candles.pair : candles.venue !== undefined && candles.venue !== BOT_MARKET.venue ? `${candles.venue} ${candles.pair ?? pair}` : null;
        row = wrong ? { ...row, state: "error", error: `The owner answered for ${wrong}, not ${marketLabel(BOT_MARKET.venue, pair)}.`, receivedAt: Date.now() } : { ...row, state: "ok", read: candles, receivedAt: Date.now() };
      } catch (cause) {
        row = { ...row, state: "error", error: cause instanceof Error ? cause.message : "owner read unavailable", receivedAt: Date.now() };
      }
    }
    rows.push(row);
    onCoin?.(row);
  }
  return rows;
}

/** A refresh replaces one coin at a time, so coins not yet re-read keep their row and a failed read never keeps an old success. */
export function withCoin(rows: BotCoin[] | undefined, row: BotCoin): BotCoin[] {
  const next = [...(rows ?? [])];
  const index = next.findIndex(item => item.coin === row.coin);
  if (index >= 0) next[index] = row; else next.push(row);
  return MARKET_COINS.flatMap(coin => next.filter(item => item.coin === coin));
}
