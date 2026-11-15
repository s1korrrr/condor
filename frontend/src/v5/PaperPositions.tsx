import type { PaperRead } from "./contracts";
import { latest } from "./money-model.mjs";
import { paperCompleteRead, paperCompleteRecords, paperExactAmount, paperPairBag, paperPairHoldings, paperTime, paperWords } from "./policy";
import { activeLots, breakEvenDistance, exactSignedSum, sellOrderCount, moneySampleState } from "./bots-position-model.mjs";
import { PAIRS, type Candles } from "./paper-candles";
import type { MoneyRead } from "./money-api";
import { utcMinute } from "./shown.mjs";

export function PaperPositions({ positions, decisions, wallet, now, valuesAt = now, prices = {}, money }: { positions?: PaperRead; decisions?: PaperRead; wallet?: PaperRead; now: number; valuesAt?: number; prices?: Record<string, Candles | undefined>; money?: MoneyRead }) {
  const newest = latest(Array.isArray(money?.rows) ? money.rows : [], "v5").newest;
  const sample = moneySampleState(newest, now);
  const rows = paperCompleteRecords(positions, valuesAt);
  const walletData = paperCompleteRead(wallet, valuesAt) && wallet?.data && typeof wallet.data === "object" && !Array.isArray(wallet.data) ? wallet.data as Record<string, unknown> : null;
  const assets = Array.isArray(walletData?.assets) ? walletData.assets as Record<string, unknown>[] : [];
  return <section className="paper-section"><div className="paper-section-heading"><h2>Positions</h2></div><div className="paper-pairs">{PAIRS.map(pair => {
    const coin = pair.split("-")[0];
    const holdings = paperPairHoldings(pair, positions, valuesAt);
    const lots = rows && holdings ? activeLots(rows.filter(row => row.trading_pair === pair)) : null;
    const bag = paperPairBag(pair, decisions, positions, valuesAt);
    const buckets = prices[pair]?.buckets;
    const candle = Array.isArray(buckets) ? buckets.at(-1) : null;
    const observed = candle && candle[6] === 1 && typeof candle[4] === "number" ? { close: candle[4], at: (candle[0] + 60) * 1000 } : null;
    const price = observed && observed.at <= now && now - observed.at <= 180_000 ? observed : null;
    const distance = breakEvenDistance(bag?.breakevenPrice, price?.close);
    const coinMoney = sample ? newest?.coins?.[coin] : null;
    const profit = exactSignedSum(coinMoney?.realized, coinMoney?.unrealized);
    const asset = assets.find(item => item && item.asset === coin);
    const markAt = asset?.mark_at_ms;
    const worth = walletData?.quote_asset === "USDC" && typeof markAt === "number" && markAt <= now && now - markAt <= 30_000 && typeof asset?.marked_value_quote === "string" && /^\d+(\.\d+)?$/.test(asset.marked_value_quote) ? asset.marked_value_quote : null;
    const sellOrders = sellOrderCount(lots);
    return <article className="paper-pair" key={pair}><h3>{coin}</h3><p><strong>{profit === null ? "—" : paperExactAmount(profit, "USDC")}</strong> · profit or loss</p><p className="paper-caption">{profit === null ? "— · per-coin profit sample not published" : `Realized plus unrealized · sample as of ${paperTime(newest?.at_ms, now)} · ${sample?.state === "late" ? "late; next sample was due" : "next sample due"} ${utcMinute(sample?.next) ?? "unknown"}`}</p>
      <p>{distance === "—" ? "— · current price or breakeven unavailable" : distance}</p><p className="paper-caption">Price: {price ? `${price.close} USDC · ${paperTime(price.at, now)}` : "— · latest closed candle unavailable or old"} · Breakeven: {bag?.breakevenPrice ? `${bag.breakevenPrice} USDC` : "— · not published"}</p>
      {price && bag?.breakevenPrice && distance !== "—" && <progress max={100} value={Math.min(100, price.close / Number(bag.breakevenPrice) * 100)} aria-label={`${coin} price relative to breakeven`} />}
      <dl className="paper-detail"><dt>Holding</dt><dd>{holdings ? paperExactAmount(holdings.total, coin) : "— · position read unavailable"}</dd><dt>Worth now</dt><dd>{typeof worth === "string" ? paperExactAmount(worth, "USDC") : "— · current owner mark unavailable"}</dd><dt>Lots</dt><dd>{lots ? lots.length : "— · position read unavailable"}</dd><dt>Sell orders placed</dt><dd>{sellOrders === null ? "— · owner protection incomplete" : `${sellOrders} · owner-reported protected exits`}</dd></dl>
      <details><summary>Details</summary><dl className="paper-detail"><dt>Bag reason</dt><dd>{bag?.reason ? paperWords(bag.reason) : "— · not published"}</dd><dt>Trailing armed</dt><dd>{bag?.trailArmed == null ? "— · not published" : bag.trailArmed ? "Yes" : "No"}</dd><dt>Trailing peak</dt><dd>{bag?.trailPeak ? paperExactAmount(bag.trailPeak, "USDC") : "— · not published"}</dd><dt>Release</dt><dd>{bag?.release ? paperWords(bag.release) : "— · not published"}</dd></dl></details>
    </article>;
  })}</div><details><summary>Details</summary><p>Terminal dust is excluded from lot and sell-order counts. Holding includes owner-reported dust.</p></details></section>;
}
