import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { BotsPageResponse } from '@/lib/api';
import { authFetch } from '@/lib/auth-token';
import { transientReadFailure } from '@/lib/read-continuity';
import { useServer } from '@/hooks/useServer';
import { parseTradingVisualsSources, type TradingVisualsSource } from '@/features/trading-visuals/sources';
import { buildBotPositionView, partitionBotInventory, numeric, type BotPairPosition } from '@/features/bots/position-view';
import { loadBotFillTrips, openTripForPair, tripOutcomeLabel, type FillTrip } from '@/features/bots/fill-trips';
import { PairPosition, PriceLevels, ObservationTable } from './NativeBotPositions';
import './command-desk.css';

type Section = 'positions' | 'orders' | 'controllers' | 'trips';
const ownerName = (bot: string) => bot === 'ok_rsi' ? 'Main' : bot === 'ok_rsi_sui_sell_only' ? 'SUI · Sell only' : bot;
const amount = (value: unknown, unit = '') => {
  const n = numeric(value);
  return n === null ? 'Unavailable' : `${n.toLocaleString(undefined, { maximumFractionDigits: 8 })}${unit ? ` ${unit}` : ''}`;
};
const stateLabel = (value: string | null) => value?.replaceAll('_', ' ') || 'State unavailable';
async function read(path: string, signal: AbortSignal) {
  const response = await authFetch(path, { signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]), cache: 'no-store' });
  if (!response.ok) throw Object.assign(new Error(`Bot observation request failed (${response.status}).`), { status: response.status });
  return response.json();
}
const money = (value: number | null, quote: string) => {
  if (value === null) return 'Unavailable';
  return `${value > 0 ? '+' : ''}${amount(value, quote)}`;
};

function PositionChoices({ rows, selected, onSelect }: { rows: BotPairPosition[]; selected?: string; onSelect: (id: string) => void }) {
  return <div className="bot-desk__positions">{rows.map(row => <button type="button" key={row.id} aria-pressed={selected === row.id} onClick={() => onSelect(row.id)} aria-label={`${row.pair} position`}>
    <span><strong>{row.pair}</strong><small>{stateLabel(row.phase)}</small>{!row.uniquePair && <small>{row.controllerId || row.id}</small>}</span>
    <span className="bot-desk__number">{amount(row.markValue, row.quote)}<small>Current market value</small></span>
  </button>)}</div>;
}

function TripReceipt({ row, bot, trip }: { row: BotPairPosition; bot: string; trip?: FillTrip }) {
  const fills = `/trading-visuals?bot=${encodeURIComponent(bot)}&pair=${encodeURIComponent(row.pair)}&view=activity&record=fills`;
  if (trip?.outcome === 'unknown_cost') {
    return <div className="bot-desk__receipts"><h4>Buy/sell trip</h4><p>Acquisition cost is unknown. Realized PnL is unavailable{trip.pnlUnavailableReason ? ` (${trip.pnlUnavailableReason.replaceAll('_', ' ')})` : ''}.</p><Link to={fills}>Inspect recorded fills ↗</Link></div>;
  }
  if (trip && trip.remainingCostQuote !== null) {
    return <div className="bot-desk__receipts"><h4>Buy/sell trip</h4><p>Fill-replay remaining cost {amount(trip.remainingCostQuote, row.quote)}. Bought {trip.buyAmountBase} {row.baseAsset}, sold {trip.sellAmountBase}, still in the bag {trip.remainingBase}. Realized {money(trip.realizedPnlQuote, row.quote)}.</p><Link to={fills}>Inspect recorded fills ↗</Link></div>;
  }
  return <div className="bot-desk__receipts"><h4>Purchase receipts</h4><p>Gross purchase spend for this current position is unavailable without complete fill attribution.</p><Link to={fills}>Inspect recorded fills ↗</Link></div>;
}

function openedUtc(value: string) {
  return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '').replace('Z', '') : 'Unavailable';
}

function TripLedger({ trips, bot }: { trips: FillTrip[]; bot: string }) {
  const cancelled = trips.filter(trip => trip.outcome === 'cancelled');
  const visible = trips.filter(trip => trip.outcome !== 'cancelled');
  if (!visible.length && !cancelled.length) return <p>No recorded spot buy/sell trips for this owner. Futures fills are omitted.</p>;
  return <div className="bot-desk__trips">
    {visible.length ? <table>
    <caption className="sr-only">Spot fill-replay trips</caption>
    <thead><tr>{['Pair', 'Opened · UTC', 'Outcome', 'Buys', 'Sells', 'Remaining', 'Realized', 'Fees'].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
    <tbody>{visible.map(trip => <tr key={`${trip.sourceDbId}:${trip.pair}:${trip.openedAt}:${trip.fills[0]?.fillId ?? trip.outcome}`}>
      <td>{trip.pair}</td>
      <td>{openedUtc(trip.openedAt)}</td>
      <td>{tripOutcomeLabel[trip.outcome]}{trip.pnlUnavailableReason ? ` · ${trip.pnlUnavailableReason.replaceAll('_', ' ')}` : ''}</td>
      <td>{trip.buyAmountBase}</td>
      <td>{trip.sellAmountBase}</td>
      <td>{trip.remainingBase}</td>
      <td>{money(trip.realizedPnlQuote, trip.quote)}</td>
      <td>{amount(trip.feesQuote, trip.quote)}</td>
    </tr>)}</tbody>
    </table> : <p>No filled, open, or unknown-cost spot trips.</p>}
    {!!cancelled.length && <details className="bot-desk__legs"><summary>Cancelled unfilled orders ({cancelled.length})</summary>
      <ul>{cancelled.map((trip, index) => <li key={`${trip.sourceDbId}:${trip.pair}:${trip.openedAt}:${index}`}>{trip.pair} · {openedUtc(trip.openedAt)}</li>)}</ul>
    </details>}
    <details className="bot-desk__legs"><summary>Fill legs</summary>{visible.filter(trip => trip.fills.length).map(trip => <div key={`${trip.sourceDbId}:${trip.openedAt}:${trip.pair}:${trip.fills[0]?.fillId}`}>
    <h4>{trip.pair} · {tripOutcomeLabel[trip.outcome]}</h4>
    <ul>{trip.fills.map(fill => <li key={fill.fillId}>{fill.side} {fill.amountBase} @ {amount(fill.priceQuote, trip.quote)}{fill.side === 'sell' ? ` · realized ${money(fill.realizedPnlQuote, trip.quote)}` : ''} · {fill.timestamp}</li>)}</ul>
  </div>)}</details>
  <p className="bot-desk__muted">Spot 1x fill-replay FIFO from recorded TradeFill receipts. A filled trip sold its bought inventory. Remaining units stay in the bag. Hold is an open POSITION_HOLD transfer, not a realized exit. Unknown cost (including wallet sales) omits PnL. Cancelled unfilled orders are listed separately. <Link to={`/trading-visuals?bot=${encodeURIComponent(bot)}&view=activity&record=fills`}>Recorded fills</Link></p>
  </div>;
}

function PositionInspector({ row, bot, page, now, trip }: { row: BotPairPosition; bot: string; page?: BotsPageResponse; now: number; trip?: FillTrip }) {
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
    <TripReceipt row={row} bot={bot} trip={trip}/>
    <details className="bot-desk__evidence"><summary>Owner evidence &amp; exit details</summary><PairPosition row={row} bot={bot} page={page} now={now} showLevels={false}/></details>
  </aside>;
}

/** Projection failures remove current values, but keep the owner and workspace mounted. */
export function CommandDeskObservation({ payload, bot, page, now, section, selected, onSelect, trips, tripsError }: {
  payload: unknown; bot: string; page?: BotsPageResponse; now: number; section: Section; selected: string | null; onSelect: (id: string) => void;
  trips?: FillTrip[] | null; tripsError?: string | null;
}) {
  let view;
  try { view = buildBotPositionView(payload, bot, now); }
  catch (error) { return <p className="bot-desk__notice" role="status">{error instanceof Error ? error.message : 'Bot state could not be read.'}</p>; }
  const { primary, small } = partitionBotInventory(view.pairs);
  const row = selected ? view.pairs.find(item => item.id === selected) : primary[0] ?? small[0];
  const completeOrders = view.orders !== null && view.ordersStatus.complete === true;
  const trip = row && trips ? openTripForPair(trips, row.pair) : undefined;
  return <>
    <div className="bot-desk__observation"><span>{view.orderCountLabel} <strong>{amount(view.activeOrderCount)}</strong></span><span>Active executors <strong>{amount(view.activeExecutorCount)}</strong></span><small>Observed {new Date(view.observedAt).toLocaleTimeString('en-GB', { timeZone: 'UTC' })} UTC</small></div>
    {section === 'positions' && <div className="bot-desk__position-workspace"><div>
      <PositionChoices rows={primary} selected={row?.id} onSelect={onSelect}/>
      {!!small.length && <details className="bot-desk__small" open={Boolean(row && small.includes(row))}><summary>Small &amp; zero inventory ({small.length})</summary><p>Below 1 unit of quote value with no active executor or reported pending sell. Not a venue minimum.</p><PositionChoices rows={small} selected={row?.id} onSelect={onSelect}/></details>}
      {!view.pairs.length && <p className="bot-desk__notice">No controller positions are included in this observation.</p>}
      {selected && !row && <p role="status" className="bot-desk__notice">The selected position is no longer reported. Select a current position.</p>}
    </div>{row && <PositionInspector key={row.id} row={row} bot={bot} page={page} now={now} trip={trip}/>}</div>}
    {section === 'orders' && <section aria-label="Selected bot working orders" className="bot-desk__orders"><h3>Working exchange orders</h3>{completeOrders ? view.orders!.length ? <ObservationTable rows={view.orders!} columns={[
      ['Pair', 'pair'], ['Side', 'side'], ['Price (quote)', 'price_quote'], ['Amount (base)', 'amount_base'], ['Filled (base)', 'filled_amount_base'], ['Remaining (base)', 'remaining_amount_base'], ['Status', 'status'],
    ]}/> : <p>No active orders in this owner observation.</p> : <p role="status">Complete exchange order detail is unavailable. A reported limit-order count excludes market orders.</p>}<p className="bot-desk__muted">Owner-issued requests and conditional exit plans are shown in position evidence; they are not assumed to be exchange orders.</p></section>}
    {section === 'controllers' && <section aria-label="Selected bot controllers"><h3>Controller observations</h3>{view.pairs.map(item => <details className="bot-desk__controller" key={item.id}><summary>{item.pair}<span>{stateLabel(item.phase)}</span></summary><PairPosition row={item} bot={bot} page={page} now={now}/></details>)}</section>}
    {section === 'trips' && <section aria-label="Buy and sell trips" className="bot-desk__orders"><h3>Buy/sell trips</h3>{tripsError ? <p role="alert">{tripsError}</p> : trips == null ? <p role="status">Reading recorded fill trips…</p> : <TripLedger trips={trips} bot={bot}/>}</section>}
    <details className="bot-desk__coverage"><summary>Source &amp; accounting details</summary><p>Managed inventory combines open and closing executor net units and retained units. Episode bags are counted once. Current market value uses the observed price; it is not gross purchase spend. Open-position PnL is not lifetime strategy profit. Episode PnL is before exit costs. Trip PnL is spot fill-replay FIFO from recorded fills, not account equity. Missing quantities, prices and basis remain unavailable. Whole-account holdings and aggregate performance stay in <Link to="/capital">Capital</Link>.</p></details>
  </>;
}

function OwnerWorkspace({ source, page, controls, logs }: { source: TradingVisualsSource; page?: BotsPageResponse; controls: ReactNode; logs: ReactNode }) {
  const [now, setNow] = useState(Date.now);
  const [section, setSection] = useState<Section>('positions');
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const query = useQuery({ queryKey: ['native-position-observation', source.server, source.bot], queryFn: ({ signal }) => read(`/api/v1/trading-visuals/bootstrap?bot=${encodeURIComponent(source.bot)}`, signal), refetchInterval: 10_000, retry: false });
  const tripsQuery = useQuery({ queryKey: ['native-fill-trips', source.server, source.bot], queryFn: ({ signal }) => loadBotFillTrips(source.bot, read, signal), refetchInterval: 30_000, retry: false });
  const owner = page?.bots.find(item => item.bot_name === source.bot);
  const tabs = { positions: 'Positions', orders: 'Working orders', trips: 'Buy/sell trips', controllers: 'Controller details' } as const;
  return <section className="bot-desk__workspace" aria-label={`${source.bot} command desk`}>
    <header className="bot-desk__owner-header"><div><h2>{ownerName(source.bot)}</h2><p>{source.bot} · {source.server}</p></div><div className="bot-desk__owner-actions"><span className="bot-desk__status">{owner?.status ? stateLabel(owner.status) : 'Lifecycle unavailable'}</span>{controls}</div></header>
    <nav className="bot-desk__tabs" aria-label="Selected bot workspace">{(Object.keys(tabs) as Section[]).map(item => <button type="button" key={item} aria-pressed={section === item} onClick={() => setSection(item)}>{tabs[item]}</button>)}</nav>
    {query.isPending ? <p className="bot-desk__notice" role="status">Reading bot positions and orders…</p> : query.isError ? <p className="bot-desk__notice" role="alert">{query.error.message} Retrying in the background. <button type="button" onClick={() => void query.refetch()}>Check now</button></p> : <CommandDeskObservation payload={query.data} bot={source.bot} page={page} now={Math.max(now, query.dataUpdatedAt)} section={section} selected={selected} onSelect={setSelected} trips={tripsQuery.isPending ? null : tripsQuery.data} tripsError={tripsQuery.isError ? tripsQuery.error.message : null}/>}
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
