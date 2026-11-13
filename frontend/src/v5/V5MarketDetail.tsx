import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { DataTable, type TableColumn } from "@/features/quant-ops/kit/DataTable";
import { RecordedCandleChart, type RecordedMinute } from "@/components/charts/RecordedCandleChart";
import type { CrossStats, CrossView } from "./candle-store-model";
import { readCandleStore } from "./candle-store-api";
import { coinStats, REFERENCE, type CandleRead } from "./market-model.mjs";

const RANGES = ["1h", "6h", "24h", "7d"] as const;
type Range = (typeof RANGES)[number];
type Candles = { buckets: RecordedMinute[]; volume_unit: string; pair: string; venue: string; segment: string; now: number };
type VenueRow = CrossStats & { segment: "spot" | "perpetual" };

const signed = (value: number | null | undefined, digits = 2, unit = "") => value == null ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(digits)}${unit}`;
const compact = (value: number) => value >= 1e9 ? `${(value / 1e9).toFixed(2)} B` : value >= 1e6 ? `${(value / 1e6).toFixed(1)} M` : value >= 1e3 ? `${(value / 1e3).toFixed(1)} k` : value.toFixed(0);
const venueName = (venue: string) => venue.replace("_io", ".io");

const columns: TableColumn<VenueRow>[] = [
  { id: "venue", header: "Venue", value: row => venueName(row.venue), rowHeader: true, size: 95 },
  { id: "segment", header: "Market", value: row => row.segment, size: 85 },
  { id: "pair", header: "Pair", value: row => row.pair, size: 95 },
  { id: "mean", header: "Mean gap (bp)", value: row => row.mean_bps == null ? null : Number(row.mean_bps.toFixed(2)), kind: "number", size: 85, title: () => "Average signed distance from the median of venues; positive means this venue trades above the others" },
  { id: "abs", header: "Mean |gap| (bp)", value: row => row.mean_abs_bps == null ? null : Number(row.mean_abs_bps.toFixed(2)), kind: "number", size: 90 },
  { id: "p95", header: "p95 |gap| (bp)", value: row => row.p95_abs_bps == null ? null : Number(row.p95_abs_bps.toFixed(2)), kind: "number", size: 85 },
  { id: "max", header: "Max |gap| (bp)", value: row => row.max_abs_bps == null ? null : Number(row.max_abs_bps.toFixed(2)), kind: "number", size: 85, title: row => row.max_at == null ? undefined : `At ${new Date(row.max_at * 1000).toISOString().slice(0, 16).replace("T", " ")}Z` },
  { id: "minutes", header: "Minutes compared", value: row => row.n, kind: "number", size: 90 },
  { id: "quote", header: "Quote", value: row => row.quote, size: 65 },
];

/** Drill-down for one coin: candles with a range picker, window statistics and per-venue price-gap statistics. */
export function V5MarketDetail({ coin, color, onClose }: { coin: string; color: string; onClose: () => void }) {
  const [range, setRange] = useState<Range>("24h");
  const pair = `${coin}-${REFERENCE.quote}`;
  const candles = useQuery({ queryKey: ["v5-market", "detail", coin, range], retry: false, refetchInterval: 60_000, queryFn: async () => {
    const spot = await readCandleStore<Candles>("candles", { lane: REFERENCE.spot, pair, range });
    const perpetual = await readCandleStore<Candles>("candles", { lane: REFERENCE.perpetual, pair, range }).catch(() => null);
    return { spot, perpetual };
  } });
  const venues = useQuery({ queryKey: ["v5-market", "venues", coin, range], retry: false, refetchInterval: 60_000, queryFn: async () => {
    const rows: VenueRow[] = [];
    for (const segment of ["spot", "perpetual"] as const) {
      const view = await readCandleStore<CrossView>("cross", { asset: coin, segment, range }).catch(() => null);
      rows.push(...(view?.table ?? []).map(row => ({ ...row, segment })));
    }
    return rows;
  } });
  const stats = candles.data ? coinStats(candles.data.spot as unknown as CandleRead, candles.data.perpetual as unknown as CandleRead) : null;
  const tiles: [string, string, string?][] = stats ? [
    [`Return, ${range}`, signed(stats.returnWindowPct, 2, "%")],
    ["Return, last hour", signed(stats.return1hPct, 2, "%"), stats.return1hPct == null ? "no close exactly one hour earlier" : undefined],
    ["Return, last 6 hours", signed(stats.return6hPct, 2, "%"), stats.return6hPct == null ? (range === "1h" ? "needs the 6h range or longer" : "no close exactly six hours earlier") : undefined],
    ["High–low range", `${stats.rangePct.toFixed(2)}%`],
    ["Largest drop from a peak", signed(stats.maxDrawdownPct, 2, "%")],
    ["Traded value", stats.volumeQuote == null ? "—" : `${compact(stats.volumeQuote)} ${REFERENCE.quote}`, stats.volumeQuote == null ? `volume missing for ${stats.volumeMissingMinutes} minute(s)` : `${venueName(REFERENCE.venue)} spot only`],
    ["Perpetual premium, mean", stats.premium ? signed(stats.premium.mean, 1, " bp") : "—", stats.premium ? `min ${signed(stats.premium.min, 1)} · max ${signed(stats.premium.max, 1)} bp` : "no minute with both legs"],
    ["Minutes held", `${stats.minutes} / ${stats.windowMinutes}`, "closed minutes in the window"],
  ] : [];
  return <section className="v5m-card v5m-detail" aria-label={`${coin} detail`}>
    <header className="v5m-detail-head">
      <h3><i style={{ background: color }} />{coin} · {venueName(REFERENCE.venue)} {pair}</h3>
      <div role="group" aria-label="Range" className="v5m-seg">{RANGES.map(item => <button key={item} type="button" aria-pressed={range === item} onClick={() => setRange(item)}>{item}</button>)}</div>
      <button type="button" className="v5m-icon" aria-label={`Close ${coin} detail`} onClick={onClose}><X size={16} /></button>
    </header>
    {candles.isPending ? <p role="status" className="v5m-hint">Reading {range} of {coin} candles…</p> : candles.isError ? <p role="alert" className="v5m-hint">Candles unavailable: {candles.error.message}. Nothing older is shown.</p> : <>
      <div className="v5m-stats v5m-stats--wide">{tiles.map(([label, value, note]) => <div key={label} className="v5m-stat"><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div>)}</div>
      <RecordedCandleChart buckets={candles.data.spot.buckets} label={`${venueName(REFERENCE.venue)} spot · ${pair} (price in ${REFERENCE.quote})`} volumeUnit={candles.data.spot.volume_unit} />
    </>}
    <h3 className="v5m-subhead">How far each venue's price sits from the others, {range}</h3>
    <p className="v5m-hint">Owner-computed against the median of venues each minute · sort or filter any column · hover a header for its meaning</p>
    {venues.isPending ? <p role="status" className="v5m-hint">Reading venue prices…</p> : venues.isError || !venues.data?.length ? <p className="v5m-hint">Cross-venue statistics unavailable for {coin}.</p> :
      <DataTable rows={venues.data} columns={columns} rowId={row => `${row.segment}:${row.lane}`} label={`${coin} venue price gaps`} initialSort={{ id: "abs", desc: true }} pageSize={14} dense exportName={`v5-${coin.toLowerCase()}-venue-gaps-${range}`} />}
  </section>;
}
