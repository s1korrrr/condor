import { lazy, Suspense, useMemo } from "react";
import { paperPairBag, paperRetainedRecords, paperTime } from "./policy";
import type { PaperRead } from "./contracts";
import { tradeMarkers } from "./bots-chart-model.mjs";
import { PAIRS, latestFinalCandle, type Candles } from "./paper-candles";

const RecordedCandleChart = lazy(() => import("@/components/charts/RecordedCandleChart").then(module => ({ default: module.RecordedCandleChart })));

export function PaperPriceChart({ fills, positions, decisions, now, valuesAt = now, asOf = null, pair = PAIRS[0], range = "24h", setPair = () => {}, setRange = () => {}, view, reason = "Candle read unavailable" }: { fills?: PaperRead; positions?: PaperRead; decisions?: PaperRead; now: number; valuesAt?: number; asOf?: number | null; pair?: string; range?: string; setPair?: (pair: string) => void; setRange?: (range: string) => void; view?: Candles; reason?: string }) {
  view = view && Array.isArray(view.buckets) ? view : undefined;
  const records = paperRetainedRecords(fills, valuesAt);
  const mapped = useMemo(() => view && records ? tradeMarkers(records, pair, view.start, view.end, view.buckets) : null, [records, pair, view?.start, view?.end, view?.buckets]);
  const bag = paperPairBag(pair, decisions, positions, valuesAt);
  const latest = latestFinalCandle(view?.buckets);
  return <section className="paper-section"><div className="paper-section-heading"><h2>Price and trades</h2></div>
    <div className="v5-button-row">{PAIRS.map(item => <button className="v5-button" key={item} aria-pressed={pair === item} onClick={() => setPair(item)}>{item.split("-")[0]}</button>)}</div>
    <div className="v5-button-row">{[["24h", "1D"], ["7d", "7D"]].map(([value, label]) => <button className="v5-button" key={value} aria-pressed={range === value} onClick={() => setRange(value)}>{label}</button>)}</div>
    <p className="paper-caption">30 days is not offered: the candle store keeps 7 days of 1-minute candles.</p>
    {view && <p className="paper-caption">Requested window: {paperTime(view.start * 1000, now)} to {paperTime((view.end + 60) * 1000, now)} · Latest final candle: {latest ? paperTime(latest.at, now) : "— · no final candle"} · OKX spot</p>}
    {asOf !== null && <p className="paper-caption">Trade markers and breakeven are dimmed snapshot values, not current · {paperTime(asOf, now)}</p>}
    <p className="paper-caption" style={asOf !== null ? {opacity: 0.6} : undefined}>{mapped ? `▲ ${mapped.entries} entries ▼ ${mapped.exits} exits · retained fills${fills?.completeness === "partial" ? " (partial)" : ""}. Trades in missing candle minutes are counted but cannot be plotted.` : "— · fills or candles unavailable"}</p>
    {view ? <Suspense fallback={<p role="status">Loading chart…</p>}><RecordedCandleChart buckets={view.buckets} label={`${view.venue} spot · ${view.pair}`} volumeUnit={view.volume_unit} markers={mapped?.markers} breakeven={bag?.breakevenPrice} snapshotDimmed={asOf !== null} /></Suspense> : <p role="status">— · {reason}</p>}
  </section>;
}
