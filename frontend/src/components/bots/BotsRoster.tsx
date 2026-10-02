import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { BotsPageResponse } from '@/lib/api';
import { authFetch } from '@/lib/auth-token';
import { transientReadFailure } from '@/lib/read-continuity';
import { useServer } from '@/hooks/useServer';
import { useServers } from '@/hooks/useServers';
import { displayBotName, parseTradingVisualsSources, sourcesForServer, type TradingVisualsSource } from '@/features/trading-visuals/sources';
import { buildBotPositionView, mixedOperationalLabel, openPairCount, type BotPairPosition } from '@/features/bots/position-view';
import { projectExecutionStats, projectFills, projectLifecycleDecisions, projectQuantBotSummary, projectQuantCycles, projectQuantExecution, projectRecordedDecisions, type ExecutionStats, type LifecycleDecision, type QuantBotSummary, type QuantCycles } from '@/features/bots/quant-roster';
import { formatDecimal, formatSigned, metricTone } from '@/features/quant-ops/format';
import { Heatmap, Histogram, LifecycleCounts, MetricCard, PanelFrame, RailBar, StateGlyph } from '@/features/quant-ops/primitives';
import { TileGrid } from '@/features/quant-ops/kit/grid';
import { DataTable } from '@/features/quant-ops/kit/DataTable';
import { FleetStrip, fleetInput } from './FleetStrip';
import { StrategyChartsSlot } from './StrategyChartsSlot';
import { botChartsHref } from '@/features/bots/chart-links';
import { projectFleetHealth, type FleetHealth } from '@/features/bots/fleet-health';
import { durationLabel, fillTotals, projectBotStats, projectFleetTiles, tileNote, type FleetBotInput, type FillTotals } from '@/features/bots/fleet-tiles';
import { pnlSeries, type PnlSeries } from '@/features/bots/pnl-series';
import { botNet, botSourceFreshness, ownerReadsFingerprint, winRateText } from '@/features/bots/bot-net';
import { projectControllerPnl } from '@/features/bots/controller-pnl';
import { rowsPanelState, type PanelState } from '@/features/quant-ops/panel-state';
import { PriceLevels } from './NativeBotPositions';
import { BotDraftWizard } from './BotDraftWizard';
import '@/features/quant-ops/quant-ops.css';
import './bots-roster.css';

const amount = (value: unknown, unit: string | null = '') => {
  if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))) return 'Unavailable';
  const decimal = formatDecimal(value, 18);
  return decimal === 'Unavailable' ? decimal : `${decimal}${unit ? ` ${unit}` : ''}`;
};
const stateLabel = (value: string | null) => value?.replaceAll('_', ' ') || 'Unverified';
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

function dcaLabel(row: BotPairPosition, reportedLevel?: string | null) {
  if (reportedLevel) return `Owner stage ${reportedLevel}`;
  if (row.targetBase !== null) return `Target ${row.targetBase} ${row.baseAsset}`;
  return 'No plan stage reported';
}

export type OwnerReads = {
  bot: string; server: string; status: string | null; view: ReturnType<typeof buildBotPositionView> | null;
  controller: ReturnType<typeof projectControllerPnl>;
  quant: QuantBotSummary | null; cycles: QuantCycles | null; execution: ExecutionStats | null; decisions: LifecycleDecision[];
  /** Stack heartbeat and service restarts from the operations read; null until that read lands. */
  health: FleetHealth | null;
  fillTotals: FillTotals | null;
  day: PnlSeries; week: PnlSeries;
};

/** All pair rows stay in page flow. Selecting a row never hides the rest. */
export function RosterObservation({ payload, bot, now, lifecycleStatus = null, summary: summaryPayload, events, execution, cycles: cyclesPayload, day, week, controllerTotal = null, controllerQuote = null, summaryIssue, eventsIssue, executionIssue }: {
  payload: unknown; bot: string; now: number; controllerTotal?: number | null; controllerQuote?: string | null;
  lifecycleStatus?: string | null;
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
  const quantPair = (row: BotPairPosition) => quant?.pairs.find(pair => pair.pair === row.pair && (pair.controllerId === row.controllerId || !pair.controllerId)) ?? null;
  const pairQuotes = new Set<string>(view.pairs.map(row => row.quote));
  const quote: string | null = pairQuotes.size === 1 ? [...pairQuotes][0] ?? null : null;
  const owned = view.pairs.length > 0 && quote !== null && view.pairs.every(row => row.markValue !== null) ? view.pairs.reduce((total, row) => total + row.markValue!, 0) : null;
  const regimes = [...new Set((quant?.pairs ?? []).map(row => row.regime).filter(Boolean))] as string[];
  const openPairs = openPairCount(view.pairs);
  const entryPairs = (quant?.pairs ?? []).filter(row => row.planMode === 'ENTRIES').length;
  const exitPairs = (quant?.pairs ?? []).filter(row => row.planMode === 'EXITS').length;
  const nextConditions = [...new Set<string>(view.pairs.flatMap((row: BotPairPosition) => typeof row.planNext === 'string' && row.planNext.length > 0 ? [row.planNext] : []))];
  const nextCondition: string = nextConditions.length > 1 ? 'MIXED · see per-pair conditions' : nextConditions[0] ?? 'No owner condition recorded; see per-pair rows.';
  const retainedReport = quant?.retainedPositionNetPnl;
  const retainedValue = retainedReport?.value ?? retainedReport?.lastKnown ?? null;
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
      <div data-panel-id="B12"><span>Reported inventory value</span><strong>{amount(quant?.ownedValue.value ?? owned, quote)}</strong><small className="q-block">{openPairs === null ? 'Open pair count unavailable' : `${openPairs} open pair${openPairs === 1 ? '' : 's'}`} · marked PnL {pairPnl === null ? 'Unknown basis' : amount(pairPnl, quote ?? '')}</small></div>
      <div data-panel-id="B13"><span>DCA plan</span><strong>{quant?.pairs.length ? `${entryPairs} entering · ${exitPairs} exiting` : 'No plan reported'}</strong><small className="q-block">{quant?.pairs.length ? 'Per-pair target, anchor and next step in the ladder below' : 'Owner plan fields absent from this observation'}</small></div>
      <div data-panel-id="B14"><span>Inventory age</span><strong>{cycles?.inventoryAge.availability === 'available' ? `${ageLabel(cycles.inventoryAge.oldestSeconds)} oldest` : cycles ? 'No open lots' : 'Not readable'}</strong><small className="q-block">{cycles?.inventoryAge.availability === 'available' ? `value-weighted ${ageLabel(cycles.inventoryAge.weightedSeconds)} · ${cycles.inventoryAge.lots.length} lot${cycles.inventoryAge.lots.length === 1 ? '' : 's'} · from native fill times` : cycles?.inventoryAge.reason ?? 'Cycle projection not readable'}</small></div>
      <div data-panel-id="B15"><span>Trailing arm distance</span><strong>{nearest ? `${nearest.pair} ${(nearest.activation * 100).toFixed(2)}%` : trailing.length ? 'Armed' : 'No trailing executor'}</strong><small className="q-block">{nearest ? `to trailing activation · ${nearest.state ?? 'state unavailable'}` : 'Profit capture needs a marked intracycle path; the owner records only the trailing state.'}</small></div>
      <div data-panel-id="B16"><span>Risk rail use</span><strong>{tightest && tightest.limit ? `${tightest.utilization == null ? 'Usage unavailable' : `${(tightest.utilization * 100).toFixed(1)}%`} of ${formatDecimal(tightest.limit)} ${tightest.unit ?? ''}` : quant ? 'No rail with a limit' : 'Not readable'}</strong><small className="q-block">{tightest ? `${tightest.name.replaceAll('_', ' ')} · ${tightest.state} · ${tightest.source ?? ''}` : 'Owner publishes no daily-loss rail'}</small></div>
    </div>
    <div className="q-bot-mid">
      <div data-panel-id="B17">
        <span className="q-muted">Bot PnL · controller report · full history lives in <Link to={`/capital?bot=${encodeURIComponent(bot)}`}>Capital</Link></span>
        <p className={metricTone(controllerTotal) ? `q-${metricTone(controllerTotal)}` : undefined} style={{ fontSize: 18, fontWeight: 600 }}>
          {controllerTotal === null ? '—' : formatSigned(controllerTotal)} {controllerTotal === null ? '' : controllerQuote ?? ''}
          {day?.change != null && <small className={`q-kpi-delta${metricTone(day.change) ? ` q-${metricTone(day.change)}` : ''}`} style={{ marginLeft: 8 }}>{formatSigned(day.change)} 24h</small>}
        </p>
        <p className="q-empty">{dayPoints.length >= 2 ? `${dayPoints.length} saved 24h observations` : day?.reason ?? 'Performance history requires a timestamped, comparable series.'}{dayPoints.length >= 2 && day?.reason ? ` · 24h change unavailable: ${day.reason}` : ''}</p>
        <details className="q-source-details"><summary>Accounting and observation details</summary><p className="q-empty">Controller report is the headline PnL source shared with Capital. Retained-position net diagnostic: {retainedValue === null ? 'Unavailable' : `${formatSigned(retainedValue)} ${retainedReport?.unit ?? ''}`}; this excludes completed executor history and is not controller lifecycle PnL. Fee basis: {retainedReport?.feeBasis ? retainedReport.feeBasis.replaceAll('_', ' ') : 'unavailable'}. Snapshot observed {retainedReport?.observedAt ?? quant?.observedAt ?? 'Unavailable'}. 7d change {week?.change == null ? 'needs an unbroken saved week' : `${formatSigned(week.change)} ${week.quote ?? ''}`}. Open-position marked PnL: {pairPnl === null ? 'Unknown basis' : amount(pairPnl, quote ?? '')}.</p></details>
      </div>
      <div data-panel-id="B18">
        <span className="q-muted">Cycles <StateGlyph state={cycleState} /></span>
        {cycles ? <>
          <div className="q-stacked" role="img" aria-label="Cycle outcomes" style={{ marginTop: 6 }}>{(() => { const total = Object.values(cycles.counts).reduce((sum, value) => sum + value, 0) || 1; const colors: Record<string, string> = { open: 'var(--q-blue)', closed_scored: 'var(--q-positive)', ownership_transfer: 'var(--q-violet)', entry_pending: 'var(--q-cyan)', entry_unfilled: 'var(--q-neutral)', unclassified: 'var(--q-warning)' }; return Object.entries(cycles.counts).filter(([, count]) => count > 0).map(([key, count]) => <span key={key} style={{ width: `${(count / total) * 100}%`, background: colors[key] ?? 'var(--q-neutral)' }} title={`${key.replaceAll('_', ' ')} ${count}`} />); })()}</div>
          <p>{Object.entries(cycles.counts).map(([key, count]) => `${key.replaceAll('_', ' ')} ${count}`).join(' · ')}</p>
          <p className="q-empty">{cycles.stats.scored} scored · {cycles.stats.wins}W / {cycles.stats.losses}L{cycles.stats.winRate != null ? ` · win rate ${(cycles.stats.winRate * 100).toFixed(1)}%` : ''}{cycles.stats.expectancy ? ` · expectancy ${formatSigned(cycles.stats.expectancy)}` : ''} · {cycles.stats.fillCount ?? 'Unavailable'} fills. Transfers and unfilled entries are never wins or losses.</p>
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
        <DataTable label="Recorded decisions" rowId={row => row.key} rows={decisionRows} initialSort={{ id: 'at', desc: true }} pageSize={8} exportName={`${bot}-decisions.csv`}
          emptyText={`No identity-validated recorded decision journal is available${eventsIssue ? ` (${eventsIssue})` : ''}. Current state and next conditions are shown above and are not decisions.`}
          columns={[
            { id: 'at', header: 'Time (UTC)', value: row => row.at, cell: row => stamp(row.at), size: 150 },
            { id: 'action', header: 'Action', value: row => row.action, size: 150, cell: row => <><span className="q-pill" data-tone={row.action === 'BUY' ? 'holding' : row.action === 'CANCEL' ? 'flat' : row.action === 'TRANSFER' ? 'neutral' : 'building'}>{stateLabel(row.action)}</span>{row.outcome && <small className="q-block">{row.outcome}</small>}<small className="q-block" title={row.key}>{row.id}</small></>, wrap: true },
            { id: 'pair', header: 'Pair', value: row => row.pair ?? 'Unavailable', size: 90 },
            { id: 'reasons', header: 'Reasons and gates', value: row => row.reasons || 'No reason or gate details recorded.', size: 240, wrap: true },
            { id: 'links', header: 'Evidence links', value: row => row.links, size: 200, wrap: true },
          ]} />
        <p className="q-empty">Decision IDs and owner boot IDs define journal records; lifecycle records use executor IDs. Missing order/fill links stay unlinked; no nearest-time join is used.</p>
      </PanelFrame>
      <PanelFrame panelId="B21" title="Execution quality" scopeLabel={stats?.benchmarkBasis ?? 'Adverse slippage · bps'} state={histogram ? (stats && stats.sampleCount < stats.minSample ? { kind: 'collecting', sample: { have: stats.sampleCount, need: stats.minSample }, reason: 'Benchmarked fills' } : { kind: 'fresh' }) : stats ? { kind: 'collecting', sample: { have: stats.sampleCount, need: stats.minSample }, reason: `Benchmarked fills · excluded ${Object.entries(stats.excludedReasons).map(([key, count]) => `${count} ${key.toLowerCase().replaceAll('_', ' ')}`).join(', ') || 'none'}` } : { kind: 'unavailable', reason: executionIssue ?? 'no valid owner-scoped benchmark cohort' }}>
        {histogram ? <><Histogram bins={histogram.bins} unit="bps" sampleCount={histogram.sampleCount} excludedCount={histogram.excludedCount} /><p className="q-empty">{histogram.paperExcluded} simulated fills excluded{stats && Object.keys(stats.excludedReasons).length ? ` · not benchmarked: ${Object.entries(stats.excludedReasons).map(([key, count]) => `${count} ${key.toLowerCase().replaceAll('_', ' ')}`).join(', ')}` : ''}. Mean {stats?.meanBps == null ? '—' : formatSigned(stats.meanBps)} bps · median {stats?.medianBps == null ? '—' : formatSigned(stats.medianBps)} bps.</p></> : <p className="q-empty">Slippage histogram waits for fills with owner-recorded decision marks{stats ? ` (${stats.sampleCount}/${stats.minSample})` : ''}.</p>}
        {stats && <ul className="q-diag" style={{ marginTop: 8 }}>
          <li><span>Fill ratio</span><strong>{stats.fillRatio == null ? '—' : `${(stats.fillRatio * 100).toFixed(1)}%`}{!stats.orderSampleSufficient && <small> · n&lt;{stats.minSample}</small>}</strong></li>
          <li><span>Cancel / reject</span><strong>{stats.cancelRate == null ? '—' : `${(stats.cancelRate * 100).toFixed(1)}%`} / {stats.rejectRate == null ? '—' : `${(stats.rejectRate * 100).toFixed(1)}%`}</strong></li>
          <li><span>Median decision→first fill</span><strong>{stats.latencyMedianSeconds == null ? '—' : `${stats.latencyMedianSeconds.toFixed(1)}s`} <small>n={stats.latencySamples}</small></strong></li>
          <li><span>Maker / taker</span><strong>{stats.makerCount ?? '—'} / {stats.takerCount ?? '—'}{stats.liquidityUnclassifiedCount ? <small title="Plain limit orders may rest or cross; only post-only and market orders prove liquidity."> · {stats.liquidityUnclassifiedCount} unclassified</small> : null}</strong></li>
        </ul>}
      </PanelFrame>
      <PanelFrame panelId="B22" title="Bot diagnostics" scopeLabel="Each row has its own freshness">
        <ul className="q-diag">
          <li><span>Lifecycle</span><strong>{lifecycleStatus ? stateLabel(lifecycleStatus) : 'Unavailable'}</strong></li>
          <li><span>Quant operational state</span><strong>{quant?.freshness === 'current' ? quant.state : quant?.lastKnown ? `${quant.state} · stale` : 'Unavailable / stale'}</strong></li>
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
    <div data-panel-id="B12-pairs">
      <h3 className="q-table-title">Per-pair inventory · {displayBotName(bot)}</h3>
      <DataTable<BotPairPosition> label={`Per-pair inventory · ${displayBotName(bot)}`} rowId={row => row.id} rows={view.pairs} initialSort={{ id: 'value', desc: true }} pageSize={20} exportName={`${bot}-pairs.csv`}
        emptyText="No controller positions are included in this observation."
        columns={[
          { id: 'pair', header: 'Pair', rowHeader: true, value: row => row.pair, size: 110, cell: row => <><Link to={botChartsHref(bot, row.pair)}>{row.pair}</Link>{!row.uniquePair && <small> {row.controllerId || row.id}</small>}</> },
          { id: 'state', header: 'State', value: row => stateLabel(row.phase), size: 130, cell: row => <span className="q-pill" data-tone={tone(row.phase)}>{stateLabel(row.phase)}</span> },
          { id: 'units', header: 'Units', kind: 'number', value: row => row.quantity, cell: row => row.quantity === null ? 'Unavailable' : `${row.quantity} ${row.baseAsset}`, size: 150 },
          { id: 'entry', header: 'Entry', kind: 'number', value: row => row.breakeven, cell: row => row.breakeven == null ? (row.quantity === '0' ? '—' : 'Unknown basis') : amount(row.breakeven, row.quote), size: 160 },
          { id: 'mark', header: 'Mark', kind: 'number', value: row => row.price, cell: row => amount(row.price, row.quote), size: 130 },
          { id: 'value', header: 'Marked value', kind: 'number', value: row => row.markValue, cell: row => amount(row.markValue, row.quote), size: 170 },
          { id: 'pnl', header: 'Open-position PnL', kind: 'number', value: row => row.bagPnl, cell: row => row.bagPnl == null ? (row.quantity === '0' ? '—' : 'Unknown basis') : amount(row.bagPnl, row.quote), className: row => metricTone(row.bagPnl) ? `q-${metricTone(row.bagPnl)}` : undefined, size: 180 },
          { id: 'dca', header: 'DCA', value: row => dcaLabel(row, quantPair(row)?.dcaLevel), size: 160, wrap: true },
          { id: 'plan', header: 'Plan', value: row => { const q = quantPair(row); return q?.planMode ? `${q.planMode} · target ${q.planTarget ?? '—'}${q.execs ? ` · ${q.execs}` : ''}` : null; }, cell: row => { const q = quantPair(row); return q?.planMode ? `${q.planMode} · target ${q.planTarget ?? '—'}${q.execs ? ` · ${q.execs}` : ''}` : '—'; }, size: 180, wrap: true },
          { id: 'next', header: 'Next condition', value: row => row.planNext || row.reason || row.hold ? stateLabel(row.planNext || row.reason || row.hold) : 'Owner has not reported a next condition.', size: 220, wrap: true },
          { id: 'gate', header: 'Gate', value: row => quantPair(row)?.gate ?? null, cell: row => { const gate = quantPair(row)?.gate; return gate ? <span className="q-pill" data-tone={gate === 'ready' ? 'ok' : 'blocked'} title={gate}>{gate.split(':')[0]}</span> : '—'; }, size: 110 },
          { id: 'working', header: 'Working', value: row => row.executors.length || row.pendingSells?.length ? `${row.executors.length} executor · ${row.pendingSells?.length ?? 0} sell request` : 'None reported', size: 150 },
        ]} />
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
  const fills = useQuery({ queryKey: ['native-fill-ledger', source.server, source.bot], queryFn: ({ signal }) => readOptional(`/api/v1/trading-visuals/fills?bot=${encoded}&limit=500`, signal), refetchInterval: 60_000, retry: false });
  const operations = useQuery({ queryKey: ['native-operations', source.server, source.bot], queryFn: ({ signal }) => readOptional(`/api/v1/trading-visuals/operations?bot=${encoded}`, signal), refetchInterval: 15_000, retry: false });
  const owner = page?.bots.find(item => item.bot_name === source.bot);
  let view: OwnerReads['view'] = null;
  try { if (bootstrap.data) view = buildBotPositionView(bootstrap.data, source.bot, Math.max(now, bootstrap.dataUpdatedAt), { allowStale: true }); } catch { view = null; }
  const reads: OwnerReads = {
    bot: source.bot, server: source.server, status: owner?.status ?? null, view,
    controller: projectControllerPnl(page, source.bot, now),
    quant: projectQuantBotSummary(summary.data?.payload, source.bot, Math.max(now, summary.dataUpdatedAt)),
    cycles: projectQuantCycles(cycles.data?.payload, source.bot),
    execution: projectExecutionStats(execution.data?.payload, source.bot),
    decisions: projectLifecycleDecisions(events.data?.payload, source.bot, Math.max(now, events.dataUpdatedAt)) ?? [],
    health: projectFleetHealth(operations.data?.payload, source.bot, Math.max(now, operations.dataUpdatedAt)),
    fillTotals: fillTotals(projectFills(fills.data?.payload, source.bot)),
    day: pnlSeries(day.data?.payload, source.bot, now, '1D'), week: pnlSeries(week.data?.payload, source.bot, now, '1W'),
  };
  return { reads, raw: { bootstrap, summary: summary.data, events: events.data, execution: execution.data, cycles: cycles.data } };
}

/** Keeps a filtered-out bot's reads (and staleness clock) live so fleet totals never freeze on a hidden owner. Same query keys as its card, so no extra requests. */
function OwnerReadsFeed({ source, page, onReads }: { source: TradingVisualsSource; page?: BotsPageResponse; onReads: (reads: OwnerReads) => void }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const { reads } = useOwnerReads(source, page, now);
  useEffect(() => { onReads(reads); }, [onReads, reads]);
  return null;
}

function OwnerCard({ source, page, logs, controls, onReads }: { source: TradingVisualsSource; page?: BotsPageResponse; logs: ReactNode; controls?: ReactNode; onReads: (reads: OwnerReads) => void }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const { reads, raw } = useOwnerReads(source, page, now);
  const { bootstrap } = raw;
  useEffect(() => { onReads(reads); }, [onReads, reads]);
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
        {controls}
        <button type="button" disabled title="Pause entries needs a verified native entry-control route. Process stop is a different operation and is not used here." data-panel-id="B10">Pause entries</button>
        <button type="button" disabled title="Settings shows effective configuration only after an owner schema inspector is enabled. Writes stay off.">Settings</button>
      </div>
    </header>
    <StrategyChartsSlot bot={source.bot} server={source.server} />
    {bootstrap.isPending ? <p className="q-empty" role="status">Reading the current bot inventory and order observation…</p> : bootstrap.isError ? <p className="q-empty" role="alert">{(bootstrap.error as Error & { status?: number }).status === 401 || (bootstrap.error as Error & { status?: number }).status === 403 ? `Owner read denied (${(bootstrap.error as Error & { status?: number }).status}).` : (bootstrap.error as Error).message} Cached inventory is withheld. <button type="button" onClick={() => void bootstrap.refetch()}>Check now</button></p> : <RosterObservation payload={bootstrap.data} lifecycleStatus={reads.status} summary={raw.summary?.payload} bot={source.bot} now={Math.max(now, bootstrap.dataUpdatedAt)} events={raw.events?.payload} execution={raw.execution?.payload} cycles={raw.cycles?.payload} day={reads.day} week={reads.week} controllerTotal={reads.controller.total} controllerQuote={reads.controller.quote} summaryIssue={raw.summary?.issue} eventsIssue={raw.events?.issue} executionIssue={raw.execution?.issue} />}
    {logs && <details><summary>Recent owner logs</summary>{logs}</details>}
  </article>;
}

const BOT_LIFECYCLE = ['running', 'starting', 'stopping', 'stopped', 'exited'];
const percentText = (ratio: number | null | undefined) => ratio == null ? '—' : `${(ratio * 100).toFixed(1)}%`;

/** Fleet tiles need every registered bot, including one whose reads have not landed: it contributes its lifecycle status only. */
export function pendingFleetInput(source: TradingVisualsSource, status: string | null): FleetBotInput {
  return { bot: source.bot, name: displayBotName(source.bot), status, view: null, quant: null, cycles: null, execution: null, health: null };
}

export function BotsRoster({ page, renderControls, renderLogs }: { page?: BotsPageResponse; renderControls?: (bot: string) => ReactNode; renderLogs: (bot: string) => ReactNode }) {
  const { server } = useServer();
  const servers = useServers();
  const [search, setSearch] = useState('');
  const [lifecycle, setLifecycle] = useState('all');
  const [compact, setCompact] = useState(false);
  const [grid, setGrid] = useState(true);
  const [draft, setDraft] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 5000); return () => window.clearInterval(timer); }, []);
  const [readsByBot, setReadsByBot] = useState<Record<string, OwnerReads>>({});
  const onReads = useMemo(() => (reads: OwnerReads) => setReadsByBot(current => {
    const key = `${reads.server}:${reads.bot}`;
    if (current[key] && ownerReadsFingerprint(current[key]) === ownerReadsFingerprint(reads)) return current;
    return { ...current, [key]: reads };
  }), []);
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
  const fleet = scoped.map(source => readsByBot[`${source.server}:${source.bot}`]).filter((reads): reads is OwnerReads => Boolean(reads));
  const complete = fleet.length === scoped.length && scoped.length > 0;
  const statusOf = (source: TradingVisualsSource) => { const status = page?.bots.find(item => item.bot_name === source.bot)?.status ?? null; return status !== null && BOT_LIFECYCLE.includes(status) ? status : null; };
  // Whole-fleet KPIs: every registered bot contributes, whether or not it passes the page filter.
  const inputs = scoped.map(source => { const reads = readsByBot[`${source.server}:${source.bot}`]; return reads ? { ...fleetInput(reads), status: statusOf(source) ?? reads.status } : pendingFleetInput(source, statusOf(source)); });
  const tiles = projectFleetTiles(inputs, now);
  const statsFor = (source: TradingVisualsSource) => { const reads = readsByBot[`${source.server}:${source.bot}`]; return reads ? projectBotStats(fleetInput(reads), now) : null; };
  const netFor = (reads: OwnerReads) => botNet(reads.controller.total);
  const assets = [...new Set(fleet.flatMap(reads => (reads.quant?.pairs ?? []).map(pair => pair.pair.split('-')[0])))].sort();
  const heatCells = fleet.flatMap(reads => (reads.quant?.pairs ?? []).map(pair => ({ row: displayBotName(reads.bot), column: pair.pair.split('-')[0], value: pair.markedValue == null ? null : Number(pair.markedValue) })));
  const funnel = fleet.length ? (() => { const totals = new Map<string, number>(); for (const reads of fleet) for (const stage of reads.execution?.funnel ?? []) totals.set(stage.stage, (totals.get(stage.stage) ?? 0) + stage.count); return [...totals.entries()].map(([stage, count]) => ({ stage, count })); })() : [];
  const ladder = fleet.flatMap(reads => (reads.quant?.pairs ?? []).map(pair => ({ bot: reads.bot, ...pair })));
  const staleOwners = fleet.filter(reads => reads.quant != null && reads.quant.freshness !== 'current').map(reads => ({ name: displayBotName(reads.bot), observedAt: reads.quant!.observedAt ?? null }));
  const rowsState = (count: number, emptyReason: string): PanelState => rowsPanelState(count, emptyReason, staleOwners);
  const events = fleet.flatMap(reads => reads.decisions.map(row => ({ ...row, bot: reads.bot }))).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, 40);
  const inventoryRows = (() => { const byAsset = new Map<string, { positions: number; units: number; value: number | null; oldest: number | null }>(); for (const reads of fleet) { for (const pair of reads.quant?.pairs ?? []) { if (pair.units == null || Number(pair.units) <= 0) continue; const asset = pair.pair.split('-')[0]; const entry = byAsset.get(asset) ?? { positions: 0, units: 0, value: 0, oldest: null }; entry.positions += 1; entry.units += Number(pair.units); entry.value = entry.value == null || pair.markedValue == null ? null : entry.value + Number(pair.markedValue); const lot = reads.cycles?.inventoryAge.lots.filter(item => item.pair === pair.pair).map(item => item.ageSeconds ?? 0).sort((a, b) => b - a)[0] ?? null; entry.oldest = lot == null ? entry.oldest : Math.max(entry.oldest ?? 0, lot); byAsset.set(asset, entry); } } return [...byAsset.entries()].sort(([, a], [, b]) => (b.value ?? 0) - (a.value ?? 0)); })();
  const inventoryTotal = inventoryRows.every(([, row]) => row.value != null) ? inventoryRows.reduce((total, [, row]) => total + (row.value ?? 0), 0) : null;
  const allFresh = fleet.every(reads => Object.values(botSourceFreshness(reads)).every(Boolean));
  const botIds = scoped.map(source => source.bot);
  return <div className={`bot-roster${compact ? ' bot-roster--compact' : ''}`} data-quant-ops="bots">
    <header className="q-page-head">
      <div>
        <p className="q-muted" data-panel-id="S01">Bots · {scoped.length} registered</p>
        <h1>Bots</h1>
        <p className="q-kicker" data-panel-id="S02">Operations across the whole bot set: executors, positions, orders, trades, fees and execution quality. Money PnL and wallet history live in Capital.</p>
      </div>
      <div className="q-chip-row" data-panel-id="B06">
        <input className="q-search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search bots, pairs, incidents" aria-label="Search bots" data-panel-id="S04" />
        <select aria-label="Lifecycle filter" value={lifecycle} onChange={event => setLifecycle(event.target.value)}>
          <option value="all">All bots</option>
          <option value="running">Running</option>
          <option value="stopped">Stopped</option>
        </select>
        {(search || lifecycle !== 'all') && <button type="button" className="q-chip" onClick={() => { setSearch(''); setLifecycle('all'); }}>Reset</button>}
        <button type="button" className="q-chip" aria-pressed={grid} onClick={() => setGrid(value => !value)} title="Grid shows the bot cards; list shows only the performance table." data-panel-id="S07">{grid ? 'Grid' : 'List'}</button>
        <button type="button" className="q-chip" aria-pressed={compact} onClick={() => setCompact(value => !value)} title="Changes local display density only." data-panel-id="B07">{compact ? 'Comfortable density' : 'Compact density'}</button>
        <button type="button" className="q-chip" onClick={() => setDraft(true)} title="New Bot prepares a local draft with execution_authorized=false. Live launch is a separate sealed deployment." data-panel-id="B08">+ New Bot</button>
      </div>
    </header>
    <TileGrid label="Fleet bot statistics" min={170} max={7} panelId="B-fleet-tiles">
      {tiles.map(tile => <MetricCard key={tile.id} panelId={tile.id} title={tile.title} value={tile.value} unit={tile.unit} state={tile.state} note={tileNote(tile)} />)}
    </TileGrid>
    {sources.isError && <p role="alert" className="q-notice">{sources.error.message} <button type="button" onClick={() => void sources.refetch()}>Check now</button></p>}
    {sources.isPending && <p className="q-empty" role="status">Discovering authorized bot owners…</p>}
    {!sources.isPending && !filtered.length && <p className="q-empty" role="status">No authorized bot source is available for this selection.</p>}
    {scoped.length > 0 && !complete && <p className="q-empty" role="status">Reading owner observations: {fleet.length} of {scoped.length} bots read. Tiles cover the bots read so far.</p>}
    <FleetStrip sources={grid ? filtered : []} readsByBot={readsByBot} page={page} now={now} />
    {scoped.length > 0 && <StrategyChartsSlot bots={botIds} server={server ?? null} />}
    <PanelFrame panelId="B29" title="Bot performance" scopeLabel="One row per registered bot · operations and execution quality · PnL in Capital" state={complete ? (allFresh ? { kind: 'fresh' } : { kind: 'stale', reason: 'Lifecycle, performance, and quant freshness are assessed independently; at least one source is stale.' }) : { kind: 'collecting', sample: { have: fleet.length, need: scoped.length || 1 }, reason: 'Bots read' }}>
      <DataTable label="Bot performance" rowId={source => `${source.server}:${source.bot}`} rows={filtered} initialSort={{ id: 'bot', desc: false }} exportName="bot-performance.csv" emptyText="No registered bot matches the filter."
        columns={[
          { id: 'bot', header: 'Bot', rowHeader: true, value: source => displayBotName(source.bot), size: 150 },
          { id: 'status', header: 'Status', value: source => readsByBot[`${source.server}:${source.bot}`]?.status ?? null, size: 130, cell: source => { const reads = readsByBot[`${source.server}:${source.bot}`]; return <><span className="q-pill" data-tone={tone(reads?.status ?? 'unknown')}>{stateLabel(reads?.status ?? null)}</span>{reads?.view?.stale && <small className="q-block">observation {ageLabel(reads.view.ageSeconds)} old</small>}</>; } },
          { id: 'controller', header: 'Controller', value: source => readsByBot[`${source.server}:${source.bot}`]?.quant?.controllerName ?? '—', size: 150 },
          { id: 'executors', header: 'Executors', kind: 'number', value: source => statsFor(source)?.executors ?? null, size: 90 },
          { id: 'positions', header: 'Positions', kind: 'number', value: source => statsFor(source)?.held ?? null, cell: source => { const stats = statsFor(source); return stats?.held == null ? '—' : `${stats.held} / ${stats.registered}`; }, size: 90 },
          { id: 'orders', header: 'Orders', kind: 'number', value: source => statsFor(source)?.orders ?? null, size: 80 },
          { id: 'pending', header: 'Entries pending', kind: 'number', value: source => statsFor(source)?.pendingEntries ?? null, size: 110 },
          { id: 'trades', header: 'Trades', kind: 'number', value: source => statsFor(source)?.fills ?? null, size: 80 },
          { id: 'win', header: 'Win rate %', kind: 'number', value: source => { const rate = readsByBot[`${source.server}:${source.bot}`]?.cycles?.stats.winRate; return rate == null ? null : Number((rate * 100).toFixed(1)); }, cell: source => { const cycles = readsByBot[`${source.server}:${source.bot}`]?.cycles; return cycles ? `${winRateText(cycles.stats)} · ${cycles.stats.wins}W/${cycles.stats.losses}L` : '—'; }, size: 120 },
          { id: 'fill', header: 'Fill ratio %', kind: 'number', value: source => { const ratio = statsFor(source)?.fillRatio; return ratio == null ? null : Number((ratio * 100).toFixed(1)); }, cell: source => percentText(statsFor(source)?.fillRatio), size: 90 },
          { id: 'fees', header: 'Fees', kind: 'number', value: source => statsFor(source)?.fees ?? null, cell: source => { const stats = statsFor(source); return stats?.fees == null ? '—' : `${formatDecimal(stats.fees, 4)}${stats.volume ? ` · ${((stats.fees / stats.volume) * 10_000).toFixed(1)} bps` : ''}`; }, size: 130 },
          { id: 'latency', header: 'Latency (s)', kind: 'number', value: source => readsByBot[`${source.server}:${source.bot}`]?.execution?.latencyMedianSeconds ?? null, cell: source => { const value = readsByBot[`${source.server}:${source.bot}`]?.execution?.latencyMedianSeconds; return value == null ? '—' : `${value.toFixed(1)}s`; }, size: 80 },
          { id: 'heartbeat', header: 'Last report', kind: 'number', value: source => { const age = statsFor(source)?.heartbeatAgeSeconds; return age == null ? null : Math.round(age); }, cell: source => { const age = statsFor(source)?.heartbeatAgeSeconds; return age == null ? '—' : `${durationLabel(age)} ago`; }, size: 100 },
          { id: 'pnl', header: 'PnL (Capital has detail)', kind: 'number', value: source => { const reads = readsByBot[`${source.server}:${source.bot}`]; return reads ? netFor(reads).value : null; }, cell: source => { const reads = readsByBot[`${source.server}:${source.bot}`]; return !reads || netFor(reads).value == null ? '—' : `${formatSigned(netFor(reads).value)} ${reads.controller.quote ?? ''}`; }, className: source => { const reads = readsByBot[`${source.server}:${source.bot}`]; const toneName = metricTone(reads ? netFor(reads).value : null); return toneName ? `q-${toneName}` : undefined; }, size: 150 },
        ]} />
    </PanelFrame>
    {draft && <BotDraftWizard bots={scoped.map(item => item.bot)} onClose={() => setDraft(false)} />}
    {filtered.map(source => <OwnerCard key={`${source.server}:${source.bot}`} source={source} page={page} logs={renderLogs(source.bot)} controls={renderControls?.(source.bot)} onReads={onReads}/>)}
    {scoped.filter(source => !filtered.includes(source)).map(source => <OwnerReadsFeed key={`${source.server}:${source.bot}:feed`} source={source} page={page} onReads={onReads} />)}
    <div className="q-bot-cols">
      <PanelFrame panelId="B30" title="Position inventory by symbol" scopeLabel="Bot-owned units and marked value · wallet remainder stays in Capital" state={rowsState(inventoryRows.length, 'No bot reports nonzero owned units.')}>
        <DataTable label="Position inventory by symbol" rowId={([asset]) => asset} rows={inventoryRows} initialSort={{ id: 'value', desc: true }} dense emptyText="No owned units reported."
          columns={[
            { id: 'asset', header: 'Symbol', rowHeader: true, value: ([asset]) => asset, size: 80 },
            { id: 'positions', header: 'Positions', kind: 'number', value: ([, row]) => row.positions, size: 80 },
            { id: 'units', header: 'Units', kind: 'number', value: ([, row]) => row.units, cell: ([, row]) => formatDecimal(row.units, 8), size: 110 },
            { id: 'value', header: 'Value', kind: 'number', value: ([, row]) => row.value, cell: ([, row]) => row.value == null ? 'Mark incomplete' : formatDecimal(row.value), size: 90 },
            { id: 'share', header: '% of owned', kind: 'number', value: ([, row]) => row.value == null || !inventoryTotal ? null : Number(((row.value / inventoryTotal) * 100).toFixed(1)), cell: ([, row]) => row.value == null || !inventoryTotal ? '—' : `${((row.value / inventoryTotal) * 100).toFixed(1)}%`, size: 90 },
            { id: 'oldest', header: 'Oldest lot (h)', kind: 'number', value: ([, row]) => row.oldest == null ? null : Number((row.oldest / 3600).toFixed(1)), cell: ([, row]) => row.oldest == null ? '—' : `${(row.oldest / 3600).toFixed(1)}h`, title: ([, row]) => row.oldest == null ? undefined : ageLabel(row.oldest), size: 100 },
          ]} />
      </PanelFrame>
      <PanelFrame panelId="B24" title="Symbol exposure heatmap" scopeLabel="Marked owned value per bot and asset · hatched = no position" state={heatCells.length ? { kind: 'fresh' } : { kind: 'unavailable', reason: 'No bot reports pair inventory.' }}>
        {heatCells.length ? <Heatmap mode="magnitude" metricLabel="Owned exposure" unitLabel="marked quote value in each bot’s quote currency" rows={[...new Set(heatCells.map(cell => cell.row))]} columns={assets} cells={heatCells} /> : <p className="q-empty">No marked owned value to plot.</p>}
      </PanelFrame>
      <PanelFrame panelId="B31" title="Order lifecycle event counts" scopeLabel="Independent lifetime counts · no joined cohort or conversion rate" state={funnel.length ? { kind: 'fresh' } : { kind: 'unavailable', reason: 'No lifecycle rows are readable yet.' }}>
        <LifecycleCounts stages={funnel} />
      </PanelFrame>
    </div>
    <div className="q-bot-cols">
      <PanelFrame panelId="B32" title="DCA ladder state" scopeLabel="Owner plan per pair · mode, target, anchor, next step" state={rowsState(ladder.length, 'No owner plan fields in the current observation.')}>
        <DataTable label="DCA ladder state" rowId={row => `${row.bot}:${row.controllerId ?? row.pair}`} rows={ladder} dense emptyText="No plan rows."
          columns={[
            { id: 'pair', header: 'Pair', rowHeader: true, value: row => row.pair, cell: row => <Link to={botChartsHref(row.bot, row.pair)}>{row.pair}</Link>, size: 90 },
            { id: 'mode', header: 'Mode', value: row => row.planMode ?? '—', cell: row => <span className="q-pill" data-tone={row.planMode === 'EXITS' ? 'holding' : 'building'}>{row.planMode ?? '—'}</span>, size: 90 },
            { id: 'target', header: 'Target', kind: 'number', value: row => row.planTarget ?? null, cell: row => row.planTarget ?? '—', size: 90 },
            { id: 'anchor', header: 'Anchor', kind: 'number', value: row => row.planAnchor ?? null, cell: row => row.planAnchor ?? '—', size: 90 },
            { id: 'slice', header: 'Slice', value: row => row.dcaLevel ?? '—', size: 70 },
            { id: 'next', header: 'Next', value: row => row.planNext ?? '—', size: 140, wrap: true },
            { id: 'score', header: 'Score', kind: 'number', value: row => row.score ?? null, cell: row => row.score ?? '—', size: 70 },
            { id: 'execs', header: 'Execs', value: row => row.execs ?? '—', size: 70 },
          ]} />
      </PanelFrame>
      <PanelFrame panelId="B33" title="Next conditions" scopeLabel="Owner-recorded conditions and gates · not forecasts" state={rowsState(ladder.length, 'No owner conditions in the current observation.')}>
        <DataTable label="Next conditions" rowId={row => `${row.bot}:${row.controllerId ?? row.pair}:next`} rows={ladder} dense emptyText="No conditions."
          columns={[
            { id: 'bot', header: 'Bot', value: row => displayBotName(row.bot), size: 110 },
            { id: 'pair', header: 'Pair', rowHeader: true, value: row => row.pair, size: 90 },
            { id: 'state', header: 'State', value: row => stateLabel(row.state), cell: row => <span className="q-pill" data-tone={tone(row.state)}>{stateLabel(row.state)}</span>, size: 110 },
            { id: 'condition', header: 'Condition', value: row => row.planNext ?? row.nextCondition ?? '—', size: 170, wrap: true },
            { id: 'gate', header: 'Gate', value: row => row.gate ?? '—', cell: row => row.gate === 'ready' ? <span className="q-pill" data-tone="ok">ready</span> : <span className="q-pill" data-tone="blocked" title={row.gate ?? ''}>{row.gate ? row.gate.split(':')[0] : '—'}</span>, size: 100 },
          ]} />
      </PanelFrame>
      <PanelFrame panelId="B22-fleet" title="Bot health" scopeLabel="One line per bot · independent states">
        <ul className="q-diag">
          {fleet.map(reads => <li key={`${reads.server}:${reads.bot}`}><span>{displayBotName(reads.bot)}</span><strong>{reads.quant?.freshness === 'current' ? 'heartbeat fresh' : 'heartbeat stale'} · {reads.quant?.riskRails.availability === 'available' ? 'rails published' : 'no rails'} · {reads.view ? `${reads.view.pairs.length} pairs${reads.view.stale ? ` (last known ${ageLabel(reads.view.ageSeconds)} ago)` : ''}` : 'inventory unread'} · {reads.execution?.fillRatio == null ? 'no fills' : `fill ${(reads.execution.fillRatio * 100).toFixed(0)}%`}{reads.health?.heartbeat.bootId ? ` · boot ${reads.health.heartbeat.bootId.slice(0, 8)}` : ''}</strong></li>)}
          {!fleet.length && <li><span>No bot read yet</span><strong>—</strong></li>}
        </ul>
      </PanelFrame>
    </div>
    <PanelFrame panelId="B25" title="Recorded behavior timeline" scopeLabel="Decision → order → fill → exit · linked by owner IDs" state={events.length ? { kind: 'fresh' } : { kind: 'unavailable', reason: 'No lifecycle records are readable yet.' }}>
      <ol className="q-timeline">
        {events.slice(0, 12).map(row => <li key={`${row.bot}:${row.decisionId}`}><span>{stamp(row.occurredAt)}</span><span className="q-pill" data-tone={row.action === 'BUY' ? 'holding' : row.action === 'CANCEL' ? 'flat' : 'building'}>{row.action}</span><span>{row.pair ?? '—'}</span><span>{row.orderIds.length} order{row.orderIds.length === 1 ? '' : 's'} → {row.fillIds.length} fill{row.fillIds.length === 1 ? '' : 's'}{row.outcome ? ` → ${row.outcome}` : ''}{row.netPnl ? ` · net ${formatSigned(row.netPnl)}` : ''}<small className="q-block">{displayBotName(row.bot)} · executor {row.executorId.slice(0, 10)}…</small></span></li>)}
        {!events.length && <li><span>—</span><span /><span /><span>No lifecycle records.</span></li>}
      </ol>
    </PanelFrame>
    <PanelFrame panelId="B34" title="Recent decisions & events" scopeLabel="Lifecycle records across bots · newest first · bounded to 40" state={events.length ? { kind: 'fresh' } : { kind: 'unavailable', reason: 'No lifecycle records are readable yet.' }}>
      <DataTable label="Recent decisions and events" rowId={row => `log:${row.bot}:${row.decisionId}`} rows={events} initialSort={{ id: 'at', desc: true }} pageSize={15} exportName="bot-events.csv" emptyText="No lifecycle records yet."
        columns={[
          { id: 'at', header: 'Time (UTC)', value: row => row.occurredAt, cell: row => stamp(row.occurredAt), size: 160 },
          { id: 'type', header: 'Type', value: row => row.action, cell: row => <span className="q-pill" data-tone={row.action === 'BUY' ? 'holding' : row.action === 'CANCEL' ? 'flat' : row.action === 'TRANSFER' ? 'neutral' : 'building'}>{row.action}</span>, size: 100 },
          { id: 'bot', header: 'Bot', value: row => displayBotName(row.bot), size: 130 },
          { id: 'pair', header: 'Pair', value: row => row.pair ?? '—', size: 100 },
          { id: 'outcome', header: 'Outcome', value: row => row.outcome ?? 'recorded', size: 130 },
          { id: 'price', header: 'Decision price', kind: 'number', value: row => row.decisionPrice ?? null, cell: row => row.decisionPrice ?? '—', size: 120 },
          { id: 'amount', header: 'Base amount', kind: 'number', value: row => row.amountBase ?? null, cell: row => row.amountBase ?? '—', size: 120 },
          { id: 'net', header: 'Net', kind: 'number', value: row => row.netPnl ?? null, cell: row => row.netPnl ? formatSigned(row.netPnl) : '—', className: row => metricTone(row.netPnl) ? `q-${metricTone(row.netPnl)}` : undefined, size: 90 },
          { id: 'reasons', header: 'Reasons', value: row => row.reasonCodes.join(', ') || '—', size: 200, wrap: true },
        ]} />
    </PanelFrame>
    <footer className="q-footer" data-panel-id="S06"><span className="q-footer-state" data-state={complete ? (fleet.every(reads => Object.values(botSourceFreshness(reads)).every(Boolean)) ? 'fresh' : 'stale') : 'collecting'}>{complete ? (fleet.every(reads => Object.values(botSourceFreshness(reads)).every(Boolean)) ? 'Lifecycle, performance, and quant sources current' : 'Lifecycle, performance, or quant source stale or not reporting') : `${fleet.length} / ${scoped.length} bots read`}</span><span>{server ?? 'Server not selected'} · UTC</span><span><Link to="/capital">Open Capital</Link></span></footer>
  </div>;
}
