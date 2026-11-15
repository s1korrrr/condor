import type { PaperRead } from "./contracts";
import { latest } from "./money-model.mjs";
import { paperCompleteRead, paperCompleteRecords, paperDecimalSum, paperExitProjection, paperPairBag, paperPairHoldings, paperPairObservation, paperTime, paperWords } from "./policy";
import { coin as formatCoin, price as formatPrice, usdc } from "./format.mjs";
import { activeLots, breakEvenDistance, exactSignedSum, moneySampleState } from "./bots-position-model.mjs";
import { PAIRS, latestFinalCandle, type Candles } from "./paper-candles";
import type { MoneyRead } from "./money-api";
import { utcMinute } from "./shown.mjs";

export function PaperPositions({ positions, executors, decisions, wallet, now, valuesAt = now, asOf = null, prices = {}, money }: { positions?: PaperRead; executors?: PaperRead; decisions?: PaperRead; wallet?: PaperRead; now: number; valuesAt?: number; asOf?: number | null; prices?: Record<string, Candles | undefined>; money?: MoneyRead }) {
  const newest = latest(Array.isArray(money?.rows) ? money.rows : [], "v5").newest;
  const sample = moneySampleState(newest, now);
  const rows = paperCompleteRecords(positions, valuesAt);
  const walletData = paperCompleteRead(wallet, valuesAt) && wallet?.data && typeof wallet.data === "object" && !Array.isArray(wallet.data) ? wallet.data as Record<string, unknown> : null;
  const assets = Array.isArray(walletData?.assets) ? walletData.assets as Record<string, unknown>[] : [];
  return <section className="paper-section paper-positions"><div className="paper-section-heading"><h2>Positions</h2></div><div className="paper-pairs">{PAIRS.map(pair => {
    const coin = pair.split("-")[0];
    const holdings = paperPairHoldings(pair, positions, valuesAt);
    const lots = rows && holdings ? activeLots(rows.filter(row => row.trading_pair === pair)) : null;
    const holding = holdings && paperDecimalSum(holdings.states.filter(item => item.state !== "terminal_dust").map(item => item.quantity));
    const dust = holdings?.states.find(item => item.state === "terminal_dust");
    const bag = paperPairBag(pair, decisions, positions, valuesAt);
    const decision = paperPairObservation(pair, positions, executors, decisions, valuesAt).decision;
    const observed = latestFinalCandle(prices[pair]?.buckets);
    const price = observed && observed.at <= now && now - observed.at <= 180_000 ? observed : null;
    const distance = breakEvenDistance(bag?.breakevenPrice, price?.close);
    const coinMoney = sample ? newest?.coins?.[coin] : null;
    const profit = exactSignedSum(coinMoney?.realized, coinMoney?.unrealized);
    const asset = assets.find(item => item && item.asset === coin);
    const markAt = asset?.mark_at_ms;
    const worth = walletData?.quote_asset === "USDC" && typeof markAt === "number" && markAt <= now && now - markAt <= 30_000 && typeof asset?.marked_value_quote === "string" && /^\d+(\.\d+)?$/.test(asset.marked_value_quote) ? asset.marked_value_quote : null;
    const projections = lots?.map(lot => paperExitProjection(lot, positions, executors, valuesAt));
    const protection = projections?.map(item => item.verified ? item.protectedExit : item.ownerProtectedExit);
    const unknown = protection?.filter(item => item === null).length ?? 0;
    const ownerReported = !paperCompleteRead(executors, valuesAt);
    const sellOrders = !protection ? "— · position read unavailable" : unknown ? `— · protection unknown for ${unknown} lot(s)` : `${protection.filter(Boolean).length} of ${protection.length} · ${ownerReported ? "owner-reported · executor cross-check unavailable" : "verified protected exits"}`;
    return <article className="paper-pair" key={pair}><h3>{coin}</h3><p><strong title={profit ?? undefined}>{profit === null ? "—" : usdc(profit)}</strong> · profit or loss</p><p className="paper-caption">{profit === null ? "— · per-coin profit sample not published" : `Realized plus unrealized · sample as of ${paperTime(newest?.at_ms, now)} · ${sample?.state === "late" ? "late; next sample was due" : "next sample due"} ${utcMinute(sample?.next) ?? "unknown"}`}</p>
      <p className="paper-caption">Price: {price ? <><span title={String(price.close)}>{formatPrice(price.close)} USDC</span> · {paperTime(price.at, now)}</> : "— · latest closed candle unavailable or old"}</p>
      {asOf !== null && <p className="paper-caption">Position and breakeven below are not current · {paperTime(asOf, now)}</p>}
      <div className={asOf !== null ? "paper-dimmed-position" : undefined} style={asOf !== null ? {opacity: 0.6} : undefined}>
      <p>{distance === "—" ? "— · current price or breakeven unavailable" : distance}</p><p className="paper-caption">Breakeven: {bag?.breakevenPrice ? <span title={bag.breakevenPrice}>{formatPrice(bag.breakevenPrice)} USDC</span> : "— · not published"}</p>
      {price && bag?.breakevenPrice && distance !== "—" && <progress max={100} value={Math.min(100, price.close / Number(bag.breakevenPrice) * 100)} aria-label={`${coin} price relative to breakeven`} />}
      {decision && <p>Buy decision: {paperWords(decision.status)} · {paperWords(decision.reason)} · {paperTime(decision.event_at_ms, now)}</p>}
      <dl className="paper-detail"><dt>Holding</dt><dd>{holding !== null ? <span title={holding}>{formatCoin(holding, coin)}</span> : "— · position read unavailable"}{dust && <div>+ <span title={dust.quantity}>{formatCoin(dust.quantity, coin)}</span> dust</div>}</dd><dt>Worth now</dt><dd>{typeof worth === "string" ? <span title={worth}>{usdc(worth)}</span> : "— · current owner mark unavailable"}</dd><dt>Lots</dt><dd>{lots ? lots.length : "— · position read unavailable"}</dd><dt>Sell orders placed</dt><dd>{sellOrders}</dd></dl>
      <details><summary>Details</summary><dl className="paper-detail"><dt>Bag reason</dt><dd>{bag?.reason ? paperWords(bag.reason) : "— · not published"}</dd><dt>Trailing armed</dt><dd>{bag?.trailArmed == null ? "— · not published" : bag.trailArmed ? "Yes" : "No"}</dd><dt>Trailing peak</dt><dd>{bag?.trailPeak ? <span title={bag.trailPeak}>{formatPrice(bag.trailPeak)} USDC</span> : "— · not published"}</dd><dt>Release</dt><dd>{bag?.release ? paperWords(bag.release) : "— · not published"}</dd></dl></details>
      </div>
    </article>;
  })}</div><details><summary>Details</summary><p>Terminal dust is excluded from holding and lot and sell-order counts; it is shown separately.</p></details></section>;
}
