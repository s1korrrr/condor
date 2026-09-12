import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { BotsPageResponse } from '@/lib/api';
import { currentControllerPolicy } from '@/features/bots/observed-policy';
import { authFetch } from '@/lib/auth-token';
import { parseTradingVisualsSources, type TradingVisualsSource } from '@/features/trading-visuals/sources';
import { buildBotPositionView, partitionBotInventory, numeric, type BotPairPosition } from '@/features/bots/position-view';

async function read(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await authFetch(path, { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), cache: 'no-store' });
  if (!response.ok) throw new Error(`Bot observation request failed (${response.status}).`);
  return response.json();
}
const number = (value: unknown, unit = '') => { const n = numeric(value); return n === null ? '—' : `${n.toLocaleString(undefined, { maximumFractionDigits: 8 })}${unit ? ` ${unit}` : ''}`; };
const label = (value: unknown) => typeof value === 'string' && value ? value.replaceAll('_', ' ') : '—';
function Metric({ title, value, detail }: { title: string; value: string; detail?: string }) {
  return <div><dt className="text-xs text-[var(--color-text-muted)]">{title}</dt><dd className="mt-1 font-semibold tabular-nums text-sm">{value}</dd>{detail && <dd className="mt-1 text-xs text-[var(--color-text-muted)]">{detail}</dd>}</div>;
}
function PriceLevels({ row }: { row: BotPairPosition }) {
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
function PairPosition({ row, bot, page, now }: { row: BotPairPosition; bot: string; page?:BotsPageResponse; now:number }) {
  const to = `/trading-visuals?bot=${encodeURIComponent(bot)}&pair=${encodeURIComponent(row.pair)}`;
  const policy=currentControllerPolicy(page,bot,row,now);
  const metrics = [
    ['Tracked inventory cost', row.base !== null && row.breakeven !== null ? row.base * row.breakeven : null, row.quote],
    ['Planned bag reduction', row.plannedReduction, row.baseAsset], ['Target remaining inventory', row.targetBase, row.baseAsset],
    ['Price move to trailing floor', row.floor !== null && row.price !== null ? (row.floor / row.price - 1) * 100 : null, '%'],
  ] as const;
  return <div className="space-y-4 p-4 bg-[var(--color-bg)]/40">
    <div className="flex flex-wrap justify-between gap-3"><p className="text-xs text-[var(--color-text-muted)]">{row.inventorySource} · {row.id}</p><div className="flex gap-4 text-sm text-[var(--color-primary)]"><Link to={`${to}&view=charts`}>Chart</Link><Link to={`${to}&view=activity&record=fills`}>Fills</Link></div></div>
    <PriceLevels row={row} />
    {policy && <div><h4 className="text-sm font-medium">Observed trailing policy and operator state</h4><p className="mt-1 text-xs text-[var(--color-text-muted)]">Native controller telemetry · {policy.controllerId} · received {new Date(policy.receivedAt*1000).toISOString()} UTC. Policy settings do not establish an armed trailing price.</p><dl className="mt-3 grid grid-cols-2 lg:grid-cols-3 gap-3">{policy.fields.map(([title,value])=><Metric key={title} title={title} value={value}/>)}</dl></div>}
    {metrics.some(([,value]) => value !== null) && <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">{metrics.filter(([,value])=>value!==null).map(([title,value,unit])=><Metric key={title} title={title} value={number(value,unit)}/>)}</dl>}
    {row.quantity !== null && <p className="text-xs break-all">Observed inventory units: <span className="tabular-nums">{row.quantity} {row.baseAsset}</span></p>}
    {row.inventoryEntries.length > 1 && <details className="text-xs"><summary>Exact retained inventory entries ({row.inventoryEntries.length})</summary><ul className="mt-2 space-y-1">{row.inventoryEntries.map((entry,i)=><li key={i} className="break-all tabular-nums">{String(entry.amount_base)} {row.baseAsset}{numeric(entry.breakeven_price)!==null ? ` · basis ${String(entry.breakeven_price)} ${row.quote}` : ''}</li>)}</ul></details>}
    {(row.hold || row.reason || row.planNext || row.riskClear !== null) && <div className="space-y-1 text-sm"><h4 className="font-medium">Controller plan and gates</h4>{row.hold && <p>Hold: {label(row.hold)}</p>}{row.reason && <p>{label(row.reason)}</p>}{row.planNext && <p>Owner plan: {row.planNext}</p>}{row.riskClear !== null && <p>Exit risk gate: {row.riskClear ? 'clear' : 'blocked'}</p>}</div>}
    {row.plannedReduction !== null && <p className="text-xs text-[var(--color-text-muted)]">The inventory target is before order sizing and gates. A conditional plan does not guarantee an order, fill price or closing time.</p>}
    {row.pendingSells !== null && <div><h4 className="text-sm font-medium">Owner-issued sell requests</h4>{row.pendingSells.length ? <ObservationTable rows={row.pendingSells} columns={[
      ['Request', 'request_id'], ['State', 'request_state'], ['Price · '+row.quote, 'price_quote'], ['Amount · '+row.baseAsset,'amount_base'], ['Filled','filled_amount_base'], ['Remaining','remaining_amount_base'],
    ]}/> : <p className="mt-2 text-xs">No pending sell request in this observation.</p>}<p className="mt-2 text-xs text-[var(--color-text-muted)]">Requests may still be awaiting an exchange order.{row.pendingSellsTruncated ? ' The owner limited this list; additional requests may exist.' : ''}</p></div>}
    {!!row.executors.length && <div><h4 className="text-sm font-medium">Active executors</h4><ObservationTable rows={row.executors} columns={[
      ['Side','side'], ['Executor','executor_type'], ['Status','status'], ['Remaining · '+row.baseAsset,'remaining_position_amount_base'], ['PnL · '+row.quote,'net_pnl_quote'], ['Trail state','trailing_state'], ['Activation · '+row.quote,'trailing_activation_price'], ['Trigger · '+row.quote,'trailing_trigger_price'],
    ]}/></div>}
  </div>;
}
function ObservationTable({rows,columns}: {rows:Record<string,unknown>[];columns:[string,string][]}) {
  const visible=columns.filter(([,key])=>rows.some(row=>row[key]!==null && row[key]!==undefined));
  return <div className="overflow-x-auto"><table className="w-full text-xs text-left"><thead><tr>{visible.map(([title,key])=><th key={key} className="py-3 pr-5 font-medium whitespace-nowrap">{title}</th>)}</tr></thead><tbody>{rows.map((row,i)=><tr key={i} className="border-t border-[var(--color-border)]">{visible.map(([,key])=><td key={key} className="py-3 pr-5 tabular-nums whitespace-nowrap">{row[key]===null || row[key]===undefined ? '—' : String(row[key])}</td>)}</tr>)}</tbody></table></div>;
}
function InventoryTable({rows,bot,page,now}: {rows:BotPairPosition[];bot:string;page?:BotsPageResponse;now:number}) {
  return <div className="space-y-1">{rows.map(row=><details key={row.id} className="border-b border-[var(--color-border)] last:border-0">
    <summary className="cursor-pointer list-none grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 py-3 text-xs" aria-label={`${row.pair} inventory details`}>
      <span><strong className="block text-sm text-[var(--color-primary)]">{row.pair}</strong><span className="mt-1 block text-[var(--color-text-muted)]">{label(row.phase)}</span></span>
      <span className="tabular-nums break-all"><span className="block text-[var(--color-text-muted)]">Held units</span>{row.quantity ?? '—'} {row.baseAsset}</span>
      <span className="tabular-nums"><span className="block text-[var(--color-text-muted)]">Market value</span>{number(row.markValue,row.quote)}</span>
      <span className="tabular-nums"><span className="block text-[var(--color-text-muted)]">Unrealized PnL</span>{number(row.bagPnl,row.quote)}<span className="block text-[var(--color-primary)] mt-1">Details</span></span>
    </summary><PairPosition row={row} bot={bot} page={page} now={now}/></details>)}</div>;
}
export function BotPositionObservation({ payload, bot, now, page }: { payload: unknown; bot: string; now: number; page?:BotsPageResponse }) {
  let view;
  try { view = buildBotPositionView(payload, bot, now); } catch (error) { return <p role="status" className="text-sm text-[var(--color-yellow)]">{error instanceof Error ? error.message : 'Bot state could not be read.'}</p>; }
  const completeOrders = view.orders !== null && view.ordersStatus.complete === true;
  const {primary,small}=partitionBotInventory(view.pairs);
  const missing:string[]=[];
  if (!completeOrders) missing.push('complete exchange order detail');
  if(view.pairs.some(row=>row.base===null)) missing.push('inventory quantities for some controllers');
  if(view.pairs.some(row=>row.breakeven===null && row.base!==0)) missing.push('acquisition basis for some inventory');
  if(view.pairs.some(row=>row.pendingSells===null || row.floor===null)) missing.push('detailed sell requests or trailing levels');
  return <div className="space-y-4">
    <dl className="flex flex-wrap gap-x-10 gap-y-4">{view.activeOrderCount!==null && <Metric title={view.orderCountLabel} value={number(view.activeOrderCount)} detail={completeOrders ? "Connector-tracked, including pending placement" : "Limit orders only; market orders excluded"} />}<Metric title="Active executors" value={number(view.activeExecutorCount)} /><Metric title="Observed at · UTC" value={new Date(view.observedAt).toISOString().replace('T',' ').replace('Z','')} /></dl>
    <div aria-label="Observation coverage" className="text-xs leading-relaxed text-[var(--color-text-muted)] border-l-2 border-[var(--color-border)] pl-3"><p>{view.pairs.some(row=>row.inventorySource==='Controller episode bag') ? 'Controller episode inventory and retained bot inventory are shown in their stated scopes.' : 'Retained bot inventory: positions recorded by the execution owner, not the whole account balance.'} Values use each pair’s quote currency. {view.pairs.some(row=>row.inventorySource==='Controller episode bag') ? 'Episode PnL is mark value less tracked cost, before exit costs.' : 'PnL is the owner-reported retained-position result.'}</p>{missing.length>0 && <p className="mt-1">This snapshot does not report {missing.join('; ')}. Only reported fields are shown in details; a dash marks a missing value. Account holdings remain in <Link className="underline" to="/portfolio">Portfolio</Link>.</p>}</div>
    {completeOrders && <details className="rounded-lg border border-[var(--color-border)] p-3"><summary className="cursor-pointer text-sm">Inspect active orders ({view.orders!.length})</summary>{view.orders!.length ? <ObservationTable rows={view.orders!} columns={[
      ['Pair','pair'], ['Side','side'], ['Price (quote)','price_quote'], ['Amount (base)','amount_base'], ['Filled (base)','filled_amount_base'], ['Remaining (base)','remaining_amount_base'], ['Status','status'],
    ]}/> : <p className="mt-3 text-sm">No active orders in this owner observation.</p>}</details>}
    {!!primary.length && <InventoryTable rows={primary} bot={bot} page={page} now={now}/>}
    {!!small.length && <details className="rounded-lg border border-[var(--color-border)] px-4 py-3"><summary className="cursor-pointer text-sm">Small &amp; zero inventory ({small.length})</summary><p className="my-3 text-xs text-[var(--color-text-muted)]">Each position is below 1 unit of its quote currency with no active executor or reported pending sell. This display grouping is not a venue trading minimum. Exact reported quantities remain below.</p><InventoryTable rows={small} bot={bot} page={page} now={now}/></details>}
    {!view.pairs.length && <p role="status" className="text-sm">No controller positions are included in this observation.</p>}
  </div>;
}
function SourcePositions({ source, page }: { source: TradingVisualsSource; page?:BotsPageResponse }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(id); }, []);
  const query = useQuery({ queryKey: ['native-position-observation', source.server, source.bot], queryFn: ({ signal }) => read(`/api/v1/trading-visuals/bootstrap?bot=${encodeURIComponent(source.bot)}`, signal), refetchInterval: 10_000, retry: false });
  return <section className="space-y-4" aria-label={`${source.bot} positions and orders`}><h2 className="text-base font-semibold">{source.bot}</h2>{query.isPending ? <p role="status">Reading bot positions and orders…</p> : query.isError ? <p role="alert" className="text-sm">{query.error.message} <button className="underline" onClick={() => void query.refetch()}>Retry</button></p> : <BotPositionObservation page={page} payload={query.data} bot={source.bot} now={Math.max(now, query.dataUpdatedAt)} />}</section>;
}
export function NativeBotPositions({ server, page }: { server: string; page?:BotsPageResponse }) {
  const query = useQuery({ queryKey: ['native-position-sources', server], queryFn: async ({ signal }) => parseTradingVisualsSources(await read('/api/v1/trading-visuals/sources', signal)).filter(source => source.server === server), retry: false, refetchInterval: 30_000 });
  return <div className="space-y-6">{query.isPending ? <p role="status">Discovering bot position sources…</p> : query.isError ? <p role="alert">{query.error.message} <button className="underline" onClick={() => void query.refetch()}>Retry</button></p> : query.data?.length ? query.data.map(source => <SourcePositions key={`${source.server}:${source.bot}`} source={source} page={page} />) : <p role="status">No authorized bot position source is available for this server.</p>}</div>;
}
