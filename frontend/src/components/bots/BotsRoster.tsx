import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { BotsPageResponse } from '@/lib/api';
import { authFetch } from '@/lib/auth-token';
import { transientReadFailure } from '@/lib/read-continuity';
import { useServer } from '@/hooks/useServer';
import { useServers } from '@/hooks/useServers';
import { displayBotName, parseTradingVisualsSources, sourcesForServer, type TradingVisualsSource } from '@/features/trading-visuals/sources';
import { buildBotPositionView, mixedOperationalLabel, numeric, type BotPairPosition } from '@/features/bots/position-view';
import { formatSigned, metricTone } from '@/features/quant-ops/format';
import { Heatmap, Histogram, MetricCard, PanelFrame } from '@/features/quant-ops/primitives';
import { PriceLevels } from './NativeBotPositions';
import { BotDraftWizard } from './BotDraftWizard';
import '@/features/quant-ops/quant-ops.css';
import './bots-roster.css';

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
async function readOptional(path: string, signal: AbortSignal) {
  const response = await authFetch(path, { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), cache: 'no-store' });
  if (!response.ok) return null;
  return response.json();
}

function profileTags(bot: string, pairs: BotPairPosition[]) {
  const tags = ['Spot'];
  if (pairs.length > 1) tags.push('Multi-asset');
  if (bot.includes('sell_only') || bot.includes('sell-only')) tags.push('Sell-only');
  else tags.push('DCA');
  return tags;
}

function dcaLabel(bot: string, row: BotPairPosition) {
  if (bot.includes('sell_only') || bot.includes('sell-only')) return 'Not applicable — entry disabled';
  if (row.targetBase == null) return 'Observed stages only. No plan maximum.';
  return `${row.executors.length} working / plan max unavailable`;
}

function PairRow({ row, bot }: { row: BotPairPosition; bot: string }) {
  const working = row.executors.length || row.pendingSells?.length ? `${row.executors.length} executor · ${row.pendingSells?.length ?? 0} sell request` : 'None reported';
  return <tr>
    <th scope="row"><Link to={`/trading-visuals?bot=${encodeURIComponent(bot)}&pair=${encodeURIComponent(row.pair)}`}>{row.pair}</Link>{!row.uniquePair && <small> {row.controllerId || row.id}</small>}</th>
    <td>{stateLabel(row.phase)}</td>
    <td>{row.quantity === null ? 'Unavailable' : `${row.quantity} ${row.baseAsset}`}</td>
    <td>{row.breakeven == null ? 'Unavailable' : amount(row.breakeven, row.quote)}</td>
    <td>{amount(row.price, row.quote)}</td>
    <td>{amount(row.markValue, row.quote)}</td>
    <td>{amount(row.bagPnl, row.quote)}</td>
    <td>{dcaLabel(bot, row)}</td>
    <td>{row.planNext || row.reason || row.hold ? stateLabel(row.planNext || row.reason || row.hold) : 'Owner has not reported a next condition.'}</td>
    <td>{working}</td>
  </tr>;
}

/** All pair rows stay in page flow. Selecting a row never hides the rest. */
export function RosterObservation({ payload, bot, now, events, execution }: {
  payload: unknown; bot: string; now: number;
  events?: { data?: { decisions?: { pair?: string; action?: string; occurred_at?: string; linkage?: string }[] } } | null;
  execution?: { histogram?: { bins?: { from: number; to: number; count: number }[]; sample_count?: number; excluded_count?: number } } | null;
}) {
  let view;
  try { view = buildBotPositionView(payload, bot, now); }
  catch (error) { return <p className="q-empty" role="status">{error instanceof Error ? error.message : 'Bot state could not be read.'}</p>; }
  const completeOrders = view.orders !== null && view.ordersStatus.complete === true;
  const owned = view.pairs.every(row => row.markValue !== null) ? view.pairs.reduce((total, row) => total + row.markValue!, 0) : null;
  const quote = view.pairs[0]?.quote ?? 'USDC';
  const regimes = [...new Set(view.pairs.map(row => row.phase).filter(Boolean))] as string[];
  const openPairs = view.pairs.filter(row => row.quantity !== null && Number(row.quantity) !== 0).length;
  const ownerDecisions = events?.data?.decisions?.filter(row => row.action) ?? [];
  const decisions = ownerDecisions.length ? ownerDecisions.map(row => ({
    pair: row.pair || '—',
    action: String(row.action),
    when: row.occurred_at || view.observedAt,
    link: row.linkage || 'unlinked',
  })) : view.pairs.map(row => ({
    pair: row.pair,
    action: row.planNext || row.reason || row.hold || row.phase,
    when: view.observedAt,
    link: 'unlinked',
  }));
  const histogram = execution?.histogram?.sample_count ? execution.histogram.bins ?? [] : [];
  return <div className="q-bot-card">
    <div className="q-state-ribbon" data-panel-id="B11">
      <div><span>Regime</span><strong>{regimes.length > 1 ? `MIXED — ${mixedOperationalLabel(view.pairs)}` : stateLabel(regimes[0] ?? null)}</strong></div>
      <div><span>State</span><strong>{mixedOperationalLabel(view.pairs)}</strong></div>
      <div data-panel-id="B12"><span>Current position</span><strong>{amount(owned, quote)}</strong></div>
      <div data-panel-id="B13"><span>DCA progress</span><strong>{bot.includes('sell_only') || bot.includes('sell-only') ? 'N/A' : 'Plan max unavailable'}</strong></div>
      <div data-panel-id="B14"><span>Inventory age</span><strong>Unavailable</strong></div>
      <div data-panel-id="B15"><span>Profit capture</span><strong>Unavailable</strong></div>
      <div data-panel-id="B16"><span>Risk</span><strong>Unverified</strong></div>
    </div>
    <div className="q-bot-mid">
      <div data-panel-id="B17">
        <span className="q-muted">Marked inventory PnL</span>
        <p className={metricTone(view.pairs.every(row => row.bagPnl != null) ? view.pairs.reduce((sum, row) => sum + (row.bagPnl ?? 0), 0) : null) ? `q-${metricTone(view.pairs.every(row => row.bagPnl != null) ? view.pairs.reduce((sum, row) => sum + (row.bagPnl ?? 0), 0) : null)}` : undefined} style={{ fontSize: 22, fontWeight: 600 }}>
          {view.pairs.every(row => row.bagPnl != null) ? formatSigned(view.pairs.reduce((sum, row) => sum + (row.bagPnl ?? 0), 0)) : 'Unavailable'} {quote}
        </p>
        <p className="q-empty">Current marked snapshot by pair; no PnL history is admitted. Open-position PnL is not lifetime strategy profit. {openPairs} open pair{openPairs === 1 ? '' : 's'}.</p>
      </div>
      <div data-panel-id="B18">
        <span className="q-muted">Open vs closed trips</span>
        <p>Open {view.activeExecutorCount} · scored closed Unavailable</p>
        <p className="q-empty">Transfer-only closures are not losses. Win rate needs scored cycles.</p>
      </div>
      <div data-panel-id="B19">
        <span className="q-muted">Next action</span>
        <p>{view.pairs.find(row => row.planNext)?.planNext || 'Owner has not reported a next condition.'}</p>
        <p className="q-empty">A price threshold has no predicted execution time. Conditions are not working orders.</p>
      </div>
    </div>
    <div className="q-bot-cols">
      <PanelFrame panelId="B20" title="Recent decisions" scopeLabel="Unlinked owner observations">
        <table>
          <thead><tr><th>Time</th><th>Action</th><th>Pair</th></tr></thead>
          <tbody>
            {decisions.map(row => <tr key={`${row.pair}:${row.action}`}><td>{new Date(row.when).toISOString().slice(11, 16)} UTC</td><td>{stateLabel(String(row.action))}</td><td>{row.pair}</td></tr>)}
            {!decisions.length && <tr><td colSpan={3}>No decision journal is admitted.</td></tr>}
          </tbody>
        </table>
        <p className="q-empty">No timestamp-nearest fill join. Missing IDs stay {decisions.some(row => row.link === 'unlinked') ? 'unlinked' : 'owner-linked'}.</p>
      </PanelFrame>
      <PanelFrame panelId="B21" title="Execution quality" scopeLabel="Adverse slippage · bps">
        <Histogram bins={histogram} unit="bps" sampleCount={execution?.histogram?.sample_count ?? 0} excludedCount={execution?.histogram?.excluded_count ?? 0} />
      </PanelFrame>
      <PanelFrame panelId="B22" title="Bot diagnostics" scopeLabel="Each row has its own freshness">
        <ul className="q-diag">
          <li><span>Lifecycle</span><strong>{mixedOperationalLabel(view.pairs)}</strong></li>
          <li><span>Heartbeat</span><strong>{new Date(view.observedAt).toLocaleTimeString('en-GB', { timeZone: 'UTC' })} UTC</strong></li>
          <li><span>Working orders</span><strong>{completeOrders ? String(view.orders!.length) : 'Incomplete'}</strong></li>
          <li><span>Inventory</span><strong>{view.pairs.some(row => row.quantity === null) ? 'Partial' : 'Reported'}</strong></li>
          <li><span>Risk rails</span><strong>Unverified</strong></li>
        </ul>
      </PanelFrame>
    </div>
    <div className="q-table-wrap" data-panel-id="B12">
      <table>
        <caption>Per-pair inventory · {displayBotName(bot)}</caption>
        <thead><tr><th>Pair</th><th>State</th><th>Units</th><th>Entry</th><th>Mark</th><th>Marked value</th><th>Open-position PnL</th><th>DCA</th><th>Next condition</th><th>Working</th></tr></thead>
        <tbody>
          {view.pairs.map(row => <PairRow key={row.id} row={row} bot={bot}/>)}
          {!view.pairs.length && <tr><td colSpan={10}>No controller positions are included in this observation.</td></tr>}
        </tbody>
      </table>
    </div>
    {view.pairs.filter(row => row.price !== null).map(row => <PriceLevels key={`levels-${row.id}`} row={row}/>)}
    <section aria-label={`${bot} working orders`}>
      <h3>Working exchange orders</h3>
      {completeOrders ? view.orders!.length ? <ul>{view.orders!.map((order, index) => <li key={String(order.order_id ?? index)}>{String(order.pair ?? '')} {String(order.side ?? '')} {amount(order.remaining_amount_base ?? order.amount_base)}</li>)}</ul> : <p className="q-empty">No active orders in this owner observation.</p> : <p role="status" className="q-empty">Complete exchange order detail is unavailable. A reported limit-order count excludes market orders.</p>}
    </section>
    <details><summary>Source and accounting details</summary><p className="q-empty">Managed inventory combines open and closing executor net units and retained units. Tiny inventory stays in the pair table. Whole-account holdings stay in <Link to="/capital">Capital</Link>.</p></details>
  </div>;
}

function OwnerCard({ source, page, controls, logs }: { source: TradingVisualsSource; page?: BotsPageResponse; controls: ReactNode; logs: ReactNode }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const query = useQuery({
    queryKey: ['native-position-observation', source.server, source.bot],
    queryFn: async ({ signal }) => ({
      bootstrap: await read(`/api/v1/trading-visuals/bootstrap?bot=${encodeURIComponent(source.bot)}`, signal),
      events: await readOptional(`/api/v1/trading-visuals/quant-events?bot=${encodeURIComponent(source.bot)}`, signal),
      execution: await readOptional(`/api/v1/trading-visuals/quant-execution?bot=${encodeURIComponent(source.bot)}`, signal),
    }),
    refetchInterval: 10_000, retry: false,
  });
  const owner = page?.bots.find(item => item.bot_name === source.bot);
  let pairs: BotPairPosition[] = [];
  try { if (query.data?.bootstrap) pairs = buildBotPositionView(query.data.bootstrap, source.bot, Math.max(now, query.dataUpdatedAt)).pairs; } catch { pairs = []; }
  return <article className="q-card q-bot-card" aria-label={`${source.bot} roster card`}>
    <header className="q-bot-head" data-panel-id="B09">
      <div>
        <h2>{displayBotName(source.bot)}</h2>
        <p className="q-muted">{source.bot} · {source.server} · native-v2</p>
        <div className="q-tags">{profileTags(source.bot, pairs).map(tag => <span key={tag} className="q-tag">{tag}</span>)}</div>
      </div>
      <div className="q-chip-row">
        <span className="q-muted">{owner?.status ? stateLabel(owner.status) : 'Lifecycle unavailable'}</span>
        <button type="button" disabled title="Pause entries needs a verified native entry-control route. Process stop is a different operation and is not used here." data-panel-id="B10">Pause entries</button>
        <button type="button" disabled title="Settings shows effective configuration only after an owner schema inspector is enabled. Writes stay off.">Settings</button>
        {controls}
      </div>
    </header>
    {query.isPending ? <p className="q-empty" role="status">Reading bot positions and orders…</p> : query.isError ? <p className="q-empty" role="alert">{query.error.message} Retrying in the background. <button type="button" onClick={() => void query.refetch()}>Check now</button></p> : <RosterObservation payload={query.data?.bootstrap} bot={source.bot} now={Math.max(now, query.dataUpdatedAt)} events={query.data?.events} execution={query.data?.execution} />}
    {logs && <details><summary>Recent owner logs</summary>{logs}</details>}
  </article>;
}

export function BotsRoster({ page, renderControls, renderLogs }: { page?: BotsPageResponse; renderControls: (bot: string) => ReactNode; renderLogs: (bot: string) => ReactNode }) {
  const { server } = useServer();
  const servers = useServers();
  const [search, setSearch] = useState('');
  const [lifecycle, setLifecycle] = useState('all');
  const [draft, setDraft] = useState(false);
  const sources = useQuery({ queryKey: ['native-command-desk-sources'], queryFn: async ({ signal }) => parseTradingVisualsSources(await read('/api/v1/trading-visuals/sources', signal)), retry: false, refetchInterval: 30_000 });
  const visible = !sources.isError || transientReadFailure(sources.error) ? sources.data ?? [] : [];
  const scoped = sourcesForServer(visible, server, servers.data ?? []);
  const query = search.trim().toLowerCase();
  const filtered = scoped.filter(source => {
    if (query && !source.bot.toLowerCase().includes(query) && !displayBotName(source.bot).toLowerCase().includes(query)) return false;
    const owner = page?.bots.find(item => item.bot_name === source.bot);
    if (lifecycle === 'running') return owner?.status === 'running';
    if (lifecycle === 'stopped') return owner?.status === 'stopped';
    return true;
  });
  const verifiedRunning = scoped.filter(source => page?.bots.find(item => item.bot_name === source.bot)?.status === 'running').length;
  const quotes = new Set((page?.controllers ?? []).map(row => row.trading_pair?.split('-')[1]).filter(Boolean));
  const heatmapBots = scoped.map(source => displayBotName(source.bot));
  const heatmapSymbols = [...new Set((page?.controllers ?? []).map(row => row.trading_pair?.split('-')[0]).filter((value): value is string => Boolean(value)))];
  const heatmapCells = heatmapBots.flatMap(bot => heatmapSymbols.map(symbol => {
    const source = scoped.find(item => displayBotName(item.bot) === bot);
    const rows = (page?.controllers ?? []).filter(row => row.bot_name === source?.bot && row.trading_pair?.startsWith(`${symbol}-`));
    const values = rows.map(row => numeric(row.global_pnl_quote));
    return { row: bot, column: symbol, value: values.length && values.every(value => value != null) ? values.reduce((sum, value) => sum + value!, 0) : null };
  }));
  const comparison = scoped.map(source => {
    const rows = (page?.controllers ?? []).filter(row => row.bot_name === source.bot);
    const total = rows.length && rows.every(row => numeric(row.global_pnl_quote) != null) ? rows.reduce((sum, row) => sum + numeric(row.global_pnl_quote)!, 0) : null;
    return { bot: source.bot, total, quote: rows[0]?.trading_pair?.split('-')[1] ?? null };
  });
  return <div className="bot-roster" data-quant-ops="bots">
    <header className="q-page-head">
      <div>
        <p className="q-muted" data-panel-id="S01">RSIBOT · Modular V2 · Bots</p>
        <h1>Bots</h1>
        <p className="q-kicker" data-panel-id="S02">Live bot operations, decisions and performance. Per-bot PnL is never summed across a shared wallet.</p>
      </div>
      <div className="q-chip-row" data-panel-id="B06">
        <input className="q-search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search bots, pairs, incidents" aria-label="Search bots" data-panel-id="S04" />
        <select aria-label="Lifecycle filter" value={lifecycle} onChange={event => setLifecycle(event.target.value)}>
          <option value="all">All bots</option>
          <option value="running">Running</option>
          <option value="stopped">Stopped</option>
        </select>
        {(search || lifecycle !== 'all') && <button type="button" className="q-chip" onClick={() => { setSearch(''); setLifecycle('all'); }}>Reset</button>}
        <button type="button" className="q-chip" title="Display density, timezone and quote stay local. They never write controller parameters." data-panel-id="B07">Display</button>
        <button type="button" className="q-chip" onClick={() => setDraft(true)} title="New Bot prepares a local draft with execution_authorized=false. Live launch is a separate sealed deployment." data-panel-id="B08">+ New Bot</button>
      </div>
    </header>
    <section className="q-kpis" aria-label="Registered bots">
      <MetricCard panelId="B01" title="Active bots" value={`${verifiedRunning} / ${scoped.length}`} note="Verified running / registered. A configured bot is not automatically active." />
      <MetricCard panelId="B02" title="Total bot PnL" value="Unavailable" note={quotes.size > 1 || scoped.length > 1 ? 'Aggregate blocked: shared wallet or mixed quote. Per-bot results stay on each card.' : 'Need disjoint ownership proof before summing.'} />
      <MetricCard panelId="B03" title="Open positions" value="Unavailable" note="Position count is per card. Executors are not positions." />
      <MetricCard panelId="B04" title="Today's profit capture" value="Unavailable" note="Closed-cycle net today needs scored cycles and a midnight bound." />
      <MetricCard panelId="B05" title="Total trades" value="Unavailable" note="Filled orders, fills and scored cycles are separate counts." />
    </section>
    {sources.isError && <p role="alert" className="q-notice">{sources.error.message} <button type="button" onClick={() => void sources.refetch()}>Check now</button></p>}
    {sources.isPending && <p className="q-empty" role="status">Discovering authorized bot owners…</p>}
    {!sources.isPending && !filtered.length && <p className="q-empty" role="status">No authorized bot source is available for this selection.</p>}
    {draft && <BotDraftWizard bots={scoped.map(item => item.bot)} onClose={() => setDraft(false)} />}
    {filtered.map(source => <OwnerCard key={`${source.server}:${source.bot}`} source={source} page={page} controls={sources.isError ? null : renderControls(source.bot)} logs={renderLogs(source.bot)}/>)}
    <div className="q-compare">
      <PanelFrame panelId="B23" title="Bot PnL comparison" scopeLabel="Per-bot native results · not a portfolio sum">
        {quotes.size > 1 ? <p className="q-empty">Quote currencies differ. Comparison is blocked.</p> : <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>{comparison.map(row => <li key={row.bot}><strong>{displayBotName(row.bot)}</strong> <span className={metricTone(row.total) ? `q-${metricTone(row.total)}` : undefined}>{row.total == null ? 'Unavailable' : formatSigned(row.total)} {row.quote ?? ''}</span></li>)}</ul>}
      </PanelFrame>
      <PanelFrame panelId="B24" title="Controller PnL by symbol" scopeLabel="Current per-bot quote PnL; not account exposure">
        {quotes.size > 1 ? <p className="q-empty">Quote currencies differ. Controller PnL heatmap is unavailable.</p> : heatmapSymbols.length ? <Heatmap rows={heatmapBots} columns={heatmapSymbols} cells={heatmapCells} /> : <p className="q-empty">No controller symbols are admitted for a PnL heatmap.</p>}
      </PanelFrame>
    </div>
    <PanelFrame panelId="B25" title="Recorded behavior timeline" scopeLabel="Shared, compact, not a new tab">
      <p className="q-empty">No independent decision journal is admitted beyond the per-card observations above. HOLD/BLOCKED stay on those cards.</p>
    </PanelFrame>
    <footer className="q-footer" data-panel-id="S06"><span>{server ?? 'Server not selected'} · UTC</span><span><Link to="/capital">Open Capital</Link></span></footer>
  </div>;
}
