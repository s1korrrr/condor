import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PaperRead } from './contracts';
import { PaperPriceChart } from './PaperPriceChart';
import { usePaperSnapshot } from './usePaperSnapshot';
import { paperCoherentRead, paperCompleteRead, paperCompleteRecords, paperPairBag, paperRetainedRecords, paperSectionError, paperTime, paperWords } from './policy';
import { paperDimmedSnapshot, paperSnapshotPresentation } from './snapshot-presentation';
import { exactSignedSum } from './bots-position-model.mjs';
import { hasPaperCandlePair, paperCandleQuery, usePaperCandleSymbols } from './paper-candles';
import { count, ownerDisplay, type OwnerValueKind } from './format.mjs';
import { OwnerValue } from './OwnerValue';
import { groupTrades, lotBreakeven, reconcileFills, targetFromBreakeven, tradeWindow } from './trades-model.mjs';
import './v5-trades.css';

type Row = Record<string, any>;
type Read = (path: string, section: string, signal: AbortSignal) => Promise<PaperRead>;
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const exact = (value: unknown, display: (value: any) => React.ReactNode) => typeof value === 'string' ? display(value) : '—';
const ownerValue = (value: string, kind: OwnerValueKind, exactValue?: string) => ownerDisplay(value, kind).tone === 'zero'
  ? <><OwnerValue value="0" kind="coin" exact={exactValue ?? value} />{kind === 'pct' ? '%' : ''}{kind === 'usdc' ? ' USDC' : ''}</>
  : <OwnerValue value={value} kind={kind} exact={exactValue} />;
const money = (value: string) => ownerValue(value, 'usdc');
const profit = (value: string) => <>{ownerValue(value, 'pnl')} USDC</>;
const unitPrice = (value: string) => ownerValue(value, 'price');
const coinValue = (value: string, unit?: string) => <OwnerValue value={value} kind="coin" unit={unit} />;
const countValue = (value: string | number) => <OwnerValue value={value} kind="coin" />;
const at = (value: unknown, now: number) => typeof value === 'number' && Number.isSafeInteger(value) && value <= now ? <span title={String(value)}>{paperTime(value, now)}</span> : '—';
const age = at;
const asset = (row: Row) => typeof row.trading_pair === 'string' ? row.trading_pair.split('-')[0] : 'Not published';
const sum = (rows: Row[], key: string) => rows.every(row => typeof row[key] === 'string') ? rows.reduce((total: string | null, row) => total === null ? null : exactSignedSum(total, row[key]), '0') : null;

function historyRows(read: PaperRead | undefined, now: number): Row[] | null {
  if (!read || read.section !== 'history' || paperSectionError(read) || !read.capabilities?.includes('read') || !['available', 'degraded'].includes(read.state) || !['complete', 'partial'].includes(read.completeness ?? '') || typeof read.generated_at_ms !== 'number' || read.generated_at_ms > now || now - read.generated_at_ms > 30_000) return null;
  const descriptor = object(object(read.data).terminal_executors);
  const data = object(descriptor.data);
  return ['complete', 'partial'].includes(descriptor.completeness) && Array.isArray(descriptor.capabilities) && descriptor.capabilities.includes('read') && data.delivery === 'publication_pages' && Array.isArray(data.records) && data.records.every((row: Row) => typeof row.executor_id === 'string') ? data.records : null;
}

function windowRecords(read: PaperRead | undefined, now: number): Row[] | null {
  const retained = paperRetainedRecords(read, now);
  if (retained) return retained;
  if (!read || !['fills', 'executors'].includes(read.section) || read.completeness !== 'complete' || !read.next_cursor || paperSectionError(read) || !read.capabilities?.includes('read') || !['available', 'degraded'].includes(read.state) || typeof read.generated_at_ms !== 'number' || read.generated_at_ms > now || now - read.generated_at_ms > 30_000) return null;
  return Array.isArray(read.data) ? read.data : null;
}

function Table({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return <div className="v5-trades-scroll"><table><thead><tr>{headers.map(header => <th key={header}>{header}</th>)}</tr></thead><tbody>{children}</tbody></table></div>;
}

function TradeChart({ trade, fills, now, valuesAt, asOf }: { trade: Row; fills?: PaperRead; now: number; valuesAt: number; asOf: number | null }) {
  const pair = typeof trade.trading_pair === 'string' ? trade.trading_pair : '';
  const [range, setRange] = useState('24h');
  const symbols = usePaperCandleSymbols(!!pair);
  const listed = hasPaperCandlePair(symbols.data, pair);
  const candles = useQuery(paperCandleQuery(pair, range, listed));
  const view = candles.data && typeof candles.data.end === 'number' && (candles.data.end + 60) * 1000 <= now && Array.isArray(candles.data.buckets) && candles.data.buckets.every((bucket: unknown[]) => Array.isArray(bucket) && typeof bucket[0] === 'number' && (bucket[0] + 60) * 1000 <= now) ? candles.data : undefined;
  const ownFills = fills && Array.isArray(fills.data) ? { ...fills, completeness: fills.next_cursor ? 'partial' : fills.completeness, data: fills.data.filter((row: Row) => row.executor_id === trade.executor_id && typeof row.event_at_ms === 'number' && row.event_at_ms <= now) } : undefined;
  return <PaperPriceChart fills={ownFills} now={now} valuesAt={valuesAt} asOf={asOf} pair={pair} range={range} setRange={setRange} view={view} reason="Candles are unavailable or future-dated for this trade; a published candle window would fill this chart." />;
}

export function TradesContent({ reads, now, readFailed = false, heartbeat = 'Unavailable' }: { reads: PaperRead[]; now: number; readFailed?: boolean; heartbeat?: string }) {
  const sections = Object.fromEntries(reads.map(read => [read.section, read]));
  const snapshot = sections.status?.generated_at_ms;
  const { dimmed: ageDimmed, snapshotAt, valuesAt } = paperDimmedSnapshot(snapshot, now);
  const dimmed = ageDimmed || readFailed || heartbeat !== 'Fresh';
  const validSnapshot = typeof snapshot === 'number' && snapshot <= now && now - snapshot <= 120_000;
  const executorRecords = validSnapshot ? windowRecords(sections.executors, valuesAt) : null;
  const fillRecords = validSnapshot ? windowRecords(sections.fills, valuesAt) : null;
  const historyRecords = validSnapshot ? historyRows(sections.history, valuesAt) : null;
  const notFuture = (row: Row, fields: string[]) => fields.every(field => row[field] == null || typeof snapshot === 'number' && typeof row[field] === 'number' && Number.isSafeInteger(row[field]) && row[field] <= snapshot);
  const executors = executorRecords?.filter(row => notFuture(row, ['created_at_ms', 'close_at_ms'])) ?? null;
  const receivedFills = fillRecords?.filter(row => notFuture(row, ['event_at_ms'])) ?? null;
  const reconciled = reconcileFills(fillRecords ?? []);
  const fills = receivedFills ? reconciled.fills.filter(row => notFuture(row, ['event_at_ms'])) : null;
  const history = historyRecords?.filter(row => notFuture(row, ['created_at_ms', 'close_at_ms'])) ?? null;
  const lots = (validSnapshot ? paperCompleteRecords(sections.positions, valuesAt) : null) as Row[] | null;
  const orderRecords = (validSnapshot ? paperCompleteRecords(sections.orders, valuesAt) : null) as Row[] | null;
  const orders = orderRecords?.filter(row => notFuture(row, ['created_at_ms', 'updated_at_ms'])) ?? null;
  const futureRows = (executorRecords?.length ?? 0) !== (executors?.length ?? 0) || (fillRecords?.length ?? 0) !== (receivedFills?.length ?? 0) || (historyRecords?.length ?? 0) !== (history?.length ?? 0) || (orderRecords?.length ?? 0) !== (orders?.length ?? 0);
  const accounting = validSnapshot && paperCompleteRead(sections.accounting, valuesAt) ? object(object(sections.accounting.data).controllers) : null;
  const wallet = validSnapshot && paperCompleteRead(sections.wallet, valuesAt) ? object(sections.wallet.data) : null;
  const markFor = (row: Row) => {
    if (!wallet || typeof wallet.quote_asset !== 'string' || !Array.isArray(wallet.assets) || row.trading_pair !== `${asset(row)}-${wallet.quote_asset}`) return null;
    const matches = wallet.assets.filter((item: Row) => item.asset === asset(row));
    const mark = matches.length === 1 ? matches[0] : null;
    return mark && typeof snapshot === 'number' && typeof mark.mark_quote === 'string' && typeof mark.mark_at_ms === 'number' && Number.isSafeInteger(mark.mark_at_ms) && mark.mark_at_ms <= snapshot && mark.mark_at_ms <= now && now - mark.mark_at_ms <= 30_000 ? mark : null;
  };
  const trades = useMemo(() => groupTrades((executors ?? []).filter(row => !reconciled.withheldExecutors.has(row.executor_id)), (history ?? []).filter(row => !reconciled.withheldExecutors.has(row.executor_id)), fills ?? []), [executors, history, fills, fillRecords]);
  const [selected, setSelected] = useState<string | null>(null);
  const [filterCoin, setFilterCoin] = useState('all');
  const [filterState, setFilterState] = useState('all');
  const visible = trades.filter((row: Row) => (filterCoin === 'all' || asset(row) === filterCoin) && (filterState === 'all' || (filterState === 'closed' ? row.terminal === true : row.terminal === false)));
  const selectedTrade = trades.find((row: Row) => row.executor_id === selected);
  const tradeIds = new Set(trades.map((row: Row) => row.executor_id));
  const unlinkedFills = fills?.filter(row => !tradeIds.has(row.executor_id)) ?? [];
  const coins = [...new Set(trades.map((row: Row) => asset(row)))].sort() as string[];
  const mappings = new Map<string, Set<string>>();
  for (const row of [...(executors ?? []), ...(history ?? []), ...(lots ?? [])]) {
    if (typeof row.controller_id === 'string' && typeof row.trading_pair === 'string') {
      const pairs = mappings.get(row.controller_id) ?? new Set<string>();
      pairs.add(row.trading_pair); mappings.set(row.controller_id, pairs);
    }
  }
  const totals = new Map<string, Row[]>();
  if (accounting) for (const [controller, value] of Object.entries(accounting)) {
    const pairs = mappings.get(controller);
    const name = pairs?.size === 1 ? `Observed pair ${[...pairs][0]} · ${controller}` : `Pair not established · ${controller}`;
    totals.set(name, [object(value)]);
  }
  const counts = (rows: Row[], key: string) => rows.every(row => Number.isSafeInteger(row[key]) && row[key] >= 0) ? rows.reduce((total, row) => total + BigInt(row[key]), 0n).toString() : null;
  const selectedFills = selectedTrade && fills ? fills.filter(row => row.executor_id === selected) : null;
  const selectedLots = selectedTrade && lots ? lots.filter(row => row.executor_id === selected) : null;
  const selectedOrders = selectedTrade && orders ? orders.filter(row => row.executor_id === selected) : null;
  const selectedBag = selectedTrade && validSnapshot ? paperPairBag(selectedTrade.trading_pair, sections.decisions, sections.positions, valuesAt) : null;
  return <div className="v5-trades">
    {!validSnapshot && <p role="status">Trades are unavailable or expired. A fresh coherent paper snapshot will fill this view.</p>}
    {dimmed && <p role="status">{paperSnapshotPresentation(snapshot, now, readFailed).label} · {readFailed ? 'Refresh failed. ' : ''}{heartbeat !== 'Fresh' ? 'Owner heartbeat is not current. ' : ''}Values below are dimmed.</p>}
    {futureRows && <p role="status">Future-dated records are withheld until a coherent owner snapshot can show them.</p>}
    {reconciled.conflicts > 0 && <p role="status">Conflicting or incomplete fill identities were withheld, along with affected trades. A consistent owner publication will restore them.</p>}
    <div style={dimmed ? { opacity: 0.6 } : undefined}>
    <section className="paper-section"><h2>Trades</h2>
      <p title={executors && fills && history ? `Fills: ${fills.length}; closed trades: ${trades.filter((row: Row) => row.terminal === true).length}` : undefined}>{executors && fills && history ? tradeWindow(count(fills.length), count(trades.filter((row: Row) => row.terminal === true).length), !!sections.fills?.next_cursor || sections.fills?.completeness === 'partial', !!sections.history?.next_cursor) : 'The owner trade or fill window is unavailable. A fresh published snapshot will fill this list.'}</p>
      <div className="v5-trades-filters"><label>Coin <select value={filterCoin} onChange={event => setFilterCoin(event.target.value)}><option value="all">All coins</option>{coins.map(coinName => <option key={coinName}>{coinName}</option>)}</select></label><label>State <select value={filterState} onChange={event => setFilterState(event.target.value)}><option value="all">All states</option><option value="open">Open</option><option value="closed">Closed</option></select></label></div>
      {executors && fills && history && visible.length ? <Table headers={['Coin', 'State', 'Opened', 'Buy fills', 'Holding time', 'Fees', 'Profit', 'Close type', 'Details']}>{visible.map((row: Row) => <tr key={row.executor_id}><td>{asset(row)}</td><td>{row.terminal === true ? 'Closed' : row.terminal === false ? 'Open' : 'Not published'}</td><td>{at(row.created_at_ms, now)}</td><td title="Buy fills in the retained window; not a lifetime count">{countValue(row.fills.filter((fill: Row) => fill.side === 'BUY' && typeof fill.event_at_ms === 'number' && fill.event_at_ms <= now).length)}</td><td>{typeof row.created_at_ms === 'number' && typeof row.close_at_ms === 'number' && row.close_at_ms <= now && row.close_at_ms >= row.created_at_ms ? <>{countValue(Math.floor((row.close_at_ms - row.created_at_ms) / 1000))} s</> : '—'}</td><td>{exact(row.cum_fees_quote, money)}</td><td>{exact(row.realized_pnl_quote, profit)}</td><td>{typeof row.close_type === 'string' ? paperWords(row.close_type) : '—'}</td><td><button className="v5-button" onClick={() => setSelected(row.executor_id)}>View trade</button></td></tr>)}</Table> : <p>No trade rows are available for these filters; published matching executors will appear here.</p>}
    </section>
    <section className="paper-section"><h2>Fills not linked to a shown trade</h2><p>These fills have no executor published or no matching executor in the retained view. They are not assigned to a trade.</p>
      {unlinkedFills.length ? <Table headers={['Trade ID', 'Order ID', 'Executor', 'Time', 'Side', 'Quantity', 'Price', 'Fee', 'Reason']}>{unlinkedFills.map(row => <tr key={JSON.stringify([row.order_id, row.trade_id])}><td>{row.trade_id}</td><td>{row.order_id}</td><td>{row.executor_id ?? 'Not published'}</td><td>{at(row.event_at_ms, now)}</td><td>{paperWords(row.side)}</td><td>{exact(row.quantity, value => coinValue(value, asset(row)))}</td><td>{exact(row.price, unitPrice)}</td><td>{typeof row.fee_amount === 'string' ? exact(row.fee_amount, value => coinValue(value, typeof row.fee_currency === 'string' ? row.fee_currency : undefined)) : exact(row.fee_quote, money)}</td><td>{row.executor_id ? history && executors ? 'No matching executor in the retained view; it may be outside the retained history' : 'Retained trade history or executors unavailable' : 'No executor published'}</td></tr>)}</Table> : <p>{fills ? 'No unlinked fills in this window; a published unmatched fill will appear here.' : 'Fills are unavailable; a retained owner fill window will fill this table.'}</p>}
    </section>
    <section className="paper-section"><h2>Totals by coin</h2><p>Owner lifetime totals are per controller. Pair labels come from retained records and do not establish lifetime coin attribution. Entries and exits count distinct filled orders, not actions.</p>
      {accounting && totals.size ? <Table headers={['Coin or controller', 'Profit', 'Fees', 'Volume', 'Entries', 'Exits']}>{[...totals].map(([name, rows]) => <tr key={name}><td>{name}</td><td>{exact(sum(rows, 'realized_pnl_quote'), profit)}</td><td>{exact(sum(rows, 'fees_paid_quote'), money)}</td><td>{exact(sum(rows, 'volume_traded_quote'), money)}</td><td>{exact(counts(rows, 'entry_count'), countValue)}</td><td>{exact(counts(rows, 'exit_count'), countValue)}</td></tr>)}</Table> : <p>Accounting totals are not published or unavailable; an owner accounting snapshot will fill this table.</p>}
    </section>
    <section className="paper-section"><h2>Open orders</h2>{orders?.length ? <Table headers={['Side', 'Price', 'Quantity', 'Executor', 'Placed']}>{orders.map(row => <tr key={row.order_id}><td>{paperWords(row.side)}</td><td>{exact(row.price, unitPrice)}</td><td>{exact(row.quantity, value => coinValue(value, asset(row)))}</td><td>{row.executor_id ?? 'Not published'}</td><td>{age(row.created_at_ms, now)}</td></tr>)}</Table> : <p>{orders ? 'No open orders in the owner snapshot; newly published open orders will appear here.' : 'Open orders are unavailable; a complete owner orders snapshot will fill this table.'}</p>}</section>
    {selectedTrade && <section className="paper-section"><h2>Trade details · {asset(selectedTrade)}</h2><p>Executor: {selectedTrade.executor_id}</p><p>Average entry price: — · Average exit price: — · Margin at sale: —</p><p>The owner does not publish these sale metrics. A complete owner publication is needed; partial fills cannot establish exact averages or margin.</p>
      <h3>Fills</h3>{selectedFills?.length ? <Table headers={['Time', 'Side', 'Quantity', 'Price', 'Fee']}>{selectedFills.map(row => <tr key={`${row.order_id}:${row.trade_id}`}><td>{at(row.event_at_ms, now)}</td><td>{paperWords(row.side)}</td><td>{exact(row.quantity, value => coinValue(value, asset(row)))}</td><td>{exact(row.price, unitPrice)}</td><td>{typeof row.fee_amount === 'string' ? exact(row.fee_amount, value => coinValue(value, typeof row.fee_currency === 'string' ? row.fee_currency : undefined)) : exact(row.fee_quote, money)}</td></tr>)}</Table> : <p>No fills for this trade in the retained window; a published matching fill will appear here.</p>}
      <TradeChart trade={selectedTrade} fills={fills && sections.fills ? {...sections.fills, data: fills} : undefined} now={now} valuesAt={valuesAt} asOf={dimmed && typeof snapshot === 'number' ? snapshot : snapshotAt} />
      <h3>Lots and targets</h3><p>Owner bag breakeven: {selectedBag?.breakevenPrice ? unitPrice(selectedBag.breakevenPrice) : '— · a coherent owner bag publication will fill this value'}. This is for the whole bag, not an individual lot.</p><p>Lot breakeven uses the owner value when published; otherwise it is basis divided by quantity, rounded to 12 decimal places before display. Target distance uses the owner mark, rounded to two percentage places; a fresh mark is needed when it shows —.</p>
      {selectedLots?.length ? <Table headers={['State', 'Quantity', 'Basis', 'Breakeven', 'Target', 'Owner mark', 'Distance to target', 'Target remaining', 'Sell order']}>{selectedLots.map(row => { const ownerBreakeven = typeof row.breakeven_price === 'string' && /^\d+(?:\.\d+)?$/.test(row.breakeven_price) ? row.breakeven_price : null; const breakeven = ownerBreakeven ?? lotBreakeven(row.remaining_basis_quote, row.quantity); const mark = markFor(row); const distance = mark ? targetFromBreakeven(mark.mark_quote, '1', row.target_price) : null; const order = object(row.protected_exit_order); return <tr key={row.position_id}><td>{paperWords(row.state)}</td><td>{exact(row.quantity, value => coinValue(value, asset(row)))}</td><td>{exact(row.remaining_basis_quote, money)}</td><td>{breakeven === null ? '—' : ownerValue(breakeven, 'price', ownerBreakeven ?? `${row.remaining_basis_quote} / ${row.quantity}`)}</td><td>{exact(row.target_price, unitPrice)}</td><td>{mark ? <>{exact(mark.mark_quote, unitPrice)} · {at(mark.mark_at_ms, now)}</> : '—'}</td><td>{distance === null ? '—' : ownerValue(distance, 'pct', `(${row.target_price} − ${mark.mark_quote}) / ${mark.mark_quote} × 100`)}</td><td>{exact(row.remaining_target_amount, value => coinValue(value, asset(row)))}</td><td>{typeof order.order_id === 'string' ? `${order.order_id} · ${paperWords(order.state)}` : typeof order.state === 'string' ? `${paperWords(order.state)} · order ID not published` : 'Not published'}</td></tr>; })}</Table> : <p>No matching lot is published in this snapshot; a retained owner position would fill this table.</p>}
      <h3>Trade orders</h3>{selectedOrders?.length ? <Table headers={['Side', 'Price', 'Quantity', 'Order', 'Placed']}>{selectedOrders.map(row => <tr key={row.order_id}><td>{paperWords(row.side)}</td><td>{exact(row.price, unitPrice)}</td><td>{exact(row.quantity, value => coinValue(value, asset(row)))}</td><td>{row.order_id}</td><td>{at(row.created_at_ms, now)}</td></tr>)}</Table> : <p>{orders ? 'No open orders for this trade in the owner snapshot; a published matching order would appear here.' : 'Trade orders are unavailable; a complete orders snapshot will fill this table.'}</p>}
    </section>}
    {!selectedTrade && <p>Select a trade to see its fills, lots, orders and chart.</p>}
    </div>
  </div>;
}

export function V5Trades({ bot, now, read, readFailed, heartbeat }: { bot: string; now: number; read: Read; readFailed?: boolean; heartbeat: string }) {
  const query = usePaperSnapshot<PaperRead[]>(['v5-paper-trades', bot], true, 9, (progress, signal) => {
    const prefix = '/api/v1/servers/rsibot-v5/';
    const botPath = `${prefix}bots/${encodeURIComponent(bot)}/`;
    return paperCoherentRead(`${botPath}native/status`, [
      { section: 'executors', path: `${botPath}executors`, paginate: true },
      { section: 'fills', path: `${prefix}fleet/fills?limit=100`, paginate: true },
      { section: 'positions', path: `${prefix}fleet/holdings`, paginate: true },
      { section: 'decisions', path: `${botPath}decisions` },
      { section: 'wallet', path: `${prefix}fleet/summary` },
      { section: 'history', path: `${prefix}controller-performance/history?interval=5m&limit=200`, paginate: true, maxPages: 5 },
      { section: 'accounting', path: `${prefix}fleet/accounting` },
      { section: 'orders', path: `${botPath}orders`, paginate: true },
    ], (path, section) => read(path, section, signal), undefined, progress);
  });
  return <div>{query.progress && <p role="status">{query.progress}</p>}{query.isError && <p role="alert">Trades could not refresh: {query.error.message}</p>}{query.data ? <TradesContent reads={query.data} now={now} readFailed={readFailed || query.isError} heartbeat={heartbeat} /> : <p>Waiting for a coherent owner snapshot to show trades.</p>}</div>;
}
