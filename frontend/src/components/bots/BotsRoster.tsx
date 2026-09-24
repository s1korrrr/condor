import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { BotsPageResponse } from '@/lib/api';
import { authFetch } from '@/lib/auth-token';
import { transientReadFailure } from '@/lib/read-continuity';
import { useServer } from '@/hooks/useServer';
import { useServers } from '@/hooks/useServers';
import { displayBotName, parseTradingVisualsSources, sourcesForServer, type TradingVisualsSource } from '@/features/trading-visuals/sources';
import { buildBotPositionView, mixedOperationalLabel, type BotPairPosition } from '@/features/bots/position-view';
import { projectQuantBotSummary, projectQuantExecution, projectRecordedDecisions } from '@/features/bots/quant-roster';
import { formatDecimal, formatSigned, metricTone } from '@/features/quant-ops/format';
import { Histogram, MetricCard, PanelFrame } from '@/features/quant-ops/primitives';
import { PriceLevels } from './NativeBotPositions';
import { BotDraftWizard } from './BotDraftWizard';
import '@/features/quant-ops/quant-ops.css';
import './bots-roster.css';

const amount = (value: unknown, unit: string | null = '') => {
  if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))) return 'Unavailable';
  const decimal = formatDecimal(value, 18);
  return decimal === 'Unavailable' ? decimal : `${decimal}${unit ? ` ${unit}` : ''}`;
};
const stateLabel = (value: string | null) => value?.replaceAll('_', ' ') || 'State unavailable';
async function read(path: string, signal: AbortSignal) {
  const response = await authFetch(path, { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), cache: 'no-store' });
  if (!response.ok) throw Object.assign(new Error(`Bot observation request failed (${response.status}).`), { status: response.status });
  return response.json();
}
async function readOptional(path: string, signal: AbortSignal) {
  try {
    const response = await authFetch(path, { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), cache: 'no-store' });
    if (!response.ok) return { payload: null, issue: response.status === 401 || response.status === 403 ? `Access denied (${response.status})` : response.status === 404 ? 'Endpoint unavailable (404)' : `Read failed (${response.status})` };
    return { payload: await response.json(), issue: null };
  } catch {
    return { payload: null, issue: 'Read unavailable' };
  }
}

function dcaLabel(row: BotPairPosition, reportedLevel?: string | null) {
  if (reportedLevel) return `Owner stage ${reportedLevel} · maximum unavailable`;
  if (row.targetBase !== null) return `Target ${row.targetBase} ${row.baseAsset} · maximum unavailable`;
  return 'Unavailable';
}

function PairRow({ row, bot, stage }: { row: BotPairPosition; bot: string; stage: string | null }) {
  const working = row.executors.length || row.pendingSells?.length ? `${row.executors.length} executor · ${row.pendingSells?.length ?? 0} sell request` : 'None reported';
  return <tr>
    <th scope="row"><Link to={`/trading-visuals?bot=${encodeURIComponent(bot)}&pair=${encodeURIComponent(row.pair)}`}>{row.pair}</Link>{!row.uniquePair && <small> {row.controllerId || row.id}</small>}</th>
    <td>{stateLabel(row.phase)}</td>
    <td>{row.quantity === null ? 'Unavailable' : `${row.quantity} ${row.baseAsset}`}</td>
    <td>{row.breakeven == null ? 'Unavailable' : amount(row.breakeven, row.quote)}</td>
    <td>{amount(row.price, row.quote)}</td>
    <td>{amount(row.markValue, row.quote)}</td>
    <td>{amount(row.bagPnl, row.quote)}</td>
    <td>{dcaLabel(row, stage)}</td>
    <td>{row.planNext || row.reason || row.hold ? stateLabel(row.planNext || row.reason || row.hold) : 'Owner has not reported a next condition.'}</td>
    <td>{working}</td>
  </tr>;
}

/** All pair rows stay in page flow. Selecting a row never hides the rest. */
export function RosterObservation({ payload, bot, now, summary: summaryPayload, events, execution, summaryIssue, eventsIssue, executionIssue }: {
  payload: unknown; bot: string; now: number;
  summary?: unknown;
  events?: unknown;
  execution?: unknown;
  summaryIssue?: string | null;
  eventsIssue?: string | null;
  executionIssue?: string | null;
}) {
  let view;
  try { view = buildBotPositionView(payload, bot, now); }
  catch (error) { return <p className="q-empty" role="status">{error instanceof Error ? error.message : 'Bot state could not be read.'}</p>; }
  const quant = projectQuantBotSummary(summaryPayload, bot, now);
  const decisions = projectRecordedDecisions(events, bot, now) ?? [];
  const executionQuality = projectQuantExecution(execution, bot);
  const completeOrders = view.orders !== null && view.ordersStatus.complete === true;
  const pairQuotes = new Set<string>(view.pairs.map(row => row.quote));
  const quote: string | null = pairQuotes.size === 1 ? [...pairQuotes][0] ?? null : null;
  const owned = view.pairs.length > 0 && quote !== null && view.pairs.every(row => row.markValue !== null)
    ? view.pairs.reduce((total, row) => total + row.markValue!, 0) : null;
  const regimes = [...new Set((quant?.pairs ?? []).map(row => row.regime).filter(Boolean))] as string[];
  const openPairs = view.pairs.filter(row => row.quantity !== null && formatDecimal(row.quantity, 18) !== '0').length;
  const dcaStages = quant?.pairs.map(row => row.dcaLevel ? `${row.pair}: ${row.dcaLevel}` : null).filter((value): value is string => value !== null) ?? [];
  const nextConditions = [...new Set<string>(view.pairs.flatMap((row: BotPairPosition) => typeof row.planNext === 'string' && row.planNext.length > 0 ? [row.planNext] : []))];
  const nextCondition: string = nextConditions.length > 1 ? 'MIXED · see per-pair conditions'
    : nextConditions[0] ?? 'No owner condition recorded; see per-pair rows.';
  const openExecutors = quant?.cycleCounts.open;
  const netReport = quant?.netLifecycle;
  const netValue = netReport?.value ?? null;
  const netUnit = netReport?.unit ?? null;
  const pairPnl = quote !== null && view.pairs.length > 0 && view.pairs.every(row => row.bagPnl !== null)
    ? view.pairs.reduce((total, row) => total + row.bagPnl!, 0) : null;
  return <div className="q-bot-card">
    <div className="q-state-ribbon" data-panel-id="B11">
      <div><span>Signal regime</span><strong>{quant?.freshness === 'current' ? regimes.length > 1 ? `MIXED · ${regimes.join(' / ')}` : regimes[0] ?? 'Unavailable' : 'Unavailable'}</strong></div>
      <div><span>State</span><strong>{mixedOperationalLabel(view.pairs)}</strong></div>
      <div data-panel-id="B12"><span>Reported inventory value</span><strong>{amount(quant?.ownedValue.value ?? owned, quote)}</strong></div>
      <div data-panel-id="B13"><span>Reported DCA stages</span><strong>{dcaStages.length ? `${dcaStages.length} pair${dcaStages.length === 1 ? '' : 's'} reporting · see inventory` : 'Unavailable · no plan maximum reported'}</strong></div>
      <div data-panel-id="B14"><span>Inventory age</span><strong>Unavailable</strong></div>
      <div data-panel-id="B15"><span>Profit capture</span><strong>Unavailable</strong></div>
      <div data-panel-id="B16"><span>Risk</span><strong>Unverified</strong></div>
    </div>
    <div className="q-bot-mid">
      <div data-panel-id="B17">
        <span className="q-muted">Current native net PnL report</span>
        <p className={metricTone(netValue) ? `q-${metricTone(netValue)}` : undefined} style={{ fontSize: 22, fontWeight: 600 }}>
          {netValue === null ? 'Unavailable' : formatSigned(netValue)} {netUnit ?? ''}
        </p>
        <p className="q-empty">Performance history requires a timestamped, comparable series.</p>
        <details className="q-source-details"><summary>Accounting and observation details</summary><p className="q-empty">{netReport?.feeBasis ? `Fee basis: ${netReport.feeBasis.replaceAll('_', ' ')}.` : 'Fee basis unavailable.'} Snapshot observed {netReport?.observedAt ?? quant?.observedAt ?? 'Unavailable'}. This is not a selected-period return or completed-cycle history. Open-position marked PnL: {pairPnl === null ? 'Unavailable' : amount(pairPnl, quote ?? '')}. {openPairs} open pair{openPairs === 1 ? '' : 's'}.</p></details>
      </div>
      <div data-panel-id="B18">
        <span className="q-muted">Current executor classifications</span>
        <p>Open {openExecutors ?? 'Unavailable'} · closed-scored {quant?.cycleCounts.closedScored ?? 'Unavailable'} · ownership transfers {quant?.cycleCounts.ownershipTransfer ?? 'Unavailable'} · unclassified {quant?.cycleCounts.unclassified ?? 'Unavailable'}</p>
        <p className="q-empty">These counts describe the current owner projection; they are not lifetime cycle totals or win-rate evidence.</p>
      </div>
      <div data-panel-id="B19">
        <span className="q-muted">Next action</span>
        <p>{nextCondition}</p>
        <p className="q-empty">Conditions remain per pair in the inventory table. A threshold has no predicted execution time and is not a working order.</p>
      </div>
    </div>
    <div className="q-bot-cols">
      <PanelFrame panelId="B20" title="Recorded decisions" scopeLabel={decisions.length ? 'Owner decision journal · stable IDs' : 'Decision journal unavailable'}>
        <table>
          <thead><tr><th>Time</th><th>Action</th><th>Pair</th><th>Reasons and gates</th><th>Evidence links</th></tr></thead>
          <tbody>
            {decisions.map(row => <tr key={`${row.ownerBootId}:${row.decisionId}`}><td>{new Date(row.occurredAt).toISOString().replace('T', ' ').slice(0, 19)} UTC</td><td>{stateLabel(row.action)}<small className="q-block">{row.decisionId} · {row.controllerId} · boot {row.ownerBootId}</small></td><td>{row.pair ?? 'Unavailable'}</td><td>{[...row.reasonCodes, ...row.gateResults.map(gate => [gate.name, gate.result].filter(Boolean).join(': ')).filter(Boolean)].join(' · ') || 'No reason or gate details recorded.'}</td><td>{row.linkage === 'owner' ? `Order IDs ${row.orderIds.join(', ') || '—'} · fill IDs ${row.fillIds.join(', ') || '—'}` : 'Unlinked · no owner order/fill IDs'}</td></tr>)}
            {!decisions.length && <tr><td colSpan={5}>No identity-validated recorded decision journal is available{eventsIssue ? ` (${eventsIssue})` : ''}. Current state and next conditions are shown above and are not decisions.</td></tr>}
          </tbody>
        </table>
        <p className="q-empty">Decision IDs and owner boot IDs define records. Missing order/fill links stay unlinked; no nearest-time join is used.</p>
      </PanelFrame>
      <PanelFrame panelId="B21" title="Execution quality" scopeLabel="Adverse slippage · bps">
        {executionQuality ? <><Histogram bins={executionQuality.bins} unit="bps" sampleCount={executionQuality.sampleCount} excludedCount={executionQuality.excludedCount} /><p className="q-empty">{executionQuality.paperExcluded} simulated fills excluded. Histogram uses fills with owner-recorded compatible benchmark prices.</p></> : <p className="q-empty">Unavailable · {executionIssue ?? 'no valid owner-scoped benchmark cohort'}.</p>}
      </PanelFrame>
      <PanelFrame panelId="B22" title="Bot diagnostics" scopeLabel="Each row has its own freshness">
        <ul className="q-diag">
          <li><span>Lifecycle</span><strong>{quant?.freshness === 'current' ? quant.state : 'Unavailable / stale'}</strong></li>
          <li><span>Owner heartbeat</span><strong>{quant?.observedAt ?? 'Unavailable'}</strong></li>
          <li><span>Quant summary</span><strong>{quant?.freshness ?? summaryIssue ?? 'Unavailable'}</strong></li>
          <li><span>Execution mode</span><strong>{quant?.executionMode ?? 'Unavailable'}</strong></li>
          <li><span>Ownership evidence</span><strong>{quant?.ownershipBasis ?? 'Unavailable'}</strong></li>
          <li><span>Working orders</span><strong>{completeOrders ? String(view.orders!.length) : 'Incomplete'}</strong></li>
          <li><span>Inventory</span><strong>{view.pairs.some(row => row.quantity === null) ? 'Partial' : 'Reported'}</strong></li>
          <li><span>Risk rails</span><strong>Unverified · policy revision unavailable</strong></li>
        </ul>
      </PanelFrame>
    </div>
    <div className="q-table-wrap" data-panel-id="B12">
      <table>
        <caption>Per-pair inventory · {displayBotName(bot)}</caption>
        <thead><tr><th>Pair</th><th>State</th><th>Units</th><th>Entry</th><th>Mark</th><th>Marked value</th><th>Open-position PnL</th><th>DCA</th><th>Next condition</th><th>Working</th></tr></thead>
        <tbody>
          {view.pairs.map(row => <PairRow key={row.id} row={row} bot={bot} stage={quant?.pairs.find(pair => pair.pair === row.pair && pair.controllerId === row.controllerId)?.dcaLevel ?? null}/>)}
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

function OwnerCard({ source, page, logs }: { source: TradingVisualsSource; page?: BotsPageResponse; logs: ReactNode }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const bootstrap = useQuery({
    queryKey: ['native-position-observation', source.server, source.bot],
    queryFn: ({ signal }) => read(`/api/v1/trading-visuals/bootstrap?bot=${encodeURIComponent(source.bot)}`, signal),
    refetchInterval: 10_000, retry: false,
  });
  const summary = useQuery({
    queryKey: ['native-quant-summary', source.server, source.bot],
    queryFn: ({ signal }) => readOptional(`/api/v1/trading-visuals/quant-summary?bot=${encodeURIComponent(source.bot)}`, signal),
    refetchInterval: 10_000, retry: false,
  });
  const events = useQuery({
    queryKey: ['native-quant-events', source.server, source.bot],
    queryFn: ({ signal }) => readOptional(`/api/v1/trading-visuals/quant-events?bot=${encodeURIComponent(source.bot)}`, signal),
    refetchInterval: 15_000, retry: false,
  });
  const execution = useQuery({
    queryKey: ['native-quant-execution', source.server, source.bot],
    queryFn: ({ signal }) => readOptional(`/api/v1/trading-visuals/quant-execution?bot=${encodeURIComponent(source.bot)}`, signal),
    refetchInterval: 30_000, retry: false,
  });
  const owner = page?.bots.find(item => item.bot_name === source.bot);
  const quant = projectQuantBotSummary(summary.data?.payload, source.bot, Math.max(now, summary.dataUpdatedAt));
  let pairs: BotPairPosition[] = [];
  try { if (bootstrap.data) pairs = buildBotPositionView(bootstrap.data, source.bot, Math.max(now, bootstrap.dataUpdatedAt)).pairs; } catch { pairs = []; }
  return <article className="q-card q-bot-card" aria-label={`${source.bot} roster card`}>
    <header className="q-bot-head" data-panel-id="B09">
      <div>
        <h2>{displayBotName(source.bot)}</h2>
        <p className="q-muted">{source.bot} · {source.server} · {quant?.executionMode ?? 'execution mode unavailable'} · {quant?.ownershipBasis ?? 'ownership basis unavailable'}</p>
        <div className="q-tags">
          {quant?.executionMode && <span className="q-tag">{quant.executionMode}</span>}
          {new Set(pairs.map(row => row.pair)).size > 1 && <span className="q-tag">Multi-pair · {new Set(pairs.map(row => row.pair)).size}</span>}
          <span className="q-tag">Profile unavailable</span><span className="q-tag">Version unavailable</span>
        </div>
      </div>
      <div className="q-chip-row">
        <span className="q-muted">{owner?.status ? `${stateLabel(owner.status)} · status ${owner.status_received_at ? new Date(owner.status_received_at * 1000).toISOString() : 'time unavailable'}` : 'Lifecycle unavailable'}</span>
        <button type="button" disabled title="Pause entries needs a verified native entry-control route. Process stop is a different operation and is not used here." data-panel-id="B10">Pause entries</button>
        <button type="button" disabled title="Settings shows effective configuration only after an owner schema inspector is enabled. Writes stay off.">Settings</button>
      </div>
    </header>
    {bootstrap.isPending ? <p className="q-empty" role="status">Reading the current bot inventory and order observation…</p> : bootstrap.isError ? <p className="q-empty" role="alert">{(bootstrap.error as Error & { status?: number }).status === 401 || (bootstrap.error as Error & { status?: number }).status === 403 ? `Owner read denied (${(bootstrap.error as Error & { status?: number }).status}).` : bootstrap.error.message} Cached inventory is withheld. <button type="button" onClick={() => void bootstrap.refetch()}>Check now</button></p> : <RosterObservation payload={bootstrap.data} summary={summary.data?.payload} bot={source.bot} now={Math.max(now, bootstrap.dataUpdatedAt)} events={events.data?.payload} execution={execution.data?.payload} summaryIssue={summary.data?.issue} eventsIssue={events.data?.issue} executionIssue={execution.data?.issue} />}
    {logs && <details><summary>Recent owner logs</summary>{logs}</details>}
  </article>;
}

export function BotsRoster({ page, renderLogs }: { page?: BotsPageResponse; renderControls?: (bot: string) => ReactNode; renderLogs: (bot: string) => ReactNode }) {
  const { server } = useServer();
  const servers = useServers();
  const [search, setSearch] = useState('');
  const [lifecycle, setLifecycle] = useState('all');
  const [compact, setCompact] = useState(false);
  const [draft, setDraft] = useState(false);
  const sources = useQuery({ queryKey: ['native-command-desk-sources'], queryFn: async ({ signal }) => parseTradingVisualsSources(await read('/api/v1/trading-visuals/sources', signal)), retry: false, refetchInterval: 30_000 });
  const visible = !sources.isError || transientReadFailure(sources.error) ? sources.data ?? [] : [];
  const scoped = sourcesForServer(visible, server, servers.data ?? []);
  const query = search.trim().toLowerCase();
  const filtered = scoped.filter(source => {
    const controllerMatches = (page?.controllers ?? []).some(row => row.bot_name === source.bot
      && [row.controller_id, row.controller_name, row.trading_pair].some(value => value?.toLowerCase().includes(query)));
    if (query && !source.bot.toLowerCase().includes(query) && !displayBotName(source.bot).toLowerCase().includes(query) && !controllerMatches) return false;
    const owner = page?.bots.find(item => item.bot_name === source.bot);
    if (lifecycle === 'running') return owner?.status === 'running';
    if (lifecycle === 'stopped') return owner?.status === 'stopped';
    return true;
  });
  const statusesKnown = !sources.isError && Boolean(page) && scoped.length > 0 && scoped.every(source => {
    const status = page?.bots.find(owner => owner.bot_name === source.bot)?.status;
    return status !== undefined && ['running', 'starting', 'stopping', 'stopped', 'exited'].includes(status);
  });
  const verifiedRunning = scoped.filter(source => page?.bots.find(item => item.bot_name === source.bot)?.status === 'running').length;
  return <div className={`bot-roster${compact ? ' bot-roster--compact' : ''}`} data-quant-ops="bots">
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
        <button type="button" className="q-chip" aria-pressed={compact} onClick={() => setCompact(value => !value)} title="Changes local display density only." data-panel-id="B07">{compact ? 'Comfortable density' : 'Compact density'}</button>
        <button type="button" className="q-chip" onClick={() => setDraft(true)} title="New Bot prepares a local draft with execution_authorized=false. Live launch is a separate sealed deployment." data-panel-id="B08">+ New Bot</button>
      </div>
    </header>
    <section className="q-kpis" aria-label="Registered bots">
      <MetricCard panelId="B01" title="Active bots" value={statusesKnown ? `${verifiedRunning} / ${scoped.length}` : 'Unavailable'} note="Verified running / registered. A configured bot is not automatically active." />
      <MetricCard panelId="B02" title="Total bot PnL" value="Unavailable" note={scoped.length > 1 ? 'Bots share the account; no disjoint capital allocation or common period is admitted.' : 'No owner-issued allocation and selected-period performance series are admitted.'} />
      <MetricCard panelId="B03" title="Open positions" value="Unavailable" note="Position count is per card. Executors are not positions." />
      <MetricCard panelId="B04" title="Today's profit capture" value="Unavailable" note="Closed-cycle net today needs scored cycles and a midnight bound." />
      <MetricCard panelId="B05" title="Total trades" value="Unavailable" note="Filled orders, fills and scored cycles are separate counts." />
    </section>
    {sources.isError && <p role="alert" className="q-notice">{sources.error.message} <button type="button" onClick={() => void sources.refetch()}>Check now</button></p>}
    {sources.isPending && <p className="q-empty" role="status">Discovering authorized bot owners…</p>}
    {!sources.isPending && !filtered.length && <p className="q-empty" role="status">No authorized bot source is available for this selection.</p>}
    {draft && <BotDraftWizard bots={scoped.map(item => item.bot)} onClose={() => setDraft(false)} />}
    {filtered.map(source => <OwnerCard key={`${source.server}:${source.bot}`} source={source} page={page} logs={renderLogs(source.bot)}/>)}
    <div className="q-compare">
      <PanelFrame panelId="B23" title="Comparable bot PnL" scopeLabel="Common window, currency and allocation required">
        <p className="q-empty">Unavailable · controller snapshots have no admitted common selected-period series or disjoint capital allocation. Current per-bot owner reports remain on each card and are not added here.</p>
      </PanelFrame>
      <PanelFrame panelId="B24" title="Symbol exposure heatmap" scopeLabel="Uniquely owned marked value required">
        <p className="q-empty">Unavailable · the roster summary does not provide a complete per-bot ownership matrix for every symbol. Controller PnL is not exposure.</p>
      </PanelFrame>
    </div>
    <PanelFrame panelId="B25" title="Recorded behavior timeline" scopeLabel="Shared, compact, not a new tab">
      <p className="q-empty">No independent decision journal is admitted beyond the per-card observations above. HOLD/BLOCKED stay on those cards.</p>
    </PanelFrame>
    <footer className="q-footer" data-panel-id="S06"><span>{server ?? 'Server not selected'} · UTC</span><span><Link to="/capital">Open Capital</Link></span></footer>
  </div>;
}
