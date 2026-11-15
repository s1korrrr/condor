import { useEffect, useRef, useState } from "react";
import { CandlestickSeries, ColorType, createChart, createSeriesMarkers, LineStyle, type UTCTimestamp } from "lightweight-charts";
import { getThemeColors } from "@/lib/theme-colors";
import { useTheme } from "@/hooks/useTheme";

export type RecordedMinute = [number, number | null, number | null, number | null, number | null, number | null, number, number, number, number, number, number];
const NO_MARKERS: { time: number; side: unknown; price: unknown; quantity: unknown }[] = [];

export function RecordedCandleChart({ buckets, label, volumeUnit, markers = NO_MARKERS, breakeven, snapshotDimmed = false }: { buckets: RecordedMinute[]; label: string; volumeUnit: string; markers?: { time: number; side: unknown; price: unknown; quantity: unknown }[]; breakeven?: string | null; snapshotDimmed?: boolean }) {
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
    createSeriesMarkers(series, markers.map(marker => ({ time: marker.time as UTCTimestamp, position: marker.side === "BUY" ? "belowBar" : "aboveBar", shape: marker.side === "BUY" ? "arrowUp" : "arrowDown", color: snapshotDimmed ? "rgba(128, 128, 128, 0.55)" : marker.side === "BUY" ? colors.up : colors.down, text: `${marker.side} ${String(marker.quantity)} @ ${String(marker.price)}` })));
    if (breakeven && Number.isFinite(Number(breakeven)) && Number(breakeven) > 0) series.createPriceLine({ price: Number(breakeven), color: snapshotDimmed ? "rgba(128, 128, 128, 0.55)" : colors.text, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "Breakeven" });
    const byTime = new Map(buckets.map(row => [row[0], row]));
    chart.subscribeCrosshairMove(event => setHover(event.time ? byTime.get(Number(event.time)) ?? null : null));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [buckets, theme, markers, breakeven, snapshotDimmed]);
  const state = hover ? (hover[6] ? "Final" : hover[7] ? "No trade" : hover[8] ? "Unrecoverable" : hover[9] ? "Missing" : "Pending") : null;
  return <figure className="recorded-candle-chart min-w-0 rounded-lg border border-[var(--color-border)] p-3">
    <figcaption className="mb-2 text-sm font-medium">{label} · 1m · UTC</figcaption>
    <div ref={container} role="img" aria-label={`${label} interactive 1m candlestick chart; missing minutes remain gaps`} className="recorded-candle-canvas h-[360px] min-w-0" />
    <p className="recorded-candle-readout min-h-12 break-words pt-2 text-xs text-[var(--color-text-muted)]" aria-live="polite">{hover ? `${new Date(hover[0] * 1000).toISOString()} · ${state} · O ${hover[1] ?? "Unavailable"} · H ${hover[2] ?? "Unavailable"} · L ${hover[3] ?? "Unavailable"} · C ${hover[4] ?? "Unavailable"} · Volume ${hover[5] ?? "Unavailable"} ${volumeUnit}` : "Touch and hold or hover for recorded OHLC, volume and minute state. Drag to pan; scroll to zoom. Gaps are never filled."}</p>
  </figure>;
}
