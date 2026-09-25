import { useEffect, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Activity, BarChart3, Bot, Radio, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { authFetch } from '@/lib/auth-token';
import { transientReadFailure } from '@/lib/read-continuity';
import { useServer } from '@/hooks/useServer';
import { useServers } from '@/hooks/useServers';
import { displayBotName, parseTradingVisualsSources, sourcesForServer, type TradingVisualsSource } from '@/features/trading-visuals/sources';
import { projectQuantBotSummary, type QuantBotSummary } from '@/features/bots/quant-roster';
import { pnlSeries, type PnlSeries } from '@/features/bots/pnl-series';
import { assetColor, formatDecimal, formatSigned, metricTone } from '@/features/quant-ops/format';
import { MetricCard, RailBar, StateGlyph } from '@/features/quant-ops/primitives';
import { DonutChart, SparkChart } from '@/features/quant-ops/kit/charts';
import { TileGrid } from '@/features/quant-ops/kit/grid';
import type { PanelState } from '@/features/quant-ops/panel-state';
import { fleetCardState, operationsHref, projectFleetHealth, serviceRollup, tradingVisualsHref, type FleetHealth } from './native-fleet';
import '@/features/quant-ops/quant-ops.css';
import './native-fleet.css';

async function read(path: string, signal: AbortSignal) {
  const response = await authFetch(path, { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), cache: 'no-store' });
  if (!response.ok) throw Object.assign(new Error(`Fleet read failed (${response.status}).`), { status: response.status });
  return response.json();
}
async function readOptional(path: string, signal: AbortSignal): Promise<{ payload: unknown; issue: string | null }> {
  try {
    const response = await authFetch(path, { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), cache: 'no-store' });
    if (!response.ok) return { payload: null, issue: response.status === 401 || response.status === 403 ? `Access denied (${response.status})` : `Read failed (${response.status})` };
    return { payload: await response.json(), issue: null };
  } catch { return { payload: null, issue: 'Read unavailable' }; }
}

const tone = (value: string | null | undefined) => (value ?? 'unknown').toLowerCase().split(/[\s:]/)[0];
const toneClass = (value: number | string | null | undefined) => metricTone(value) ? `q-${metricTone(value)}` : undefined;
const stamp = (iso: string | null | undefined) => iso ? `${iso.replace('T', ' ').slice(11, 19)} UTC` : '—';
const duration = (seconds: number | null) => seconds == null || !Number.isFinite(seconds) || seconds < 0 ? null : seconds < 3600 ? `${Math.round(seconds / 60)}m` : seconds < 86400 ? `${(seconds / 3600).toFixed(1)}h` : `${(seconds / 86400).toFixed(1)}d`;
const uptime = (iso: string | null, now: number) => iso ? duration((now - Date.parse(iso)) / 1000) : null;

type FleetReads = { source: TradingVisualsSource; status: string | null; quant: QuantBotSummary | null; health: FleetHealth | null; summaryIssue: string | null; operationsIssue: string | null; summaryPending: boolean; operationsPending: boolean; day: PnlSeries; state: PanelState };

/** Every owner read the page needs, per registered bot. Query keys match Bots, so both pages share one cache. */
function useFleetReads(sources: TradingVisualsSource[], statusFor: (bot: string) => string | null, now: number): FleetReads[] {
  const summaries = useQueries({ queries: sources.map(source => ({ queryKey: ['native-quant-summary', source.server, source.bot], queryFn: ({ signal }: { signal: AbortSignal }) => readOptional(`/api/v1/trading-visuals/quant-summary?bot=${encodeURIComponent(source.bot)}`, signal), refetchInterval: 10_000, retry: false })) });
  const operations = useQueries({ queries: sources.map(source => ({ queryKey: ['native-operations', source.server, source.bot], queryFn: ({ signal }: { signal: AbortSignal }) => readOptional(`/api/v1/trading-visuals/operations?bot=${encodeURIComponent(source.bot)}`, signal), refetchInterval: 15_000, retry: false })) });
  const days = useQueries({ queries: sources.map(source => ({ queryKey: ['native-pnl-history', source.server, source.bot, '1D'], queryFn: ({ signal }: { signal: AbortSignal }) => readOptional(`/api/v1/servers/${encodeURIComponent(source.server)}/bots/${encodeURIComponent(source.bot)}/performance-history?range=1D`, signal), refetchInterval: 30_000, retry: false })) });
  return sources.map((source, index) => {
    const summary = summaries[index], operation = operations[index], day = days[index];
    const quant = projectQuantBotSummary(summary.data?.payload, source.bot, Math.max(now, summary.dataUpdatedAt));
    const health = projectFleetHealth(operation.data?.payload, source.bot, Math.max(now, operation.dataUpdatedAt));
    const summaryIssue = summary.data?.issue ?? null;
    return {
      source, status: statusFor(source.bot), quant, health, summaryIssue, operationsIssue: operation.data?.issue ?? null,
      summaryPending: summary.isPending, operationsPending: operation.isPending,
      day: pnlSeries(day.data?.payload, source.bot, now), state: fleetCardState(quant, health, summaryIssue),
    };
  });
}

function FleetCard({ reads, now }: { reads: FleetReads; now: number }) {
  const { source, quant, health, status, state, day } = reads;
  const rollup = serviceRollup(health);
  const net = quant?.netLifecycle.value ?? quant?.netLifecycle.lastKnown ?? null;
  const owned = quant?.ownedValue.value ?? quant?.ownedValue.lastKnown ?? null;
  const quote = quant?.netLifecycle.unit ?? quant?.ownedValue.unit ?? '';
  const holding = quant?.pairs.filter(row => row.state.toUpperCase().includes('HOLD')).length ?? 0;
  // One slice per base asset: two controllers on the same asset add up instead of repeating a label.
  const ownedByAsset = new Map<string, number>();
  for (const row of quant?.pairs ?? []) {
    const value = row.markedValue == null ? NaN : Number(row.markedValue);
    if (Number.isFinite(value) && value > 0) ownedByAsset.set(row.pair.split('-')[0], (ownedByAsset.get(row.pair.split('-')[0]) ?? 0) + value);
  }
  const slices = [...ownedByAsset].map(([asset, value]) => ({ label: asset, value, color: assetColor(asset) }));
  const heartbeatAge = quant?.observedAt ? duration((now - Date.parse(quant.observedAt)) / 1000) : null;
  return <article className="q-card nf-card" data-state={state.kind} aria-label={`${source.bot} fleet card`}>
    <header className="nf-head">
      <div className="nf-id">
        <h2><Bot size={17} aria-hidden="true" /> {displayBotName(source.bot)}</h2>
        <p className="q-muted">{source.bot} · {source.server}{health?.heartbeat.bootId ? ` · boot ${health.heartbeat.bootId.slice(0, 8)}` : ''}</p>
      </div>
      <div className="nf-head__state">
        <StateGlyph state={state} />
        {status && <span className="q-pill" data-tone={tone(status)}>{status}</span>}
      </div>
    </header>
    <div className="q-tags">
      <span className="q-tag">Spot</span>
      <span className="q-tag">{quant?.executionMode ?? 'mode unavailable'}</span>
      <span className="q-tag">{quant?.controllerName ? `Controller ${quant.controllerName}` : 'Controller unavailable'}</span>
      <span className="q-tag">{quant?.profile ? `Profile ${quant.profile}` : 'Profile unavailable'}</span>
      <span className="q-tag">{quant?.ownershipBasis ?? 'ownership unavailable'}</span>
    </div>
    <div className="nf-body">
      <section className="nf-panel nf-pnl" aria-label="Net lifecycle PnL">
        <span className="q-muted">Net lifecycle PnL{quant?.lastKnown ? ` · last published ${stamp(quant.observedAt ?? quant.generatedAt)}` : ''}</span>
        <strong className={toneClass(net)}>{net == null ? 'Unavailable' : formatSigned(net)}<small>{quote}</small></strong>
        <span className={`nf-delta ${toneClass(day.change) ?? ''}`}>24h {day.change == null ? '—' : formatSigned(day.change)}</span>
        {day.points.filter(point => point.value != null).length >= 2
          ? <SparkChart points={day.points.map(point => ({ time: point.time, value: point.value }))} positive={(day.change ?? 0) >= 0} height={86} unit={day.quote ?? undefined} format={value => formatSigned(value)} ariaLabel="24h saved net PnL" />
          : <p className="q-empty">{day.reason ?? 'Reading saved performance…'}</p>}
        <p className="nf-state">{quant ? quant.state.replaceAll('_', ' ') : reads.summaryPending ? 'Reading owner summary…' : reads.summaryIssue ?? 'Owner summary unavailable'}</p>
      </section>
      <section className="nf-panel" aria-label="Owned value by asset">
        <span className="q-muted">Owned value by asset</span>
        {slices.length ? <DonutChart slices={slices} center={owned == null ? '—' : formatDecimal(owned)} sub={quote || 'owned'} unit={quote} /> : <p className="q-empty">No marked owned inventory in this observation.</p>}
      </section>
      <dl className="nf-stats">
        <div><dt>Owned value</dt><dd>{owned == null ? '—' : `${formatDecimal(owned)} ${quote}`}</dd></div>
        <div><dt>Pairs holding</dt><dd>{quant ? `${holding} / ${quant.pairs.length}` : '—'}</dd></div>
        <div><dt>Shared wallet</dt><dd>{quant?.wallet?.value ? `${formatDecimal(quant.wallet.value, 0)} ${quant.wallet.currency ?? ''}` : '—'}</dd></div>
        <div><dt>Heartbeat</dt><dd>{health ? health.heartbeat.state : '—'}{heartbeatAge ? ` · ${heartbeatAge} ago` : ''}</dd></div>
        <div><dt>Services</dt><dd>{health ? `${rollup.healthy} / ${rollup.total} healthy` : '—'}</dd></div>
        <div><dt>Lifecycle</dt><dd>{health?.heartbeat.lifecycleState?.replaceAll('_', ' ') ?? quant?.state.replaceAll('_', ' ') ?? '—'}</dd></div>
      </dl>
    </div>
    {quant && quant.pairs.length > 0 && <ul className="nf-pairs" aria-label="Pairs">
      {quant.pairs.map(row => <li key={`${row.controllerId ?? ''}:${row.pair}`}>
        <Link to={tradingVisualsHref(source.bot, row.pair)} title={`${row.pair} · ${row.state} · ${row.planMode ?? ''} ${row.planNext ?? row.nextCondition ?? ''}`.trim()}>
          <i style={{ background: assetColor(row.pair.split('-')[0]) }} aria-hidden="true" />
          <strong>{row.pair}</strong>
          <span className="q-pill" data-tone={tone(row.state)}>{row.state.replaceAll('_', ' ').toLowerCase()}</span>
          <em className={toneClass(row.unrealized)}>{row.unrealized == null ? '' : formatSigned(row.unrealized)}</em>
        </Link>
      </li>)}
    </ul>}
    {quant?.riskRails.tightest && <RailBar name={quant.riskRails.tightest.name} used={quant.riskRails.tightest.used} limit={quant.riskRails.tightest.limit} unit={quant.riskRails.tightest.unit} state={quant.riskRails.tightest.state} utilization={quant.riskRails.tightest.utilization} />}
    <div className="nf-services" aria-label="Stack services">
      {health ? <>
        <span className="q-muted"><Radio size={12} aria-hidden="true" /> {rollup.healthy}/{rollup.total} services healthy · heartbeat {health.heartbeat.state}</span>
        <ul className="nf-services__list">{health.services.map(row => <li key={row.id} data-state={row.state} title={`${row.id} · ${row.state}${uptime(row.startedAt, now) ? ` · up ${uptime(row.startedAt, now)}` : ''}${row.restartCount ? ` · ${row.restartCount} restarts` : ''}\n${row.detail}`}>
          <i className="op-dot" data-state={row.state} aria-hidden="true" /><span>{row.id}</span><small>{uptime(row.startedAt, now) ?? row.state}</small>
        </li>)}</ul>
      </> : <span className="q-muted">{reads.operationsPending ? 'Reading stack services…' : reads.operationsIssue ?? 'Stack observation unavailable'}</span>}
    </div>
    <footer className="nf-actions">
      <Link className="q-chip" to="/bots"><Activity size={14} aria-hidden="true" /> Bots desk</Link>
      <Link className="q-chip" to={tradingVisualsHref(source.bot)}><BarChart3 size={14} aria-hidden="true" /> Charts</Link>
      <Link className="q-chip" to={`/capital?bot=${encodeURIComponent(source.bot)}`}><Wallet size={14} aria-hidden="true" /> Capital</Link>
      <Link className="q-chip" to={operationsHref(source.bot)}><Radio size={14} aria-hidden="true" /> Operations</Link>
    </footer>
  </article>;
}

/** Fleet on a native server: a summary strip, then every registered owner with identity, PnL, inventory, rails and stack health. */
export function NativeFleet() {
  const { server } = useServer();
  const servers = useServers();
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const sources = useQuery({ queryKey: ['native-command-desk-sources'], queryFn: async ({ signal }) => parseTradingVisualsSources(await read('/api/v1/trading-visuals/sources', signal)), retry: false, refetchInterval: 30_000 });
  const page = useQuery({ queryKey: ['bots', server], queryFn: () => api.getBots(server!), enabled: !!server, refetchInterval: 10_000, retry: false });
  const visible = !sources.isError || transientReadFailure(sources.error) ? sources.data ?? [] : [];
  const scoped = sourcesForServer(visible, server, servers.data ?? []);
  const fleet = useFleetReads(scoped, bot => page.data?.bots.find(row => row.bot_name === bot)?.status ?? null, now);
  const running = fleet.filter(row => row.status === 'running').length;
  const statusKnown = Boolean(page.data) && fleet.every(row => row.status != null);
  const services = fleet.reduce((total, row) => { const rollup = serviceRollup(row.health); return { healthy: total.healthy + rollup.healthy, total: total.total + rollup.total }; }, { healthy: 0, total: 0 });
  const healthRead = fleet.length > 0 && fleet.every(row => row.health != null);
  const heartbeats = fleet.filter(row => row.health?.heartbeat.state === 'healthy').length;
  const fresh = fleet.filter(row => row.state.kind === 'fresh').length;
  const pairs = fleet.flatMap(row => row.quant?.pairs ?? []);
  const holding = pairs.filter(row => row.state.toUpperCase().includes('HOLD')).length;
  const single = fleet.length === 1 ? fleet[0] : null;
  const singleOwned = single?.quant ? single.quant.ownedValue.value ?? single.quant.ownedValue.lastKnown : null;
  const singleOwnedStale = single?.quant != null && single.quant.ownedValue.value == null && single.quant.ownedValue.lastKnown != null;
  const singleNet = single?.quant ? single.quant.netLifecycle.value ?? single.quant.netLifecycle.lastKnown : null;
  const singleNetStale = single?.quant != null && single.quant.netLifecycle.value == null && single.quant.netLifecycle.lastKnown != null;
  const perBot = 'Per-bot values are never summed across owners on a shared wallet; see each card.';
  return <div className="nf-page" data-quant-ops="fleet">
    <header className="q-page-head">
      <div>
        <p className="q-muted" data-panel-id="S01">RSIBOT · Modular V2 · Fleet</p>
        <h1>Fleet</h1>
        <p className="q-kicker">Registered owners on {server ?? 'this server'} · identity, state, pairs and stack health from each owner's own reads. Per-bot PnL is never summed.</p>
      </div>
    </header>
    {sources.isPending && <p className="q-empty" role="status">Discovering registered owners…</p>}
    {sources.isError && !transientReadFailure(sources.error) && <p className="q-empty" role="alert">{(sources.error as Error).message}</p>}
    {!sources.isPending && !scoped.length && <p className="q-empty" role="status">No registered owner is authorized for reads on this server.</p>}
    {scoped.length > 0 && <TileGrid label="Fleet summary" min={190} max={6}>
      <MetricCard panelId="F01" title="Registered owners" value={String(scoped.length)} state={{ kind: 'fresh' }} note={scoped.map(source => displayBotName(source.bot)).join(', ')} />
      <MetricCard panelId="F02" title="Running" value={statusKnown ? `${running} / ${scoped.length}` : 'Unavailable'} state={statusKnown ? { kind: 'fresh' } : { kind: 'stale', reason: 'Lifecycle status is missing for a registered owner.' }} note="Verified running lifecycle / registered" />
      <MetricCard panelId="F03" title="Services healthy" value={healthRead ? `${services.healthy} / ${services.total}` : 'Unavailable'} tone={healthRead && services.healthy < services.total ? 'negative' : undefined} state={healthRead ? services.healthy === services.total ? { kind: 'fresh' } : { kind: 'incomplete', reason: 'At least one stack service is not healthy.' } : { kind: 'collecting', reason: 'Reading stack services' }} note={`${heartbeats} / ${fleet.length} heartbeat${fleet.length === 1 ? '' : 's'} healthy`} />
      <MetricCard panelId="F04" title="Fresh observations" value={`${fresh} / ${fleet.length}`} state={fresh === fleet.length ? { kind: 'fresh' } : { kind: 'stale', reason: 'At least one owner observation is not current.' }} note="Owner summary current and heartbeat healthy" />
      <MetricCard panelId="F05" title="Pairs holding" value={`${holding} / ${pairs.length}`} state={fleet.every(row => row.quant) ? { kind: 'fresh' } : { kind: 'collecting', reason: 'Reading owner summaries' }} note="Pairs with a held bag / registered pairs" />
      <MetricCard panelId="F06" title={single ? 'Owned value' : 'Owned value (per bot)'} value={singleOwned == null ? 'Unavailable' : formatDecimal(singleOwned)} unit={single?.quant?.ownedValue.unit ?? undefined} state={single ? singleOwned == null ? { kind: 'unavailable', reason: 'The owner has not published an owned value.' } : singleOwnedStale ? { kind: 'stale', observedAt: single.quant?.observedAt ?? null, reason: 'Owner last published owned value; the current observation is not fresh.' } : { kind: 'fresh' } : { kind: 'incomplete', reason: perBot }} note={single ? `Net lifecycle ${singleNet == null ? '—' : formatSigned(singleNet)} ${single.quant?.netLifecycle.unit ?? ''}${singleNetStale ? ' · last published' : ''}` : perBot} />
    </TileGrid>}
    <div className="nf-grid">
      {fleet.map(reads => <FleetCard key={`${reads.source.server}:${reads.source.bot}`} reads={reads} now={now} />)}
    </div>
  </div>;
}
