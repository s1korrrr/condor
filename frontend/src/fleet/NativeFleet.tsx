import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Activity, BarChart3, Bot, Radio } from 'lucide-react';
import { api } from '@/lib/api';
import { authFetch } from '@/lib/auth-token';
import { transientReadFailure } from '@/lib/read-continuity';
import { useServer } from '@/hooks/useServer';
import { useServers } from '@/hooks/useServers';
import { displayBotName, parseTradingVisualsSources, sourcesForServer, type TradingVisualsSource } from '@/features/trading-visuals/sources';
import { projectQuantBotSummary } from '@/features/bots/quant-roster';
import { formatDecimal, formatSigned, metricTone } from '@/features/quant-ops/format';
import { RailBar, StateGlyph } from '@/features/quant-ops/primitives';
import { fleetCardState, operationsHref, projectFleetHealth, serviceRollup, tradingVisualsHref } from './native-fleet';
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
const stamp = (iso: string | null | undefined) => iso ? `${iso.replace('T', ' ').slice(11, 19)} UTC` : '—';
const uptime = (iso: string | null, now: number) => {
  if (!iso) return null;
  const seconds = (now - Date.parse(iso)) / 1000;
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return seconds < 3600 ? `${Math.round(seconds / 60)}m` : seconds < 86400 ? `${(seconds / 3600).toFixed(1)}h` : `${(seconds / 86400).toFixed(1)}d`;
};

function FleetCard({ source, status, now }: { source: TradingVisualsSource; status: string | null; now: number }) {
  const encoded = encodeURIComponent(source.bot);
  const summary = useQuery({ queryKey: ['native-quant-summary', source.server, source.bot], queryFn: ({ signal }) => readOptional(`/api/v1/trading-visuals/quant-summary?bot=${encoded}`, signal), refetchInterval: 10_000, retry: false });
  const operations = useQuery({ queryKey: ['native-operations', source.server, source.bot], queryFn: ({ signal }) => readOptional(`/api/v1/trading-visuals/operations?bot=${encoded}`, signal), refetchInterval: 15_000, retry: false });
  const quant = projectQuantBotSummary(summary.data?.payload, source.bot, Math.max(now, summary.dataUpdatedAt));
  const health = projectFleetHealth(operations.data?.payload, source.bot, Math.max(now, operations.dataUpdatedAt));
  const state = fleetCardState(quant, health, summary.data?.issue ?? null);
  const rollup = serviceRollup(health);
  const net = quant?.netLifecycle.value ?? quant?.netLifecycle.lastKnown ?? null;
  const owned = quant?.ownedValue.value ?? quant?.ownedValue.lastKnown ?? null;
  const quote = quant?.netLifecycle.unit ?? quant?.ownedValue.unit ?? '';
  const holding = quant?.pairs.filter(row => row.state.toUpperCase().includes('HOLD')).length ?? 0;
  return <article className="q-card nf-card" data-state={state.kind} aria-label={`${source.bot} fleet card`}>
    <header className="nf-head">
      <div>
        <h2><Bot size={16} aria-hidden="true" /> {displayBotName(source.bot)}</h2>
        <p className="q-muted">{source.bot} · {source.server}</p>
      </div>
      <div className="nf-head__state">
        <StateGlyph state={state} />
        {status && <span className="q-pill" data-tone={tone(status)}>{status}</span>}
      </div>
    </header>
    <div className="q-tags">
      <span className="q-tag">{quant?.executionMode ?? 'mode unavailable'}</span>
      <span className="q-tag">{quant?.controllerName ? `Controller ${quant.controllerName}` : 'Controller unavailable'}</span>
      <span className="q-tag">{quant?.profile ? `Profile ${quant.profile}` : 'Profile unavailable'}</span>
      <span className="q-tag">{quant?.ownershipBasis ?? 'ownership unavailable'}</span>
    </div>
    <p className="nf-state">{quant ? quant.state.replaceAll('_', ' ') : summary.isPending ? 'Reading owner summary…' : summary.data?.issue ?? 'Owner summary unavailable'}{quant?.lastKnown && <small className="q-muted"> · last published {stamp(quant.observedAt ?? quant.generatedAt)}</small>}</p>
    <div className="q-stats nf-stats">
      <span><small>Net lifecycle</small><strong className={metricTone(net) ? `q-${metricTone(net)}` : undefined}>{net == null ? '—' : `${formatSigned(net)} ${quote}`}</strong></span>
      <span><small>Owned value</small><strong>{owned == null ? '—' : `${formatDecimal(owned, 2)} ${quote}`}</strong></span>
      <span><small>Pairs</small><strong>{quant ? `${holding} holding / ${quant.pairs.length}` : '—'}</strong></span>
      <span><small>Wallet</small><strong>{quant?.wallet?.value ? `${formatDecimal(quant.wallet.value, 0)} ${quant.wallet.currency ?? ''}` : '—'}</strong></span>
    </div>
    {quant && quant.pairs.length > 0 && <ul className="nf-pairs" aria-label="Pairs">
      {quant.pairs.map(row => <li key={row.pair}>
        <Link to={tradingVisualsHref(source.bot, row.pair)} title={`${row.pair} · ${row.state} · ${row.planMode ?? ''} ${row.planNext ?? row.nextCondition ?? ''}`.trim()}>
          <strong>{row.pair}</strong>
          <span className="q-pill" data-tone={tone(row.state)}>{row.state.replaceAll('_', ' ').toLowerCase()}</span>
          <em className={metricTone(row.unrealized) ? `q-${metricTone(row.unrealized)}` : undefined}>{row.unrealized == null ? '' : formatSigned(row.unrealized)}</em>
        </Link>
      </li>)}
    </ul>}
    {quant?.riskRails.tightest && <RailBar name={quant.riskRails.tightest.name} used={quant.riskRails.tightest.used} limit={quant.riskRails.tightest.limit} unit={quant.riskRails.tightest.unit} state={quant.riskRails.tightest.state} utilization={quant.riskRails.tightest.utilization} />}
    <div className="nf-services" aria-label="Stack services">
      {health ? <>
        <span className="q-muted"><Radio size={12} aria-hidden="true" /> {rollup.healthy}/{rollup.total} services healthy · heartbeat {health.heartbeat.state}{health.heartbeat.bootId ? ` · boot ${health.heartbeat.bootId.slice(0, 8)}` : ''}</span>
        <div className="nf-services__dots">{health.services.map(row => <i key={row.id} className="op-dot" data-state={row.state} title={`${row.id} · ${row.state}${uptime(row.startedAt, now) ? ` · up ${uptime(row.startedAt, now)}` : ''}${row.restartCount ? ` · ${row.restartCount} restarts` : ''}\n${row.detail}`} />)}</div>
      </> : <span className="q-muted">{operations.isPending ? 'Reading stack services…' : operations.data?.issue ?? 'Stack observation unavailable'}</span>}
    </div>
    <footer className="nf-actions">
      <Link className="q-icon-btn" to="/bots"><Activity size={14} aria-hidden="true" /> Bots desk</Link>
      <Link className="q-icon-btn" to={tradingVisualsHref(source.bot)}><BarChart3 size={14} aria-hidden="true" /> Charts</Link>
      <Link className="q-icon-btn" to={operationsHref(source.bot)}><Radio size={14} aria-hidden="true" /> Operations</Link>
    </footer>
  </article>;
}

/** Fleet on a native server: every registered owner with its identity, state, pairs, tightest rail and stack health. */
export function NativeFleet() {
  const { server } = useServer();
  const servers = useServers();
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const sources = useQuery({ queryKey: ['native-command-desk-sources'], queryFn: async ({ signal }) => parseTradingVisualsSources(await read('/api/v1/trading-visuals/sources', signal)), retry: false, refetchInterval: 30_000 });
  const page = useQuery({ queryKey: ['bots', server], queryFn: () => api.getBots(server!), enabled: !!server, refetchInterval: 10_000, retry: false });
  const visible = !sources.isError || transientReadFailure(sources.error) ? sources.data ?? [] : [];
  const scoped = sourcesForServer(visible, server, servers.data ?? []);
  return <div className="quant-page nf-page" data-quant-ops="fleet">
    <header className="q-page-head">
      <div>
        <h1>Fleet</h1>
        <p className="q-kicker">Registered owners on {server ?? 'this server'} · identity, state, pairs and stack health from each owner's own reads. Per-bot PnL is never summed.</p>
      </div>
    </header>
    {sources.isPending && <p className="q-empty" role="status">Discovering registered owners…</p>}
    {sources.isError && !transientReadFailure(sources.error) && <p className="q-empty" role="alert">{(sources.error as Error).message}</p>}
    {!sources.isPending && !scoped.length && <p className="q-empty" role="status">No registered owner is authorized for reads on this server.</p>}
    <div className="nf-grid">
      {scoped.map(source => <FleetCard key={`${source.server}:${source.bot}`} source={source} status={page.data?.bots.find(row => row.bot_name === source.bot)?.status ?? null} now={now} />)}
    </div>
  </div>;
}
