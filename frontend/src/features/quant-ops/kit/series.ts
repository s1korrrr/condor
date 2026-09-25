/** Pure series projection and palette for the shared charts. No React, so it is testable and fast-refresh safe. */

/** Palette tokens with fallbacks, so charts render the same outside a `[data-quant-ops]` scope. */
export const CHART = {
  blue: 'var(--q-blue, #259aff)', cyan: 'var(--q-cyan, #22d3ee)', positive: 'var(--q-positive, #35eab5)', negative: 'var(--q-negative, #ff6577)',
  warning: 'var(--q-warning, #f59e0b)', violet: 'var(--q-violet, #8b5cf6)', neutral: 'var(--q-neutral, #64748b)',
  grid: 'var(--q-border, #20313e)', muted: 'var(--q-muted, #a4bacb)', text: 'var(--q-text, #e5e7eb)', surface: 'var(--q-surface, #0a151d)',
} as const;

export type SeriesPoint = { time: number; value: number | null };
export type ChartSeries = {
  id: string; label: string; color: string; points: SeriesPoint[];
  /** Secondary series keep their own scale on the left edge (for example cumulative bot PnL over wallet value). */
  axis?: 'primary' | 'secondary'; area?: boolean; unit?: string; format?: (value: number) => string; dashed?: boolean;
};
export type ChartMarker = { time: number; label: string; color?: string };


/** Axis tick label that fits the visible span: clock times within two days, dates beyond. */
export function timeTick(span: number) {
  return (time: number) => span <= 2 * 86_400_000
    ? new Date(time).toLocaleTimeString('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' })
    : new Date(time).toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'short', day: 'numeric' });
}

export type TimeSeriesProjection = {
  rows: Record<string, number>[];
  keys: { key: string; series: ChartSeries; single: SeriesPoint | null }[];
  domain: [number, number] | null;
  invalid: string | null;
};

/**
 * Pure projection behind TimeSeriesChart. Each series splits at null values into separate keys, so
 * no line crosses a gap, while samples from other series on the shared time axis never break it.
 */
export function projectTimeSeries(series: ChartSeries[]): TimeSeriesProjection {
  const byTime = new Map<number, Record<string, number>>();
  const keys: TimeSeriesProjection['keys'] = [];
  let min = Infinity, max = -Infinity;
  for (const item of series) {
    for (let index = 0; index < item.points.length; index++) {
      const point = item.points[index];
      if (!Number.isFinite(point.time) || (index > 0 && point.time <= item.points[index - 1].time)) return { rows: [], keys: [], domain: null, invalid: `${item.label}: timestamps are invalid or out of order.` };
      if (point.value !== null && !Number.isFinite(point.value)) return { rows: [], keys: [], domain: null, invalid: `${item.label}: a value is not a finite number.` };
    }
    let segment: SeriesPoint[] = [];
    const flush = () => {
      if (!segment.length) return;
      const key = `${item.id}~${keys.filter(entry => entry.series.id === item.id).length}`;
      keys.push({ key, series: item, single: segment.length === 1 ? segment[0] : null });
      for (const point of segment) {
        const row = byTime.get(point.time) ?? { time: point.time };
        row[key] = point.value as number;
        byTime.set(point.time, row);
        min = Math.min(min, point.time); max = Math.max(max, point.time);
      }
      segment = [];
    };
    for (const point of item.points) { if (point.value === null) flush(); else segment.push(point); }
    flush();
  }
  const rows = [...byTime.values()].sort((a, b) => a.time - b.time);
  return { rows, keys, domain: Number.isFinite(min) ? [min, max === min ? min + 1 : max] : null, invalid: null };
}

/** The sample a series held at `time`: the latest point at or before it. A null sample is a gap. */
export function valueAt(points: SeriesPoint[], time: number): SeriesPoint | null {
  let low = 0, high = points.length - 1, found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (points[mid].time <= time) { found = mid; low = mid + 1; } else high = mid - 1;
  }
  return found < 0 ? null : points[found];
}

/** Padded numeric domain for the values of the given series; flat lines get a visible band. */
export function valueDomain(series: ChartSeries[], includeZero = false): [number, number] | null {
  const values = series.flatMap(item => item.points.map(point => point.value).filter((value): value is number => value !== null));
  if (includeZero) values.push(0);
  if (!values.length) return null;
  const low = Math.min(...values), high = Math.max(...values);
  const pad = Math.max((high - low) * 0.08, Math.abs(high) * 0.0005, 1e-9);
  return [low - pad, high + pad];
}
