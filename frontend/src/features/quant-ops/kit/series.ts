/** Pure series projection and palette for the shared charts. No React, so it is testable and fast-refresh safe. */

/** Palette tokens with fallbacks, so charts render the same outside a `[data-quant-ops]` scope. */
export const CHART = {
  blue: 'var(--q-blue, var(--color-primary, #259aff))', cyan: 'var(--q-cyan, var(--color-accent, #22d3ee))', positive: 'var(--q-positive, var(--color-green, #35eab5))', negative: 'var(--q-negative, var(--color-red, #ff6577))',
  warning: 'var(--q-warning, var(--color-yellow, #f59e0b))', violet: 'var(--q-violet, #8b5cf6)', neutral: 'var(--q-neutral, #64748b)',
  grid: 'var(--q-border, var(--color-border, #20313e))', muted: 'var(--q-muted, var(--color-text-muted, #a4bacb))', text: 'var(--q-text, var(--color-text, #e5e7eb))', surface: 'var(--q-surface, var(--color-surface, #0a151d))',
} as const;

/** Largest JavaScript Date offset; later or earlier timestamps cannot be shown as a time. */
const MAX_TIME_MS = 8.64e15;

export type SeriesPoint = { time: number; value: number | null };
export type ChartSeries = {
  id: string; label: string; color: string; points: SeriesPoint[];
  /** Secondary series keep their own scale on the left edge (for example cumulative bot PnL over wallet value). */
  axis?: 'primary' | 'secondary'; area?: boolean; unit?: string; format?: (value: number) => string;
  /** One signed series drawn green above zero and red below it (breadth pressure, net flow). Tooltip still shows one row. */
  signSplit?: { positive: string; negative: string };
  /** Set on the drawn halves of a `signSplit` series: the area fills from zero, not from the axis floor. */
  zeroBase?: boolean;
  /** Listed in the tooltip (with its own axis scale) but not drawn, for values a drawn series already implies. */
  tooltipOnly?: boolean;
  /** Area gradient strength at the line; defaults to 0.28. */
  fillOpacity?: number;
  /** Optional line pattern shared with visible legends for non-color identification. */
  dash?: string;
};
export type ChartMarker = { time: number; label: string; color?: string };


/** Axis tick label that fits the visible span: clock times within two days, dates beyond. */
export function timeTick(span: number) {
  return (time: number) => span <= 2 * 86_400_000
    ? new Date(time).toLocaleTimeString('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' })
    : new Date(time).toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'short', day: 'numeric' });
}

/**
 * Splits a `signSplit` series into a positive and a negative part joined at the exact zero crossing,
 * so each part can be coloured on its own. Only drawing uses the parts; values are never altered.
 */
export function expandSignSplit(series: ChartSeries[]): ChartSeries[] {
  return series.flatMap(item => {
    if (!item.signSplit) return [item];
    const part = (sign: 1 | -1, color: string): ChartSeries => {
      const points: SeriesPoint[] = [];
      item.points.forEach((point, index) => {
        const previous = item.points[index - 1];
        if (previous && previous.value !== null && point.value !== null && previous.value * point.value < 0) {
          const crossing = previous.time + (previous.value / (previous.value - point.value)) * (point.time - previous.time);
          if (crossing > previous.time && crossing < point.time) points.push({ time: crossing, value: 0 });
        }
        points.push({ time: point.time, value: point.value === null ? null : sign * point.value > 0 ? point.value : 0 });
      });
      return { ...item, id: `${item.id}${sign > 0 ? '+' : '-'}`, color, points, signSplit: undefined, zeroBase: true };
    };
    return [part(1, item.signSplit.positive), part(-1, item.signSplit.negative)];
  });
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
export function projectTimeSeries(input: ChartSeries[]): TimeSeriesProjection {
  const series = expandSignSplit(input);
  const byTime = new Map<number, Record<string, number>>();
  const keys: TimeSeriesProjection['keys'] = [];
  let min = Infinity, max = -Infinity;
  for (const item of series) {
    for (let index = 0; index < item.points.length; index++) {
      const point = item.points[index];
      if (!Number.isFinite(point.time) || Math.abs(point.time) > MAX_TIME_MS || (index > 0 && point.time <= item.points[index - 1].time)) return { rows: [], keys: [], domain: null, invalid: `${item.label}: timestamps are invalid or out of order.` };
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

/** Unpadded [min, max] of the drawn values (and zero when asked); rounded axes add their own headroom. */
export function valueExtent(series: ChartSeries[], includeZero = false): [number, number] | null {
  const values = series.flatMap(item => item.points.map(point => point.value).filter((value): value is number => value !== null));
  if (includeZero) values.push(0);
  return values.length ? [Math.min(...values), Math.max(...values)] : null;
}

/** Padded numeric domain for the values of the given series; flat lines get a visible band. */
export function valueDomain(series: ChartSeries[], includeZero = false): [number, number] | null {
  const values = series.flatMap(item => item.points.map(point => point.value).filter((value): value is number => value !== null));
  if (includeZero) values.push(0);
  if (!values.length) return null;
  const low = Math.min(...values), high = Math.max(...values);
  // A flat series still gets a readable band: 1% of its level, or 0.01 around zero.
  const pad = high > low ? Math.max((high - low) * 0.08, Math.abs(high) * 0.0005) : Math.abs(high) * 0.01 || 0.01;
  return [low - pad, high + pad];
}

const cleanTick = (value: number) => {
  const rounded = Number(value.toPrecision(12));
  return rounded === 0 ? 0 : rounded;
};

/**
 * Rounded axis ticks that cover [low, high] in steps of 1, 2, 2.5 or 5 × 10^n. Only the axis extent
 * widens to the nearest tick; plotted values are never changed or clipped.
 */
export function niceTicks(low: number, high: number, count = 5, integer = false): { ticks: number[]; step: number } | null {
  if (!Number.isFinite(low) || !Number.isFinite(high) || high < low || !Number.isFinite(high - low)) return null;
  // A range flat relative to its magnitude, or so small it underflows, gets the flat-series band.
  if (high - low <= Math.max(Math.abs(low), Math.abs(high)) * 1e-9 || high - low < 1e-250) {
    const relative = Math.abs(high) * 0.01;
    const pad = relative >= 1e-250 ? relative : integer ? 1 : 0.01; low -= pad; high += pad;
  }
  const raw = (high - low) / Math.max(1, count - 1);
  const power = 10 ** Math.floor(Math.log10(raw));
  let step = [1, 2, 2.5, 5, 10].map(multiple => cleanTick(multiple * power)).find(candidate => candidate >= raw * (1 - 1e-9)) ?? 10 * power;
  if (integer) step = Math.max(1, Math.ceil(step));
  const first = Math.floor(low / step + 1e-9), last = Math.ceil(high / step - 1e-9);
  // Bounded, precision-safe iteration; null means no rounded axis (callers use the chart's own).
  if (!(step > 0) || !Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last - first > 50) return null;
  const ticks: number[] = [];
  for (let index = 0; index <= last - first; index++) ticks.push(cleanTick((first + index) * step));
  return new Set(ticks).size === ticks.length && ticks.length >= 2 ? { ticks, step } : null;
}

/** Decimal places that write every multiple of `step` exactly (2.5 → 1, 0.25 → 2). */
function stepDecimals(step: number) {
  for (let decimals = 0; decimals <= 12; decimals++) {
    const scaled = step * 10 ** decimals;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-6) return decimals;
  }
  return 12;
}

const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

/**
 * One label rule for a whole axis: the precision follows the tick step, so neighbouring ticks never
 * mix forms. Steps below 0.001 use a compact exponent (+1e-4); exact values stay in tables.
 */
export function axisFormatter(step: number, signed = false) {
  const prefix = (value: number) => signed && value > 0 ? '+' : '';
  if (step > 0 && step < 1e-3) {
    const exponent = Math.floor(Math.log10(step));
    const decimals = stepDecimals(cleanTick(step / 10 ** exponent));
    return (value: number) => value === 0 ? '0' : `${prefix(value)}${(value / 10 ** exponent).toFixed(decimals)}e${exponent}`;
  }
  const decimals = stepDecimals(step);
  const grouped = new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return (value: number) => {
    if (value === 0) return decimals ? (0).toFixed(decimals) : '0';
    // Compact K/M only when the step is coarse enough that neighbouring ticks still differ.
    if (Math.abs(value) >= 10_000 && step >= 1000) return `${prefix(value)}${COMPACT.format(value)}`;
    return `${prefix(value)}${Math.abs(value) >= 10_000 ? grouped.format(value) : value.toFixed(decimals)}`;
  };
}

const SUPERSCRIPT: Record<string, string> = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };

/**
 * Axis labels with one shared multiplier for tiny steps: ticks read -3, -2, … and the unit heading
 * carries ×10⁻⁴. The exponent follows the largest tick, so a narrow band near 0.00178 reads 1.76–1.80
 * ×10⁻³. Only the label is divided; plotted and tabulated values stay exact.
 */
export function axisScale(step: number, signed = false, ticks: number[] = []): { multiplier: string | null; format: (value: number) => string } {
  if (!(step > 0 && step < 1e-3)) return { multiplier: null, format: axisFormatter(step, signed) };
  const largest = Math.max(0, ...ticks.map(Math.abs));
  const exponent = Math.floor(Math.log10(largest > step ? largest : step));
  const mantissa = axisFormatter(cleanTick(step / 10 ** exponent), signed);
  return {
    multiplier: `×10${String(exponent).split('').map(char => SUPERSCRIPT[char]).join('')}`,
    format: value => mantissa(cleanTick(value / 10 ** exponent)),
  };
}

const DAY_MS = 86_400_000;

/**
 * UTC-midnight ticks inside a multi-day domain at one whole-day stride (at most about seven labels).
 * Ticks within 3% of either end are left out, so a centred date label is never cut by the plot edge.
 */
export function dayTicks([start, end]: [number, number], maxTicks = 7): number[] {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || Math.abs(start) > MAX_TIME_MS || Math.abs(end) > MAX_TIME_MS) return [];
  const stride = Math.max(1, Math.ceil((end - start) / DAY_MS / maxTicks)) * DAY_MS;
  const edge = (end - start) * 0.03, first = Math.ceil(start / DAY_MS) * DAY_MS;
  const ticks: number[] = [];
  // Index-bounded: at most maxTicks + 1 candidates whatever the float arithmetic does.
  for (let index = 0; index <= maxTicks; index++) {
    const tick = first + index * stride;
    if (tick > end) break;
    if (tick - start >= edge && end - tick >= edge) ticks.push(tick);
  }
  return ticks;
}

/** Axis label for a ratio shown in percent (-0.0005 → -0.05%), at the precision of the tick step. */
export function ratioPercentTick(value: number, step: number): string {
  return `${axisFormatter(cleanTick(step * 100))(cleanTick(value * 100))}%`;
}

/**
 * Rounded ticks and the axis extent they span. With `margin`, an extent that sits exactly on an outer
 * tick gets 3% headroom past it (no extra label), so a line on that value does not merge with the
 * frame; bars keep a flush zero baseline. Null when no rounded axis exists.
 */
export function roundedAxis(extent: [number, number] | null, { integer = false, margin = false }: { integer?: boolean; margin?: boolean } = {}) {
  const nice = extent && niceTicks(extent[0], extent[1], 5, integer);
  if (!nice) return null;
  const first = nice.ticks[0], last = nice.ticks[nice.ticks.length - 1], room = margin ? (last - first) * 0.03 : 0;
  return { ...nice, domain: [extent[0] === first ? first - room : first, extent[1] === last ? last + room : last] as [number, number] };
}
