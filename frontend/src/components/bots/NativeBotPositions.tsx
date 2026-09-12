import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { authFetch } from '@/lib/auth-token';
import { parseTradingVisualsSources, type TradingVisualsSource } from '@/features/trading-visuals/sources';
import { buildBotPositionView, numeric, type BotPairPosition } from '@/features/bots/position-view';

async function read(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await authFetch(path, { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), cache: 'no-store' });
  if (!response.ok) throw new Error(`Bot observation request failed (${response.status}).`);
  return response.json();
}
const number = (value: unknown, unit = '') => { const n = numeric(value); return n === null ? 'Unavailable' : `${n.toLocaleString(undefined, { maximumFractionDigits: 8 })}${unit ? ` ${unit}` : ''}`; };
const label = (value: unknown) => typeof value === 'string' && value ? value.replaceAll('_', ' ') : 'Unavailable';
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
function PairPosition({ row, bot }: { row: BotPairPosition; bot: string }) {
  const to = `/trading-visuals?bot=${encodeURIComponent(bot)}&pair=${encodeURIComponent(row.pair)}`;
  return <article className="rounded-lg border border-[var(--color-border)] p-4 space-y-5" aria-label={`${row.pair} position and sell plan`}>
    <header className="flex flex-wrap justify-between gap-3"><div><h3 className="font-semibold">{row.pair}</h3><p className="mt-1 text-xs text-[var(--color-text-muted)]">{row.inventorySource} · {label(row.phase)}</p></div><div className="flex gap-4 text-sm text-[var(--color-primary)]"><Link className="underline underline-offset-4" to={`${to}&view=charts`}>Chart</Link><Link className="underline underline-offset-4" to={`${to}&view=activity&record=fills`}>Fills</Link></div></header>
    <dl className="grid grid-cols-2 gap-5 xl:grid-cols-4">
      <Metric title="Bag holding" value={number(row.base, row.baseAsset)} />
      <Metric title="Bag market value" value={number(row.markValue, row.quote)} detail="At the owner-reported current price" />
      <Metric title="Bag unrealized PnL" value={number(row.bagPnl, row.quote)} detail={row.inventorySource === 'Controller episode bag' ? 'Mark value less tracked cost; before exit costs' : 'Owner-reported retained-position PnL'} />
      <Metric title="Tracked bag cost" value={number(row.base !== null && row.breakeven !== null ? row.base * row.breakeven : null, row.quote)} detail="Unavailable when acquisition basis is unknown" />
    </dl>
    <PriceLevels row={row} />
    <div className="border-t border-[var(--color-border)] pt-4 space-y-3"><h4 className="text-sm font-medium">Next sell and trailing exit</h4>
      <dl className="grid grid-cols-2 gap-5 xl:grid-cols-4">
        <Metric title="Price move to trailing floor" value={number(row.floor !== null && row.price !== null ? (row.floor / row.price - 1) * 100 : null, "%")} detail="From the current price; the floor can move" />
        <Metric title="Profit floor status" value={row.profitPrice === null || row.price === null ? "Unavailable" : row.price >= row.profitPrice ? "Price above floor" : "Price below floor"} detail="Price alone may not permit a sell" />
        <Metric title="Planned bag reduction" value={number(row.plannedReduction, row.baseAsset)} detail="Inventory target difference, before order sizing and gates" />
        <Metric title="Target remaining bag" value={number(row.targetBase, row.baseAsset)} />
      </dl>
      <p className="text-sm text-[var(--color-text-muted)]">{row.hold ? `Hold: ${label(row.hold)}. ` : ''}{row.reason ? `Controller: ${label(row.reason)}. ` : 'Controller gate detail is unavailable. '}{row.riskClear === false ? 'Exit risk gate is blocked.' : row.riskClear === true ? 'The reported exit risk gate is clear.' : ''}</p>
      {row.planNext && <p className="text-sm">Owner plan: {row.planNext}</p>}
      {row.pendingSells?.length ? <div className="overflow-x-auto"><table className="w-full text-sm text-left"><caption className="text-left text-xs text-[var(--color-text-muted)] pb-2">Owner-issued sell requests · may be awaiting an exchange order</caption><thead><tr>{['Request', 'State', 'Requested price', 'Amount', 'Filled', 'Remaining'].map(name => <th key={name} className="py-2 pr-5 font-medium whitespace-nowrap">{name}</th>)}</tr></thead><tbody>{row.pendingSells.map((request, i) => <tr key={String(request.request_id ?? i)} className="border-t border-[var(--color-border)]/40">{[label(request.request_id), label(request.request_state), number(request.price_quote, row.quote), number(request.amount_base, row.baseAsset), number(request.filled_amount_base, row.baseAsset), number(request.remaining_amount_base, row.baseAsset)].map((value, j) => <td key={j} className="py-2 pr-5 tabular-nums whitespace-nowrap">{value}</td>)}</tr>)}</tbody></table></div> : <p className="text-xs text-[var(--color-text-muted)]">{row.pendingSells ? 'No pending sell request in this observation.' : 'Pending sell requests are not included in this owner snapshot.'} A conditional plan does not guarantee the next order, fill price or closing time.</p>}
      {row.pendingSellsTruncated && <p role="status" className="text-xs text-[var(--color-yellow)]">The owner limited this sell-request list; additional requests may exist.</p>}
      {row.executors.length > 0 && <div className="overflow-x-auto"><table className="w-full text-sm text-left"><caption className="text-left text-xs text-[var(--color-text-muted)] pb-2">Active executors · trailing levels and PnL reported by the execution owner</caption><thead><tr>{['Side / executor', 'Status', 'Remaining position', 'PnL', 'Trail state', 'Activation price', 'Trigger price'].map(name => <th key={name} className="py-2 pr-5 font-medium whitespace-nowrap">{name}</th>)}</tr></thead><tbody>{row.executors.map((executor, i) => <tr key={String(executor.executor_id ?? i)} className="border-t border-[var(--color-border)]/40">{[`${label(executor.side)} · ${label(executor.executor_type)}`, label(executor.status), number(executor.remaining_position_amount_base, row.baseAsset), number(executor.net_pnl_quote, row.quote), label(executor.trailing_state), number(executor.trailing_activation_price, row.quote), number(executor.trailing_trigger_price, row.quote)].map((value, j) => <td key={j} className="py-2 pr-5 whitespace-nowrap tabular-nums">{value}</td>)}</tr>)}</tbody></table></div>}
    </div>
  </article>;
}
export function BotPositionObservation({ payload, bot, now }: { payload: unknown; bot: string; now: number }) {
  let view;
  try { view = buildBotPositionView(payload, bot, now); } catch (error) { return <p role="status" className="text-sm text-[var(--color-yellow)]">{error instanceof Error ? error.message : 'Bot state unavailable.'}</p>; }
  const completeOrders = view.ordersStatus.complete === true;
  return <div className="space-y-4">
    <dl className="flex flex-wrap gap-x-10 gap-y-4"><Metric title={view.orderCountLabel} value={number(view.activeOrderCount)} detail={completeOrders ? "Connector-tracked orders, including pending placement" : "Legacy owner count; market orders are not included"} /><Metric title="Active executors" value={number(view.activeExecutorCount)} detail="An executor can manage several orders" /><Metric title="Observed at · UTC" value={new Date(view.observedAt).toISOString().replace('T', ' ').replace('Z', '')} /></dl>
    {view.orders && completeOrders ? <details className="rounded-lg border border-[var(--color-border)] p-3"><summary className="cursor-pointer text-sm">Inspect active orders ({view.orders.length})</summary>{view.orders.length ? <div className="overflow-x-auto mt-3"><table className="w-full text-sm text-left"><thead><tr>{['Pair', 'Side', 'Price (quote)', 'Amount (base)', 'Filled (base)', 'Remaining (base)', 'Status'].map(name => <th key={name} className="py-2 pr-5 font-medium whitespace-nowrap">{name}</th>)}</tr></thead><tbody>{view.orders.map((order, i) => <tr key={String(order.order_id ?? i)} className="border-t border-[var(--color-border)]/40">{[label(order.pair), label(order.side), number(order.price_quote), number(order.amount_base), number(order.filled_amount_base), number(order.remaining_amount_base), label(order.status)].map((value, j) => <td key={j} className="py-2 pr-5 whitespace-nowrap tabular-nums">{value}</td>)}</tr>)}</tbody></table></div> : <p className="mt-3 text-sm">No active orders in this owner observation.</p>}</details> : <p className="text-xs text-[var(--color-text-muted)]">The detailed active-order list is unavailable or incomplete in this snapshot. Recorded database orders remain available in Trading Visuals.</p>}
    {view.pairs.length ? view.pairs.map(row => <PairPosition key={row.id} row={row} bot={bot} />) : <p role="status" className="text-sm">No controller positions are included in this observation.</p>}
    <p className="text-xs text-[var(--color-text-muted)]">Bot inventory and executor PnL describe their stated scopes. Account balances and account history remain in Portfolio. Future trailing levels depend on price movement; no closing time is predicted.</p>
  </div>;
}
function SourcePositions({ source }: { source: TradingVisualsSource }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(id); }, []);
  const query = useQuery({ queryKey: ['native-position-observation', source.server, source.bot], queryFn: ({ signal }) => read(`/api/v1/trading-visuals/bootstrap?bot=${encodeURIComponent(source.bot)}`, signal), refetchInterval: 10_000, retry: false });
  return <section className="space-y-4" aria-label={`${source.bot} positions and orders`}><h2 className="text-base font-semibold">{source.bot}</h2>{query.isPending ? <p role="status">Reading bot positions and orders…</p> : query.isError ? <p role="alert" className="text-sm">{query.error.message} <button className="underline" onClick={() => void query.refetch()}>Retry</button></p> : <BotPositionObservation payload={query.data} bot={source.bot} now={Math.max(now, query.dataUpdatedAt)} />}</section>;
}
export function NativeBotPositions({ server }: { server: string }) {
  const query = useQuery({ queryKey: ['native-position-sources', server], queryFn: async ({ signal }) => parseTradingVisualsSources(await read('/api/v1/trading-visuals/sources', signal)).filter(source => source.server === server), retry: false, refetchInterval: 30_000 });
  return <div className="space-y-6">{query.isPending ? <p role="status">Discovering bot position sources…</p> : query.isError ? <p role="alert">{query.error.message} <button className="underline" onClick={() => void query.refetch()}>Retry</button></p> : query.data?.length ? query.data.map(source => <SourcePositions key={`${source.server}:${source.bot}`} source={source} />) : <p role="status">No authorized bot position source is available for this server.</p>}</div>;
}
