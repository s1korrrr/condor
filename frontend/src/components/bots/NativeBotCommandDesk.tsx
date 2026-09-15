import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { BotsPageResponse } from '@/lib/api';
import { authFetch } from '@/lib/auth-token';
import { transientReadFailure } from '@/lib/read-continuity';
import { useServer } from '@/hooks/useServer';
import { parseTradingVisualsSources, type TradingVisualsSource } from '@/features/trading-visuals/sources';
import { buildBotPositionView, partitionBotInventory, numeric, type BotPairPosition } from '@/features/bots/position-view';
import { PairPosition, PriceLevels, ObservationTable } from './NativeBotPositions';
import './command-desk.css';

type Section = 'positions' | 'orders' | 'controllers';
const ownerName = (bot: string) => bot === 'ok_rsi' ? 'Main' : bot === 'ok_rsi_sui_sell_only' ? 'SUI · Sell only' : bot;
const amount = (value: unknown, unit = '') => {
  const n = numeric(value);
  return n === null ? 'Unavailable' : `${n.toLocaleString(undefined, { maximumFractionDigits: 8 })}${unit ? ` ${unit}` : ''}`;
};
const stateLabel = (value: string | null) => value?.replaceAll('_', ' ') || 'State unavailable';
async function read(path: string, signal: AbortSignal) {
  const response = await authFetch(path, { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), cache: 'no-store' });
  if (!response.ok) throw Object.assign(new Error(`Bot observation request failed (${response.status}).`), { status: response.status });
  return response.json();
}

function PositionChoices({ rows, selected, onSelect }: { rows: BotPairPosition[]; selected?: string; onSelect: (id: string) => void }) {
  return <div className="bot-desk__positions">{rows.map(row => <button type="button" key={row.id} aria-pressed={selected === row.id} onClick={() => onSelect(row.id)} aria-label={`${row.pair} position`}>
    <span><strong>{row.pair}</strong><small>{stateLabel(row.phase)}</small>{!row.uniquePair && <small>{row.controllerId || row.id}</small>}</span>
    <span className="bot-desk__number">{amount(row.markValue, row.quote)}<small>Current market value</small></span>
  </button>)}</div>;
}

function PositionInspector({ row, bot, page, now }: { row: BotPairPosition; bot: string; page?: BotsPageResponse; now: number }) {
  return <aside className="bot-desk__inspector" aria-label={`${row.pair} position inspector`}>
    <header><h3>{row.pair}</h3><small>Selected position</small></header>
    <dl className="bot-desk__metrics">
      <div><dt>Current market value</dt><dd>{amount(row.markValue, row.quote)}</dd></div>
      <div><dt>Managed net units</dt><dd>{row.quantity === null ? 'Unavailable' : `${row.quantity} ${row.baseAsset}`}</dd></div>
      <div><dt>Open-position PnL</dt><dd>{amount(row.bagPnl, row.quote)}</dd></div>
      <div><dt>Tracked inventory cost</dt><dd>{amount(row.base !== null && row.breakeven !== null ? row.base * row.breakeven : null, row.quote)}</dd></div>
    </dl>
    <PriceLevels row={row}/>
    <div className="bot-desk__next"><h4>Next decision</h4><p>{row.planNext || row.reason || row.hold ? stateLabel(row.planNext || row.reason || row.hold) : 'The owner has not reported its next condition.'}</p><small>A controller condition is not a working exchange order.</small></div>
    <div className="bot-desk__receipts"><h4>Purchase receipts</h4><p>Gross purchase spend for this current position is unavailable without complete fill attribution.</p><Link to={`/trading-visuals?bot=${encodeURIComponent(bot)}&pair=${encodeURIComponent(row.pair)}&view=activity&record=fills`}>Inspect recorded fills ↗</Link></div>
    <details className="bot-desk__evidence"><summary>Owner evidence &amp; exit details</summary><PairPosition row={row} bot={bot} page={page} now={now} showLevels={false}/></details>
  </aside>;
}

/** Projection failures remove current values, but keep the owner and workspace mounted. */
export function CommandDeskObservation({ payload, bot, page, now, section, selected, onSelect }: {
  payload: unknown; bot: string; page?: BotsPageResponse; now: number; section: Section; selected: string | null; onSelect: (id: string) => void;
}) {
  let view;
  try { view = buildBotPositionView(payload, bot, now); }
  catch (error) { return <p className="bot-desk__notice" role="status">{error instanceof Error ? error.message : 'Bot state could not be read.'}</p>; }
  const { primary, small } = partitionBotInventory(view.pairs);
  const row = selected ? view.pairs.find(item => item.id === selected) : primary[0] ?? small[0];
  const completeOrders = view.orders !== null && view.ordersStatus.complete === true;
  return <>
    <div className="bot-desk__observation"><span>{view.orderCountLabel} <strong>{amount(view.activeOrderCount)}</strong></span><span>Active executors <strong>{amount(view.activeExecutorCount)}</strong></span><small>Observed {new Date(view.observedAt).toLocaleTimeString('en-GB', { timeZone: 'UTC' })} UTC</small></div>
    {section === 'positions' && <div className="bot-desk__position-workspace"><div>
      <PositionChoices rows={primary} selected={row?.id} onSelect={onSelect}/>
      {!!small.length && <details className="bot-desk__small" open={Boolean(row && small.includes(row))}><summary>Small &amp; zero inventory ({small.length})</summary><p>Below 1 unit of quote value with no active executor or reported pending sell. Not a venue minimum.</p><PositionChoices rows={small} selected={row?.id} onSelect={onSelect}/></details>}
      {!view.pairs.length && <p className="bot-desk__notice">No controller positions are included in this observation.</p>}
      {selected && !row && <p role="status" className="bot-desk__notice">The selected position is no longer reported. Select a current position.</p>}
    </div>{row && <PositionInspector key={row.id} row={row} bot={bot} page={page} now={now}/>}</div>}
    {section === 'orders' && <section aria-label="Selected bot working orders" className="bot-desk__orders"><h3>Working exchange orders</h3>{completeOrders ? view.orders!.length ? <ObservationTable rows={view.orders!} columns={[
      ['Pair', 'pair'], ['Side', 'side'], ['Price (quote)', 'price_quote'], ['Amount (base)', 'amount_base'], ['Filled (base)', 'filled_amount_base'], ['Remaining (base)', 'remaining_amount_base'], ['Status', 'status'],
    ]}/> : <p>No active orders in this owner observation.</p> : <p role="status">Complete exchange order detail is unavailable. A reported limit-order count excludes market orders.</p>}<p className="bot-desk__muted">Owner-issued requests and conditional exit plans are shown in position evidence; they are not assumed to be exchange orders.</p></section>}
    {section === 'controllers' && <section aria-label="Selected bot controllers"><h3>Controller observations</h3>{view.pairs.map(item => <details className="bot-desk__controller" key={item.id}><summary>{item.pair}<span>{stateLabel(item.phase)}</span></summary><PairPosition row={item} bot={bot} page={page} now={now}/></details>)}</section>}
    <details className="bot-desk__coverage"><summary>Source &amp; accounting details</summary><p>Managed inventory combines open and closing executor net units and retained units. Episode bags are counted once. Current market value uses the observed price; it is not gross purchase spend. Open-position PnL is not lifetime strategy profit. Episode PnL is before exit costs. Missing quantities, prices and basis remain unavailable. Whole-account holdings and aggregate performance stay in <Link to="/capital">Capital</Link>.</p></details>
  </>;
}

function OwnerWorkspace({ source, page, controls, logs }: { source: TradingVisualsSource; page?: BotsPageResponse; controls: ReactNode; logs: ReactNode }) {
  const [now, setNow] = useState(Date.now);
  const [section, setSection] = useState<Section>('positions');
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const query = useQuery({ queryKey: ['native-position-observation', source.server, source.bot], queryFn: ({ signal }) => read(`/api/v1/trading-visuals/bootstrap?bot=${encodeURIComponent(source.bot)}`, signal), refetchInterval: 10_000, retry: false });
  const owner = page?.bots.find(item => item.bot_name === source.bot);
  return <section className="bot-desk__workspace" aria-label={`${source.bot} command desk`}>
    <header className="bot-desk__owner-header"><div><h2>{ownerName(source.bot)}</h2><p>{source.bot} · {source.server}</p></div><div className="bot-desk__owner-actions"><span className="bot-desk__status">{owner?.status ? stateLabel(owner.status) : 'Lifecycle unavailable'}</span>{controls}</div></header>
    <nav className="bot-desk__tabs" aria-label="Selected bot workspace">{(['positions', 'orders', 'controllers'] as const).map(item => <button type="button" key={item} aria-pressed={section === item} onClick={() => setSection(item)}>{({ positions: 'Positions', orders: 'Working orders', controllers: 'Controller details' })[item]}</button>)}</nav>
    {query.isPending ? <p className="bot-desk__notice" role="status">Reading bot positions and orders…</p> : query.isError ? <p className="bot-desk__notice" role="alert">{query.error.message} Retrying in the background. <button type="button" onClick={() => void query.refetch()}>Check now</button></p> : <CommandDeskObservation payload={query.data} bot={source.bot} page={page} now={Math.max(now, query.dataUpdatedAt)} section={section} selected={selected} onSelect={setSelected}/>}
    {logs && <details className="bot-desk__logs"><summary>Recent owner logs</summary>{logs}</details>}
  </section>;
}

export function NativeBotCommandDesk({ page, renderControls, renderLogs }: { page?: BotsPageResponse; renderControls: (bot: string) => ReactNode; renderLogs: (bot: string) => ReactNode }) {
  const { server, setServer } = useServer();
  const [selection, setSelection] = useState<TradingVisualsSource | null>(null);
  const sources = useQuery({ queryKey: ['native-command-desk-sources'], queryFn: async ({ signal }) => parseTradingVisualsSources(await read('/api/v1/trading-visuals/sources', signal)), retry: false, refetchInterval: 30_000 });
  const visible = !sources.isError || transientReadFailure(sources.error) ? sources.data ?? [] : [];
  const source = selection?.server === server ? visible.find(item => item.server === server && item.bot === selection.bot) : visible.find(item => item.server === server);
  return <div className="bot-desk">
    <nav className="bot-desk__rail" aria-label="Bot owners">{visible.map(item => <button type="button" key={`${item.server}:${item.bot}`} aria-pressed={source?.bot === item.bot && source?.server === item.server} onClick={() => { setSelection(item); setServer(item.server); }}><strong>{ownerName(item.bot)}</strong><small>{item.server}</small></button>)}</nav>
    <div className="bot-desk__body">{sources.isError && <p role="alert" className="bot-desk__notice">{sources.error.message} <button type="button" onClick={() => void sources.refetch()}>Check now</button></p>}{source ? <OwnerWorkspace key={`${source.server}:${source.bot}`} source={source} page={page} controls={sources.isError ? null : renderControls(source.bot)} logs={renderLogs(source.bot)}/> : <p className="bot-desk__notice" role="status">{sources.isPending ? 'Discovering authorized bot owners…' : 'No authorized bot source is available for this selection.'}</p>}</div>
  </div>;
}
