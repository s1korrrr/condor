import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Activity, BarChart3, Wallet } from 'lucide-react';
import type { BotsPageResponse } from '@/lib/api';
import { displayBotName, type TradingVisualsSource } from '@/features/trading-visuals/sources';
import { ASSET_COLORS, formatDecimal, formatSigned, metricTone } from '@/features/quant-ops/format';
import { StateGlyph } from '@/features/quant-ops/primitives';
import type { PanelState } from '@/features/quant-ops/panel-state';
import type { OwnerReads } from './BotsRoster';
import { winRateText } from '@/features/bots/bot-net';
import { durationLabel, projectBotStats, type FleetBotInput } from '@/features/bots/fleet-tiles';
import { botChartsHref } from '@/features/bots/chart-links';
import './fleet-strip.css';

const tone = (value: string | null | undefined) => (value ?? 'unknown').toLowerCase().split(/[\s:]/)[0];
const label = (value: string | null | undefined) => value?.replaceAll('_', ' ') || 'unknown';
const toneClass = (value: number | string | null | undefined) => metricTone(value) ? `q-${metricTone(value)}` : undefined;

export function fleetInput(reads: OwnerReads, name = displayBotName(reads.bot)): FleetBotInput {
  return { bot: reads.bot, name, status: reads.status, view: reads.view, quant: reads.quant, cycles: reads.cycles, execution: reads.execution, health: reads.health, fillTotals: reads.fillTotals ?? null };
}

/** One compact card per registered bot: identity, lifecycle, operational counters and a small PnL chip (full PnL stays in Capital). */
function FleetBotCard({ source, reads, status, color, now }: { source: TradingVisualsSource; reads: OwnerReads | undefined; status: string | null; color: string; now: number }) {
  const quant = reads?.quant ?? null;
  const stats = reads ? projectBotStats(fleetInput(reads), now) : null;
  const pairs = quant?.pairs.length ? quant.pairs : (reads?.view?.pairs ?? []).map(row => ({ controllerId: row.controllerId, pair: row.pair, state: row.phase ?? 'UNKNOWN', planMode: null, planNext: row.planNext, nextCondition: row.reason, unrealized: row.bagPnl === null ? null : String(row.bagPnl) }));
  const freshness: PanelState = !reads ? { kind: 'collecting', reason: 'Reading owner observations' } : !reads.view ? { kind: 'incomplete', reason: 'Runtime observation has not been read yet' } : quant?.freshness === 'current' && !reads.view.stale ? { kind: 'fresh', observedAt: quant.observedAt } : { kind: 'stale', observedAt: quant?.observedAt ?? null, reason: 'Owner observation is not current; last-known values shown.' };
  const net = reads?.controller.total ?? null;
  const cycles = reads?.cycles ?? null;
  const bps = stats?.fees != null && stats.volume ? (stats.fees / stats.volume) * 10_000 : null;
  // A counter this bot has no source for is left out instead of printed as a placeholder.
  const maker = stats?.makers != null || stats?.takers != null ? ` · ${stats.makers ?? 0}M/${stats.takers ?? 0}T` : '';
  type Cell = { title: string; value: ReactNode };
  const cells: Cell[] = [];
  const add = (present: boolean, title: string, value: () => ReactNode) => { if (present) cells.push({ title, value: value() }); };
  if (stats) {
    add(stats.executors != null, 'Executors', () => stats.executors);
    add(stats.held != null, 'Positions', () => `${stats.held} / ${stats.registered}`);
    add(stats.orders != null, 'Working orders', () => stats.orders);
    add(stats.pendingEntries != null, 'Entries pending', () => `${stats.pendingEntries}${stats.unfilledEntries ? ` · ${stats.unfilledEntries} unfilled` : ''}`);
    add(stats.fills != null, 'Trades', () => `${stats.fills}${stats.opened24h ? ` · 24h ${stats.opened24h}` : ''}`);
    add(cycles != null, 'Win rate', () => winRateText(cycles!.stats));
    add(stats.fillRatio != null, 'Fill ratio', () => `${(stats.fillRatio! * 100).toFixed(1)}%${maker}`);
    add(stats.fees != null, 'Fees', () => `${formatDecimal(stats.fees!, 4)}${bps == null ? '' : ` · ${bps.toFixed(1)} bps`}`);
    add(stats.openLots != null, 'Oldest lot', () => stats.openLots === 0 ? 'none' : durationLabel(stats.oldestLotSeconds));
    add(stats.avgHoldSeconds != null, 'Avg hold', () => durationLabel(stats.avgHoldSeconds));
    add(stats.heartbeatAgeSeconds != null, 'Last report', () => <>{durationLabel(stats.heartbeatAgeSeconds)} ago{stats.sequence != null ? <small> · seq {stats.sequence}</small> : null}</>);
  }
  return <article className="q-card fs-card" data-state={freshness.kind} aria-label={`${source.bot} fleet card`} style={{ ['--fs-accent' as string]: color }}>
    <header className="fs-head">
      <div className="fs-id">
        <h3><i aria-hidden="true" />{displayBotName(source.bot)}</h3>
        <p className="q-muted">{source.bot} · {source.server}{stats?.bootId ? ` · boot ${stats.bootId.slice(0, 8)}` : ''}</p>
      </div>
      <div className="fs-head__state">
        <StateGlyph state={freshness} />
        <span className="q-pill" data-tone={tone(status)}>{label(status)}</span>
      </div>
    </header>
    <div className="q-tags">
      <span className="q-tag">Spot</span>
      {pairs.length > 0 && <span className="q-tag">{pairs.length} pair{pairs.length === 1 ? '' : 's'}</span>}
      {quant?.controllerName && <span className="q-tag">{quant.controllerName}</span>}
      {quant?.profile && <span className="q-tag">Profile {quant.profile}</span>}
      {quant?.executionMode && <span className="q-tag">{quant.executionMode}</span>}
      {stats?.stackHeartbeat && <span className="q-tag" data-tone={stats.stackHeartbeat === 'healthy' ? 'ok' : 'blocked'}>stack {stats.stackHeartbeat}</span>}
    </div>
    <dl className="fs-stats">
      {cells.map(cell => <div key={cell.title}><dt>{cell.title}</dt><dd>{cell.value}</dd></div>)}
      <div><dt title="Controller-report PnL; full PnL history is in Capital">PnL (controller)</dt><dd><span className={toneClass(net)}>{net == null ? '—' : `${formatSigned(net)} ${reads?.controller.quote ?? ''}`}</span></dd></div>
    </dl>
    {pairs.length > 0 && <ul className="fs-pairs" aria-label="Pairs">
      {pairs.map(pair => <li key={`${pair.controllerId ?? ''}:${pair.pair}`}>
        <Link to={botChartsHref(source.bot, pair.pair)} title={`${pair.pair} · ${label(pair.state)} · ${pair.planMode ?? ''} ${pair.planNext ?? pair.nextCondition ?? ''}`.trim()}>
          <strong>{pair.pair}</strong>
          <span className="q-pill" data-tone={tone(pair.state)}>{label(pair.state).toLowerCase()}</span>
          <em className={toneClass(pair.unrealized)}>{pair.unrealized == null ? '' : formatSigned(pair.unrealized)}</em>
        </Link>
      </li>)}
    </ul>}
    <footer className="fs-actions">
      <Link className="q-chip" to={botChartsHref(source.bot)}><BarChart3 size={13} aria-hidden="true" /> Charts</Link>
      <Link className="q-chip" to={`/capital?bot=${encodeURIComponent(source.bot)}`}><Wallet size={13} aria-hidden="true" /> Capital</Link>
      <Link className="q-chip" to={`/operations?bot=${encodeURIComponent(source.bot)}`}><Activity size={13} aria-hidden="true" /> Operations</Link>
    </footer>
  </article>;
}

/** One card per registered bot; N bots flow across the row. Bots are discovered from the source registry, never named here. */
export function FleetStrip({ sources, readsByBot, page, now }: {
  sources: TradingVisualsSource[]; readsByBot: Record<string, OwnerReads>; page?: BotsPageResponse; now: number;
}) {
  if (!sources.length) return null;
  return <section className="fs-grid" data-panel-id="B28" aria-label="Registered bots">
    {sources.map((source, index) => {
      const reads = readsByBot[`${source.server}:${source.bot}`];
      return <FleetBotCard key={`${source.server}:${source.bot}`} source={source} reads={reads} color={ASSET_COLORS[index % ASSET_COLORS.length]} now={now}
        status={reads?.status ?? page?.bots.find(item => item.bot_name === source.bot)?.status ?? null} />;
    })}
  </section>;
}
