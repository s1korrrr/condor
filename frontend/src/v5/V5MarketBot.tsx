import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { SparkChart } from "@/features/quant-ops/kit/charts";
import { TileGrid } from "@/features/quant-ops/kit/grid";
import { ageSeconds, BOT_MARKET, coinTile, MARKET_COINS } from "./market-model.mjs";
import { candleCurrent, windowChange } from "./market-header";
import { botPair, marketLabel, readBotMarket, withCoin, type BotCoin } from "./market-bot";
import { usePaperCandleSymbols } from "./paper-candles";
import { age as ageShort, ownerTitleText, pct, price, utcMin } from "./format.mjs";

const REFRESH_MS = 60_000;
const ageText = (seconds: number | null) => seconds == null ? "age unknown" : `${ageShort(seconds)} ago`;

/**
 * "Bot market": the candle store's okx__spot -USDC series for the five bot coins, the market the bots trade.
 * Starts after the Binance view settles and reads one coin at a time, painting each coin as it arrives.
 */
export function V5BotMarket({ range, enabled, now, color, holding }: { range: string; enabled: boolean; now: number; color: Record<string, string>; holding: (coin: string, last: number | null) => ReactNode }) {
  const symbols = usePaperCandleSymbols(enabled);
  // Rows arrive one coin at a time while the query runs; they are kept per range so a range change never shows the old range's rows.
  const [progress, setProgress] = useState<{ range: string; rows: BotCoin[] }>({ range, rows: [] });
  const reads = useQuery({ queryKey: ["v5-market", "bot", range], enabled: enabled && !symbols.isPending, retry: false, refetchInterval: REFRESH_MS, queryFn: ({ signal }) =>
    readBotMarket({ range, symbols: symbols.data, signal, onCoin: row => setProgress(previous => ({ range, rows: withCoin(previous.range === range ? previous.rows : [], row) })) }) });
  const rows = progress.range === range && progress.rows.length ? progress.rows : reads.data ?? [];
  const waiting = !enabled ? "Waiting for the Binance view…" : symbols.isPending ? "Reading the store's symbol list…" : "Reading…";
  return <section className="v5m-section" aria-label="Bot market">
    <header><h2>Bot market</h2><span>{marketLabel(BOT_MARKET.venue, `*-${BOT_MARKET.quote}`)} · the pairs the V5 bots trade · {range}</span></header>
    <p className="v5m-hint">The candle store's {BOT_MARKET.spot} lane, one coin at a time after the Binance view (5 price reads and one symbol list per refresh).{symbols.isError ? ` The symbol list could not be read (${symbols.error.message}); each price read says whether its pair exists.` : ""}</p>
    <TileGrid label="Bot market coins" min={200}>{MARKET_COINS.map(coin => {
      const row = rows.find(item => item.coin === coin);
      const pair = botPair(coin);
      const tile = row?.state === "ok" ? coinTile(coin, row.read, null) : null;
      const current = row?.state === "ok" && candleCurrent(row.read, row.receivedAt, now);
      const change = current ? windowChange(row!.read) : null;
      const seconds = tile && row?.read ? ageSeconds(tile.lastTime, row.read, row.receivedAt, now) : null;
      const label = marketLabel(row?.read?.venue ?? BOT_MARKET.venue, row?.read?.pair ?? pair);
      return <article key={coin} className="v5m-card v5m-coin" data-bot-market={coin}>
        <div className="v5m-coin-top"><span className="v5m-sym"><i style={{ background: color[coin] }} />{coin}</span>{tile && <span className="v5m-change">{range} {change == null ? "—" : pct(change)}</span>}</div>
        <small className="v5m-asof">{label}</small>
        {!row ? <p className="v5m-hint" role="status">{reads.isError ? "Prices unavailable." : waiting}</p>
          : row.state === "missing" ? <><strong className="v5m-price">—</strong><p className="v5m-hint">Not in the candle store: {BOT_MARKET.spot} {pair} is not in its symbol list.</p></>
          : row.state === "error" ? <><strong className="v5m-price">—</strong><p className="v5m-hint">Price unavailable. {row.error}</p></>
          : !tile ? <><strong className="v5m-price">—</strong><p className="v5m-hint">No recorded prices in the selected {range}.</p></>
          : <>
            <strong className="v5m-price" title={ownerTitleText(current ? String(tile.last) : undefined)}>{current ? `${price(tile.last)} ${BOT_MARKET.quote}` : "—"}</strong>
            <small className={`v5m-asof${current ? "" : " is-old"}`}>{current ? "Close" : "— close not current"} · {utcMin((tile.lastTime + 60) * 1000) ?? "unknown"} · {ageText(seconds)}</small>
            {change == null && <small className="v5m-asof">{range} change unavailable. {current ? "A price at the start of the period is missing or unusable." : "A recent price at the end of the period is needed."}</small>}
            <SparkChart points={tile.spark} color={color[coin]} height={44} format={price} unit={BOT_MARKET.quote} ariaLabel={`${coin} ${label} recorded prices, ${range}, breaks where minutes are missing`} />
            {holding(coin, current ? tile.last : null)}
          </>}
      </article>;
    })}</TileGrid>
  </section>;
}
