import { useQuery } from "@tanstack/react-query";
import { type RecordedMinute } from "@/components/charts/RecordedCandleChart";
import { readCandleStore } from "./candle-store-api";
import type { PaperRead } from "./contracts";
import { latest } from "./money-model.mjs";
import { paperCompleteRead, paperCompleteRecords, paperExactAmount, paperPairBag, paperPairHoldings, paperTime } from "./policy";
import { activeLots, breakEvenDistance, exactSignedSum, sellOrderCount } from "./bots-position-model.mjs";
import { PAIRS } from "./PaperPriceChart";
import { readMoney } from "./V5Money";

type Symbols = { rows: { lane: string; pair: string }[] };
type Candles = { buckets: RecordedMinute[] };
type Prices = Record<string, { close: number; at: number } | null>;

export function PaperPositions({ positions, decisions, wallet, now }: { positions?: PaperRead; decisions?: PaperRead; wallet?: PaperRead; now: number }) {
  const symbols = useQuery({ queryKey: ["v5-bots-candle-symbols"], queryFn: () => readCandleStore<Symbols>("symbols"), retry: false, refetchInterval: 60_000 });
  const prices = useQuery({ queryKey: ["v5-bots-prices"], enabled: !!symbols.data && !symbols.isError, retry: false, refetchInterval: 60_000, queryFn: async () => {
    const result: Prices = {};
    for (const pair of PAIRS) {
      if (!symbols.data?.rows.some(row => row.lane === "okx__spot" && row.pair === pair)) { result[pair] = null; continue; }
      try {
        const view = await readCandleStore<Candles>("candles", { lane: "okx__spot", pair, range: "24h" });
        const row = view.buckets.at(-1);
        result[pair] = row && row[6] === 1 && typeof row[4] === "number" ? { close: row[4], at: (row[0] + 60) * 1000 } : null;
      } catch { result[pair] = null; }
    }
    return result;
  } });
  const money = useQuery({ queryKey: ["v5-money", "7d"], queryFn: () => readMoney("7d"), retry: false, refetchInterval: 60_000 });
  const newest = !money.isError ? latest(money.data?.rows ?? [], "v5").newest : null;
  const moneyCurrent = newest && !newest.gap && newest.unit === "USDC" && newest.at_ms <= now && now - newest.at_ms <= 30_000 && typeof newest.snapshot_at_ms === "number" && newest.snapshot_at_ms <= now && now - newest.snapshot_at_ms <= 30_000;
  const rows = paperCompleteRecords(positions, now);
  const walletData = paperCompleteRead(wallet, now) && wallet?.data && typeof wallet.data === "object" && !Array.isArray(wallet.data) ? wallet.data as Record<string, unknown> : null;
  const assets = Array.isArray(walletData?.assets) ? walletData.assets as Record<string, unknown>[] : [];
  return <section className="paper-section"><div className="paper-section-heading"><h2>Positions</h2></div><div className="paper-pairs">{PAIRS.map(pair => {
    const coin = pair.split("-")[0];
    const holdings = paperPairHoldings(pair, positions, now);
    const lots = rows && holdings ? activeLots(rows.filter(row => row.trading_pair === pair)) : null;
    const bag = paperPairBag(pair, decisions, positions, now);
    const observed = !prices.isError && !symbols.isError ? prices.data?.[pair] : null;
    const price = observed && observed.at <= now && now - observed.at <= 180_000 ? observed : null;
    const distance = breakEvenDistance(bag?.breakevenPrice, price?.close);
    const coinMoney = moneyCurrent ? newest.coins?.[coin] : null;
    const profit = exactSignedSum(coinMoney?.realized, coinMoney?.unrealized);
    const asset = assets.find(item => item && item.asset === coin);
    const markAt = asset?.mark_at_ms;
    const worth = walletData?.quote_asset === "USDC" && typeof markAt === "number" && markAt <= now && now - markAt <= 30_000 && typeof asset?.marked_value_quote === "string" && /^\d+(\.\d+)?$/.test(asset.marked_value_quote) ? asset.marked_value_quote : null;
    const sellOrders = sellOrderCount(lots);
    return <article className="paper-pair" key={pair}><h3>{coin}</h3><p><strong>{profit === null ? "—" : paperExactAmount(profit, "USDC")}</strong> · profit or loss</p><p className="paper-caption">{profit === null ? "— · current per-coin profit not published" : `Realized plus unrealized · ${paperTime(newest?.at_ms, now)}`}</p>
      <p>{distance === "—" ? "— · current price or breakeven unavailable" : distance}</p><p className="paper-caption">Price: {price ? `${price.close} USDC · ${paperTime(price.at, now)}` : "— · latest closed candle unavailable or old"} · Breakeven: {bag?.breakevenPrice ? `${bag.breakevenPrice} USDC` : "— · not published"}</p>
      {price && bag?.breakevenPrice && distance !== "—" && <progress max={100} value={Math.min(100, price.close / Number(bag.breakevenPrice) * 100)} aria-label={`${coin} price relative to breakeven`} />}
      <dl className="paper-detail"><dt>Holding</dt><dd>{holdings ? paperExactAmount(holdings.total, coin) : "— · position read unavailable"}</dd><dt>Worth now</dt><dd>{typeof worth === "string" ? paperExactAmount(worth, "USDC") : "— · current owner mark unavailable"}</dd><dt>Lots</dt><dd>{lots ? lots.length : "— · position read unavailable"}</dd><dt>Sell orders placed</dt><dd>{sellOrders === null ? "— · owner protection incomplete" : `${sellOrders} · owner-reported protected exits`}</dd></dl>
    </article>;
  })}</div><details><summary>Details</summary><p>Terminal dust is excluded from lot and sell-order counts. Holding includes owner-reported dust.</p></details></section>;
}
