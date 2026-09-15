import { Link } from 'react-router-dom';
import type { BotsPageResponse } from '@/lib/api';
import { currentControllerPolicy } from '@/features/bots/observed-policy';
import { numeric, type BotPairPosition } from '@/features/bots/position-view';
const number = (value: unknown, unit = '') => { const n = numeric(value); return n === null ? '—' : `${n.toLocaleString(undefined, { maximumFractionDigits: 8 })}${unit ? ` ${unit}` : ''}`; };
const label = (value: unknown) => typeof value === 'string' && value ? value.replaceAll('_', ' ') : '—';
function Metric({ title, value, detail }: { title: string; value: string; detail?: string }) {
  return <div><dt className="text-xs text-[var(--color-text-muted)]">{title}</dt><dd className="mt-1 font-semibold tabular-nums text-sm">{value}</dd>{detail && <dd className="mt-1 text-xs text-[var(--color-text-muted)]">{detail}</dd>}</div>;
}
export function PriceLevels({ row }: { row: BotPairPosition }) {
  const levels = [
    { name: 'Breakeven', value: row.breakeven, color: '#94a3b8' },
    { name: 'Minimum profit price', value: row.profitPrice, color: '#d5ae66' },
    { name: 'Trailing floor', value: row.floor, color: '#f59e0b' },
    { name: 'Current price', value: row.price, color: '#55b8ff' },
    { name: 'Tracked peak', value: row.peak, color: '#34d399' },
  ].filter((entry): entry is { name: string; value: number; color: string } => entry.value !== null && entry.value > 0);
  if (levels.length < 2) return null;
  const min = Math.min(...levels.map(item => item.value)), max = Math.max(...levels.map(item => item.value));
  const padding = Math.max((max - min) * 0.1, max * 0.005);
  const x = (value: number) => 15 + (value - min + padding) / (max - min + 2 * padding) * 570;
  return <figure className="rounded-lg bg-[var(--color-bg)] p-3">
    <figcaption className="text-xs text-[var(--color-text-muted)] mb-2">Observed price levels · {row.quote}</figcaption>
    <svg viewBox="0 0 600 76" role="img" aria-label={`Price levels for ${row.pair}`} className="w-full h-20"><line x1="15" y1="38" x2="585" y2="38" stroke="#475569" />{levels.map((item, i) => <g key={item.name}><line x1={x(item.value)} y1={15 + i * 4} x2={x(item.value)} y2="60" stroke={item.color} strokeWidth={item.name === 'Current price' ? 3 : 1.5} strokeDasharray={item.name === 'Current price' ? undefined : '4 3'} /><circle cx={x(item.value)} cy={15 + i * 4} r="4" fill={item.color} /><title>{`${item.name}: ${number(item.value, row.quote)}`}</title></g>)}</svg>
    <dl className="flex flex-wrap gap-x-6 gap-y-3">{levels.map(item => <div key={item.name} className="text-xs"><dt className="flex items-center gap-1.5 text-[var(--color-text-muted)]"><span className="inline-block h-2 w-2 rounded-full" style={{ background: item.color }} />{item.name}</dt><dd className="mt-1 tabular-nums">{number(item.value)}</dd></div>)}</dl>
  </figure>;
}
export function PairPosition({ row, bot, page, now, showLevels = true }: { row: BotPairPosition; bot: string; page?:BotsPageResponse; now:number; showLevels?:boolean }) {
  const to = `/trading-visuals?bot=${encodeURIComponent(bot)}&pair=${encodeURIComponent(row.pair)}`;
  const policy=currentControllerPolicy(page,bot,row,now);
  const metrics = [
    ['Tracked inventory cost', row.base !== null && row.breakeven !== null ? row.base * row.breakeven : null, row.quote],
    ['Planned bag reduction', row.plannedReduction, row.baseAsset], ['Target remaining inventory', row.targetBase, row.baseAsset],
    ['Price move to trailing floor', row.floor !== null && row.price !== null ? (row.floor / row.price - 1) * 100 : null, '%'],
  ] as const;
  return <div className="space-y-4 p-4 bg-[var(--color-bg)]/40">
    <div className="flex flex-wrap justify-between gap-3"><p className="text-xs text-[var(--color-text-muted)]">{row.inventorySource} · {row.id}</p><div className="flex gap-4 text-sm text-[var(--color-primary)]"><Link to={`${to}&view=charts`}>Chart</Link><Link to={`${to}&view=activity&record=fills`}>Fills</Link></div></div>
    {showLevels && <PriceLevels row={row} />}
    {policy && <div><h4 className="text-sm font-medium">Observed trailing policy and operator state</h4><p className="mt-1 text-xs text-[var(--color-text-muted)]">Native controller telemetry · {policy.controllerId} · received {new Date(policy.receivedAt*1000).toISOString()} UTC. Policy settings do not establish an armed trailing price.</p><dl className="mt-3 grid grid-cols-2 lg:grid-cols-3 gap-3">{policy.fields.map(([title,value])=><Metric key={title} title={title} value={value}/>)}</dl></div>}
    {metrics.some(([,value]) => value !== null) && <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">{metrics.filter(([,value])=>value!==null).map(([title,value,unit])=><Metric key={title} title={title} value={number(value,unit)}/>)}</dl>}
    {row.quantity !== null && <p className="text-xs break-all">Observed inventory units: <span className="tabular-nums">{row.quantity} {row.baseAsset}</span></p>}
    {row.inventoryEntries.length > 1 && <details className="text-xs"><summary>Exact retained inventory entries ({row.inventoryEntries.length})</summary><ul className="mt-2 space-y-1">{row.inventoryEntries.map((entry,i)=><li key={i} className="break-all tabular-nums">{String(entry.amount_base)} {row.baseAsset}{numeric(entry.breakeven_price)!==null ? ` · basis ${String(entry.breakeven_price)} ${row.quote}` : ''}</li>)}</ul></details>}
    {(row.hold || row.reason || row.planNext || row.riskClear !== null) && <div className="space-y-1 text-sm"><h4 className="font-medium">Controller plan and gates</h4>{row.hold && <p>Hold: {label(row.hold)}</p>}{row.reason && <p>{label(row.reason)}</p>}{row.planNext && <p>Owner plan: {row.planNext}</p>}{row.riskClear !== null && <p>Exit risk gate: {row.riskClear ? 'clear' : 'blocked'}</p>}</div>}
    {row.plannedReduction !== null && <p className="text-xs text-[var(--color-text-muted)]">The inventory target is before order sizing and gates. A conditional plan does not guarantee an order, fill price or closing time.</p>}
    {row.pendingSells !== null && <div><h4 className="text-sm font-medium">Owner-issued sell requests</h4>{row.pendingSells.length ? <ObservationTable rows={row.pendingSells} columns={[
      ['Request', 'request_id'], ['State', 'request_state'], ['Price · '+row.quote, 'price_quote'], ['Amount · '+row.baseAsset,'amount_base'], ['Filled','filled_amount_base'], ['Remaining','remaining_amount_base'],
    ]}/> : <p className="mt-2 text-xs">No pending sell request in this observation.</p>}<p className="mt-2 text-xs text-[var(--color-text-muted)]">Requests may still be awaiting an exchange order.{row.pendingSellsTruncated ? ' The owner limited this list; additional requests may exist.' : ''}</p></div>}
    {!!row.executors.length && <div><h4 className="text-sm font-medium">Open and closing executors</h4><ObservationTable rows={row.executors} columns={[
      ['Side','side'], ['Executor','executor_type'], ['Status','status'], ['Remaining · '+row.baseAsset,'remaining_position_amount_base'], ['PnL · '+row.quote,'net_pnl_quote'], ['Trail state','trailing_state'], ['Activation · '+row.quote,'trailing_activation_price'], ['Trigger · '+row.quote,'trailing_trigger_price'],
    ]}/></div>}
  </div>;
}
export function ObservationTable({rows,columns}: {rows:Record<string,unknown>[];columns:[string,string][]}) {
  const visible=columns.filter(([,key])=>rows.some(row=>row[key]!==null && row[key]!==undefined));
  return <div className="overflow-x-auto"><table className="w-full text-xs text-left"><thead><tr>{visible.map(([title,key])=><th key={key} className="py-3 pr-5 font-medium whitespace-nowrap">{title}</th>)}</tr></thead><tbody>{rows.map((row,i)=><tr key={i} className="border-t border-[var(--color-border)]">{visible.map(([,key])=><td key={key} className="py-3 pr-5 tabular-nums whitespace-nowrap">{row[key]===null || row[key]===undefined ? '—' : String(row[key])}</td>)}</tr>)}</tbody></table></div>;
}
