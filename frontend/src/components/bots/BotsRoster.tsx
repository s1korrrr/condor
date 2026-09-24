import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { BotsPageResponse } from '@/lib/api';
import { authFetch } from '@/lib/auth-token';
import { transientReadFailure } from '@/lib/read-continuity';
import { useServer } from '@/hooks/useServer';
import { useServers } from '@/hooks/useServers';
import { displayBotName, parseTradingVisualsSources, sourcesForServer, type TradingVisualsSource } from '@/features/trading-visuals/sources';
import { buildBotPositionView, mixedOperationalLabel, type BotPairPosition } from '@/features/bots/position-view';
import { projectExecutionStats, projectLifecycleDecisions, projectQuantBotSummary, projectQuantCycles, projectQuantExecution, projectRecordedDecisions, type ExecutionStats, type LifecycleDecision, type QuantBotSummary, type QuantCycles } from '@/features/bots/quant-roster';
import { ASSET_COLORS, formatDecimal, formatSigned, metricTone } from '@/features/quant-ops/format';
import { Funnel, Heatmap, Histogram, MetricCard, MultiLine, PanelFrame, RailBar, Sparkline, StateGlyph } from '@/features/quant-ops/primitives';
import type { PanelState } from '@/features/quant-ops/panel-state';
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
const ageLabel = (seconds: number | null | undefined) => seconds == null ? 'Unavailable' : seconds < 3600 ? `${Math.round(seconds / 60)}m` : seconds < 86400 ? `${(seconds / 3600).toFixed(1)}h` : `${(seconds / 86400).toFixed(1)}d`;
const stamp = (iso: string | null | undefined) => iso ? `${iso.replace('T', ' ').slice(0, 19)} UTC` : '—';
const tone = (value: string | null | undefined) => (value ?? 'unknown').toLowerCase().split(/[\s:]/)[0];
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

/** Saved native PnL points for one window, as the durable observer stored them. */
type PnlSeries = { points: { time: number; value: number | null; owner: number }[]; quote: string | null; change: number | null; reason: string | null };
function pnlSeries(payload: unknown, bot: string, now: number): PnlSeries {
  const empty = (reason: string): PnlSeries => ({ points: [], quote: null, change: null, reason });
  if (!payload || typeof payload !== 'object') return empty('Performance history requires a timestamped, comparable series.');
  const data = payload as { source?: unknown; bot_name?: unknown; points?: unknown; truncated?: unknown };
  if (data.source !== 'native_mqtt_observer' || data.bot_name !== bot || !Array.isArray(data.points)) return empty('Performance history identity is invalid.');
  if (!data.points.length) return empty('Performance history requires a timestamped, comparable series. Recording begins with the first verified native report.');
  const points: PnlSeries['points'] = [];
  let owner = 0, previous: { timestamp: number; identity: string; segment: string; quote: string } | null = null, quote: string | null = null, gap = false;
  for (const raw of data.points) {
    const row = raw as { timestamp: number; identity: string; segment: string; quote: string; total_pnl_quote: string };
    const value = Number(row.total_pnl_quote);
    if (!Number.isFinite(row.timestamp) || row.timestamp * 1000 > now + 5_000 || !Number.isFinite(value) || typeof row.quote !== 'string' || (quote && quote !== row.quote) || (previous && row.timestamp <= previous.timestamp)) return empty('Performance history contains incompatible observations.');
    quote = row.quote;
    if (previous && (previous.segment !== row.segment || previous.identity !== row.identity || row.timestamp - previous.timestamp > 90)) { points.push({ time: previous.timestamp * 1000 + 1, value: null, owner }); gap = true; }
    if (previous && previous.identity !== row.identity) owner += 1;
    points.push({ time: row.timestamp * 1000, value, owner });
    previous = row;
  }
  // Window change = sum of within-owner changes. Sampling gaps keep the line broken but contribute nothing; owner boundaries contribute nothing.
  void gap;
  let change: number | null = null;
  if (points.length > 1 && data.truncated !== true) {
    change = 0;
    let runStart: { value: number; owner: number } | null = null, runLast: { value: number; owner: number } | null = null;
    for (const point of points) {
      if (point.value == null) continue;
      if (!runStart || runStart.owner !== point.owner) { if (runStart && runLast) change += runLast.value - runStart.value; runStart = { value: point.value, owner: point.owner }; }
      runLast = { value: point.value, owner: point.owner };
    }
    if (runStart && runLast) change += runLast.value - runStart.value;
  }
  return { points, quote, change, reason: null };
}

function dcaLabel(row: BotPairPosition, reportedLevel?: string | null) {
  if (reportedLevel) return `Owner stage ${reportedLevel}`;
  if (row.targetBase !== null) return `Target ${row.targetBase} ${row.baseAsset}`;
  return 'No plan stage reported';
}

function PairRow({ row, bot, quantPair }: { row: BotPairPosition; bot: string; quantPair: QuantBotSummary['pairs'][number] | null }) {
  const working = row.executors.length || row.pendingSells?.length ? `${row.executors.length} executor · ${row.pendingSells?.length ?? 0} sell request` : 'None reported';
  return <tr>
    <th scope="row"><Link to={`/trading-visuals?bot=${encodeURIComponent(bot)}&pair=${encodeURIComponent(row.pair)}`}>{row.pair}</Link>{!row.uniquePair && <small> {row.controllerId || row.id}</small>}</th>
    <td><span className="q-pill" data-tone={tone(row.phase)}>{stateLabel(row.phase)}</span></td>
    <td>{row.quantity === null ? 'Unavailable' : `${row.quantity} ${row.baseAsset}`}</td>
    <td>{row.breakeven == null ? (row.quantity === '0' ? '—' : 'Unknown basis') : amount(row.breakeven, row.quote)}</td>
    <td>{amount(row.price, row.quote)}</td>
    <td>{amount(row.markValue, row.quote)}</td>
    <td className={metricTone(row.bagPnl) ? `q-${metricTone(row.bagPnl)}` : undefined}>{row.bagPnl == null ? (row.quantity === '0' ? '—' : 'Unknown basis') : amount(row.bagPnl, row.quote)}</td>
    <td>{dcaLabel(row, quantPair?.dcaLevel)}{quantPair?.planMode && <small className="q-block">{quantPair.planMode} · target {quantPair.planTarget ?? '—'} · {quantPair.execs ?? ''}</small>}</td>
    <td>{row.planNext || row.reason || row.hold ? stateLabel(row.planNext || row.reason || row.hold) : 'Owner has not reported a next condition.'}{quantPair?.gate && quantPair.gate !== 'ready' && <small className="q-block">gate: {quantPair.gate}</small>}</td>
    <td>{working}</td>
  </tr>;
}

/** Native controller-report total for one bot (active executors + retained positions), the scope Capital and the saved series use. */
function controllerNet(page: BotsPageResponse | undefined, bot: string): { total: number | null; realized: number | null; unrealized: number | null; quote: string | null } {
  const rows = (page?.controllers ?? []).filter(row => row.bot_name === bot);
  const quotes = new Set(rows.map(row => typeof row.trading_pair === 'string' ? row.trading_pair.split('-')[1] : ''));
  const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const sum = (key: 'global_pnl_quote' | 'realized_pnl_quote' | 'unrealized_pnl_quote') => rows.length && rows.every(row => finite(row[key]) !== null) ? rows.reduce((total, row) => total + (row[key] as number), 0) : null;
  const usable = rows.length > 0 && quotes.size === 1;
  return { total: usable ? sum('global_pnl_quote') : null, realized: usable ? sum('realized_pnl_quote') : null, unrealized: usable ? sum('unrealized_pnl_quote') : null, quote: usable ? [...quotes][0] : null };
}

export type OwnerReads = {
  bot: string; server: string; status: string | null; view: ReturnType<typeof buildBotPositionView> | null;
  controller: { total: number | null; realized: number | null; unrealized: number | null; quote: string | null };
  quant: QuantBotSummary | null; cycles: QuantCycles | null; execution: ExecutionStats | null; decisions: LifecycleDecision[];
  day: PnlSeries; week: PnlSeries;
};

/** All pair rows stay in page flow. Selecting a row never hides the rest. */
export function RosterObservation({ payload, bot, now, summary: summaryPayload, events, execution, cycles: cyclesPayload, day, week, controllerTotal = null, controllerQuote = null, summaryIssue, eventsIssue, executionIssue }: {
  payload: unknown; bot: string; now: number; controllerTotal?: number | null; controllerQuote?: string | null;
  summary?: unknown; events?: unknown; execution?: unknown; cycles?: unknown;
  day?: PnlSeries; week?: PnlSeries;
  summaryIssue?: string | null; eventsIssue?: string | null; executionIssue?: string | null;
}) {
  let view;
  try { view = buildBotPositionView(payload, bot, now, { allowStale: true }); }
  catch (error) { return <p className="q-empty" role="status">{error instanceof Error ? error.message : 'Bot state could not be read.'}</p>; }
  const quant = projectQuantBotSummary(summaryPayload, bot, now);
  const journal = projectRecordedDecisions(events, bot, now) ?? [];
  const lifecycle = projectLifecycleDecisions(events, bot, now) ?? [];
  const histogram = projectQuantExecution(execution, bot);
  const stats = projectExecutionStats(execution, bot);
  const cycles = projectQuantCycles(cyclesPayload, bot);
  const completeOrders = view.orders !== null && view.ordersStatus.complete === true;
  const pairQuotes = new Set<string>(view.pairs.map(row => row.quote));
  const quote: string | null = pairQuotes.size === 1 ? [...pairQuotes][0] ?? null : null;
  const owned = view.pairs.length > 0 && quote !== null && view.pairs.every(row => row.markValue !== null) ? view.pairs.reduce((total, row) => total + row.markValue!, 0) : null;
  const regimes = [...new Set((quant?.pairs ?? []).map(row => row.regime).filter(Boolean))] as string[];
  const openPairs = view.pairs.filter(row => row.quantity !== null && formatDecimal(row.quantity, 18) !== '0').length;
  const entryPairs = (quant?.pairs ?? []).filter(row => row.planMode === 'ENTRIES').length;
  const exitPairs = (quant?.pairs ?? []).filter(row => row.planMode === 'EXITS').length;
  const nextConditions = [...new Set<string>(view.pairs.flatMap((row: BotPairPosition) => typeof row.planNext === 'string' && row.planNext.length > 0 ? [row.planNext] : []))];
  const nextCondition: string = nextConditions.length > 1 ? 'MIXED · see per-pair conditions' : nextConditions[0] ?? 'No owner condition recorded; see per-pair rows.';
  const netReport = quant?.netLifecycle;
  const netValue = netReport?.value ?? netReport?.lastKnown ?? null;
  const netUnit = netReport?.unit ?? null;
  const pairPnl = quote !== null && view.pairs.length > 0 && view.pairs.every(row => row.bagPnl !== null) ? view.pairs.reduce((total, row) => total + row.bagPnl!, 0) : null;
  const dayPoints = (day?.points ?? []).map(point => point.value).filter((value): value is number => value != null);
  const trailing = view.pairs.flatMap(row => row.executors.map(executor => ({ pair: row.pair, activation: Number(executor.distance_to_trailing_activation_pct), trigger: Number(executor.distance_to_trailing_trigger_pct), state: typeof executor.trailing_state === 'string' ? executor.trailing_state : null })).filter(item => Number.isFinite(item.activation) || Number.isFinite(item.trigger)));
  const nearest = trailing.filter(item => Number.isFinite(item.activation)).sort((a, b) => a.activation - b.activation)[0] ?? null;
  const tightest = quant?.riskRails.tightest ?? null;
  const cycleState: PanelState = !cycles ? { kind: 'unavailable', reason: 'Cycle projection not readable.' } : cycles.stats.scored < cycles.stats.minSample ? { kind: 'collecting', sample: { have: cycles.stats.scored, need: cycles.stats.minSample }, reason: 'Scored closed cycles' } : { kind: 'fresh' };
  const decisionRows = journal.length ? journal.map(row => ({ key: `${row.ownerBootId}:${row.decisionId}`, at: row.occurredAt, action: row.action, id: `${row.decisionId.slice(0, 12)} · ${row.controllerId} · boot ${row.ownerBootId.slice(0, 8)}`, pair: row.pair, reasons: [...row.reasonCodes, ...row.gateResults.map(gate => [gate.name, gate.result].filter(Boolean).join(': ')).filter(Boolean)].join(' · '), links: row.linkage === 'owner' ? `Order IDs ${row.orderIds.join(', ') || '—'} · fill IDs ${row.fillIds.join(', ') || '—'}` : 'Unlinked · no owner order/fill IDs', outcome: null as string | null }))
    : lifecycle.map(row => ({ key: row.decisionId, at: row.occurredAt, action: row.action, id: `executor ${row.executorId.slice(0, 10)}…`, pair: row.pair, reasons: [...row.reasonCodes, row.decisionPrice ? `decision price ${row.decisionPrice}` : '', row.netPnl ? `net ${formatSigned(row.netPnl)}` : ''].filter(Boolean).join(' · '), links: row.linkage === 'owner' ? `${row.orderIds.length} order ID${row.orderIds.length === 1 ? '' : 's'} · ${row.fillIds.length ? `fill IDs ${row.fillIds.join(', ')}` : 'no fill'}` : 'Unlinked · no owner order IDs', outcome: row.outcome }));
  const staleBanner = view.stale ? <p className="q-notice" role="status" data-state="stale"><StateGlyph state={{ kind: 'stale', observedAt: view.observedAt, reason: 'Owner observation is not current' }} /> Owner observation is not current: last published {stamp(view.observedAt)} · {ageLabel(view.ageSeconds)} ago. Every value on this card is that last observation; nothing below is live.</p> : null;
  return <div className="q-bot-card" data-state={view.stale ? 'stale' : 'fresh'}>
    {staleBanner}
    <div className="q-state-ribbon" data-panel-id="B11">
      <div><span>Signal regime</span><strong>{regimes.length ? <span className="q-pill" data-tone={tone(regimes.length > 1 ? 'mixed' : regimes[0])}>{regimes.length > 1 ? `MIXED · ${regimes.join(' / ')}` : regimes[0]}</span> : 'Not reported'}{quant?.lastKnown && <small className="q-block">last known</small>}</strong></div>
      <div><span>State</span><strong><span className="q-pill" data-tone={tone(mixedOperationalLabel(view.pairs))}>{mixedOperationalLabel(view.pairs)}</span></strong></div>
      <div data-panel-id="B12"><span>Reported inventory value</span><strong>{amount(quant?.ownedValue.value ?? owned, quote)}</strong><small className="q-block">{openPairs} open pair{openPairs === 1 ? '' : 's'} · marked PnL {pairPnl === null ? 'Unknown basis' : amount(pairPnl, quote ?? '')}</small></div>
      <div data-panel-id="B13"><span>DCA plan</span><strong>{quant?.pairs.length ? `${entryPairs} entering · ${exitPairs} exiting` : 'No plan reported'}</strong><small className="q-block">{quant?.pairs.length ? 'Per-pair target, anchor and next step in the ladder below' : 'Owner plan fields absent from this observation'}</small></div>
      <div data-panel-id="B14"><span>Inventory age</span><strong>{cycles?.inventoryAge.availability === 'available' ? `${ageLabel(cycles.inventoryAge.oldestSeconds)} oldest` : cycles ? 'No open lots' : 'Not readable'}</strong><small className="q-block">{cycles?.inventoryAge.availability === 'available' ? `value-weighted ${ageLabel(cycles.inventoryAge.weightedSeconds)} · ${cycles.inventoryAge.lots.length} lot${cycles.inventoryAge.lots.length === 1 ? '' : 's'} · from native fill times` : cycles?.inventoryAge.reason ?? 'Cycle projection not readable'}</small></div>
      <div data-panel-id="B15"><span>Trailing arm distance</span><strong>{nearest ? `${nearest.pair} ${(nearest.activation * 100).toFixed(2)}%` : trailing.length ? 'Armed' : 'No trailing executor'}</strong><small className="q-block">{nearest ? `to trailing activation · ${nearest.state ?? 'state unavailable'}` : 'Profit capture needs a marked intracycle path; the owner records only the trailing state.'}</small></div>
      <div data-panel-id="B16"><span>Risk rail use</span><strong>{tightest && tightest.limit ? `${((tightest.utilization ?? 0) * 100).toFixed(1)}% of ${formatDecimal(tightest.limit)} ${tightest.unit ?? ''}` : quant ? 'No rail with a limit' : 'Not readable'}</strong><small className="q-block">{tightest ? `${tightest.name.replaceAll('_', ' ')} · ${tightest.state} · ${tightest.source ?? ''}` : 'Owner publishes no daily-loss rail'}</small></div>
    </div>
    <div className="q-bot-mid">
      <div data-panel-id="B17">
        <span className="q-muted">Native net PnL · controller report · 24h saved series</span>
        <p className={metricTone(controllerTotal ?? netValue) ? `q-${metricTone(controllerTotal ?? netValue)}` : undefined} style={{ fontSize: 22, fontWeight: 600 }}>
          {(controllerTotal ?? netValue) === null ? 'Unavailable' : formatSigned(controllerTotal ?? netValue)} {controllerQuote ?? netUnit ?? ''}
          {day?.change != null && <small className={`q-kpi-delta${metricTone(day.change) ? ` q-${metricTone(day.change)}` : ''}`} style={{ marginLeft: 8 }}>{formatSigned(day.change)} 24h</small>}
        </p>
        {dayPoints.length >= 2 ? <Sparkline points={dayPoints.slice(-60)} positive={(day?.change ?? 0) >= 0} /> : <p className="q-empty">{day?.reason ?? 'Performance history requires a timestamped, comparable series.'}</p>}
        <details className="q-source-details"><summary>Accounting and observation details</summary><p className="q-empty">{netReport?.feeBasis ? `Fee basis: ${netReport.feeBasis.replaceAll('_', ' ')}.` : 'Fee basis unavailable.'} Retained-position net (reporting summary): {netValue === null ? 'Unavailable' : `${formatSigned(netValue)} ${netUnit ?? ''}`}. Snapshot observed {netReport?.observedAt ?? quant?.observedAt ?? 'Unavailable'}. 7d change {week?.change == null ? 'needs an unbroken saved week' : `${formatSigned(week.change)} ${week.quote ?? ''}`}. Open-position marked PnL: {pairPnl === null ? 'Unknown basis' : amount(pairPnl, quote ?? '')}.</p></details>
      </div>
      <div data-panel-id="B18">
        <span className="q-muted">Cycles <StateGlyph state={cycleState} /></span>
        {cycles ? <>
          <div className="q-stacked" role="img" aria-label="Cycle outcomes" style={{ marginTop: 6 }}>{(() => { const total = Object.values(cycles.counts).reduce((sum, value) => sum + value, 0) || 1; const colors: Record<string, string> = { open: 'var(--q-blue)', closed_scored: 'var(--q-positive)', ownership_transfer: 'var(--q-violet)', entry_pending: 'var(--q-cyan)', entry_unfilled: 'var(--q-neutral)', unclassified: 'var(--q-warning)' }; return Object.entries(cycles.counts).filter(([, count]) => count > 0).map(([key, count]) => <span key={key} style={{ width: `${(count / total) * 100}%`, background: colors[key] ?? 'var(--q-neutral)' }} title={`${key.replaceAll('_', ' ')} ${count}`} />); })()}</div>
          <p>{Object.entries(cycles.counts).map(([key, count]) => `${key.replaceAll('_', ' ')} ${count}`).join(' · ')}</p>
          <p className="q-empty">{cycles.stats.scored} scored · {cycles.stats.wins}W / {cycles.stats.losses}L{cycles.stats.winRate != null ? ` · win rate ${(cycles.stats.winRate * 100).toFixed(1)}%` : ''}{cycles.stats.expectancy ? ` · expectancy ${formatSigned(cycles.stats.expectancy)}` : ''} · {cycles.stats.fillCount} fills. Transfers and unfilled entries are never wins or losses.</p>
        </> : <p className="q-empty">Cycle projection is not readable for this owner.</p>}
      </div>
      <div data-panel-id="B19">
        <span className="q-muted">Next condition</span>
        <p>{nextCondition}</p>
        <p className="q-empty">Conditions remain per pair in the inventory table. A threshold has no predicted execution time and is not a working order.</p>
      </div>
    </div>
    <div className="q-bot-cols">
      <PanelFrame panelId="B20" title="Recorded decisions" scopeLabel={journal.length ? 'Owner decision journal · stable IDs' : lifecycle.length ? 'Derived from executor lifecycle · ID-linked orders and fills' : 'Decision journal unavailable'} state={journal.length ? { kind: 'fresh' } : lifecycle.length ? { kind: 'incomplete', reason: 'No owner decision journal; entries and exits are reconstructed from executor rows linked by IDs. HOLD/BLOCKED live in the per-pair gates.' } : { kind: 'unavailable', reason: eventsIssue ?? 'No journal and no lifecycle rows.' }}>
        <div className="q-table-scroll"><table>
          <thead><tr><th>Time</th><th>Action</th><th>Pair</th><th>Reasons and gates</th><th>Evidence links</th></tr></thead>
          <tbody>
            {decisionRows.slice(0, 8).map(row => <tr key={row.key}><td>{stamp(row.at)}</td><td><span className="q-pill" data-tone={row.action === 'BUY' ? 'holding' : row.action === 'CANCEL' ? 'flat' : row.action === 'TRANSFER' ? 'neutral' : 'building'}>{stateLabel(row.action)}</span>{row.outcome && <small className="q-block">{row.outcome}</small>}<small className="q-block" title={row.key}>{row.id}</small></td><td>{row.pair ?? 'Unavailable'}</td><td>{row.reasons || 'No reason or gate details recorded.'}</td><td>{row.links}</td></tr>)}
            {!decisionRows.length && <tr><td colSpan={5}>No identity-validated recorded decision journal is available{eventsIssue ? ` (${eventsIssue})` : ''}. Current state and next conditions are shown above and are not decisions.</td></tr>}
          </tbody>
        </table></div>
        <p className="q-empty">Decision IDs and owner boot IDs define journal records; lifecycle records use executor IDs. Missing order/fill links stay unlinked; no nearest-time join is used.</p>
      </PanelFrame>
      <PanelFrame panelId="B21" title="Execution quality" scopeLabel={stats?.benchmarkBasis ?? 'Adverse slippage · bps'} state={histogram ? (stats && stats.sampleCount < stats.minSample ? { kind: 'collecting', sample: { have: stats.sampleCount, need: stats.minSample }, reason: 'Benchmarked fills' } : { kind: 'fresh' }) : stats ? { kind: 'collecting', sample: { have: stats.sampleCount, need: stats.minSample }, reason: `Benchmarked fills · excluded ${Object.entries(stats.excludedReasons).map(([key, count]) => `${count} ${key.toLowerCase().replaceAll('_', ' ')}`).join(', ') || 'none'}` } : { kind: 'unavailable', reason: executionIssue ?? 'no valid owner-scoped benchmark cohort' }}>
        {histogram ? <><Histogram bins={histogram.bins} unit="bps" sampleCount={histogram.sampleCount} excludedCount={histogram.excludedCount} /><p className="q-empty">{histogram.paperExcluded} simulated fills excluded. Mean {stats?.meanBps ?? '—'} bps · median {stats?.medianBps ?? '—'} bps.</p></> : <p className="q-empty">Slippage histogram waits for fills with owner-recorded decision marks{stats ? ` (${stats.sampleCount}/${stats.minSample})` : ''}.</p>}
        {stats && <ul className="q-diag" style={{ marginTop: 8 }}>
          <li><span>Fill ratio</span><strong>{stats.fillRatio == null ? '—' : `${(stats.fillRatio * 100).toFixed(1)}%`}{!stats.orderSampleSufficient && <small> · n&lt;{stats.minSample}</small>}</strong></li>
          <li><span>Cancel / reject</span><strong>{stats.cancelRate == null ? '—' : `${(stats.cancelRate * 100).toFixed(1)}%`} / {stats.rejectRate == null ? '—' : `${(stats.rejectRate * 100).toFixed(1)}%`}</strong></li>
          <li><span>Median decision→fill</span><strong>{stats.latencyMedianSeconds == null ? '—' : `${stats.latencyMedianSeconds.toFixed(1)}s`} <small>n={stats.latencySamples}</small></strong></li>
          <li><span>Maker / taker</span><strong>{stats.makerCount ?? '—'} / {stats.takerCount ?? '—'}</strong></li>
        </ul>}
      </PanelFrame>
      <PanelFrame panelId="B22" title="Bot diagnostics" scopeLabel="Each row has its own freshness">
        <ul className="q-diag">
          <li><span>Lifecycle</span><strong>{quant?.freshness === 'current' ? quant.state : quant?.lastKnown ? `${quant.state} · stale` : 'Unavailable / stale'}</strong></li>
          <li><span>Owner heartbeat</span><strong>{quant?.observedAt ?? 'Unavailable'}</strong></li>
          <li><span>Quant summary</span><strong>{quant?.freshness ?? summaryIssue ?? 'Unavailable'}</strong></li>
          <li><span>Execution mode</span><strong>{quant?.executionMode ?? 'Unavailable'}</strong></li>
          <li><span>Ownership evidence</span><strong>{quant?.ownershipBasis ?? 'Unavailable'}</strong></li>
          <li><span>Working orders</span><strong>{completeOrders ? String(view.orders!.length) : 'Incomplete'}</strong></li>
          <li><span>Inventory</span><strong>{view.stale ? `Last known · ${ageLabel(view.ageSeconds)} ago` : view.pairs.some(row => row.quantity === null) ? 'Partial' : 'Reported'}</strong></li>
          <li><span>Risk rails</span><strong>{quant?.riskRails.availability === 'available' ? `${quant.riskRails.rails.filter(rail => rail.limit !== null).length} published · ${quant.riskRails.rails.filter(rail => rail.state === 'absent').length} absent` : 'None published'}</strong></li>
          <li><span>Wallet valuation</span><strong>{quant?.wallet?.availability === 'available' ? `${quant.wallet.currency} declared` : quant?.wallet?.reason?.replaceAll('_', ' ').toLowerCase() ?? 'Unavailable'}</strong></li>
        </ul>
        {quant?.riskRails.rails.map(rail => <RailBar key={rail.name} name={rail.name} used={rail.used} limit={rail.limit} unit={rail.unit} state={rail.state} utilization={rail.utilization} />)}
      </PanelFrame>
    </div>
    <div className="q-table-wrap" data-panel-id="B12-pairs">
      <table>
        <caption>Per-pair inventory · {displayBotName(bot)}</caption>
        <thead><tr><th>Pair</th><th>State</th><th>Units</th><th>Entry</th><th>Mark</th><th>Marked value</th><th>Open-position PnL</th><th>DCA</th><th>Next condition</th><th>Working</th></tr></thead>
        <tbody>
          {view.pairs.map(row => <PairRow key={row.id} row={row} bot={bot} quantPair={quant?.pairs.find(pair => pair.pair === row.pair && (pair.controllerId === row.controllerId || !pair.controllerId)) ?? null}/>)}
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

function useOwnerReads(source: TradingVisualsSource, page: BotsPageResponse | undefined, now: number): { reads: OwnerReads; raw: { bootstrap: ReturnType<typeof useQuery>; summary: { payload: unknown; issue: string | null } | undefined; events: { payload: unknown; issue: string | null } | undefined; execution: { payload: unknown; issue: string | null } | undefined; cycles: { payload: unknown; issue: string | null } | undefined } } {
  const encoded = encodeURIComponent(source.bot);
  const bootstrap = useQuery({ queryKey: ['native-position-observation', source.server, source.bot], queryFn: ({ signal }) => read(`/api/v1/trading-visuals/bootstrap?bot=${encoded}`, signal), refetchInterval: 10_000, retry: false });
  const summary = useQuery({ queryKey: ['native-quant-summary', source.server, source.bot], queryFn: ({ signal }) => readOptional(`/api/v1/trading-visuals/quant-summary?bot=${encoded}`, signal), refetchInterval: 10_000, retry: false });
  const events = useQuery({ queryKey: ['native-quant-events', source.server, source.bot], queryFn: ({ signal }) => readOptional(`/api/v1/trading-visuals/quant-events?bot=${encoded}`, signal), refetchInterval: 15_000, retry: false });
  const execution = useQuery({ queryKey: ['native-quant-execution', source.server, source.bot], queryFn: ({ signal }) => readOptional(`/api/v1/trading-visuals/quant-execution?bot=${encoded}`, signal), refetchInterval: 30_000, retry: false });
  const cycles = useQuery({ queryKey: ['native-quant-cycles', source.server, source.bot], queryFn: ({ signal }) => readOptional(`/api/v1/trading-visuals/quant-cycles?bot=${encoded}`, signal), refetchInterval: 30_000, retry: false });
  const day = useQuery({ queryKey: ['native-pnl-history', source.server, source.bot, '1D'], queryFn: ({ signal }) => readOptional(`/api/v1/servers/${encodeURIComponent(source.server)}/bots/${encoded}/performance-history?range=1D`, signal), refetchInterval: 30_000, retry: false });
  const week = useQuery({ queryKey: ['native-pnl-history', source.server, source.bot, '1W'], queryFn: ({ signal }) => readOptional(`/api/v1/servers/${encodeURIComponent(source.server)}/bots/${encoded}/performance-history?range=1W`, signal), refetchInterval: 60_000, retry: false });
  const owner = page?.bots.find(item => item.bot_name === source.bot);
  let view: OwnerReads['view'] = null;
  try { if (bootstrap.data) view = buildBotPositionView(bootstrap.data, source.bot, Math.max(now, bootstrap.dataUpdatedAt), { allowStale: true }); } catch { view = null; }
  const reads: OwnerReads = {
    bot: source.bot, server: source.server, status: owner?.status ?? null, view,
    controller: controllerNet(page, source.bot),
    quant: projectQuantBotSummary(summary.data?.payload, source.bot, Math.max(now, summary.dataUpdatedAt)),
    cycles: projectQuantCycles(cycles.data?.payload, source.bot),
    execution: projectExecutionStats(execution.data?.payload, source.bot),
    decisions: projectLifecycleDecisions(events.data?.payload, source.bot, Math.max(now, events.dataUpdatedAt)) ?? [],
    day: pnlSeries(day.data?.payload, source.bot, now), week: pnlSeries(week.data?.payload, source.bot, now),
  };
  return { reads, raw: { bootstrap, summary: summary.data, events: events.data, execution: execution.data, cycles: cycles.data } };
}

function OwnerCard({ source, page, logs, onReads }: { source: TradingVisualsSource; page?: BotsPageResponse; logs: ReactNode; onReads: (reads: OwnerReads) => void }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const { reads, raw } = useOwnerReads(source, page, now);
  const { bootstrap } = raw;
  useEffect(() => { onReads(reads); }, [onReads, reads.quant?.generatedAt, reads.cycles?.stats.fillCount, reads.day.change, reads.view?.pairs.length, reads.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const pairs = reads.view?.pairs ?? [];
  const owner = page?.bots.find(item => item.bot_name === source.bot);
  return <article className="q-card q-bot-card" aria-label={`${source.bot} roster card`}>
    <header className="q-bot-head" data-panel-id="B09">
      <div>
        <h2>{displayBotName(source.bot)}</h2>
        <p className="q-muted">{source.bot} · {source.server} · {reads.quant?.executionMode ?? 'execution mode unavailable'} · {reads.quant?.ownershipBasis ?? 'ownership basis unavailable'}</p>
        <div className="q-tags">
          {reads.quant?.executionMode && <span className="q-tag">{reads.quant.executionMode}</span>}
          <span className="q-tag">Spot</span>
          {new Set(pairs.map(row => row.pair)).size > 1 && <span className="q-tag">Multi-pair · {new Set(pairs.map(row => row.pair)).size}</span>}
          <span className="q-tag">{reads.quant?.controllerName ? `Controller ${reads.quant.controllerName}` : 'Controller unavailable'}</span>
          <span className="q-tag">{reads.quant?.profile ? `Profile ${reads.quant.profile}` : 'Profile unavailable'}</span>
        </div>
      </div>
      <div className="q-chip-row">
        <span className="q-muted">{owner?.status ? <><span className="q-pill" data-tone={tone(owner.status)}>{stateLabel(owner.status)}</span> status {owner.status_received_at ? new Date(owner.status_received_at * 1000).toISOString() : 'time unavailable'}</> : 'Lifecycle unavailable'}</span>
        <button type="button" disabled title="Pause entries needs a verified native entry-control route. Process stop is a different operation and is not used here." data-panel-id="B10">Pause entries</button>
        <button type="button" disabled title="Settings shows effective configuration only after an owner schema inspector is enabled. Writes stay off.">Settings</button>
      </div>
    </header>
    {bootstrap.isPending ? <p className="q-empty" role="status">Reading the current bot inventory and order observation…</p> : bootstrap.isError ? <p className="q-empty" role="alert">{(bootstrap.error as Error & { status?: number }).status === 401 || (bootstrap.error as Error & { status?: number }).status === 403 ? `Owner read denied (${(bootstrap.error as Error & { status?: number }).status}).` : (bootstrap.error as Error).message} Cached inventory is withheld. <button type="button" onClick={() => void bootstrap.refetch()}>Check now</button></p> : <RosterObservation payload={bootstrap.data} summary={raw.summary?.payload} bot={source.bot} now={Math.max(now, bootstrap.dataUpdatedAt)} events={raw.events?.payload} execution={raw.execution?.payload} cycles={raw.cycles?.payload} day={reads.day} week={reads.week} controllerTotal={reads.controller.total} controllerQuote={reads.controller.quote} summaryIssue={raw.summary?.issue} eventsIssue={raw.events?.issue} executionIssue={raw.execution?.issue} />}
    {logs && <details><summary>Recent owner logs</summary>{logs}</details>}
  </article>;
}

const sum = (values: (number | null)[]) => values.every(value => value != null) && values.length ? values.reduce<number>((total, value) => total + value!, 0) : null;

export function BotsRoster({ page, renderLogs }: { page?: BotsPageResponse; renderControls?: (bot: string) => ReactNode; renderLogs: (bot: string) => ReactNode }) {
  const { server } = useServer();
  const servers = useServers();
  const [search, setSearch] = useState('');
  const [lifecycle, setLifecycle] = useState('all');
  const [compact, setCompact] = useState(false);
  const [grid, setGrid] = useState(true);
  const [draft, setDraft] = useState(false);
  const [readsByBot, setReadsByBot] = useState<Record<string, OwnerReads>>({});
  const onReads = useMemo(() => (reads: OwnerReads) => setReadsByBot(current => ({ ...current, [`${reads.server}:${reads.bot}`]: reads })), []);
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
  const fleet = scoped.map(source => readsByBot[`${source.server}:${source.bot}`]).filter((reads): reads is OwnerReads => Boolean(reads));
  const complete = fleet.length === scoped.length && scoped.length > 0;
  // Net per bot: the current controller report, else the owner's last published net (stale). Never a fabricated zero.
  const netFor = (reads: OwnerReads): { value: number | null; stale: boolean } => reads.controller.total != null
    ? { value: reads.controller.total, stale: false }
    : reads.quant?.netLifecycle.lastKnown != null ? { value: Number(reads.quant.netLifecycle.lastKnown), stale: true } : { value: null, stale: false };
  const staleBots = fleet.filter(reads => reads.view?.stale || (reads.quant != null && reads.quant.freshness !== 'current'));
  const quotes = new Set(fleet.map(reads => reads.controller.quote ?? reads.quant?.netLifecycle.unit ?? reads.quant?.pairs[0]?.pair.split('-')[1]).filter(Boolean));
  const singleQuote = quotes.size === 1 ? [...quotes][0]! : null;
  // Aggregates are published only when every registered bot is read and no wallet overlap can double count: one bot, or disjoint pairs.
  const pairsByBot = fleet.map(reads => new Set((reads.quant?.pairs ?? []).map(pair => pair.pair)));
  const disjoint = pairsByBot.every((set, index) => pairsByBot.every((other, otherIndex) => index === otherIndex || [...set].every(pair => !other.has(pair))));
  const aggregateAllowed = complete && singleQuote !== null && (fleet.length === 1 || disjoint);
  const netTotal = aggregateAllowed ? sum(fleet.map(reads => netFor(reads).value)) : null;
  const netStale = aggregateAllowed && fleet.some(reads => netFor(reads).stale);
  const dayTotal = aggregateAllowed ? sum(fleet.map(reads => reads.day.change)) : null;
  const openExecutors = complete ? sum(fleet.map(reads => reads.cycles?.counts.open ?? null)) : null;
  const openPositions = complete ? sum(fleet.map(reads => reads.view ? reads.view.pairs.filter(row => row.quantity !== null && formatDecimal(row.quantity, 18) !== '0').length : null)) : null;
  const openOrders = complete ? sum(fleet.map(reads => reads.view && reads.view.orders !== null && reads.view.ordersStatus.complete === true ? reads.view.orders.length : null)) : null;
  const fillsTotal = complete ? sum(fleet.map(reads => reads.cycles?.stats.fillCount ?? null)) : null;
  const scoredTotal = complete ? sum(fleet.map(reads => reads.cycles?.stats.scored ?? null)) : null;
  const aggregateNote = !complete ? 'Waiting for every registered bot to be read.' : aggregateAllowed ? (fleet.length === 1 ? 'One registered bot; no wallet overlap to prove.' : 'Disjoint pairs, one quote currency.') : singleQuote === null ? (staleBots.length ? `${staleBots.length} bot${staleBots.length === 1 ? '' : 's'} stale; quote currency unknown until the owner publishes again.` : 'Bots report different quote currencies; no sum is published.') : 'Bots share pairs on one wallet; per-bot values stay separate.';
  const assets = [...new Set(fleet.flatMap(reads => (reads.quant?.pairs ?? []).map(pair => pair.pair.split('-')[0])))].sort();
  const heatCells = fleet.flatMap(reads => (reads.quant?.pairs ?? []).map(pair => ({ row: displayBotName(reads.bot), column: pair.pair.split('-')[0], value: pair.markedValue == null ? null : Number(pair.markedValue) })));
  const funnel = fleet.length ? (() => { const totals = new Map<string, number>(); for (const reads of fleet) for (const stage of reads.execution?.funnel ?? []) totals.set(stage.stage, (totals.get(stage.stage) ?? 0) + stage.count); return [...totals.entries()].map(([stage, count]) => ({ stage, count })); })() : [];
  const ladder = fleet.flatMap(reads => (reads.quant?.pairs ?? []).map(pair => ({ bot: reads.bot, ...pair })));
  const events = fleet.flatMap(reads => reads.decisions.map(row => ({ ...row, bot: reads.bot }))).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, 40);
  const inventoryRows = (() => { const byAsset = new Map<string, { positions: number; units: number; value: number | null; oldest: number | null }>(); for (const reads of fleet) { for (const pair of reads.quant?.pairs ?? []) { if (pair.units == null || Number(pair.units) <= 0) continue; const asset = pair.pair.split('-')[0]; const entry = byAsset.get(asset) ?? { positions: 0, units: 0, value: 0, oldest: null }; entry.positions += 1; entry.units += Number(pair.units); entry.value = entry.value == null || pair.markedValue == null ? null : entry.value + Number(pair.markedValue); const lot = reads.cycles?.inventoryAge.lots.filter(item => item.pair === pair.pair).map(item => item.ageSeconds ?? 0).sort((a, b) => b - a)[0] ?? null; entry.oldest = lot == null ? entry.oldest : Math.max(entry.oldest ?? 0, lot); byAsset.set(asset, entry); } } return [...byAsset.entries()].sort(([, a], [, b]) => (b.value ?? 0) - (a.value ?? 0)); })();
  const inventoryTotal = inventoryRows.every(([, row]) => row.value != null) ? inventoryRows.reduce((total, [, row]) => total + (row.value ?? 0), 0) : null;
  return <div className={`bot-roster${compact ? ' bot-roster--compact' : ''}`} data-quant-ops="bots">
    <header className="q-page-head">
      <div>
        <p className="q-muted" data-panel-id="S01">RSIBOT · Modular V2 · Bots</p>
        <h1>Bots</h1>
        <p className="q-kicker" data-panel-id="S02">Live bot operations, decisions and performance. Per-bot PnL is summed only when ownership overlap is disproven.</p>
      </div>
      <div className="q-chip-row" data-panel-id="B06">
        <input className="q-search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search bots, pairs, incidents" aria-label="Search bots" data-panel-id="S04" />
        <select aria-label="Lifecycle filter" value={lifecycle} onChange={event => setLifecycle(event.target.value)}>
          <option value="all">All bots</option>
          <option value="running">Running</option>
          <option value="stopped">Stopped</option>
        </select>
        {(search || lifecycle !== 'all') && <button type="button" className="q-chip" onClick={() => { setSearch(''); setLifecycle('all'); }}>Reset</button>}
        <button type="button" className="q-chip" aria-pressed={grid} onClick={() => setGrid(value => !value)} title="Grid shows the fleet strip; list shows only the performance table." data-panel-id="S07">{grid ? 'Grid' : 'List'}</button>
        <button type="button" className="q-chip" aria-pressed={compact} onClick={() => setCompact(value => !value)} title="Changes local display density only." data-panel-id="B07">{compact ? 'Comfortable density' : 'Compact density'}</button>
        <button type="button" className="q-chip" onClick={() => setDraft(true)} title="New Bot prepares a local draft with execution_authorized=false. Live launch is a separate sealed deployment." data-panel-id="B08">+ New Bot</button>
      </div>
    </header>
    <section className="q-kpis" aria-label="Registered bots">
      <MetricCard panelId="B01" title="Active bots" value={statusesKnown ? `${verifiedRunning} / ${scoped.length}` : scoped.length && page ? `${verifiedRunning} verified / ${scoped.length}` : 'Unavailable'} state={statusesKnown ? { kind: 'fresh' } : scoped.length && page ? { kind: 'stale', reason: `Lifecycle status is stale or unknown for ${scoped.length - verifiedRunning} registered bot(s); only verified running bots are counted.` } : { kind: 'unavailable', reason: 'Lifecycle status is missing for a registered bot.' }} note={statusesKnown ? 'Verified running / registered. A configured bot is not automatically active.' : `${scoped.length - verifiedRunning} registered bot(s) without a verified lifecycle: ${scoped.map(source => `${displayBotName(source.bot)} ${stateLabel(page?.bots.find(item => item.bot_name === source.bot)?.status ?? null)}`).join(', ')}.`} />
      <MetricCard panelId="B26" title="Active executors" value={openExecutors == null ? 'Unavailable' : String(openExecutors)} state={openExecutors == null ? { kind: 'collecting', sample: { have: fleet.length, need: scoped.length || 1 }, reason: 'Cycle projections per bot' } : { kind: 'fresh' }} note="Open executors with fills, from the lifecycle projection." />
      <MetricCard panelId="B03" title="Open positions" value={openPositions == null ? 'Unavailable' : String(openPositions)} state={openPositions == null ? { kind: 'collecting', sample: { have: fleet.length, need: scoped.length || 1 }, reason: 'Inventory per bot' } : staleBots.length ? { kind: 'stale', reason: `${staleBots.length} bot observation${staleBots.length === 1 ? '' : 's'} not current; last-known inventory counted.` } : { kind: 'fresh' }} note="Pairs holding nonzero units across all bots. Executors are not positions." />
      <MetricCard panelId="B27" title="Open orders" value={openOrders == null ? 'Unavailable' : String(openOrders)} state={openOrders == null ? { kind: 'incomplete', reason: 'Complete exchange order detail is missing for a bot.' } : staleBots.length ? { kind: 'stale', reason: 'Last-known order list; the owner observation is not current.' } : { kind: 'fresh' }} note="Working exchange orders in the owner observations." />
      <MetricCard panelId="B04" title="Daily bot PnL" value={dayTotal == null ? 'Unavailable' : formatSigned(dayTotal)} unit={singleQuote ?? undefined} tone={metricTone(dayTotal)} state={dayTotal == null ? { kind: aggregateAllowed ? 'collecting' : 'incomplete', reason: aggregateAllowed ? 'Needs an unbroken saved 24h series per bot.' : aggregateNote } : { kind: 'fresh' }} note="24h change of saved native net PnL." />
      <MetricCard panelId="B02" title="Total bot PnL" value={netTotal == null ? 'Unavailable' : formatSigned(netTotal)} unit={singleQuote ?? undefined} tone={metricTone(netTotal)} state={netTotal == null ? { kind: 'incomplete', reason: aggregateNote } : netStale ? { kind: 'stale', reason: 'Owner last published net; controller report not current.' } : { kind: 'fresh' }} note={`${aggregateNote} ${netStale ? 'Last published net (stale).' : 'Controller report: active executors + retained positions.'}`} />
    </section>
    {sources.isError && <p role="alert" className="q-notice">{sources.error.message} <button type="button" onClick={() => void sources.refetch()}>Check now</button></p>}
    {sources.isPending && <p className="q-empty" role="status">Discovering authorized bot owners…</p>}
    {!sources.isPending && !filtered.length && <p className="q-empty" role="status">No authorized bot source is available for this selection.</p>}
    <section className="q-fleet" data-panel-id="B28" aria-label="Fleet strip">
      <MetricCard panelId="B05" title="Total trades" value={fillsTotal == null ? 'Unavailable' : String(fillsTotal)} state={fillsTotal == null ? { kind: 'collecting', sample: { have: fleet.length, need: scoped.length || 1 }, reason: 'Lifecycle projections per bot' } : { kind: 'fresh' }} note={fillsTotal == null ? 'Native fills, lifetime.' : `native fills · ${scoredTotal ?? 0} scored cycle${scoredTotal === 1 ? '' : 's'} · ${openExecutors ?? 0} open`} />
      {grid && filtered.map((source, index) => { const reads = readsByBot[`${source.server}:${source.bot}`]; const points = reads?.day.points.map(point => point.value).filter((value): value is number => value != null) ?? []; const net = reads ? netFor(reads).value : null; return <article key={`${source.server}:${source.bot}`} className="q-card q-mini">
        <header><strong><i className="q-swatch" style={{ background: ASSET_COLORS[index % ASSET_COLORS.length] }} />{displayBotName(source.bot)}</strong><span className="q-pill" data-tone={tone(reads?.status ?? page?.bots.find(item => item.bot_name === source.bot)?.status ?? 'unknown')}>{stateLabel(reads?.status ?? page?.bots.find(item => item.bot_name === source.bot)?.status ?? null)}</span></header>
        {points.length >= 2 ? <Sparkline points={points.slice(-60)} positive={(reads?.day.change ?? 0) >= 0} /> : <small className="q-muted">{reads?.day.reason ?? 'Reading saved performance…'}</small>}
        <div className="q-mini-stats">
          <div><span>Net PnL</span><strong className={metricTone(net) ? `q-${metricTone(net)}` : undefined}>{net == null ? '—' : formatSigned(net)}</strong></div>
          <div><span>Positions</span><strong>{reads?.view ? reads.view.pairs.filter(row => row.quantity !== null && formatDecimal(row.quantity, 18) !== '0').length : '—'}</strong></div>
          <div><span>24h</span><strong className={metricTone(reads?.day.change) ? `q-${metricTone(reads?.day.change)}` : undefined}>{reads?.day.change == null ? '—' : formatSigned(reads.day.change)}</strong></div>
        </div>
      </article>; })}
    </section>
    <PanelFrame panelId="B29" title="Bot performance" scopeLabel="One row per registered bot · native net · scored cycles only" state={complete ? { kind: 'fresh' } : { kind: 'collecting', sample: { have: fleet.length, need: scoped.length || 1 }, reason: 'Bots read' }}>
      <div className="q-table-scroll"><table>
        <thead><tr><th>Bot</th><th>Status</th><th>Controller</th><th>Positions</th><th>Unrealized</th><th>Realized</th><th>Net</th><th>24h</th><th>Win rate</th><th>Fill ratio</th><th>Latency</th><th>Heartbeat</th></tr></thead>
        <tbody>
          {filtered.map(source => { const reads = readsByBot[`${source.server}:${source.bot}`]; const q = reads?.quant; const pairs = q?.pairs ?? []; const unrealized = pairs.length && pairs.every(pair => pair.unrealized != null) ? pairs.reduce((total, pair) => total + Number(pair.unrealized), 0) : null; const realized = pairs.length && pairs.every(pair => pair.realized != null) ? pairs.reduce((total, pair) => total + Number(pair.realized), 0) : null; const cycles = reads?.cycles; return <tr key={`${source.server}:${source.bot}`}>
            <th scope="row">{displayBotName(source.bot)}</th>
            <td><span className="q-pill" data-tone={tone(reads?.status ?? 'unknown')}>{stateLabel(reads?.status ?? null)}</span>{reads?.view?.stale && <small className="q-block">observation {ageLabel(reads.view.ageSeconds)} old</small>}</td>
            <td>{q?.controllerName ?? '—'}</td>
            <td>{reads?.view ? reads.view.pairs.filter(row => row.quantity !== null && formatDecimal(row.quantity, 18) !== '0').length : '—'}</td>
            <td className={metricTone(reads?.controller.unrealized ?? unrealized) ? `q-${metricTone(reads?.controller.unrealized ?? unrealized)}` : undefined}>{(reads?.controller.unrealized ?? unrealized) == null ? 'Unknown basis' : formatSigned(reads?.controller.unrealized ?? unrealized)}</td>
            <td className={metricTone(reads?.controller.realized ?? realized) ? `q-${metricTone(reads?.controller.realized ?? realized)}` : undefined}>{(reads?.controller.realized ?? realized) == null ? '—' : formatSigned(reads?.controller.realized ?? realized)}</td>
            <td className={metricTone(reads ? netFor(reads).value : null) ? `q-${metricTone(reads ? netFor(reads).value : null)}` : undefined}>{!reads || netFor(reads).value == null ? '—' : `${formatSigned(netFor(reads).value)} ${reads.controller.quote ?? reads.quant?.netLifecycle.unit ?? ''}${netFor(reads).stale ? ' · stale' : ''}`}</td>
            <td className={metricTone(reads?.day.change) ? `q-${metricTone(reads?.day.change)}` : undefined}>{reads?.day.change == null ? '—' : formatSigned(reads.day.change)}</td>
            <td>{cycles ? cycles.stats.winRate == null ? `Collecting ${cycles.stats.scored}/${cycles.stats.minSample}` : `${(cycles.stats.winRate * 100).toFixed(1)}% (n=${cycles.stats.scored})` : '—'}</td>
            <td>{reads?.execution?.fillRatio == null ? '—' : `${(reads.execution.fillRatio * 100).toFixed(1)}%`}</td>
            <td>{reads?.execution?.latencyMedianSeconds == null ? '—' : `${reads.execution.latencyMedianSeconds.toFixed(1)}s`}</td>
            <td>{q?.observedAt ? q.observedAt.slice(11, 19) : '—'}</td>
          </tr>; })}
          {!filtered.length && <tr><td colSpan={12}>No registered bot matches the filter.</td></tr>}
        </tbody>
      </table></div>
    </PanelFrame>
    {draft && <BotDraftWizard bots={scoped.map(item => item.bot)} onClose={() => setDraft(false)} />}
    {filtered.map(source => <OwnerCard key={`${source.server}:${source.bot}`} source={source} page={page} logs={renderLogs(source.bot)} onReads={onReads}/>)}
    <div className="q-bot-cols">
      <PanelFrame panelId="B30" title="Position inventory by symbol" scopeLabel="V2-owned units and marked value · wallet remainder stays in Capital" state={inventoryRows.length ? { kind: 'fresh' } : { kind: 'unavailable', reason: 'No bot reports nonzero owned units.' }}>
        <div className="q-table-scroll"><table><thead><tr><th>Symbol</th><th>Positions</th><th>Units</th><th>Value</th><th>% of owned</th><th>Oldest lot</th></tr></thead><tbody>
          {inventoryRows.map(([asset, row]) => <tr key={asset}><th scope="row">{asset}</th><td>{row.positions}</td><td>{formatDecimal(row.units, 8)}</td><td>{row.value == null ? 'Mark incomplete' : formatDecimal(row.value)}</td><td>{row.value == null || !inventoryTotal ? '—' : `${((row.value / inventoryTotal) * 100).toFixed(1)}%`}</td><td>{ageLabel(row.oldest)}</td></tr>)}
          {!inventoryRows.length && <tr><td colSpan={6}>No owned units reported.</td></tr>}
        </tbody></table></div>
      </PanelFrame>
      <PanelFrame panelId="B24" title="Symbol exposure heatmap" scopeLabel="Marked owned value per bot and asset · hatched = no position" state={heatCells.length ? { kind: 'fresh' } : { kind: 'unavailable', reason: 'No bot reports pair inventory.' }}>
        {heatCells.length ? <Heatmap rows={[...new Set(heatCells.map(cell => cell.row))]} columns={assets} cells={heatCells} /> : <p className="q-empty">No marked owned value to plot.</p>}
      </PanelFrame>
      <PanelFrame panelId="B31" title="Order lifecycle" scopeLabel="Decisions → orders → fills · lifetime owner rows" state={funnel.length ? { kind: 'fresh' } : { kind: 'unavailable', reason: 'No lifecycle rows are readable yet.' }}>
        <Funnel stages={funnel} />
      </PanelFrame>
    </div>
    <div className="q-bot-cols">
      <PanelFrame panelId="B32" title="DCA ladder state" scopeLabel="Owner plan per pair · mode, target, anchor, next step" state={ladder.length ? { kind: 'fresh' } : { kind: 'unavailable', reason: 'No owner plan fields in the current observation.' }}>
        <div className="q-table-scroll"><table><thead><tr><th>Pair</th><th>Mode</th><th>Target</th><th>Anchor</th><th>Slice</th><th>Next</th><th>Score</th><th>Execs</th></tr></thead><tbody>
          {ladder.map(row => <tr key={`${row.bot}:${row.controllerId ?? row.pair}`}><th scope="row">{row.pair}</th><td><span className="q-pill" data-tone={row.planMode === 'EXITS' ? 'holding' : 'building'}>{row.planMode ?? '—'}</span></td><td>{row.planTarget ?? '—'}</td><td>{row.planAnchor ?? '—'}</td><td>{row.dcaLevel ?? '—'}</td><td>{row.planNext ?? '—'}</td><td>{row.score ?? '—'}</td><td>{row.execs ?? '—'}</td></tr>)}
          {!ladder.length && <tr><td colSpan={8}>No plan rows.</td></tr>}
        </tbody></table></div>
      </PanelFrame>
      <PanelFrame panelId="B33" title="Next conditions" scopeLabel="Owner-recorded conditions and gates · not forecasts" state={ladder.length ? { kind: 'fresh' } : { kind: 'unavailable', reason: 'No owner conditions in the current observation.' }}>
        <div className="q-table-scroll"><table><thead><tr><th>Bot</th><th>Pair</th><th>State</th><th>Condition</th><th>Gate</th></tr></thead><tbody>
          {ladder.map(row => <tr key={`${row.bot}:${row.controllerId ?? row.pair}:next`}><td>{displayBotName(row.bot)}</td><th scope="row">{row.pair}</th><td><span className="q-pill" data-tone={tone(row.state)}>{stateLabel(row.state)}</span></td><td>{row.planNext ?? row.nextCondition ?? '—'}</td><td>{row.gate === 'ready' ? <span className="q-pill" data-tone="ok">ready</span> : <span className="q-pill" data-tone="blocked" title={row.gate ?? ''}>{row.gate ? row.gate.split(':')[0] : '—'}</span>}</td></tr>)}
          {!ladder.length && <tr><td colSpan={5}>No conditions.</td></tr>}
        </tbody></table></div>
      </PanelFrame>
      <PanelFrame panelId="B22-fleet" title="Bot health" scopeLabel="One line per bot · independent states">
        <ul className="q-diag">
          {fleet.map(reads => <li key={`${reads.server}:${reads.bot}`}><span>{displayBotName(reads.bot)}</span><strong>{reads.quant?.freshness === 'current' ? 'heartbeat fresh' : 'heartbeat stale'} · {reads.quant?.riskRails.availability === 'available' ? 'rails published' : 'no rails'} · {reads.view ? `${reads.view.pairs.length} pairs${reads.view.stale ? ` (last known ${ageLabel(reads.view.ageSeconds)} ago)` : ''}` : 'inventory unread'} · {reads.execution?.fillRatio == null ? 'no fills' : `fill ${(reads.execution.fillRatio * 100).toFixed(0)}%`}</strong></li>)}
          {!fleet.length && <li><span>No bot read yet</span><strong>—</strong></li>}
        </ul>
      </PanelFrame>
    </div>
    <div className="q-compare">
      <PanelFrame panelId="B23" title="Bot PnL comparison" scopeLabel={`7d saved native net PnL${singleQuote ? ` · ${singleQuote}` : ' · mixed quotes are not overlaid'}`} state={fleet.some(reads => reads.week.points.length >= 2) ? (singleQuote ? { kind: 'fresh' } : { kind: 'incomplete', reason: 'Bots report different quote currencies.' }) : { kind: 'collecting', sample: { have: 0, need: 2 }, reason: 'Saved weekly performance per bot' }}>
        {singleQuote ? <MultiLine unit={singleQuote} series={fleet.map((reads, index) => ({ label: displayBotName(reads.bot), color: ASSET_COLORS[index % ASSET_COLORS.length], points: reads.week.points.map(point => ({ time: point.time, value: point.value })) }))} /> : <p className="q-empty">Lines are drawn only in one shared quote currency.</p>}
      </PanelFrame>
      <PanelFrame panelId="B25" title="Recorded behavior timeline" scopeLabel="Decision → order → fill → exit · linked by owner IDs" state={events.length ? { kind: 'fresh' } : { kind: 'unavailable', reason: 'No lifecycle records are readable yet.' }}>
        <ol className="q-timeline">
          {events.slice(0, 12).map(row => <li key={`${row.bot}:${row.decisionId}`}><span>{stamp(row.occurredAt)}</span><span className="q-pill" data-tone={row.action === 'BUY' ? 'holding' : row.action === 'CANCEL' ? 'flat' : 'building'}>{row.action}</span><span>{row.pair ?? '—'}</span><span>{row.orderIds.length} order{row.orderIds.length === 1 ? '' : 's'} → {row.fillIds.length} fill{row.fillIds.length === 1 ? '' : 's'}{row.outcome ? ` → ${row.outcome}` : ''}{row.netPnl ? ` · net ${formatSigned(row.netPnl)}` : ''}<small className="q-block">{displayBotName(row.bot)} · executor {row.executorId.slice(0, 10)}…</small></span></li>)}
          {!events.length && <li><span>—</span><span /><span /><span>No lifecycle records.</span></li>}
        </ol>
      </PanelFrame>
    </div>
    <PanelFrame panelId="B34" title="Recent decisions & events" scopeLabel="Lifecycle records across bots · newest first · bounded to 40" state={events.length ? { kind: 'fresh' } : { kind: 'unavailable', reason: 'No lifecycle records are readable yet.' }}>
      <div className="q-table-scroll"><table><thead><tr><th>Time</th><th>Type</th><th>Bot</th><th>Message</th></tr></thead><tbody>
        {events.map(row => <tr key={`log:${row.bot}:${row.decisionId}`}><td>{stamp(row.occurredAt)}</td><td><span className="q-pill" data-tone={row.action === 'BUY' ? 'holding' : row.action === 'CANCEL' ? 'flat' : row.action === 'TRANSFER' ? 'neutral' : 'building'}>{row.action}</span></td><td>{displayBotName(row.bot)}</td><td>{row.pair ?? '—'} · {row.outcome ?? 'recorded'}{row.decisionPrice ? ` · decision price ${row.decisionPrice}` : ''}{row.amountBase ? ` · ${row.amountBase} base` : ''}{row.reasonCodes.length ? ` · ${row.reasonCodes.join(', ')}` : ''}</td></tr>)}
        {!events.length && <tr><td colSpan={4}>No lifecycle records yet.</td></tr>}
      </tbody></table></div>
    </PanelFrame>
    <footer className="q-footer" data-panel-id="S06"><span className="q-footer-state" data-state={complete ? (fleet.every(reads => reads.quant?.freshness === 'current') ? 'fresh' : 'stale') : 'collecting'}>{complete ? (fleet.every(reads => reads.quant?.freshness === 'current') ? 'All bot sources fresh' : `${fleet.filter(reads => reads.quant?.freshness !== 'current').length} bot source${fleet.filter(reads => reads.quant?.freshness !== 'current').length === 1 ? '' : 's'} stale`) : `${fleet.length} / ${scoped.length} bots read`}</span><span>{server ?? 'Server not selected'} · UTC</span><span><Link to="/capital">Open Capital</Link></span></footer>
  </div>;
}
