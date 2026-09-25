import { useId, useMemo, useState, type ReactNode } from 'react';
import { Area, Bar, CartesianGrid, Cell, ComposedChart, Line, Pie, PieChart, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatDecimal, formatSigned } from '../format';
import { CHART, projectTimeSeries, timeTick, valueAt, valueDomain, type ChartMarker, type ChartSeries, type SeriesPoint } from './series';
import './kit.css';

/**
 * Shared hoverable charts for every dashboard page. All charts are Recharts compositions with one
 * crosshair tooltip style. Gaps (null values) are never interpolated; the tooltip reports the value
 * each series held at the hovered time, and says when that sample is older than the cursor.
 */

const plain = (value: number) => formatDecimal(value);
const utc = (time: number, withDate = true) => new Date(time).toLocaleString('en-GB', { timeZone: 'UTC', ...(withDate ? { month: 'short', day: 'numeric' } : {}), hour: '2-digit', minute: '2-digit' });

function TooltipCard({ title, rows }: { title: string; rows: { key: string; label: string; color: string; value: string; note?: string; tone?: string }[] }) {
  return <div className="q-tooltip" role="status">
    <p className="q-tooltip__title">{title}</p>
    {rows.map(row => <p key={row.key} className="q-tooltip__row">
      <i style={{ background: row.color }} /><span>{row.label}</span><strong className={row.tone}>{row.value}</strong>
      {row.note && <small>{row.note}</small>}
    </p>)}
  </div>;
}

const toneClass = (value: number | null, signed: boolean) => !signed || value == null || value === 0 ? undefined : value > 0 ? 'q-positive' : 'q-negative';

/** Hoverable multi-series time chart with left/right axes, gap-preserving lines and optional markers. */
export function TimeSeriesChart({ series, height = 220, markers = [], highlight, leftFormat = plain, rightFormat = plain, zeroLine = false, includeZero = false, signed = false, ariaLabel, emptyText = 'No observations in this window.' }: {
  series: ChartSeries[]; height?: number; markers?: ChartMarker[]; highlight?: { time: number; value: number; label: string; color?: string } | null;
  leftFormat?: (value: number) => string; rightFormat?: (value: number) => string; zeroLine?: boolean; includeZero?: boolean; signed?: boolean;
  ariaLabel: string; emptyText?: ReactNode;
}) {
  const gradient = useId().replaceAll(':', '');
  const projection = useMemo(() => projectTimeSeries(series), [series]);
  if (projection.invalid) return <p className="q-empty">{projection.invalid} History cannot be plotted.</p>;
  if (!projection.rows.length || !projection.domain) return <div className="q-chart-empty" style={{ minHeight: Math.min(height, 160) }}><p>{emptyText}</p></div>;
  const left = series.filter(item => item.axis !== 'secondary'), right = series.filter(item => item.axis === 'secondary');
  const leftDomain = valueDomain(left, includeZero), rightDomain = valueDomain(right, includeZero);
  const span = projection.domain[1] - projection.domain[0];
  const tick = timeTick(span);
  const inRange = (time: number) => time >= projection.domain![0] && time <= projection.domain![1];
  return <figure className="q-chart" role="img" aria-label={ariaLabel} style={{ height }}>
    <ResponsiveContainer width="100%" height={height} minWidth={0}>
      <ComposedChart data={projection.rows} margin={{ top: 8, right: right.length ? 4 : 10, bottom: 0, left: 0 }}>
        <defs>{series.filter(item => item.area).map(item => <linearGradient key={item.id} id={`${gradient}-${item.id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={item.color} stopOpacity={0.28} /><stop offset="100%" stopColor={item.color} stopOpacity={0} />
        </linearGradient>)}</defs>
        <CartesianGrid stroke={CHART.grid} strokeDasharray="3 5" vertical={false} />
        <XAxis dataKey="time" type="number" scale="time" domain={projection.domain} tickFormatter={tick} tick={{ fill: CHART.muted, fontSize: 10 }} stroke={CHART.grid} minTickGap={48} tickLine={false} />
        <YAxis yAxisId="left" orientation="right" domain={leftDomain ?? ['auto', 'auto']} tickFormatter={value => leftFormat(value)} tick={{ fill: CHART.muted, fontSize: 10 }} stroke="transparent" width={64} hide={!left.length} />
        {right.length > 0 && <YAxis yAxisId="right" orientation="left" domain={rightDomain ?? ['auto', 'auto']} tickFormatter={value => rightFormat(value)} tick={{ fill: right[0].color, fontSize: 10 }} stroke="transparent" width={52} />}
        {zeroLine && <ReferenceLine yAxisId="left" y={0} stroke={CHART.muted} strokeDasharray="2 3" />}
        {markers.filter(marker => inRange(marker.time)).map(marker => <ReferenceLine key={`${marker.label}-${marker.time}`} yAxisId="left" x={marker.time} stroke={marker.color ?? CHART.warning} strokeDasharray="2 4" />)}
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
        {projection.keys.map(({ key, series: item }) => item.area
          ? <Area key={key} yAxisId={item.axis === 'secondary' ? 'right' : 'left'} dataKey={key} type="linear" stroke={item.color} strokeWidth={1.8} fill={`url(#${gradient}-${item.id})`} connectNulls isAnimationActive={false} dot={false} activeDot={{ r: 3.5, strokeWidth: 2, stroke: CHART.surface }} name={item.label} />
          : <Line key={key} yAxisId={item.axis === 'secondary' ? 'right' : 'left'} dataKey={key} type="linear" stroke={item.color} strokeWidth={1.6} strokeDasharray={item.dashed ? '4 3' : undefined} connectNulls isAnimationActive={false} dot={false} activeDot={{ r: 3.5, strokeWidth: 2, stroke: CHART.surface }} name={item.label} />)}
        {projection.keys.filter(entry => entry.single).map(({ key, series: item, single }) => <ReferenceDot key={`${key}-dot`} yAxisId={item.axis === 'secondary' ? 'right' : 'left'} x={single!.time} y={single!.value as number} r={3} fill={item.color} stroke="none" />)}
        {highlight && inRange(highlight.time) && <ReferenceDot yAxisId="left" x={highlight.time} y={highlight.value} r={4} fill={highlight.color ?? CHART.negative} stroke={CHART.surface} strokeWidth={2} label={{ value: highlight.label, position: 'insideBottomRight', fill: CHART.text, fontSize: 10 }} />}
      </ComposedChart>
    </ResponsiveContainer>
  </figure>;
}

export type BarSpec = { id: string; label: string; color: string; signColors?: boolean };

/** Hoverable category bars (days, bins) with an optional line on its own axis. Missing values stay empty. */
export function BarsChart({ rows, bars, line, height = 160, format = formatSigned, unit, ariaLabel, stacked = false, emptyText = 'No values to plot.' }: {
  rows: ({ label: string } & Record<string, number | string | null>)[]; bars: BarSpec[]; line?: { id: string; label: string; color: string } | null;
  height?: number; format?: (value: number) => string; unit?: string; ariaLabel: string; stacked?: boolean; emptyText?: ReactNode;
}) {
  const keys = [...bars.map(bar => bar.id), ...(line ? [line.id] : [])];
  if (!rows.some(row => keys.some(key => typeof row[key] === 'number'))) return <p className="q-empty">{emptyText}</p>;
  return <figure className="q-chart" role="img" aria-label={ariaLabel} style={{ height }}>
    <ResponsiveContainer width="100%" height={height} minWidth={0}>
      <ComposedChart data={rows} margin={{ top: 6, right: 4, bottom: 0, left: 0 }} barGap={2} barCategoryGap="22%">
        <CartesianGrid stroke={CHART.grid} strokeDasharray="3 5" vertical={false} />
        <XAxis dataKey="label" tick={{ fill: CHART.muted, fontSize: 10 }} stroke={CHART.grid} tickLine={false} minTickGap={16} />
        <YAxis yAxisId="left" orientation="right" domain={[(low: number) => Math.min(0, low), (high: number) => Math.max(0, high)]} tickFormatter={value => format(value)} tick={{ fill: CHART.muted, fontSize: 10 }} stroke="transparent" width={56} />
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
              return [{ key: spec.id, label: spec.label, color: spec.signColors ? (value >= 0 ? CHART.positive : CHART.negative) : spec.color, value: `${format(value)}${unit ? ` ${unit}` : ''}`, tone: toneClass(value, format === formatSigned) }];
            })} />;
          }} />
        {bars.map(bar => <Bar key={bar.id} yAxisId="left" dataKey={bar.id} name={bar.label} fill={bar.color} radius={[2, 2, 2, 2]} maxBarSize={28} stackId={stacked ? 'stack' : undefined} isAnimationActive={false}>
          {bar.signColors && rows.map((row, index) => <Cell key={index} fill={typeof row[bar.id] === 'number' && (row[bar.id] as number) < 0 ? CHART.negative : CHART.positive} />)}
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
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
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
  if (rows.filter(row => row.value != null).length < 2) return <span className="q-spark q-spark--empty" aria-hidden="true" style={{ height }} />;
  const stroke = color ?? (positive === false ? CHART.negative : CHART.positive);
  return <span className="q-spark" role="img" aria-label={ariaLabel} style={{ height }}>
    <ResponsiveContainer width="100%" height={height} minWidth={0}>
      <ComposedChart data={rows} margin={{ top: 3, right: 2, bottom: 2, left: 2 }}>
        <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={stroke} stopOpacity={0.32} /><stop offset="100%" stopColor={stroke} stopOpacity={0} /></linearGradient></defs>
        <XAxis dataKey="index" type="number" domain={['dataMin', 'dataMax']} hide />
        <YAxis domain={['dataMin', 'dataMax']} hide />
        <Tooltip isAnimationActive={false} cursor={{ stroke: CHART.muted, strokeDasharray: '2 3' }} wrapperStyle={{ outline: 'none', zIndex: 5 }} allowEscapeViewBox={{ x: true, y: true }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const row = payload[0].payload as (typeof rows)[number];
            return <div className="q-tooltip q-tooltip--compact"><strong>{row.value == null ? 'Gap' : `${format(row.value)}${unit ? ` ${unit}` : ''}`}</strong>{row.time != null && <small>{utc(row.time)} UTC</small>}</div>;
          }} />
        <Area dataKey="value" type="monotone" stroke={stroke} strokeWidth={1.6} fill={`url(#${gradient})`} connectNulls={false} dot={false} activeDot={{ r: 2.5, stroke: 'none', fill: stroke }} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  </span>;
}
