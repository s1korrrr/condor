import { useEffect, useRef, useState } from "react";
import { CandlestickSeries, ColorType, createChart, createSeriesMarkers, LineStyle, type UTCTimestamp } from "lightweight-charts";
import { getThemeColors } from "@/lib/theme-colors";
import { useTheme } from "@/hooks/useTheme";
import { coin, price } from "@/v5/format.mjs";

export type RecordedMinute = [number, number | null, number | null, number | null, number | null, number | null, number, number, number, number, number, number];
type RecordedFillMarker = { time: number; event_at_ms: number; side: unknown; price: unknown; quantity: unknown };
const NO_MARKERS: RecordedFillMarker[] = [];

function markerText(marker: RecordedFillMarker) {
  return `${marker.side} ${String(marker.quantity)} @ ${String(marker.price)} · ${new Date(marker.event_at_ms).toISOString()}`;
}

export function RecordedCandleChart({ buckets, label, volumeUnit, markers = NO_MARKERS, breakeven, snapshotDimmed = false }: { buckets: RecordedMinute[]; label: string; volumeUnit: string; markers?: RecordedFillMarker[]; breakeven?: string | null; snapshotDimmed?: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<RecordedMinute | null>(null);
  const { theme } = useTheme();
  useEffect(() => {
    if (!container.current) return;
    setHover(null);
    const colors = getThemeColors();
    const chart = createChart(container.current, {
      autoSize: true, height: 360,
      layout: { background: { type: ColorType.Solid, color: colors.bg }, textColor: colors.text, fontSize: 12 },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      timeScale: { timeVisible: true, secondsVisible: false, minBarSpacing: 0.01, fixLeftEdge: true },
      localization: { timeFormatter: time => new Date(Number(time) * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC" },
    });
    const series = chart.addSeries(CandlestickSeries, { upColor: colors.up, downColor: colors.down, borderVisible: false, wickUpColor: colors.up, wickDownColor: colors.down });
    series.setData(buckets.map(row => row[6] === 1 && row.slice(1, 5).every(value => value !== null)
      ? { time: row[0] as UTCTimestamp, open: row[1]!, high: row[2]!, low: row[3]!, close: row[4]! }
      : { time: row[0] as UTCTimestamp }));
    createSeriesMarkers(series, markers.filter(marker => Number.isFinite(Number(marker.price)) && Number(marker.price) > 0).map(marker => ({ time: marker.time as UTCTimestamp, position: marker.side === "BUY" ? "atPriceBottom" : "atPriceTop", price: Number(marker.price), shape: marker.side === "BUY" ? "arrowUp" : "arrowDown", color: snapshotDimmed ? "rgba(128, 128, 128, 0.55)" : marker.side === "BUY" ? colors.up : colors.down, text: markerText(marker) })));
    if (breakeven && Number.isFinite(Number(breakeven)) && Number(breakeven) > 0) series.createPriceLine({ price: Number(breakeven), color: snapshotDimmed ? "rgba(128, 128, 128, 0.55)" : colors.text, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "Breakeven" });
    const byTime = new Map(buckets.map(row => [row[0], row]));
    chart.subscribeCrosshairMove(event => setHover(event.time ? byTime.get(Number(event.time)) ?? null : null));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [buckets, theme, markers, breakeven, snapshotDimmed]);
  const state = hover ? (hover[6] ? "Final" : hover[7] ? "No trade" : hover[8] ? "Unrecoverable" : hover[9] ? "Missing" : "Pending") : null;
  return <figure className="recorded-candle-chart min-w-0 rounded-lg border border-[var(--color-border)] p-3">
    <figcaption className="mb-2 text-sm font-medium">{label} · 1m · UTC</figcaption>
    <div ref={container} role="img" aria-label={`${label} interactive 1m candlestick chart; missing minutes remain gaps`} title={markers.length ? markers.map(markerText).join(" · ") : undefined} className="recorded-candle-canvas h-[360px] min-w-0" />
    <p className="recorded-candle-readout min-h-12 break-words pt-2 text-xs text-[var(--color-text-muted)]" aria-live="polite">{hover ? <>{new Date(hover[0] * 1000).toISOString()} · {state}{([["O",hover[1]],["H",hover[2]],["L",hover[3]],["C",hover[4]],["Volume",hover[5]]] as const).map(([name,value]) => <span key={name} title={value == null ? undefined : String(value)}> · {name} {value == null ? "Unavailable" : name === "Volume" ? coin(value) : price(value)}{name === "Volume" ? ` ${volumeUnit}` : ""}</span>)}</> : "Touch and hold or hover for recorded OHLC, volume and minute state. Drag to pan; scroll to zoom. Gaps are never filled."}</p>
  </figure>;
}
