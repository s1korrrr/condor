import { lazy, Suspense, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { paperPairBag, paperRetainedRecords, paperTime } from "./policy";
import type { PaperRead } from "./contracts";
import { tradeMarkers } from "./bots-chart-model.mjs";
import { PAIRS, paperCandleQuery, usePaperCandleSymbols } from "./paper-candles";

const RecordedCandleChart = lazy(() => import("@/components/charts/RecordedCandleChart").then(module => ({ default: module.RecordedCandleChart })));

export function PaperPriceChart({ fills, positions, decisions, now }: { fills?: PaperRead; positions?: PaperRead; decisions?: PaperRead; now: number }) {
  const [pair, setPair] = useState(PAIRS[0]);
  const [range, setRange] = useState("24h");
  const symbols = usePaperCandleSymbols();
  const listed = !symbols.isError && symbols.data?.rows.some(row => row.lane === "okx__spot" && row.pair === pair);
  const candles = useQuery(paperCandleQuery(pair, range, !!listed));
  const view = !candles.isError && listed ? candles.data : undefined;
  const records = paperRetainedRecords(fills, now);
  const mapped = useMemo(() => view && records ? tradeMarkers(records, pair, view.start, view.end, view.buckets) : null, [view, records, pair]);
  const bag = paperPairBag(pair, decisions, positions, now);
  return <section className="paper-section"><div className="paper-section-heading"><h2>Price and trades</h2></div>
    <div className="v5-button-row">{PAIRS.map(item => <button className="v5-button" key={item} aria-pressed={pair === item} onClick={() => setPair(item)}>{item.split("-")[0]}</button>)}</div>
    <div className="v5-button-row">{[["24h", "1D"], ["7d", "7D"]].map(([value, label]) => <button className="v5-button" key={value} aria-pressed={range === value} onClick={() => setRange(value)}>{label}</button>)}</div>
    <p className="paper-caption">30 days is not offered: the candle store keeps 7 days of 1-minute candles.</p>
    {view && <p className="paper-caption">Recorded candles through {paperTime((view.end + 60) * 1000, now)} · OKX spot</p>}
    <p className="paper-caption">{mapped ? `▲ ${mapped.entries} entries ▼ ${mapped.exits} exits · retained fills${fills?.completeness === "partial" ? " (partial)" : ""}. Trades in missing candle minutes are counted but cannot be plotted.` : "— · fills or candles unavailable"}</p>
    {view ? <Suspense fallback={<p role="status">Loading chart…</p>}><RecordedCandleChart buckets={view.buckets} label={`${view.venue} spot · ${view.pair}`} volumeUnit={view.volume_unit} markers={mapped?.markers} breakeven={bag?.breakevenPrice} /></Suspense> : <p role="status">— · {symbols.isPending || (listed && candles.isPending) ? "Reading candles" : symbols.isError ? "Candle store unavailable" : !listed ? "Pair not listed in the candle store" : "Candle read unavailable"}</p>}
  </section>;
}
