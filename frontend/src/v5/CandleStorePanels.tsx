import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DataTable, type TableColumn } from "@/features/quant-ops/kit/DataTable";
import { TileGrid } from "@/features/quant-ops/kit/grid";
import { HeatStrip } from "@/features/quant-ops/kit/HeatStrip";
import { TimeSeriesChart, TooltipCard } from "@/features/quant-ops/kit/charts";
import {
  HEAT_LEGEND, RANGES, SEGMENTS, bytesText, crossAssets, crossDeviationSeries, crossQuotes, heatCell, heatRowCoverage, heatStripOrder, storeTiles, utcText,
  type CrossStats, type CrossView, type HeatRow, type HeatmapView, type StoreLane, type StoreView,
} from "./candle-store-model";
import { readCandleStore } from "./candle-store-api";


const control = "rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-[var(--color-text)]";
const muted = "text-xs text-[var(--color-text-muted)]";
const bps = (value: number | null) => value == null ? null : Number(value.toFixed(2));

function ReadFailure({ view, error, checkedAt }: { view: string; error: Error | null; checkedAt: number }) {
  return <p role="alert" className="rounded-lg border border-[var(--color-border)] p-4 text-sm">{view} unavailable: {error?.message ?? "No owner response"}. Checked {utcText(checkedAt / 1000 || null)} (dashboard time). No earlier values are shown in its place. Retry with Refresh.</p>;
}

function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly T[]; onChange: (value: T) => void }) {
  return <label className="flex min-w-0 flex-col gap-1 text-sm">{label}<select className={control} value={value} onChange={event => onChange(event.target.value as T)}>{options.map(option => <option key={option} value={option}>{option}</option>)}</select></label>;
}

const crossColumns: TableColumn<CrossStats>[] = [
  { id: "venue", header: "Venue", value: row => row.venue, rowHeader: true, size: 100 },
  { id: "pair", header: "Instrument", value: row => row.pair, size: 110 },
  { id: "quote", header: "Quote", value: row => row.quote, size: 70 },
  { id: "with_close", header: "Minutes with final close", value: row => row.minutes_with_close, kind: "number", size: 110 },
  { id: "n", header: "Minutes compared", value: row => row.n, kind: "number", size: 100 },
  { id: "mean", header: "Mean (bps)", value: row => bps(row.mean_bps), kind: "number", size: 90 },
  { id: "mean_abs", header: "Mean |dev| (bps)", value: row => bps(row.mean_abs_bps), kind: "number", size: 100 },
  { id: "p95", header: "p95 |dev| (bps)", value: row => bps(row.p95_abs_bps), kind: "number", size: 95 },
  { id: "max", header: "Largest dev (bps)", value: row => bps(row.max_abs_bps), kind: "number", size: 100 },
  { id: "max_at", header: "Largest at (UTC)", value: row => row.max_at == null ? null : utcText(row.max_at), size: 150 },
];

export function CrossVenuePanel({ pairs }: { pairs: string[] }) {
  const store = useQuery({ queryKey: ["candle-store-facts"], queryFn: () => readCandleStore<StoreView>("store"), retry: false, refetchInterval: 60000 });
  const { assets, source } = crossAssets(store.isError ? null : store.data, pairs);
  const [picked, setAsset] = useState("");
  const [segment, setSegment] = useState<(typeof SEGMENTS)[number]>("spot");
  const [range, setRange] = useState<(typeof RANGES)[number]>("24h");
  const [zoom, setZoom] = useState<[number, number] | null>(null);
  const asset = assets.includes(picked) ? picked : assets.includes("BTC") ? "BTC" : assets[0] ?? "";
  const cross = useQuery({ queryKey: ["candle-cross", asset, segment, range], queryFn: () => readCandleStore<CrossView>("cross", { asset, segment, range }), enabled: !!asset, retry: false, refetchInterval: 30000 });
  const view = cross.isError ? null : cross.data;
  const series = useMemo(() => view ? crossDeviationSeries(view) : [], [view]);
  return <section className="v5-panel min-w-0 space-y-3" aria-labelledby="candle-cross-title">
    <div><h3 id="candle-cross-title" className="font-semibold">Cross-venue price deviation</h3><p className={muted}>Each venue's final 1m close against the median of venues with a final close in that minute (at least two). {segment === "spot" ? "Spot" : "Perpetual"} lanes only; spot and perpetual are never mixed.</p></div>
    {assets.length ? <div className="flex flex-wrap items-end gap-4"><Choice label="Asset" value={asset} options={assets} onChange={value => { setAsset(value); setZoom(null); }} /><Choice label="Market type" value={segment} options={SEGMENTS} onChange={value => { setSegment(value); setZoom(null); }} /><Choice label="Range" value={range} options={RANGES} onChange={value => { setRange(value); setZoom(null); }} />{zoom && <button type="button" className={`${control} min-h-11 text-sm`} onClick={() => setZoom(null)}>Reset zoom</button>}</div>
      : store.isPending ? <p role="status">Loading asset list…</p> : <p className="text-sm">Asset list unavailable: the owner config lists no assets and no instruments are available.</p>}
    {source === "pairs" && assets.length > 0 && <p className={muted}>Asset names derived from instrument base names because the owner config list is unavailable. Venue-native names (for example Hyperliquid UBTC) may not match.</p>}
    {cross.isError && <ReadFailure view="Cross-venue read" error={cross.error} checkedAt={cross.errorUpdatedAt} />}
    {asset && cross.isPending && <p role="status">Loading cross-venue comparison…</p>}
    {view && <>
      <p className="text-sm">Evaluated {utcText(view.now)} · {utcText(view.start)} to {utcText(view.end)} · {view.res} buckets (mean of minute deviations) · median available in {view.minutes_with_median.toLocaleString()} of {view.minutes.toLocaleString()} minutes · at most {view.venues_per_minute_max} venues in one minute.</p>
      {crossQuotes(view).length > 1 && <p className="text-sm" role="note">Quotes differ ({crossQuotes(view).join(", ")}). Part of a deviation can be the quote-currency basis, not a venue price difference. No conversion is applied.</p>}
      <TimeSeriesChart series={series} height={260} ariaLabel={`${view.asset} ${view.segment} deviation from the cross-venue median, basis points`} zeroLine signed leftFormat={value => `${value >= 0 ? "+" : ""}${value.toFixed(2)} bps`} emptyText="No minute had final closes from two or more venues in this range." zoom={zoom} onZoom={setZoom} />
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Venues in the chart">{series.map(line => <li key={line.id} className="flex items-center gap-1.5"><i aria-hidden="true" className="inline-block h-0.5 w-4 rounded" style={{ background: line.color }} />{line.label} ({view.table.find(row => row.lane === line.id)?.quote ?? "quote unknown"})</li>)}</ul>
      <p className={muted}>Drag across the chart to zoom; double-click or Reset zoom to return. Gaps are minutes without a median or without this venue's final close.</p>
      <DataTable rows={view.table} columns={crossColumns} rowId={row => `${row.lane}/${row.pair}`} label={`${view.asset} ${view.segment} cross-venue deviation statistics`} pageSize={16} exportName={`candle-cross-${view.asset}-${view.segment}-${view.range}`} emptyText="No venue lists this asset in this market type." />
      <p className={muted}>{view.note}</p>
    </>}
  </section>;
}

const FIELD_STATE: Record<string, (typeof HEAT_LEGEND)[number]["state"]> = { final: "complete", no_trade: "complete", unrecoverable: "unrecoverable", missing: "gaps", pending: "pending" };
const legendColor = (state: (typeof HEAT_LEGEND)[number]["state"]) => HEAT_LEGEND.find(item => item.state === state)?.color ?? "transparent";

function heatTooltip(row: HeatRow, view: HeatmapView, ownerIndex: number) {
  const counts = row.cells[ownerIndex];
  return <TooltipCard title={`${row.venue} · ${row.pair} · ${utcText(view.hours[ownerIndex])} hour`} rows={counts == null
    ? [{ key: "outside", label: "Outside the store window", color: "transparent", value: "—" }]
    : view.fields.map((field, index) => ({ key: field, label: field.replace("_", "-"), color: legendColor(FIELD_STATE[field]), value: `${counts[index]} min` }))} />;
}

export function CoverageHeatmapPanel() {
  const [segment, setSegment] = useState<(typeof SEGMENTS)[number]>("spot");
  const heat = useQuery({ queryKey: ["candle-heatmap", segment], queryFn: () => readCandleStore<HeatmapView>("heatmap", { segment }), retry: false, refetchInterval: 60000 });
  const view = heat.isError ? null : heat.data;
  const order = useMemo(() => view ? heatStripOrder(view) : [], [view]);
  return <section className="v5-panel min-w-0 space-y-3" aria-labelledby="candle-heat-title">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><h3 id="candle-heat-title" className="font-semibold">Hourly coverage, last 168 hours</h3><p className={muted}>One row per instrument, newest hour on the left. Hover, tap or focus a row and use the arrow keys to read each hour's minute states.</p></div><Choice label="Market type" value={segment} options={SEGMENTS} onChange={setSegment} /></div>
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Heatmap legend">{HEAT_LEGEND.map(item => <li key={item.state} className="flex items-center gap-1.5"><i aria-hidden="true" className="inline-block h-3 w-3 rounded-sm border border-[var(--color-border)]" style={{ background: item.color }} />{item.label}</li>)}</ul>
    {heat.isError && <ReadFailure view="Coverage heatmap read" error={heat.error} checkedAt={heat.errorUpdatedAt} />}
    {heat.isPending && <p role="status">Loading hourly coverage…</p>}
    {view && (view.rows.length === 0 ? <p className="text-sm">The owner lists no {segment} instruments.</p> : <>
      <p className="text-sm">Evaluated {utcText(view.now)} · newest hour {utcText(view.hours[view.hours.length - 1])} (partial up to {utcText(view.last_closed)}) · oldest {utcText(view.hours[0])}.</p>
      <div className="space-y-1.5">{view.rows.map(row => {
        const coverage = heatRowCoverage(row);
        const name = `${row.venue} · ${row.pair}`;
        return <div key={`${row.lane}/${row.pair}`} className="grid grid-cols-1 items-center gap-x-3 gap-y-0.5 sm:grid-cols-[minmax(150px,220px)_minmax(0,1fr)]">
          <div className="min-w-0 text-xs"><span className="font-medium">{name}</span> <span className="text-[var(--color-text-muted)]">· {coverage == null ? "no settled minutes" : `${(coverage * 100).toFixed(2)}% settled`}</span></div>
          <HeatStrip ariaLabel={`${name} hourly coverage`} maxCellWidth={12} height={16} cells={order.map(ownerIndex => { const cell = heatCell(row.cells[ownerIndex], view.hours[ownerIndex]); return { key: String(view.hours[ownerIndex]), color: cell.color, empty: cell.state === "outside", label: `${name} · ${cell.label}` }; })} renderTooltip={index => heatTooltip(row, view, order[index])} />
        </div>;
      })}</div>
    </>)}
  </section>;
}

const laneColumns: TableColumn<StoreLane>[] = [
  { id: "venue", header: "Venue", value: row => row.venue, rowHeader: true, size: 100 },
  { id: "segment", header: "Market type", value: row => row.segment, size: 85 },
  { id: "days", header: "Journal days", value: row => row.days_held, kind: "number", size: 80 },
  { id: "first", header: "Oldest day", value: row => row.days[0] ?? null, size: 100 },
  { id: "last", header: "Newest day", value: row => row.days[row.days.length - 1] ?? null, size: 100 },
  { id: "sealed", header: "Sealed days", value: row => row.sealed_days.length, kind: "number", size: 75 },
  { id: "journal", header: "Journal (MiB)", value: row => Number((row.bytes.lanes / 1048576).toFixed(1)), kind: "number", size: 90 },
  { id: "wal", header: "Of which WAL (MiB)", value: row => Number((row.wal_bytes / 1048576).toFixed(1)), kind: "number", size: 95 },
  { id: "sealed_bytes", header: "Sealed (MiB)", value: row => Number((row.bytes.sealed / 1048576).toFixed(1)), kind: "number", size: 85 },
  { id: "metrics", header: "Metrics (KiB)", value: row => Number((row.bytes.metrics / 1024).toFixed(1)), kind: "number", size: 85 },
  { id: "total", header: "Total", value: row => row.bytes_total, kind: "number", size: 85, cell: row => bytesText(row.bytes_total) },
];

export function StoreFactsPanel() {
  const store = useQuery({ queryKey: ["candle-store-facts"], queryFn: () => readCandleStore<StoreView>("store"), retry: false, refetchInterval: 60000 });
  const view = store.isError ? null : store.data;
  return <section className="v5-panel min-w-0 space-y-3" aria-labelledby="candle-store-title">
    <div><h3 id="candle-store-title" className="font-semibold">Store facts</h3><p className={muted}>From file listings and the collector's status.json only. Journal read errors appear on the lane tiles in Coverage.</p></div>
    {store.isError && <ReadFailure view="Store facts read" error={store.error} checkedAt={store.errorUpdatedAt} />}
    {store.isPending && <p role="status">Loading store facts…</p>}
    {view && <>
      <p className="text-sm">Evaluated {utcText(view.now)} · {view.read_method}.</p>
      {[view.status.error && `Collector status: ${view.status.error}`, view.status.fatal_error && `Collector fatal error: ${view.status.fatal_error}`, view.config.error && `Lanes config: ${view.config.error}`, ...view.versions.mismatches.map(item => `Format: ${item}`)].filter(Boolean).map(text => <p key={text as string} role="alert" className="break-words text-sm">{text}</p>)}
      <TileGrid label="Candle store facts" min={180}>{storeTiles(view).map(tile => <article key={tile.id} className="h-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3" data-tone={tile.tone}><span className={muted}>{tile.label}</span><p className={`break-words text-lg font-semibold${tile.tone ? " text-[var(--color-yellow,#f59e0b)]" : ""}`}>{tile.value}</p><p className={`${muted} break-words`} title={tile.note}>{tile.note}</p></article>)}</TileGrid>
      <DataTable rows={view.lanes} columns={laneColumns} rowId={row => row.lane} label="Candle store lanes on disk" pageSize={16} exportName="candle-store-lanes" emptyText="The owner lists no lanes." />
      <p className={muted}>Config source: {view.config.source} · assets: {view.config.assets.join(", ") || "none listed"}.</p>
    </>}
  </section>;
}
