import { catalogCount, object, text, type RecordData } from './model';
import type { LabNetwork } from './lab-network-data';

const palette = ['#27c9ef', '#ad7bff', '#19d2b0', '#ffa156', '#fb769e', '#91a9cc', '#efc769', '#a7da82'];
export function LabCharts({ data, expanded = false, onFilter }: { data: LabNetwork; expanded?: boolean; onFilter(key: string, value: string): void }) {
  const kinds = [...(data.stats?.kinds ?? [])].sort((a, b) => b.count - a.count);
  return <div className="lab-chart-grid">
    <section className="quant-panel"><header className="quant-panel-heading"><div><h2>Research composition</h2><p className="quant-muted">All indexed nodes, including source and evidence records.</p></div></header>
      <div className="lab-composition"><svg viewBox="0 0 220 220" role="img" aria-label={`Composition of ${data.total_nodes.toLocaleString()} indexed nodes`}>
        <circle cx="110" cy="110" r="80" fill="none" stroke="var(--color-border)" strokeWidth="22" />
        {kinds.map((item, index) => { const length = data.total_nodes ? item.count / data.total_nodes * 2 * Math.PI * 80 : 0, start = data.total_nodes ? kinds.slice(0, index).reduce((sum, kind) => sum + kind.count, 0) / data.total_nodes * 2 * Math.PI * 80 : 0;
          return <circle key={item.key} cx="110" cy="110" r="80" fill="none" stroke={palette[index % palette.length]} strokeWidth="22" strokeDasharray={`${length} ${2 * Math.PI * 80 - length}`} strokeDashoffset={-start} transform="rotate(-90 110 110)"><title>{item.key}: {item.count.toLocaleString()}</title></circle>;
        })}<text x="110" y="108" textAnchor="middle" className="lab-donut-count">{data.total_nodes.toLocaleString()}</text><text x="110" y="132" textAnchor="middle" className="lab-donut-label">indexed nodes</text>
      </svg><ul className="lab-chart-key">{kinds.map((item, index) => <li key={item.key}><i style={{ background: palette[index % palette.length] }} /><span>{item.key.replaceAll('_', ' ')}</span><strong>{item.count.toLocaleString()}</strong></li>)}</ul></div>
    </section>
    <LabBars title="Connection types" description="Recorded relationships. Select a node to inspect direction and provenance." items={data.stats?.relations ?? []} />
    {expanded && <><LabBars title="Research families" description="Browse the most represented families in the index." items={data.stats?.families ?? []} onSelect={value => onFilter('family', value)} /><LabBars title="Accounting lanes" description="Record counts. Spot, futures and proxy economics remain separate." items={data.stats?.lanes ?? []} onSelect={value => onFilter('lane', value)} /></>}
  </div>;
}
function LabBars({ title, description, items, onSelect }: { title: string; description: string; items: { key: string; count: number }[]; onSelect?(value: string): void }) {
  const sorted = [...items].sort((a, b) => b.count - a.count), max = Math.max(1, ...sorted.map(item => item.count));
  return <section className="quant-panel"><header className="quant-panel-heading"><div><h2>{title}</h2><p className="quant-muted">{description}</p></div></header><ul className="lab-bars">{sorted.slice(0, 10).map(item => <li key={item.key}>{onSelect ? <button className="quant-record-link" onClick={() => onSelect(item.key)}>{item.key.replaceAll('_', ' ')}</button> : <span>{item.key.replaceAll('_', ' ')}</span>}<strong>{item.count.toLocaleString()}</strong><span className="lab-bar-track" aria-hidden="true"><span style={{ width: `${item.count / max * 100}%` }} /></span></li>)}</ul>{!items.length && <p className="quant-notice">No indexed groups.</p>}{items.length > 10 && <p className="lab-chart-note">Top 10 of {items.length} recorded groups.</p>}</section>;
}
export function LabCounts({ data, onView }: { data: RecordData; onView(view: string): void }) {
  const counts = object(data.counts), freshness = object(data.freshness);
  return <div className="quant-metrics lab-counts" aria-label="Research catalog counts">{[
    ['ideas', 'Ideas', 'ideas'], ['papers', 'Papers', 'papers'], ['experiments', 'Experiments', 'experiments'], ['runs', 'Attempts', ''], ['assessments', 'Assessments', ''], ['unresolved', 'Evidence gaps', 'gaps'],
  ].map(([key, label, view]) => <div key={key}>{view ? <button className="quant-record-link" onClick={() => onView(view)}>{label}</button> : <span>{label}</span>}<strong>{catalogCount(counts, key)?.toLocaleString() ?? '—'}</strong><small>Catalog records</small></div>)}<div><span>Pending events</span><strong>{catalogCount(freshness, 'pending_events')?.toLocaleString() ?? '—'}</strong><small>{text(freshness.state, 'Index unavailable').toLowerCase()}</small></div></div>;
}
export function LabLimitations({ data }: { data: RecordData }) {
  return <section className="quant-panel"><header className="quant-panel-heading"><h2>Reading this research</h2></header><ul className="lab-limitations">{(Array.isArray(data.limitations) ? data.limitations : []).filter((v): v is string => typeof v === 'string').map(value => <li key={value}>{value}</li>)}</ul></section>;
}
