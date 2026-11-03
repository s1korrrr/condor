/**
 * Pure projections for the candle store's cross-venue, coverage heatmap and store-facts reads.
 * The server (condor/v5/candle_views.py) has already validated every identity, window and count, so this module
 * only maps owner fields to presentation. It never fills a gap, converts a quote currency or merges spot with
 * perpetual lanes. Missing values stay null and are labelled, never drawn as zero.
 */
import { assetColor } from '@/features/quant-ops/format';
import { CHART, type ChartSeries } from '@/features/quant-ops/kit/series';

export type CrossPoint = [number, number];
export type CrossLine = { lane: string; venue: string; pair: string; close: CrossPoint[]; deviation_bps: CrossPoint[] };
export type CrossStats = {
  lane: string; venue: string; pair: string; quote: string; n: number; minutes_with_close: number;
  mean_bps: number | null; mean_abs_bps: number | null; p95_abs_bps: number | null; max_abs_bps: number | null; max_at: number | null;
};
export type CrossView = {
  now: number; asset: string; segment: 'spot' | 'perpetual'; range: string; res: string; res_s: number; start: number; end: number;
  minutes: number; minutes_with_median: number; venues_per_minute_max: number; note: string; series: CrossLine[]; table: CrossStats[];
};

/** final, no_trade, unrecoverable, missing, pending minutes in one UTC hour; null when the hour is outside the store window. */
export type HeatCellCounts = [number, number, number, number, number] | null;
export type HeatRow = { lane: string; venue: string; segment: string; pair: string; asset: string; cells: HeatCellCounts[] };
export type HeatmapView = { now: number; segment: 'spot' | 'perpetual'; hours: number[]; fields: string[]; last_closed: number; rows: HeatRow[] };

export type StoreLane = {
  lane: string; venue: string; segment: string; bytes: { lanes: number; sealed: number; metrics: number }; bytes_total: number;
  wal_bytes: number; days: string[]; days_held: number; sealed_days: string[]; metrics_files: number;
};
export type StoreView = {
  now: number;
  status: {
    present: boolean; error: string | null; age_s: number | null; started_at: number | null; uptime_s: number | null; fatal_error: string | null;
    process: { rss_mib: number | null; max_rss_mib: number | null; cpu_user_s: number | null; cpu_sys_s: number | null; loop_lag_s: { p50: number | null; p99: number | null; max: number | null; max_recent: number | null } };
    fault_injections: number;
  };
  retention: { window_s: number | null; margin_s: number | null; window_days: number | null; keep_days: number | null };
  versions: { found: Record<string, string | null>; expected: Record<string, string>; mismatches: string[] };
  config: { source: string; error: string | null; assets: string[] };
  bytes_total: number; lanes: StoreLane[]; read_method: string;
};

export const SEGMENTS = ['spot', 'perpetual'] as const;
export const RANGES = ['1h', '6h', '24h', '7d'] as const;

export function utcText(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return 'Unavailable';
  return new Date(seconds * 1000).toISOString().replace('T', ' ').replace(/:\d\d\.\d+Z$/, ' UTC');
}

export function bytesText(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return 'Unavailable';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function durationText(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return 'Unavailable';
  if (seconds < 120) return `${Math.round(seconds)} s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172_800) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86_400).toFixed(1)} d`;
}

export type HeatState = 'outside' | 'pending' | 'complete' | 'gaps' | 'unrecoverable';

export const HEAT_LEGEND: { state: HeatState; label: string; color: string }[] = [
  { state: 'complete', label: 'Every settled minute held (final or no-trade)', color: CHART.positive },
  { state: 'gaps', label: 'Missing minutes (darker = more)', color: CHART.negative },
  { state: 'unrecoverable', label: 'Unrecoverable minutes, none missing', color: CHART.violet },
  { state: 'pending', label: 'Only pending minutes (inside settle grace)', color: CHART.neutral },
  { state: 'outside', label: 'Outside the store window', color: 'transparent' },
];

/** One hour cell: its state, colour and a complete text label (the colour is never the only signal). */
export function heatCell(counts: HeatCellCounts, hour: number): { state: HeatState; color: string; label: string; settled: number; covered: number } {
  const when = `${utcText(hour)} hour`;
  if (counts == null) return { state: 'outside', color: 'transparent', label: `${when} · outside the store window`, settled: 0, covered: 0 };
  const [final, noTrade, unrecoverable, missing, pending] = counts;
  const covered = final + noTrade, settled = covered + unrecoverable + missing;
  const label = `${when} · final ${final} · no-trade ${noTrade} · unrecoverable ${unrecoverable} · missing ${missing} · pending ${pending} min`;
  // Neutral, not blue: the colour-blind theme maps "complete" to blue, and pending must stay distinguishable.
  if (settled === 0) return { state: 'pending', color: CHART.neutral, label, settled, covered };
  if (missing > 0) {
    const share = Math.max(35, Math.round(35 + 65 * missing / settled));
    return { state: 'gaps', color: `color-mix(in srgb, ${CHART.negative} ${share}%, transparent)`, label, settled, covered };
  }
  if (unrecoverable > 0) return { state: 'unrecoverable', color: CHART.violet, label, settled, covered };
  return { state: 'complete', color: `color-mix(in srgb, ${CHART.positive} 70%, transparent)`, label, settled, covered };
}

/** Settled coverage over the row's in-window hours; null when no settled minute exists (never 100% by default). */
export function heatRowCoverage(row: HeatRow): number | null {
  let settled = 0, covered = 0;
  row.cells.forEach(cell => {
    if (!cell) return;
    covered += cell[0] + cell[1];
    settled += cell[0] + cell[1] + cell[2] + cell[3];
  });
  return settled ? covered / settled : null;
}

/** Newest hour first, the kit HeatStrip convention. Indexes map back to owner order for tooltips. */
export function heatStripOrder(view: HeatmapView): number[] {
  return view.hours.map((_hour, index) => view.hours.length - 1 - index);
}

/** Deviation from the cross-venue median, one line per venue, in basis points. Gaps stay null. */
export function crossDeviationSeries(view: CrossView): ChartSeries[] {
  const times = new Set<number>();
  view.series.forEach(line => line.deviation_bps.forEach(([t]) => times.add(t)));
  const axis = [...times].sort((a, b) => a - b);
  return view.series.map(line => {
    const values = new Map(line.deviation_bps.map(([t, v]) => [t, v]));
    return {
      id: line.lane, label: `${line.venue} ${line.pair}`, color: assetColor(line.venue), unit: 'bps',
      format: (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)} bps`,
      points: axis.map(t => ({ time: t * 1000, value: values.get(t) ?? null })),
    };
  });
}

export function crossQuotes(view: CrossView): string[] {
  return [...new Set(view.table.map(row => row.quote))].sort();
}

/** Assets for the cross-venue picker: the owner config list, else instrument base names (labelled as derived). */
export function crossAssets(store: StoreView | null | undefined, pairs: string[]): { assets: string[]; source: 'config' | 'pairs' } {
  if (store?.config.assets.length) return { assets: [...store.config.assets], source: 'config' };
  return { assets: [...new Set(pairs.map(pair => pair.split('-')[0]).filter(Boolean))].sort(), source: 'pairs' };
}

export type StoreTile = { id: string; label: string; value: string; note: string; tone?: 'warning' };

export function storeTiles(view: StoreView): StoreTile[] {
  const { status, retention, versions } = view;
  const lag = status.process.loop_lag_s;
  return [
    { id: 'heartbeat', label: 'Collector heartbeat', value: status.present ? durationText(status.age_s) : 'Unavailable', note: status.present ? 'status.json age; liveness only, not candle finality' : 'status.json not present', tone: status.age_s == null || status.age_s > 30 ? 'warning' : undefined },
    { id: 'uptime', label: 'Collector uptime', value: durationText(status.uptime_s), note: `Started ${utcText(status.started_at)}` },
    { id: 'memory', label: 'Collector memory', value: status.process.rss_mib == null ? 'Unavailable' : `${status.process.rss_mib.toFixed(0)} MiB`, note: `Peak ${status.process.max_rss_mib == null ? 'unavailable' : `${status.process.max_rss_mib.toFixed(0)} MiB`}` },
    { id: 'lag', label: 'Event-loop lag p99', value: lag.p99 == null ? 'Unavailable' : `${(lag.p99 * 1000).toFixed(0)} ms`, note: `p50 ${lag.p50 == null ? 'unavailable' : `${(lag.p50 * 1000).toFixed(1)} ms`} · max ${lag.max == null ? 'unavailable' : `${lag.max.toFixed(2)} s`}` },
    { id: 'retention', label: 'Retention', value: retention.window_days == null ? 'Unavailable' : `${retention.window_days.toFixed(1)} d`, note: `Kept on disk ${retention.keep_days == null ? 'unavailable' : `${retention.keep_days.toFixed(1)} d`} including margin` },
    { id: 'disk', label: 'Disk use', value: bytesText(view.bytes_total), note: `${view.lanes.length} lanes · ${view.lanes.reduce((sum, lane) => sum + lane.days_held, 0)} journal days` },
    { id: 'versions', label: 'Format versions', value: versions.mismatches.length ? `${versions.mismatches.length} mismatch${versions.mismatches.length === 1 ? '' : 'es'}` : 'As expected', note: Object.values(versions.found).map(value => value ?? 'not published').join(' · '), tone: versions.mismatches.length ? 'warning' : undefined },
    { id: 'faults', label: 'Fault injections', value: String(status.fault_injections), note: status.fault_injections ? 'Test faults were injected into this collector' : 'None recorded', tone: status.fault_injections ? 'warning' : undefined },
  ];
}
