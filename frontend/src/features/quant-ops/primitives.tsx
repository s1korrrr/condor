import { useEffect, useRef, type ReactNode } from 'react';
import { assetColor, formatDecimal, formatSigned, metricTone } from './format';
import { describePanelState, PANEL_STATE_LABEL, type PanelState } from './panel-state';
import { BarsChart, DonutChart, SparkChart, TimeSeriesChart } from './kit/charts';
import { CHART } from './kit/series';
import { TileGrid } from './kit/grid';

/** Spec §5.4 glyph: one per panel, tooltip carries the exact reason and observation time. */
export function StateGlyph({ state }: { state: PanelState }) {
  return <span className="q-state" data-state={state.kind} title={describePanelState(state)} aria-label={describePanelState(state)}>
    <span className="q-state__text">{PANEL_STATE_LABEL[state.kind]}{state.sample ? ` ${state.sample.have}/${state.sample.need}` : ''}</span>
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
    <strong className={tone ? `q-${tone}` : undefined} title={`${value}${unit ? ` ${unit}` : ''}`}>{value}{unit ? <small>{unit}</small> : null}</strong>
    <div className="q-kpi-foot">
      {delta && delta.amount != null
        ? <span className={`q-kpi-delta${deltaTone ? ` q-${deltaTone}` : ''}`}>{deltaTone === 'positive' ? '▲' : deltaTone === 'negative' ? '▼' : '●'} {formatSigned(delta.amount)}{delta.percent != null ? ` (${formatSigned(delta.percent * 100)}%)` : ''}</span>
        : note ? <small className="q-muted" title={note}>{note}</small> : <span />}
      {sparkline}
    </div>
    {delta && delta.amount != null && note ? <small className="q-muted" title={note}>{note}</small> : null}
  </article>;
}

export type StatTileView = { id: string; label: string; value: string | null; unit?: string; state: PanelState; note?: string };

/** C18 strip: compact stats, each with its own typed state. Percent tiles receive a ratio and print a percent. */
export function StatStrip({ tiles, panelId = 'C18', ariaLabel = 'Capital statistics', min = 150 }: { tiles: StatTileView[]; panelId?: string; ariaLabel?: string; min?: number }) {
  return <TileGrid className="q-stats" panelId={panelId} label={ariaLabel} min={min}>
    {tiles.map(tile => {
      const isPercent = tile.unit === '%';
      const numeric = tile.value == null ? null : Number(tile.value);
      const text = tile.value == null || numeric == null || !Number.isFinite(numeric)
        ? PANEL_STATE_LABEL[tile.state.kind]
        : isPercent ? `${formatSigned(numeric * 100)}%` : tile.unit === 'x' ? `${formatDecimal(numeric)}x` : /pnl/i.test(tile.label) ? formatSigned(numeric) : formatDecimal(numeric);
      const tone = /pnl|drawdown/i.test(tile.label) ? metricTone(numeric) : undefined;
      const note = tile.note ?? (tile.state.reason && tile.value == null ? tile.state.reason : undefined);
      return <article key={tile.id} className="q-stat" data-panel-id={tile.id} data-state={tile.state.kind}>
        <span><span className="q-stat__label">{tile.label}</span><StateGlyph state={tile.state} /></span>
        <strong className={tone ? `q-${tone}` : undefined} title={text}>{text}{tile.value != null && tile.unit && !isPercent && tile.unit !== 'x' ? <small>{tile.unit}</small> : null}</strong>
        {note ? <small title={note}>{note}</small> : null}
      </article>;
    })}
  </TileGrid>;
}

type SeriesPoint = { time: number; value: number | null };
const pctTick = (value: number) => `${(value * 100).toFixed(1)}%`;

/** C19: drawdown from the running peak as a hoverable loss area. Values are ratios ≤ 0; the worst point is marked. */
export function DrawdownChart({ series, worst, height = 220 }: { series: SeriesPoint[]; worst: SeriesPoint | null; height?: number }) {
  const known = series.filter(point => point.value != null);
  if (known.length < 2) return <p className="q-empty">Drawdown needs two complete equity observations in the range.</p>;
  return <TimeSeriesChart ariaLabel={`Drawdown, worst ${worst?.value == null ? 'unavailable' : pctTick(worst.value)}`} height={height} includeZero leftFormat={pctTick} signed
    series={[{ id: 'drawdown', label: 'Drawdown', color: CHART.negative, area: true, points: series }]}
    highlight={worst?.value == null ? null : { time: worst.time, value: worst.value, label: `Max DD ${pctTick(worst.value)}` }} />;
}

/** C20: daily realized (gain/loss colors) and unrealized change bars, cumulative net as a line on its own scale. */
export function PnlBars({ days, unit, height = 240 }: { days: { day: string; realized: number | null; unrealized: number | null; cumulative: number | null }[]; unit: string; height?: number }) {
  const valued = days.filter(day => day.realized != null || day.unrealized != null);
  if (!valued.length) return <p className="q-empty">Daily realized and unrealized changes need at least one day of saved native performance.</p>;
  return <figure>
    <BarsChart ariaLabel={`Daily realized and unrealized PnL · ${unit}`} unit={unit} height={height}
      rows={valued.map(day => ({ label: day.day.slice(5), realized: day.realized, unrealized: day.unrealized, cumulative: day.cumulative }))}
      bars={[{ id: 'realized', label: 'Realized', color: CHART.positive, signColors: true }, { id: 'unrealized', label: 'Unrealized change', color: CHART.violet }]}
      line={{ id: 'cumulative', label: 'Cumulative net', color: CHART.cyan }} />
    <div className="q-legend"><span><i className="q-swatch" style={{ background: 'var(--q-positive)' }} />Realized (daily)</span><span><i className="q-swatch" style={{ background: 'var(--q-violet)' }} />Unrealized (daily change)</span><span><i className="q-swatch" style={{ background: 'var(--q-cyan)' }} />Cumulative net</span><span className="q-muted">{valued[0].day} → {valued[valued.length - 1].day} UTC</span></div>
  </figure>;
}

/** B23: several bots on one time axis and one unit. Gaps break lines; each series keeps its own color. */
export function MultiLine({ series, unit, height = 220 }: { series: { label: string; color: string; points: SeriesPoint[] }[]; unit: string; height?: number }) {
  const drawable = series.filter(row => row.points.filter(point => point.value != null).length >= 2);
  if (!drawable.length) return <p className="q-empty">A comparison line needs two saved observations per bot in the same window and unit.</p>;
  return <figure>
    <TimeSeriesChart ariaLabel={`Bot PnL comparison · ${unit}`} height={height} zeroLine includeZero signed leftFormat={value => formatSigned(value)}
      series={drawable.map(row => ({ id: row.label, label: row.label, color: row.color, unit, points: row.points }))} />
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
  return <>
    <DonutChart slices={slices.map(slice => ({ ...slice, color: assetColor(slice.label) }))} center={center} sub={complete ? unit : 'priced'} unit={unit} />
    {!complete && <p className="q-empty">Unpriced assets are excluded. This donut is not 100% of the account.</p>}
  </>;
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
  if (!bins.length) return <p className="q-empty">Execution histogram unavailable. Missing fill benchmarks are excluded, not plotted as zero.</p>;
  return <figure>
    <BarsChart ariaLabel={`Execution quality histogram · ${sampleCount} samples`} height={110} format={value => String(Math.round(value))}
      rows={bins.map(bin => ({ label: `${bin.from}–${bin.to}`, count: bin.count }))} bars={[{ id: 'count', label: `Fills (${unit})`, color: CHART.blue }]} signed={false} />
    <p className="q-muted">{sampleCount} samples · {unit}. {excludedCount} excluded for missing benchmark.</p>
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

/** Hoverable trend line. Pass timed points to show the sample time in the tooltip. */
export function Sparkline({ points, positive, unit, height = 28 }: { points: number[] | SeriesPoint[]; positive?: boolean; unit?: string; height?: number }) {
  return <SparkChart points={points} positive={positive} unit={unit} height={height} />;
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
