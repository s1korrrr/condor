import { useId, useMemo, useState } from 'react';
import { formatDecimal } from './format';
import { historySeries, type HistoryPoint } from '@/features/portfolio/model';

type OverlayPoint = { time: number; value: number | null };

/** Observation chart only. Gaps are never interpolated into portfolio returns.
 * `overlay` (cumulative bot PnL) is drawn on its own right-hand scale; `restarts` are owner-change rules. */
export function EquityChart({ points, unit, overlay, overlayLabel, restarts = [] }: {
  points: HistoryPoint[]; unit: string; overlay?: OverlayPoint[] | null; overlayLabel?: string; restarts?: number[];
}) {
  const gradient = useId().replaceAll(':', '');
  const [selected, setSelected] = useState<number | null>(null);
  const series = useMemo(() => historySeries(points), [points]);
  const overlayPath = useMemo(() => {
    if (!overlay || series.length < 2) return null;
    const known = overlay.filter((point): point is {time:number;value:number} => point.value !== null && Number.isFinite(point.value));
    if (known.length < 2) return null;
    const left = series[0].time, duration = Math.max(1, series.at(-1)!.time - left);
    const omin = Math.min(...known.map(point => point.value)), omax = Math.max(...known.map(point => point.value));
    const ospan = omax - omin || Math.max(Math.abs(omax) * 0.02, 0.01);
    const ox = (time: number) => 20 + (time - left) / duration * 810;
    const oy = (value: number) => 222 - (value - omin) / ospan * 196;
    let d = '', open = false;
    for (const point of overlay) {
      if (point.value === null || point.time < left || point.time > left + duration) { open = false; continue; }
      d += `${open ? ' L' : `${d ? ' ' : ''}M`} ${ox(point.time).toFixed(2)},${oy(point.value).toFixed(2)}`;
      open = true;
    }
    return d ? { d, min: omin, max: omax } : null;
  }, [overlay, series]);
  const known = series.filter((point): point is {time:number;value:number} => point.value !== null && Number.isFinite(point.value));
  if (!known.length) return <div className="q-chart-empty"><span className="q-empty-symbol" aria-hidden="true">⌁</span><strong>No valued observations yet</strong><p>Current balances appear above. This chart needs timestamped account history.</p></div>;
  if (series.some((point,index) => !Number.isFinite(point.time) || index > 0 && point.time <= series[index-1].time)) return <p className="q-empty">Observation timestamps are invalid. History cannot be plotted.</p>;
  const min = Math.min(...known.map(point => point.value));
  const max = Math.max(...known.map(point => point.value));
  const padding = Math.max((max-min) * .12, Math.abs(max) * .0005, .01);
  const low = min-padding, high = max+padding;
  const left = series[0].time, duration = Math.max(1, series.at(-1)!.time-left);
  const x = (time:number) => 20+(time-left)/duration*810;
  const y = (value:number) => 222-(value-low)/(high-low)*196;
  const segments: {time:number;value:number}[][]=[];
  for (const [index, point] of series.entries()) {
    if (point.value === null) continue;
    if (!segments.length || series[index-1]?.value === null) segments.push([]);
    segments.at(-1)!.push(point as {time:number;value:number});
  }
  const active = points[Math.min(selected ?? points.length-1, points.length-1)];
  const activeTime = Date.parse(active.observed_at);
  const activeValue = active.valuation_complete && Number.isFinite(Number(active.priced_total)) ? Number(active.priced_total) : null;
  const timeLabel = (time:number) => new Date(time).toLocaleString('en-GB',{timeZone:'UTC',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  return <figure className="q-equity-chart">
    <figcaption><span>{timeLabel(activeTime)} <small>UTC</small></span><strong>{activeValue === null ? 'Unpriced observation' : `${formatDecimal(active.priced_total)} ${unit}`}</strong></figcaption>
    <svg viewBox="0 0 920 270" role="img" aria-label={`Observed account equity in ${unit}. Use the observation slider for exact marks. Missing observations are gaps.`} onPointerMove={event => {
      const box=event.currentTarget.getBoundingClientRect();
      const target=left+Math.max(0,Math.min(1,((event.clientX-box.left)/box.width*920-20)/810))*duration;
      let nearest=0;
      for(let i=1;i<points.length;i++) if(Math.abs(Date.parse(points[i].observed_at)-target)<Math.abs(Date.parse(points[nearest].observed_at)-target)) nearest=i;
      setSelected(nearest);
    }} onPointerLeave={()=>setSelected(null)}>
      <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--q-blue)" stopOpacity=".24"/><stop offset="100%" stopColor="var(--q-blue)" stopOpacity="0"/></linearGradient></defs>
      {[0,1,2,3,4].map(i=>{const value=low+(high-low)*i/4;return <g key={i}><line x1="20" x2="830" y1={y(value)} y2={y(value)} stroke="var(--q-border)" strokeDasharray="3 5"/><text x="842" y={y(value)+4} fill="var(--q-muted)" fontSize="12">{formatDecimal(value)}</text></g>;})}
      {segments.map((segment,index)=>{const line=segment.map((point,i)=>`${i?'L':'M'} ${x(point.time)},${y(point.value)}`).join(' ');return <g key={index}>
        {segment.length>1 ? <><path d={`${line} L ${x(segment.at(-1)!.time)},222 L ${x(segment[0].time)},222 Z`} fill={`url(#${gradient})`}/><path d={line} fill="none" stroke="var(--q-blue)" strokeWidth="2"/></> : <circle cx={x(segment[0].time)} cy={y(segment[0].value)} r="3" fill="var(--q-blue)"/>}
      </g>;})}
      {restarts.filter(time => time >= left && time <= left + duration).map(time => <line key={`restart-${time}`} x1={x(time)} x2={x(time)} y1="26" y2="222" stroke="var(--q-warning)" strokeDasharray="2 4" opacity="0.8"><title>Owner restart</title></line>)}
      {overlayPath && <><path d={overlayPath.d} fill="none" stroke="var(--q-cyan)" strokeWidth="1.5" /><text x="842" y="20" fill="var(--q-cyan)" fontSize="11">{formatDecimal(overlayPath.max)}</text><text x="842" y="236" fill="var(--q-cyan)" fontSize="11">{formatDecimal(overlayPath.min)}</text></>}
      <line x1={x(activeTime)} x2={x(activeTime)} y1="26" y2="222" stroke="var(--q-muted)" strokeDasharray="3 4"/>
      {activeValue!==null && <circle cx={x(activeTime)} cy={y(activeValue)} r="4" fill="var(--q-blue)" stroke="var(--q-surface)" strokeWidth="2"/>}
      {[0,.5,1].map(fraction=><text key={fraction} x={20+810*fraction} y="254" fill="var(--q-muted)" fontSize="12" textAnchor={fraction===0?'start':fraction===1?'end':'middle'}>{timeLabel(left+duration*fraction)}</text>)}
    </svg>
    <label className="q-observation-slider">Inspect observations <input aria-label="Equity observation" type="range" min="0" max={Math.max(0,points.length-1)} value={Math.min(selected??points.length-1,points.length-1)} onChange={event=>setSelected(Number(event.target.value))}/><span>{known.length} valued marks</span></label>
    <div className="q-legend"><span><i className="q-swatch" style={{ background: 'var(--q-blue)' }} />Wallet value · {unit}</span>{overlayPath && <span><i className="q-swatch" style={{ background: 'var(--q-cyan)' }} />{overlayLabel ?? 'Cumulative bot PnL'} · right scale</span>}{restarts.length > 0 && <span><i className="q-swatch" style={{ background: 'var(--q-warning)' }} />Owner restart</span>}</div>
    <p className="q-empty">Account value includes deposits, withdrawals and market movement. It is not a profit curve.</p>
  </figure>;
}
