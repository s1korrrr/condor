import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { historySeries } from './model';
import type { HistoryPoint } from './model';

const palette = ['var(--color-primary)', '#60a5fa', '#2dd4bf', '#a78bfa', '#f59e0b', '#fb7185'];
import {formatValue, utc} from "./format";

export function AllocationChart({data,onSelect,complete}: {data:{token:string;value:number;weight:number|null}[];onSelect:(token:string)=>void;complete:boolean}) {
  const total=data.reduce((s,h)=>s+h.value,0);
  return <figure className="space-y-4">
    <figcaption className="text-sm font-medium">{complete?'Asset allocation':'Allocation of priced assets'} <span className="font-normal text-[var(--color-text-muted)]">· USDT</span></figcaption>
    {total>0 ? <>
      <div className="flex h-5 overflow-hidden rounded-sm" aria-hidden="true">{data.map((h,i)=><span key={h.token} style={{width:`${h.value/total*100}%`,background:palette[i%palette.length]}} />)}</div>
      <div className="flex flex-wrap gap-x-6 gap-y-3">{data.map((h,i)=><button type="button" key={h.token} onClick={()=>onSelect(h.token)} className="inline-flex items-center gap-2 text-xs hover:underline focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]"><span className="h-2 w-2 rounded-full" style={{background:palette[i%palette.length]}}/><span>{h.token}</span><span className="tabular-nums text-[var(--color-text-muted)]">{(h.value/total*100).toFixed(1)}%</span></button>)}</div>
      {!complete && <p className="text-xs text-[var(--color-yellow)]">Unpriced assets are excluded from this graphic. These percentages do not represent the complete account.</p>}
    </>:<p className="py-6 text-sm text-[var(--color-text-muted)]">Allocation will appear when positive holdings have a current price.</p>}
  </figure>;
}

export function ValueHistoryChart({points}: {points:HistoryPoint[]}) {
  const series=historySeries(points);
  const values=series.filter(p=>p.value!==null);
  return <figure className="min-w-0 space-y-3">
    <figcaption className="text-base font-semibold">Account value history <span className="text-xs font-normal text-[var(--color-text-muted)]">· USDT · UTC</span></figcaption>
    {values.length ? <div className="h-80 w-full" aria-label="Account value observations. Exact observations are available below.">
      <ResponsiveContainer width="100%" height={320} minWidth={0}>
        <LineChart data={series} margin={{top:16,right:14,left:6,bottom:8}}>
          <CartesianGrid stroke="var(--color-border)" vertical={false}/>
          <XAxis dataKey="time" type="number" domain={['dataMin','dataMax']} tickFormatter={t=>new Date(t).toLocaleString('en-GB',{timeZone:'UTC',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})} tick={{fill:'var(--color-text-muted)',fontSize:10}} minTickGap={45} axisLine={false} tickLine={false}/>
          <YAxis domain={['auto','auto']} tickFormatter={v=>Number(v).toLocaleString(undefined,{notation:'compact',maximumFractionDigits:2})} tick={{fill:'var(--color-text-muted)',fontSize:11}} axisLine={false} tickLine={false} width={64}/>
          <Tooltip contentStyle={{background:'var(--color-surface)',border:'1px solid var(--color-border)',color:'var(--color-text)'}} labelFormatter={v=>utc(new Date(Number(v)).toISOString())} formatter={v=>[`${formatValue(Number(v))} USDT`,'Account value']}/>
          <Line dataKey="value" type="linear" stroke="var(--color-primary)" strokeWidth={2} dot={values.length<60?{r:2}:false} activeDot={{r:4}} connectNulls={false} isAnimationActive={false}/>
        </LineChart>
      </ResponsiveContainer>
    </div>:<div className="flex min-h-60 items-center justify-center border-y border-dashed border-[var(--color-border)] px-6 text-center text-sm text-[var(--color-text-muted)]">No fully valued observations in this period. Unpriced holdings remain visible in Holdings.</div>}
    <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">Value changes include trading, price movements, deposits and withdrawals. This is not a profit or return chart. Missing prices and observation gaps over two minutes break the line.</p>
  </figure>;
}
