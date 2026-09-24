import { useEffect, useRef, type ReactNode } from 'react';
import { assetColor, formatDecimal, formatSigned, metricTone } from './format';
import { describePanelState, PANEL_STATE_LABEL, type PanelState } from './panel-state';

/** Spec §5.4 glyph: one per panel, tooltip carries the exact reason and observation time. */
export function StateGlyph({ state }: { state: PanelState }) {
  return <span className="q-state" data-state={state.kind} title={describePanelState(state)} aria-label={describePanelState(state)}>
    {PANEL_STATE_LABEL[state.kind]}{state.sample ? ` ${state.sample.have}/${state.sample.need}` : ''}
  </span>;
}

export function PanelFrame({ panelId, title, scopeLabel, state, actions, children }: {
  panelId: string; title: string; scopeLabel?: string; state?: PanelState; actions?: ReactNode; children: ReactNode;
}) {
  return <section className="q-card" data-panel-id={panelId} data-state={state?.kind}>
    <header>
      <div><h2>{title}</h2>{scopeLabel && <p className="q-kicker">{scopeLabel}</p>}</div>
      {(state || actions) && <div className="q-card-actions">{actions}{state && <StateGlyph state={state} />}</div>}
    </header>
    {children}
  </section>;
}

export function MetricCard({ panelId, title, value, unit, note, tone, sparkline, delta, state }: {
  panelId: string; title: string; value: string; unit?: string; note?: string;
  tone?: 'positive' | 'negative'; sparkline?: ReactNode;
  /** Signed change over the comparison window; omitted (never "+0.00%") when that window is incomplete. */
  delta?: { amount: string | number | null; percent?: number | null } | null;
  state?: PanelState;
}) {
  const deltaTone = delta ? metricTone(delta.amount) : undefined;
  return <article className="q-card q-kpi" data-panel-id={panelId} data-state={state?.kind}>
    <div className="q-kpi-head"><span>{title}</span>{state && <StateGlyph state={state} />}</div>
    <strong className={tone ? `q-${tone}` : undefined}>{value}{unit ? <small>{unit}</small> : null}</strong>
    <div className="q-kpi-foot">
      {delta && delta.amount != null
        ? <span className={`q-kpi-delta${deltaTone ? ` q-${deltaTone}` : ''}`}>{deltaTone === 'positive' ? '▲' : deltaTone === 'negative' ? '▼' : '●'} {formatSigned(delta.amount)}{delta.percent != null ? ` (${formatSigned(delta.percent * 100)}%)` : ''}</span>
        : note ? <small className="q-muted">{note}</small> : <span />}
      {sparkline}
    </div>
    {delta && delta.amount != null && note ? <small className="q-muted">{note}</small> : null}
  </article>;
}

export type StatTileView = { id: string; label: string; value: string | null; unit?: string; state: PanelState; note?: string };

/** C18 strip: compact stats, each with its own typed state. Percent tiles receive a ratio and print a percent. */
export function StatStrip({ tiles, panelId = 'C18', ariaLabel = 'Capital statistics' }: { tiles: StatTileView[]; panelId?: string; ariaLabel?: string }) {
  return <section className="q-stats" data-panel-id={panelId} aria-label={ariaLabel}>
    {tiles.map(tile => {
      const isPercent = tile.unit === '%';
      const numeric = tile.value == null ? null : Number(tile.value);
      const text = tile.value == null || numeric == null || !Number.isFinite(numeric)
        ? PANEL_STATE_LABEL[tile.state.kind]
        : isPercent ? `${formatSigned(numeric * 100)}%` : tile.unit === 'x' ? `${formatDecimal(numeric)}x` : /pnl/i.test(tile.label) ? formatSigned(numeric) : formatDecimal(numeric);
      const tone = /pnl|drawdown/i.test(tile.label) ? metricTone(numeric) : undefined;
      return <article key={tile.id} className="q-stat" data-panel-id={tile.id} data-state={tile.state.kind}>
        <span>{tile.label}<StateGlyph state={tile.state} /></span>
        <strong className={tone ? `q-${tone}` : undefined}>{text}{tile.value != null && tile.unit && !isPercent && tile.unit !== 'x' ? <small>{tile.unit}</small> : null}</strong>
        {tile.note ? <small>{tile.note}</small> : tile.state.reason && tile.value == null ? <small>{tile.state.reason}</small> : null}
      </article>;
    })}
  </section>;
}

type SeriesPoint = { time: number; value: number | null };
const CW = 640, CH = 220, CPAD = { top: 14, right: 46, bottom: 22, left: 52 };
const dayLabel = (time: number) => new Date(time).toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function seriesPath(points: SeriesPoint[], x: (time: number) => number, y: (value: number) => number): string {
  let d = '', open = false;
  for (const point of points) {
    if (point.value == null) { open = false; continue; }
    d += `${open ? ' L' : `${d ? ' ' : ''}M`} ${x(point.time).toFixed(2)},${y(point.value).toFixed(2)}`;
    open = true;
  }
  return d;
}

function timeTicks(points: SeriesPoint[], count = 5) {
  const times = points.map(point => point.time);
  const min = Math.min(...times), max = Math.max(...times);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [];
  return Array.from({ length: count }, (_, index) => min + ((max - min) * index) / (count - 1));
}

/** C19: inverted drawdown area from 0%, loss fill, marker at the maximum. Values are ratios ≤ 0. */
export function DrawdownChart({ series, worst }: { series: SeriesPoint[]; worst: SeriesPoint | null }) {
  const known = series.map(point => point.value).filter((value): value is number => value != null);
  if (known.length < 2) return <p className="q-empty">Drawdown needs two complete equity observations in the range.</p>;
  const times = series.map(point => point.time);
  const t0 = Math.min(...times), t1 = Math.max(...times), tspan = t1 - t0 || 1;
  const floor = Math.min(-0.01, ...known);
  const x = (time: number) => CPAD.left + ((time - t0) / tspan) * (CW - CPAD.left - CPAD.right);
  const y = (value: number) => CPAD.top + (value / floor) * (CH - CPAD.top - CPAD.bottom);
  const line = seriesPath(series, x, y);
  const first = series.find(point => point.value != null)!, last = [...series].reverse().find(point => point.value != null)!;
  const area = `${line} L ${x(last.time).toFixed(2)},${CPAD.top} L ${x(first.time).toFixed(2)},${CPAD.top} Z`;
  const ticks = [0, floor / 3, (2 * floor) / 3, floor];
  return <figure>
    <svg viewBox={`0 0 ${CW} ${CH}`} width="100%" height={CH} role="img" aria-label={`Drawdown, worst ${worst?.value == null ? 'unavailable' : `${(worst.value * 100).toFixed(2)}%`}`} preserveAspectRatio="none" style={{ display: 'block' }}>
      {ticks.map(tick => <g key={tick}><line x1={CPAD.left} x2={CW - CPAD.right} y1={y(tick)} y2={y(tick)} stroke="var(--q-border)" strokeDasharray="3 4" /><text className="q-axis" x={CPAD.left - 6} y={y(tick) + 3} textAnchor="end">{(tick * 100).toFixed(1)}%</text></g>)}
      {timeTicks(series).map(tick => <text key={tick} className="q-axis" x={x(tick)} y={CH - 6} textAnchor="middle">{dayLabel(tick)}</text>)}
      <path d={area} fill="var(--q-negative)" opacity="0.2" />
      <path d={line} fill="none" stroke="var(--q-negative)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      {worst?.value != null && <g>
        <circle cx={x(worst.time)} cy={y(worst.value)} r="3.5" fill="var(--q-negative)" />
        <text className="q-axis" x={Math.min(x(worst.time) + 8, CW - CPAD.right - 90)} y={Math.max(y(worst.value) - 6, CPAD.top + 10)} fill="var(--q-text)">Max DD {(worst.value * 100).toFixed(2)}% · {dayLabel(worst.time)}</text>
      </g>}
    </svg>
  </figure>;
}

/** C20: daily bars for realized (gain/loss colors) and unrealized (violet), cumulative total as a line. */
export function PnlBars({ days, unit }: { days: { day: string; realized: number | null; unrealized: number | null; cumulative: number | null }[]; unit: string }) {
  const valued = days.filter(day => day.realized != null || day.unrealized != null);
  if (!valued.length) return <p className="q-empty">Daily realized and unrealized changes need at least one day of saved native performance.</p>;
  const peak = Math.max(1e-9, ...valued.flatMap(day => [Math.abs(day.realized ?? 0), Math.abs(day.unrealized ?? 0)]));
  const cumulative = valued.map(day => day.cumulative).filter((value): value is number => value != null);
  const cmin = Math.min(0, ...cumulative), cmax = Math.max(0, ...cumulative), cspan = cmax - cmin || 1;
  const w = Math.max(220, valued.length * 28), h = 140, mid = 70;
  const cy = (value: number) => 10 + (1 - (value - cmin) / cspan) * (h - 30);
  const line = valued.map((day, index) => day.cumulative == null ? null : `${index * 28 + 14},${cy(day.cumulative).toFixed(2)}`).reduce<string>((path, pair) => pair == null ? path : `${path}${path ? ' L ' : 'M '}${pair}`, '');
  return <figure>
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label={`Daily realized and unrealized PnL · ${unit}`} preserveAspectRatio="none" style={{ display: 'block' }}>
      <line x1="0" x2={w} y1={mid} y2={mid} stroke="var(--q-border)" />
      {valued.map((day, index) => {
        const x = index * 28;
        const bar = (value: number | null, offset: number, color: string) => value == null ? null : <rect key={`${day.day}:${offset}`} x={x + 3 + offset} width="10" y={value >= 0 ? mid - (value / peak) * 55 : mid} height={Math.max(1, (Math.abs(value) / peak) * 55)} rx="1.5" fill={color} />;
        return <g key={day.day}>
          {bar(day.realized, 0, (day.realized ?? 0) >= 0 ? 'var(--q-positive)' : 'var(--q-negative)')}
          {bar(day.unrealized, 11, 'var(--q-violet)')}
        </g>;
      })}
      {line && <path d={line} fill="none" stroke="var(--q-cyan)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />}
    </svg>
    <div className="q-legend"><span><i className="q-swatch" style={{ background: 'var(--q-positive)' }} />Realized (daily)</span><span><i className="q-swatch" style={{ background: 'var(--q-violet)' }} />Unrealized (daily change)</span><span><i className="q-swatch" style={{ background: 'var(--q-cyan)' }} />Cumulative net</span><span className="q-muted">{valued[0].day} → {valued[valued.length - 1].day} UTC</span></div>
  </figure>;
}

/** B23: several bots on one time axis and one unit. Gaps break lines; each series keeps its own color. */
export function MultiLine({ series, unit }: { series: { label: string; color: string; points: SeriesPoint[] }[]; unit: string }) {
  const drawable = series.filter(row => row.points.filter(point => point.value != null).length >= 2);
  if (!drawable.length) return <p className="q-empty">A comparison line needs two saved observations per bot in the same window and unit.</p>;
  const all = drawable.flatMap(row => row.points);
  const times = all.map(point => point.time), values = all.map(point => point.value).filter((value): value is number => value != null);
  const t0 = Math.min(...times), t1 = Math.max(...times), tspan = t1 - t0 || 1;
  const min = Math.min(0, ...values), max = Math.max(0, ...values), span = max - min || 1;
  const x = (time: number) => CPAD.left + ((time - t0) / tspan) * (CW - CPAD.left - CPAD.right);
  const y = (value: number) => CPAD.top + (1 - (value - min) / span) * (CH - CPAD.top - CPAD.bottom);
  const ticks = Array.from({ length: 4 }, (_, index) => min + (span * index) / 3);
  return <figure>
    <svg viewBox={`0 0 ${CW} ${CH}`} width="100%" height={CH} role="img" aria-label={`Bot PnL comparison · ${unit}`} preserveAspectRatio="none" style={{ display: 'block' }}>
      {ticks.map(tick => <g key={tick}><line x1={CPAD.left} x2={CW - CPAD.right} y1={y(tick)} y2={y(tick)} stroke="var(--q-border)" strokeDasharray="3 4" /><text className="q-axis" x={CPAD.left - 6} y={y(tick) + 3} textAnchor="end">{formatSigned(tick)}</text></g>)}
      <line x1={CPAD.left} x2={CW - CPAD.right} y1={y(0)} y2={y(0)} stroke="var(--q-muted)" strokeDasharray="2 3" />
      {timeTicks(all).map(tick => <text key={tick} className="q-axis" x={x(tick)} y={CH - 6} textAnchor="middle">{dayLabel(tick)}</text>)}
      {drawable.map(row => <path key={row.label} d={seriesPath(row.points, x, y)} fill="none" stroke={row.color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />)}
    </svg>
    <div className="q-legend">{drawable.map(row => { const last = [...row.points].reverse().find(point => point.value != null); return <span key={row.label}><i className="q-swatch" style={{ background: row.color }} />{row.label} {last?.value == null ? '' : formatSigned(last.value)} {unit}</span>; })}</div>
  </figure>;
}

/** B31: order lifecycle funnel with absolute counts and percent of the first stage. */
export function Funnel({ stages }: { stages: { stage: string; count: number }[] }) {
  if (!stages.length) return <p className="q-empty">No order lifecycle rows are recorded yet.</p>;
  const top = Math.max(1, stages[0].count);
  return <ul className="q-funnel" aria-label="Order lifecycle funnel">
    {stages.map(stage => <li key={stage.stage}>
      <div className="q-bar-meta"><span>{stage.stage.replaceAll('_', ' ')}</span><span className="q-muted">{stage.count} · {((stage.count / top) * 100).toFixed(1)}%</span></div>
      <div className="q-bar"><span style={{ width: `${Math.min(100, (stage.count / top) * 100)}%`, background: 'var(--q-blue)' }} /></div>
    </li>)}
  </ul>;
}

/** Rail bar: used / limit with a five-segment scale. Absent rails render as absent, not zero. */
export function RailBar({ name, used, limit, unit, state, utilization }: { name: string; used: string | null; limit: string | null; unit: string | null; state: string; utilization: number | null }) {
  const filled = utilization == null ? 0 : Math.max(0, Math.min(1, utilization));
  return <div className="q-rail" data-state={state}>
    <div className="q-bar-meta"><span>{name.replaceAll('_', ' ')}</span><span className="q-muted">{limit == null ? state : `${formatDecimal(used ?? '0')} / ${formatDecimal(limit)} ${unit ?? ''} · ${(filled * 100).toFixed(1)}%`}</span></div>
    <div className="q-rail-segments" aria-hidden="true">{[0, 1, 2, 3, 4].map(index => <span key={index} data-on={filled > index / 5} data-hot={filled > 0.8} />)}</div>
  </div>;
}

export function Donut({ slices, center, unit, complete }: { slices: { label: string; value: number }[]; center: string; unit: string; complete: boolean }) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  if (total <= 0) return <p className="q-empty">Composition is unavailable until priced holdings exist.</p>;
  const arcs = slices.map((slice, index) => {
    const sweep = (slice.value / total) * Math.PI * 2;
    const start = -Math.PI / 2 + slices.slice(0, index).reduce((sum, preceding) => sum + preceding.value, 0) / total * Math.PI * 2;
    const end = start + sweep;
    const large = sweep > Math.PI ? 1 : 0;
    const r = 44, cx = 56, cy = 56;
    const x1 = cx + r * Math.cos(start), y1 = cy + r * Math.sin(start);
    const x2 = cx + r * Math.cos(end), y2 = cy + r * Math.sin(end);
    return { d: `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`, color: assetColor(slice.label), slice };
  });
  return <figure className="q-donut">
    <svg viewBox="0 0 112 112" width="168" height="168" role="img" aria-label={`Capital composition ${center} ${unit}`}>
      {arcs.length === 1 ? <circle cx="56" cy="56" r="44" fill={arcs[0].color}/> : arcs.map(arc => <path key={arc.slice.label} d={arc.d} fill={arc.color} />)}
      <circle cx="56" cy="56" r="28" fill="var(--q-surface)" />
      <text x="56" y="53" textAnchor="middle" fill="var(--q-text)" fontSize="11" fontWeight="600">{center}</text>
      <text x="56" y="68" textAnchor="middle" fill="var(--q-muted)" fontSize="8">{complete ? unit : 'priced'}</text>
    </svg>
    <div className="q-legend">{arcs.map(arc => <span key={arc.slice.label}><i className="q-swatch" style={{ background: arc.color }} />{arc.slice.label} {((arc.slice.value / total) * 100).toFixed(1)}% · {formatDecimal(arc.slice.value)}</span>)}</div>
    {!complete && <p className="q-empty">Unpriced assets are excluded. This donut is not 100% of the account.</p>}
  </figure>;
}

export function StackedBar({ rows, highlight }: { rows: { label: string; value: number }[]; highlight?: string | null }) {
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  if (total <= 0) return <p className="q-empty">Asset allocation is unavailable.</p>;
  return <figure>
    <div className="q-stacked" role="img" aria-label="Asset allocation">
      {rows.map(row => <span key={row.label} data-highlighted={highlight === row.label} style={{ width: `${(row.value / total) * 100}%`, background: assetColor(row.label), opacity: highlight && highlight !== row.label ? 0.4 : 1 }} title={`${row.label} ${((row.value / total) * 100).toFixed(1)}%`} />)}
    </div>
    <div className="q-legend">{rows.map(row => <span key={row.label}><i className="q-swatch" style={{ background: assetColor(row.label) }} />{row.label} {((row.value / total) * 100).toFixed(1)}%</span>)}</div>
  </figure>;
}

export function Histogram({ bins, unit, sampleCount, excludedCount }: { bins: { from: number; to: number; count: number }[]; unit: string; sampleCount: number; excludedCount: number }) {
  const max = Math.max(1, ...bins.map(bin => bin.count));
  if (!bins.length) return <p className="q-empty">Execution histogram unavailable. Missing fill benchmarks are excluded, not plotted as zero.</p>;
  return <figure>
    <svg viewBox="0 0 200 80" width="100%" height="80" role="img" aria-label={`Execution quality histogram · ${sampleCount} samples`}>
      {bins.map((bin, index) => <rect key={index} x={index * (200 / bins.length) + 2} y={78 - (bin.count / max) * 70} width={Math.max(4, 200 / bins.length - 4)} height={(bin.count / max) * 70} rx="1.5" fill="#49b7ff" />)}
    </svg>
    <p className="q-muted">{sampleCount} samples · {unit}. {excludedCount} excluded for missing benchmark.</p>
    <table><caption className="q-muted">Bin counts</caption><tbody>{bins.map((bin, index) => <tr key={index}><td>{bin.from}–{bin.to}</td><td>{bin.count}</td></tr>)}</tbody></table>
  </figure>;
}

export function Heatmap({ rows, columns, cells }: { rows: string[]; columns: string[]; cells: { row: string; column: string; value: number | null }[] }) {
  const lookup = new Map(cells.map(cell => [`${cell.row}:${cell.column}`, cell.value]));
  const numbers = cells.map(cell => cell.value).filter((value): value is number => value != null);
  const peak = Math.max(1, ...numbers.map(Math.abs));
  return <figure aria-label="Controller PnL by symbol heatmap" style={{ margin: 0 }}>
    <div className="q-heat" style={{ gridTemplateColumns: `88px repeat(${columns.length}, minmax(36px, 1fr))` }} aria-hidden="true">
    <div />
    {columns.map(column => <div key={column} className="q-muted" style={{ textAlign: 'center', fontSize: 11 }}>{column}</div>)}
    {rows.map(row => (
      <div key={row} style={{ display: 'contents' }}>
        <div className="q-muted" style={{ fontSize: 11 }}>{row}</div>
        {columns.map(column => {
          const value = lookup.get(`${row}:${column}`);
          const missing = value == null;
          const alpha = missing ? 0 : Math.abs(value) / peak;
          return <div key={`${row}:${column}`} className="q-heat-cell" style={{ background: missing ? 'transparent' : `color-mix(in srgb, ${value < 0 ? 'var(--q-negative)' : 'var(--q-positive)'} ${Math.round(alpha * 80)}%, var(--q-surface-raised))`, border: missing ? '1px dashed var(--q-border)' : undefined }}>{missing ? '—' : formatSigned(value)}</div>;
        })}
      </div>
    ))}
    </div>
    <table className="sr-only"><caption>Controller PnL by symbol, signed quote amounts</caption>
      <thead><tr><th scope="col">Bot</th>{columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
      <tbody>{rows.map(row => <tr key={row}><th scope="row">{row}</th>{columns.map(column => {
        const value = lookup.get(`${row}:${column}`);
        return <td key={column}>{value == null ? 'Unavailable' : formatSigned(value)}</td>;
      })}</tr>)}</tbody>
    </table>
  </figure>;
}

export function Sparkline({ points, positive }: { points: number[]; positive?: boolean }) {
  if (points.length < 2) return <svg width="88" height="28" aria-hidden="true" />;
  const min = Math.min(...points), max = Math.max(...points), span = max - min || 1;
  const d = points.map((value, index) => `${index === 0 ? 'M' : 'L'} ${(index / (points.length - 1)) * 86 + 1} ${26 - ((value - min) / span) * 22}`).join(' ');
  const area = `${d} L 87 27 L 1 27 Z`;
  const stroke = positive === false ? 'var(--q-negative)' : 'var(--q-positive)';
  return <svg width="88" height="28" viewBox="0 0 88 28" aria-hidden="true">
    <path d={area} fill={stroke} opacity="0.18" />
    <path d={d} fill="none" stroke={stroke} strokeWidth="1.6" />
  </svg>;
}

export function QuantTimeSeries({ points, unit }: { points: { time: number; value: number | null }[]; unit: string }) {
  const known = points.map(point => point.value).filter((value): value is number => value != null);
  if (known.length < 2) return <p className="q-empty">Equity history is unavailable. Gaps stay gaps. No benchmark is drawn as zero.</p>;
  if (points.some((point, index) => !Number.isFinite(point.time) || (point.value !== null && !Number.isFinite(point.value)) || (index > 0 && point.time <= points[index - 1].time)))
    return <p className="q-empty">Equity history timestamps are unavailable or out of order.</p>;
  const min = Math.min(...known), max = Math.max(...known), span = max - min || 1;
  const firstTime = points[0].time, timeSpan = points.at(-1)!.time - firstTime;
  const coords = points.map(point => {
    const x = ((point.time - firstTime) / timeSpan) * 320;
    if (point.value == null) return null;
    return { x, y: 72 - ((point.value - min) / span) * 64 };
  });
  const segments: { x: number; y: number }[][] = [];
  for (const [index, pair] of coords.entries()) {
    if (pair == null) continue;
    if (!segments.length || coords[index - 1] == null) segments.push([]);
    segments.at(-1)!.push(pair);
  }
  return <figure>
    <svg viewBox="0 0 320 80" width="100%" height="140" role="img" aria-label={`Equity ${unit}`}>
      {segments.filter(segment => segment.length > 1).map((segment, index) => {
        const line = segment.map((point, pointIndex) => `${pointIndex ? 'L' : 'M'} ${point.x},${point.y}`).join(' ');
        return <g key={index}>
          <path d={`${line} L ${segment.at(-1)!.x} 80 L ${segment[0].x} 80 Z`} fill="var(--q-positive)" opacity="0.16" />
          <path d={line} fill="none" stroke="var(--q-positive)" strokeWidth="1.8" />
        </g>;
      })}
    </svg>
    <table><caption className="q-muted">Admitted marks · {unit}</caption><tbody>
      {points.filter(point => point.value != null).slice(-4).map(point => <tr key={point.time}><td>{new Date(point.time).toISOString().slice(0, 16)}</td><td>{formatDecimal(point.value)}</td></tr>)}
    </tbody></table>
  </figure>;
}

export function DailyChangeHistogram({ values, unit }: { values: number[]; unit: string }) {
  if (!values.length) return <p className="q-empty">Daily bars are observed equity changes, not flow-adjusted PnL. Consecutive admitted marks are required.</p>;
  const peak = Math.max(1, ...values.map(Math.abs));
  return <figure>
    <svg viewBox={`0 0 ${values.length * 10} 48`} width="100%" height="48" role="img" aria-label={`Observed equity change · ${unit}`}>
      {values.map((value, index) => <rect key={index} x={index * 10 + 2} y={value >= 0 ? 24 - (value / peak) * 22 : 24} width="6" height={Math.max(1, (Math.abs(value) / peak) * 22)} fill={value >= 0 ? 'var(--q-positive)' : 'var(--q-negative)'} />)}
    </svg>
    <p className="q-muted">Observed equity change · {unit}. Deposits still look like increases here until a classified journal exists.</p>
  </figure>;
}

export function Gauge({ ratio, label }: { ratio: number | null; label: string }) {
  const pct = ratio == null ? 0 : Math.min(1.15, Math.max(0, ratio));
  const length = 157;
  return <figure className="q-gauge-wrap">
    <svg viewBox="0 0 120 74" className="q-gauge" role="img" aria-label={label}>
      <path d="M10 62 A50 50 0 0 1 110 62" fill="none" stroke="var(--q-border)" strokeWidth="10" strokeLinecap="round" />
      <path d="M10 62 A50 50 0 0 1 110 62" fill="none" stroke={ratio == null ? 'transparent' : 'var(--q-blue)'} strokeWidth="10" strokeLinecap="round" strokeDasharray={`${pct * length} ${length}`} />
    </svg>
    <p>{label}</p>
  </figure>;
}

export function BarList({ rows, max }: { rows: { label: string; value: number; note?: string }[]; max: number }) {
  const peak = max > 0 ? max : 1;
  return <ul className="q-bars">
    {rows.map(row => <li key={row.label}>
      <div className="q-bar-meta"><span>{row.label}</span><span className="q-muted">{row.note ?? `${((row.value / peak) * 100).toFixed(1)}%`}</span></div>
      <div className="q-bar"><span style={{ width: `${Math.min(100, (row.value / peak) * 100)}%`, background: assetColor(row.label) }} /></div>
    </li>)}
  </ul>;
}

export function EvidenceDrawer({ open, title, sourceRefs, onClose }: { open: boolean; title: string; sourceRefs: string[]; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    else if (!open && node.open) node.close();
  }, [open]);
  return <dialog ref={dialog} className="q-drawer" aria-label={title} onCancel={event => {event.preventDefault();onClose();}}>
    <header><h2>{title}</h2><button type="button" className="q-chip" onClick={onClose}>Close</button></header>
    <ul>{sourceRefs.length ? sourceRefs.map(ref => <li key={ref}>{ref}</li>) : <li>No incident evidence is attached to this snapshot.</li>}</ul>
  </dialog>;
}
