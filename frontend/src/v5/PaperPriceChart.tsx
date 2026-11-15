import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RecordedCandleChart, type RecordedMinute } from "@/components/charts/RecordedCandleChart";
import { paperPairBag, paperRetainedRecords, paperTime } from "./policy";
import type { PaperRead } from "./contracts";
import { readCandleStore } from "./candle-store-api";
import { tradeMarkers } from "./bots-chart-model.mjs";

export const PAIRS = ["BNB-USDC", "BTC-USDC", "ETH-USDC", "SOL-USDC", "XRP-USDC"];
type Candles = { pair: string; venue: string; volume_unit: string; start: number; end: number; buckets: RecordedMinute[] };
type Symbols = { rows: { lane: string; pair: string }[] };

export function PaperPriceChart({ fills, positions, decisions, now }: { fills?: PaperRead; positions?: PaperRead; decisions?: PaperRead; now: number }) {
  const [pair, setPair] = useState(PAIRS[0]);
  const [range, setRange] = useState("24h");
  const symbols = useQuery({ queryKey: ["v5-bots-candle-symbols"], queryFn: () => readCandleStore<Symbols>("symbols"), retry: false, refetchInterval: 60_000 });
  const listed = !symbols.isError && symbols.data?.rows.some(row => row.lane === "okx__spot" && row.pair === pair);
  const candles = useQuery({ queryKey: ["v5-bots-candles", pair, range], queryFn: () => readCandleStore<Candles>("candles", { lane: "okx__spot", pair, range }), enabled: !!listed, retry: false, refetchInterval: 60_000 });
  const view = !candles.isError && listed ? candles.data : undefined;
  const records = paperRetainedRecords(fills, now);
  const mapped = useMemo(() => view && records ? tradeMarkers(records, pair, view.start, view.end, view.buckets) : null, [view, records, pair]);
  const bag = paperPairBag(pair, decisions, positions, now);
  return <section className="paper-section"><div className="paper-section-heading"><h2>Price and trades</h2></div>
    <div className="v5-button-row">{PAIRS.map(item => <button className="v5-button" key={item} aria-pressed={pair === item} onClick={() => setPair(item)}>{item.split("-")[0]}</button>)}</div>
    <div className="v5-button-row">{[["24h", "1D"], ["7d", "7D"]].map(([value, label]) => <button className="v5-button" key={value} aria-pressed={range === value} onClick={() => setRange(value)}>{label}</button>)}</div>
    <p className="paper-caption">30 days is not offered: the candle store keeps 7 days of 1-minute candles.</p>
    {view && <p className="paper-caption">Recorded candles through {paperTime((view.end + 60) * 1000, now)} · OKX spot</p>}
    <p className="paper-caption">{mapped ? `▲ ${mapped.entries} entries ▼ ${mapped.exits} exits · latest 500 retained fills${fills?.completeness === "partial" ? " (partial)" : ""}. Trades in missing candle minutes are counted but cannot be plotted.` : "— · fills or candles unavailable"}</p>
    {view ? <RecordedCandleChart buckets={view.buckets} label={`${view.venue} spot · ${view.pair}`} volumeUnit={view.volume_unit} markers={mapped?.markers} breakeven={bag?.breakevenPrice} /> : <p role="status">— · {symbols.isPending || (listed && candles.isPending) ? "Reading candles" : symbols.isError ? "Candle store unavailable" : !listed ? "Pair not listed in the candle store" : "Candle read unavailable"}</p>}
  </section>;
}
