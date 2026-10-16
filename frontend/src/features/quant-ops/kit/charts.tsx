import { useId, useMemo, useState, type ReactNode } from 'react';
import { Area, Bar, CartesianGrid, Cell, ComposedChart, Line, Pie, PieChart, ReferenceArea, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatDecimal, formatSigned } from '../format';
import { CHART, dayTicks, markerLayout, projectTimeSeries, roundedAxis, seriesInRange, timeTick, valueAt, valueExtent, zoomSelection, type ChartMarker, type ChartSeries, type SeriesPoint } from './series';
import './kit.css';

/**
 * Shared hoverable charts for every dashboard page. All charts are Recharts compositions with one
 * crosshair tooltip style. Gaps (null values) are never interpolated; the tooltip reports the value
 * each series held at the hovered time, and says when that sample is older than the cursor.
 */

const plain = (value: number) => formatDecimal(value);
const utc = (time: number, withDate = true) => new Date(time).toLocaleString('en-GB', { timeZone: 'UTC', ...(withDate ? { month: 'short', day: 'numeric' } : {}), hour: '2-digit', minute: '2-digit' });

export function TooltipCard({ title, rows }: { title: string; rows: { key: string; label: string; color: string; value: string; note?: string; tone?: string }[] }) {
  return <div className="q-tooltip">
    <p className="q-tooltip__title">{title}</p>
    {rows.map(row => <p key={row.key} className="q-tooltip__row">
      <i style={{ background: row.color }} /><span>{row.label}</span><strong className={row.tone}>{row.value}</strong>
      {row.note && <small>{row.note}</small>}
    </p>)}
  </div>;
}


const toneClass = (value: number | null, signed: boolean) => !signed || value == null || value === 0 ? undefined : value > 0 ? 'q-positive' : 'q-negative';

/** Hoverable multi-series time chart with left/right axes, gap-preserving lines and optional markers. */
export function TimeSeriesChart({ series, height = 220, markers = [], highlight, domains, timeDomain, leftFormat = plain, rightFormat = plain, leftTickFormat, zeroLine = false, includeZero = false, signed = false, ariaLabel, emptyText = 'No observations in this window.', zoom = null, onZoom }: {
  series: ChartSeries[]; height?: number; markers?: ChartMarker[]; highlight?: { time: number; value: number; label: string; color?: string } | null;
  /** Fixed value ranges per axis (for example breadth pressure -3..3 beside a 0..100% share), instead of the padded data range. */
  domains?: { left?: [number, number]; right?: [number, number] };
  /** Shared retained interval, including missing edge observations in aligned plots. */
  timeDomain?: [number, number];
  leftFormat?: (value: number) => string; rightFormat?: (value: number) => string;
  /** Left-axis labels from the rounded tick step, so one axis never mixes precisions; tooltips keep `leftFormat`. */
  leftTickFormat?: (value: number, step: number, ticks: number[]) => string;
  zeroLine?: boolean; includeZero?: boolean; signed?: boolean;
  ariaLabel: string; emptyText?: ReactNode;
  /** Visible time range inside the full domain; null shows everything. */
  zoom?: [number, number] | null;
  /** Enables drag-to-zoom on the plot (a drag selects a range) and double-click to reset (null). */
  onZoom?: (range: [number, number] | null) => void;
}) {
  const gradient = useId().replaceAll(':', '');
  const projection = useMemo(() => projectTimeSeries(series), [series]);
  const [drag, setDrag] = useState<{ start: number; end: number } | null>(null);
  if (projection.invalid) return <p className="q-empty">{projection.invalid} History cannot be plotted.</p>;
  if (!projection.rows.length || !projection.domain) return <div className="q-chart-empty" style={{ minHeight: Math.min(height, 160) }}><p>{emptyText}</p></div>;
  const fullDomain = timeDomain ?? projection.domain;
  // A zoom outside the current data (new history, other window) falls back to the full view.
  const zoomed = zoom ? zoomSelection(zoom[0], zoom[1], fullDomain, 0) : null;
  const visible = zoomed ? seriesInRange(series, zoomed) : series;
  const left = visible.filter(item => item.axis !== 'secondary'), right = visible.filter(item => item.axis === 'secondary');
  // Data-derived axes widen to rounded ticks; caller-fixed domains (for example -3..3 pressure) stay exact.
  const leftNice = domains?.left ? null : roundedAxis(valueExtent(left, includeZero), { margin: true }), rightNice = domains?.right ? null : roundedAxis(valueExtent(right, includeZero), { margin: true });
  const leftDomain = domains?.left ?? leftNice?.domain ?? null, rightDomain = domains?.right ?? rightNice?.domain ?? null;
  // Values whose span cannot form an axis (for example ±1.7e308) are reported, never handed to Recharts as 'auto'.
  if ((!domains?.left && valueExtent(left, includeZero) && !leftNice) || (!domains?.right && valueExtent(right, includeZero) && !rightNice)) return <p className="q-empty">Values span an unsupported numeric range. History cannot be plotted.</p>;
  const domain = zoomed ?? fullDomain;
  const span = domain[1] - domain[0];
  const tick = timeTick(span);
  // Date-only labels sit on UTC midnights so neighbouring ticks never repeat a date.
  const days = (!timeDomain || zoomed) && span > 2 * 86_400_000 ? dayTicks(domain) : [];
  const timeTicks = timeDomain && !zoomed ? (span <= 120_000 ? [...domain] : [domain[0], domain[0] + span / 2, domain[1]]) : days.length >= 2 ? days : undefined;
  const inRange = (time: number) => time >= domain[0] && time <= domain[1];
  const shownMarkers = markers.filter(marker => inRange(marker.time)), markerView = markerLayout(shownMarkers, domain);
  const at = (state: unknown) => Number((state as { activeLabel?: unknown } | null)?.activeLabel);
  const finishDrag = () => {
    const range = drag && zoomSelection(drag.start, drag.end, domain);
    setDrag(null);
    if (range && onZoom) onZoom(range);
  };
  return <figure className={onZoom ? 'q-chart q-chart--zoomable' : 'q-chart'} role="img" aria-label={ariaLabel} style={{ height }}
    onDoubleClick={onZoom && zoomed ? () => onZoom(null) : undefined}>
    <ResponsiveContainer width="100%" height={height} minWidth={0}>
      <ComposedChart data={projection.rows} margin={{ top: 8, right: (right.length ? 4 : 10) + (markerView.edgeRoom ? 12 : 0), bottom: 0, left: timeDomain ? 10 : 0 }}
        onMouseDown={onZoom ? state => { const time = at(state); if (Number.isFinite(time)) setDrag({ start: time, end: time }); } : undefined}
        onMouseMove={onZoom && drag ? state => { const time = at(state); if (Number.isFinite(time)) setDrag({ ...drag, end: time }); } : undefined}
        onMouseUp={onZoom ? finishDrag : undefined} onMouseLeave={onZoom && drag ? () => setDrag(null) : undefined}>
        <defs>{[...new Map(projection.keys.map(entry => [entry.series.id, entry.series])).values()].filter(item => item.area).map(item => <linearGradient key={item.id} id={`${gradient}-${item.id}`} x1="0" y1={item.zeroBase && item.points.every(point => point.value === null || point.value <= 0) ? '1' : '0'} x2="0" y2={item.zeroBase && item.points.every(point => point.value === null || point.value <= 0) ? '0' : '1'}>
          <stop offset="0%" style={{ stopColor: item.color }} stopOpacity={item.fillOpacity ?? 0.28} /><stop offset="100%" style={{ stopColor: item.color }} stopOpacity={item.zeroBase ? (item.fillOpacity ?? 0.28) * 0.35 : 0} />
        </linearGradient>)}</defs>
        <CartesianGrid stroke={CHART.grid} strokeDasharray="3 5" vertical={false} />
        <XAxis dataKey="time" type="number" scale="time" domain={domain} allowDataOverflow={Boolean(zoomed)} interval={timeTicks ? 0 : undefined} ticks={timeTicks} tickFormatter={tick} tick={{ fill: CHART.muted, fontSize: 10 }} stroke={CHART.grid} minTickGap={48} tickLine={false} />
        <YAxis yAxisId="left" orientation="right" domain={leftDomain ?? ['auto', 'auto']} ticks={leftNice?.ticks} interval={leftNice ? 0 : undefined} tickFormatter={value => leftTickFormat && leftNice ? leftTickFormat(value, leftNice.step, leftNice.ticks) : leftFormat(value)} tick={{ fill: CHART.muted, fontSize: 10 }} stroke="transparent" width={64} hide={!left.length} />
        {right.length > 0 && <YAxis yAxisId="right" orientation="left" domain={rightDomain ?? ['auto', 'auto']} ticks={rightNice?.ticks} interval={rightNice ? 0 : undefined} tickFormatter={value => rightFormat(value)} tick={{ fill: right[0].color, fontSize: 10 }} stroke="transparent" width={52} />}
        {zeroLine && <ReferenceLine yAxisId="left" y={0} stroke={CHART.muted} strokeDasharray="2 3" />}
        {shownMarkers.map(marker => <ReferenceLine key={`${marker.label}-${marker.time}`} yAxisId="left" x={marker.time} stroke={marker.color ?? CHART.warning} strokeDasharray="2 4"
          label={markerView.labelled ? { value: marker.label, position: markerView.edgeRoom && domain[1] - marker.time <= (domain[1] - domain[0]) * 0.01 ? 'insideTopRight' : 'insideTopLeft', fontSize: 9, fill: CHART.muted } : undefined} />)}
        <Tooltip isAnimationActive={false} cursor={{ stroke: CHART.muted, strokeDasharray: '3 4' }} wrapperStyle={{ outline: 'none', zIndex: 5 }}
          content={({ active, label }) => {
            if (!active || typeof label !== 'number') return null;
            const rows = series.flatMap(item => {
              const sample = valueAt(item.points, label);
              if (!sample) return [];
              const format = item.format ?? (item.axis === 'secondary' ? rightFormat : leftFormat);
              const lag = label - sample.time;
              return [{ key: item.id, label: item.label, color: item.color, value: sample.value === null ? 'Gap' : `${format(sample.value)}${item.unit ? ` ${item.unit}` : ''}`, tone: toneClass(sample.value, signed || item.axis === 'secondary'), note: sample.value !== null && lag > 0 ? `as of ${utc(sample.time, span > 86_400_000)}` : undefined }];
            });
            const marker = markers.find(item => Math.abs(item.time - label) <= span / 200);
            return <TooltipCard title={`${utc(label)} UTC${marker ? ` · ${marker.label}` : ''}`} rows={rows} />;
          }} />
        {projection.keys.filter(({ series: item }) => !item.tooltipOnly).map(({ key, series: item }) => item.area
          ? <Area key={key} yAxisId={item.axis === 'secondary' ? 'right' : 'left'} dataKey={key} type="linear" stroke={item.color} strokeWidth={1.8} strokeDasharray={item.dash} fill={`url(#${gradient}-${item.id})`} baseValue={item.zeroBase ? 0 : undefined} connectNulls isAnimationActive={false} dot={false} activeDot={{ r: 3.5, strokeWidth: 2, stroke: CHART.surface }} name={item.label} />
          : <Line key={key} yAxisId={item.axis === 'secondary' ? 'right' : 'left'} dataKey={key} type="linear" stroke={item.color} strokeWidth={1.6} strokeDasharray={item.dash} connectNulls isAnimationActive={false} dot={false} activeDot={{ r: 3.5, strokeWidth: 2, stroke: CHART.surface }} name={item.label} />)}
        {projection.keys.filter(entry => entry.single && !entry.series.tooltipOnly).map(({ key, series: item, single }) => <ReferenceDot key={`${key}-dot`} yAxisId={item.axis === 'secondary' ? 'right' : 'left'} x={single!.time} y={single!.value as number} r={3} fill={item.color} stroke="none" />)}
        {drag && drag.end !== drag.start && <ReferenceArea yAxisId="left" x1={Math.min(drag.start, drag.end)} x2={Math.max(drag.start, drag.end)} fill={CHART.blue} fillOpacity={0.12} stroke={CHART.blue} strokeOpacity={0.45} ifOverflow="hidden" />}
        {highlight && inRange(highlight.time) && <ReferenceDot yAxisId="left" x={highlight.time} y={highlight.value} r={4} fill={highlight.color ?? CHART.negative} stroke={CHART.surface} strokeWidth={2} label={{ value: highlight.label, position: 'insideBottomRight', fill: CHART.text, fontSize: 10 }} />}
      </ComposedChart>
    </ResponsiveContainer>
  </figure>;
}

export type BarSpec = {
  id: string; label: string; color: string; signColors?: boolean;
  /** Per-row fill (for example a state colour); a row without one keeps the bar colour. */
  colorFor?: (row: Record<string, number | string | null>) => string | undefined;
};

/** Hoverable category bars (days, bins) with an optional line on its own axis. Missing values stay empty. */
export function BarsChart({ rows, bars, line, height = 160, format = formatSigned, tickFormat, signed = true, integer = false, unit, ariaLabel, emptyText = 'No values to plot.' }: {
  rows: ({ label: string } & Record<string, number | string | null>)[]; bars: BarSpec[]; line?: { id: string; label: string; color: string } | null;
  height?: number; format?: (value: number) => string; unit?: string; ariaLabel: string; emptyText?: ReactNode;
  /** Axis labels from the rounded tick step; tooltips keep `format`. */
  tickFormat?: (value: number, step: number, ticks: number[]) => string;
  /** Counts: whole-number axis ticks only. */
  integer?: boolean;
  /** Signed values color gains and losses in the tooltip; counts are not signed. */
  signed?: boolean;
}) {
  const keys = [...bars.map(bar => bar.id), ...(line ? [line.id] : [])];
  if (!rows.some(row => keys.some(key => typeof row[key] === 'number'))) return <p className="q-empty">{emptyText}</p>;
  const barValues = rows.flatMap(row => bars.map(bar => row[bar.id]).filter((value): value is number => typeof value === 'number' && Number.isFinite(value)));
  const barLow = Math.min(0, ...barValues), barHigh = Math.max(0, ...barValues);
  // All-zero bars keep a 0..1 axis instead of inventing a negative band around zero.
  const axis = barValues.length ? roundedAxis([barLow, barHigh === barLow ? barLow + 1 : barHigh], { integer }) : null;
  if (barValues.length && !axis) return <p className="q-empty">Values span an unsupported numeric range. Bars cannot be plotted.</p>;
  return <figure className="q-chart" role="img" aria-label={ariaLabel} style={{ height }}>
    <ResponsiveContainer width="100%" height={height} minWidth={0}>
      <ComposedChart data={rows} margin={{ top: 6, right: 4, bottom: 0, left: 0 }} barGap={2} barCategoryGap="22%">
        <CartesianGrid stroke={CHART.grid} strokeDasharray="3 5" vertical={false} />
        <XAxis dataKey="label" tick={{ fill: CHART.muted, fontSize: 10 }} stroke={CHART.grid} tickLine={false} minTickGap={16} />
        <YAxis yAxisId="left" orientation="right" domain={axis?.domain ?? [(low: number) => Math.min(0, low), (high: number) => Math.max(0, high)]} ticks={axis?.ticks} interval={axis ? 0 : undefined} tickFormatter={value => tickFormat && axis ? tickFormat(value, axis.step, axis.ticks) : format(value)} tick={{ fill: CHART.muted, fontSize: 10 }} stroke="transparent" width={56} allowDecimals={!integer} />
        {line && <YAxis yAxisId="line" hide />}
        <ReferenceLine yAxisId="left" y={0} stroke={CHART.grid} />
        <Tooltip isAnimationActive={false} cursor={{ fill: 'color-mix(in srgb, var(--q-blue, #259aff) 10%, transparent)' }} wrapperStyle={{ outline: 'none', zIndex: 5 }}
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null;
            const row = payload[0].payload as Record<string, number | string | null>;
            const specs = [...bars, ...(line ? [{ ...line, signColors: false }] : [])];
            return <TooltipCard title={String(label)} rows={specs.flatMap(spec => {
              const value = row[spec.id];
              if (typeof value !== 'number') return [];
              return [{ key: spec.id, label: spec.label, color: 'colorFor' in spec && spec.colorFor?.(row) || (spec.signColors ? (value >= 0 ? CHART.positive : CHART.negative) : spec.color), value: `${format(value)}${unit ? ` ${unit}` : ''}`, tone: toneClass(value, signed) }];
            })} />;
          }} />
        {bars.map(bar => <Bar key={bar.id} yAxisId="left" dataKey={bar.id} name={bar.label} fill={bar.color} radius={[2, 2, 2, 2]} maxBarSize={28} isAnimationActive={false}>
          {(bar.signColors || bar.colorFor) && rows.map((row, index) => <Cell key={index} fill={bar.colorFor?.(row) ?? (bar.signColors ? (typeof row[bar.id] === 'number' && (row[bar.id] as number) < 0 ? CHART.negative : CHART.positive) : bar.color)} />)}
        </Bar>)}
        {line && <Line yAxisId="line" dataKey={line.id} name={line.label} stroke={line.color} strokeWidth={1.6} dot={false} activeDot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />}
      </ComposedChart>
    </ResponsiveContainer>
  </figure>;
}

/** Hoverable donut. Slice colors come from the caller; the legend stays readable text. */
export function DonutChart({ slices, center, sub, unit, format = plain }: {
  slices: { label: string; value: number; color: string }[]; center: string; sub?: string; unit: string; format?: (value: number) => string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  if (total <= 0) return <p className="q-empty">Composition is unavailable until priced holdings exist.</p>;
  const focus = active == null ? null : slices[active];
  return <figure className="q-donut-chart"><div className="q-donut-chart__body">
    <div className="q-donut-chart__plot" role="img" aria-label={`${center} ${unit} composition`}>
      <ResponsiveContainer width="100%" aspect={1} minWidth={0} initialDimension={{ width: 200, height: 200 }}>
        <PieChart>
          <Pie data={slices} dataKey="value" nameKey="label" innerRadius="64%" outerRadius="96%" paddingAngle={slices.length > 1 ? 1.2 : 0} stroke="none" isAnimationActive={false}
            onMouseEnter={(_, index) => setActive(index)} onMouseLeave={() => setActive(null)}>
            {slices.map((slice, index) => <Cell key={slice.label} fill={slice.color} opacity={active == null || active === index ? 1 : 0.45} />)}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div className="q-donut-chart__center" aria-hidden="true">
        <strong>{focus ? `${((focus.value / total) * 100).toFixed(1)}%` : center}</strong>
        <small>{focus ? focus.label : sub ?? unit}</small>
      </div>
    </div>
    <ul className="q-donut-chart__legend">
      {slices.map((slice, index) => <li key={slice.label} data-active={active === index} onMouseEnter={() => setActive(index)} onMouseLeave={() => setActive(null)}>
        <i style={{ background: slice.color }} /><span title={slice.label}>{slice.label}</span>
        <strong>{((slice.value / total) * 100).toFixed(1)}%</strong><small>{format(slice.value)}</small>
      </li>)}
    </ul>
  </div></figure>;
}

/** Hoverable sparkline. Points may carry times; plain numbers are shown by position. */
export function SparkChart({ points, positive, color, height = 30, format = plain, unit, ariaLabel = 'Trend' }: {
  points: number[] | SeriesPoint[]; positive?: boolean; color?: string; height?: number; format?: (value: number) => string; unit?: string; ariaLabel?: string;
}) {
  const gradient = useId().replaceAll(':', '');
  const rows = (points as (number | SeriesPoint)[]).map((point, index) => typeof point === 'number' ? { index, value: point, time: null as number | null } : { index, value: point.value, time: point.time });
  // Timed points sit on elapsed time so irregular sampling and gaps keep their true spacing.
  const timed = rows.length > 0 && rows.every(row => row.time != null && Number.isFinite(row.time));
  if (rows.filter(row => row.value != null).length < 2) return <span className="q-spark q-spark--empty" aria-hidden="true" style={{ height }} />;
  const stroke = color ?? (positive === false ? CHART.negative : CHART.positive);
  return <span className="q-spark" role="img" aria-label={ariaLabel} style={{ height }}>
    <ResponsiveContainer width="100%" height={height} minWidth={0}>
      <ComposedChart data={rows} margin={{ top: 3, right: 2, bottom: 2, left: 2 }}>
        <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" style={{ stopColor: stroke }} stopOpacity={0.32} /><stop offset="100%" style={{ stopColor: stroke }} stopOpacity={0} /></linearGradient></defs>
        <XAxis dataKey={timed ? 'time' : 'index'} type="number" domain={['dataMin', 'dataMax']} hide />
        <YAxis domain={['dataMin', 'dataMax']} hide />
        <Tooltip isAnimationActive={false} cursor={{ stroke: CHART.muted, strokeDasharray: '2 3' }} wrapperStyle={{ outline: 'none', zIndex: 5 }} allowEscapeViewBox={{ x: true, y: true }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const row = payload[0].payload as (typeof rows)[number];
            return <div className="q-tooltip q-tooltip--compact"><strong>{row.value == null ? 'Gap' : `${format(row.value)}${unit ? ` ${unit}` : ''}`}</strong>{row.time != null && <small>{utc(row.time)} UTC</small>}</div>;
          }} />
        <Area dataKey="value" type="linear" stroke={stroke} strokeWidth={1.6} fill={`url(#${gradient})`} connectNulls={false} dot={false} activeDot={{ r: 2.5, stroke: 'none', fill: stroke }} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  </span>;
}
