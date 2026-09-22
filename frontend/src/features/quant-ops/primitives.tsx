import type { ReactNode } from 'react';
import { ASSET_COLORS, formatDecimal } from './format';

export function PanelFrame({ panelId, title, scopeLabel, children }: { panelId: string; title: string; scopeLabel?: string; children: ReactNode }) {
  return <section className="q-card" data-panel-id={panelId}>
    <header><h2>{title}</h2>{scopeLabel && <p className="q-kicker">{scopeLabel}</p>}</header>
    {children}
  </section>;
}

export function MetricCard({ panelId, title, value, unit, note, tone, sparkline }: {
  panelId: string; title: string; value: string; unit?: string; note?: string;
  tone?: 'positive' | 'negative'; sparkline?: ReactNode;
}) {
  return <article className="q-card q-kpi" data-panel-id={panelId}>
    <span>{title}</span>
    <strong className={tone ? `q-${tone}` : undefined}>{value}{unit ? <small>{unit}</small> : null}</strong>
    {sparkline}
    {note ? <small className="q-muted">{note}</small> : null}
  </article>;
}

export function Donut({ slices, center, unit, complete }: { slices: { label: string; value: number }[]; center: string; unit: string; complete: boolean }) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  if (total <= 0) return <p className="q-empty">Composition is unavailable until priced holdings exist.</p>;
  let angle = -Math.PI / 2;
  const arcs = slices.map((slice, index) => {
    const sweep = (slice.value / total) * Math.PI * 2;
    const start = angle; angle += sweep;
    const large = sweep > Math.PI ? 1 : 0;
    const r = 44, cx = 56, cy = 56;
    const x1 = cx + r * Math.cos(start), y1 = cy + r * Math.sin(start);
    const x2 = cx + r * Math.cos(angle), y2 = cy + r * Math.sin(angle);
    return { d: `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`, color: ASSET_COLORS[index % ASSET_COLORS.length], slice };
  });
  return <figure className="q-donut">
    <svg viewBox="0 0 112 112" width="168" height="168" role="img" aria-label={`Capital composition ${center} ${unit}`}>
      {arcs.map(arc => <path key={arc.slice.label} d={arc.d} fill={arc.color} />)}
      <circle cx="56" cy="56" r="28" fill="var(--q-surface)" />
      <text x="56" y="53" textAnchor="middle" fill="var(--q-text)" fontSize="11" fontWeight="600">{center}</text>
      <text x="56" y="68" textAnchor="middle" fill="var(--q-muted)" fontSize="8">{complete ? unit : 'priced'}</text>
    </svg>
    <div className="q-legend">{arcs.map(arc => <span key={arc.slice.label}><i className="q-swatch" style={{ background: arc.color }} />{arc.slice.label} {((arc.slice.value / total) * 100).toFixed(1)}% · {formatDecimal(arc.slice.value)}</span>)}</div>
    {!complete && <p className="q-empty">Unpriced assets are excluded. This donut is not 100% of the account.</p>}
  </figure>;
}

export function StackedBar({ rows }: { rows: { label: string; value: number }[] }) {
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  if (total <= 0) return <p className="q-empty">Asset allocation is unavailable.</p>;
  return <figure>
    <div className="q-stacked" role="img" aria-label="Asset allocation">
      {rows.map((row, index) => <span key={row.label} style={{ width: `${(row.value / total) * 100}%`, background: ASSET_COLORS[index % ASSET_COLORS.length] }} title={`${row.label} ${((row.value / total) * 100).toFixed(1)}%`} />)}
    </div>
    <div className="q-legend">{rows.map((row, index) => <span key={row.label}><i className="q-swatch" style={{ background: ASSET_COLORS[index % ASSET_COLORS.length] }} />{row.label} {((row.value / total) * 100).toFixed(1)}%</span>)}</div>
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
  return <div className="q-heat" style={{ gridTemplateColumns: `88px repeat(${columns.length}, minmax(36px, 1fr))` }} role="table" aria-label="Symbol exposure heatmap">
    <div />
    {columns.map(column => <div key={column} className="q-muted" style={{ textAlign: 'center', fontSize: 11 }}>{column}</div>)}
    {rows.map(row => (
      <div key={row} style={{ display: 'contents' }}>
        <div className="q-muted" style={{ fontSize: 11 }}>{row}</div>
        {columns.map(column => {
          const value = lookup.get(`${row}:${column}`);
          const missing = value == null;
          const alpha = missing ? 0 : Math.abs(value) / peak;
          return <div key={`${row}:${column}`} className="q-heat-cell" style={{ background: missing ? 'transparent' : `color-mix(in srgb, var(--q-blue) ${Math.round(alpha * 80)}%, var(--q-surface-raised))`, border: missing ? '1px dashed var(--q-border)' : undefined }}>{missing ? '—' : formatDecimal(value, 0)}</div>;
        })}
      </div>
    ))}
  </div>;
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
  const min = Math.min(...known), max = Math.max(...known), span = max - min || 1;
  const coords = points.map((point, index) => {
    const x = (index / Math.max(1, points.length - 1)) * 320;
    if (point.value == null) return null;
    return `${x},${72 - ((point.value - min) / span) * 64}`;
  });
  const line = coords.reduce<{ d: string; open: boolean }>((path, pair) => {
    if (pair == null) return { d: path.d, open: false };
    return { d: path.d + (path.open ? ` L ${pair}` : `${path.d ? ' ' : ''}M ${pair}`), open: true };
  }, { d: '', open: false }).d;
  return <figure>
    <svg viewBox="0 0 320 80" width="100%" height="140" role="img" aria-label={`Equity ${unit}`}>
      <path d={`${line} L 320 80 L 0 80 Z`} fill="var(--q-positive)" opacity="0.16" />
      <path d={line} fill="none" stroke="var(--q-positive)" strokeWidth="1.8" />
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
    {rows.map((row, index) => <li key={row.label}>
      <div className="q-bar-meta"><span>{row.label}</span><span className="q-muted">{row.note ?? `${((row.value / peak) * 100).toFixed(1)}%`}</span></div>
      <div className="q-bar"><span style={{ width: `${Math.min(100, (row.value / peak) * 100)}%`, background: ASSET_COLORS[index % ASSET_COLORS.length] }} /></div>
    </li>)}
  </ul>;
}

export function EvidenceDrawer({ open, title, sourceRefs, onClose }: { open: boolean; title: string; sourceRefs: string[]; onClose: () => void }) {
  if (!open) return null;
  return <dialog className="q-drawer" open aria-label={title}>
    <header><h2>{title}</h2><button type="button" onClick={onClose}>Close</button></header>
    <ul>{sourceRefs.length ? sourceRefs.map(ref => <li key={ref}>{ref}</li>) : <li>No source refs are attached.</li>}</ul>
  </dialog>;
}
