import { Link } from 'react-router-dom';
import { Activity, BarChart3, Wallet } from 'lucide-react';
import type { BotsPageResponse } from '@/lib/api';
import { displayBotName, type TradingVisualsSource } from '@/features/trading-visuals/sources';
import { ASSET_COLORS, formatDecimal, formatSigned, metricTone } from '@/features/quant-ops/format';
import { StateGlyph } from '@/features/quant-ops/primitives';
import { SparkChart } from '@/features/quant-ops/kit/charts';
import type { PanelState } from '@/features/quant-ops/panel-state';
import type { OwnerReads } from './BotsRoster';
import { winRateText, type BotNet } from '@/features/bots/bot-net';
import './fleet-strip.css';

const tone = (value: string | null | undefined) => (value ?? 'unknown').toLowerCase().split(/[\s:]/)[0];
const label = (value: string | null | undefined) => value?.replaceAll('_', ' ') || 'unknown';
const toneClass = (value: number | string | null | undefined) => metricTone(value) ? `q-${metricTone(value)}` : undefined;

function FleetBotCard({ source, reads, status, color, net }: { source: TradingVisualsSource; reads: OwnerReads | undefined; status: string | null; color: string; net: BotNet | null }) {
  const quant = reads?.quant ?? null;
  const quote = reads?.controller.quote ?? quant?.netLifecycle.unit ?? null;
  const pairs = quant?.pairs ?? [];
  const openPairs = reads?.view ? reads.view.pairs.filter(row => row.quantity !== null && formatDecimal(row.quantity, 18) !== '0').length : null;
  const owned = quant?.ownedValue.value ?? quant?.ownedValue.lastKnown ?? null;
  const orders = reads?.view && reads.view.orders !== null && reads.view.ordersStatus.complete === true ? reads.view.orders.length : null;
  const freshness: PanelState = !reads ? { kind: 'collecting', reason: 'Reading owner observations' } : quant?.freshness === 'current' && !reads.view?.stale ? { kind: 'fresh', observedAt: quant.observedAt } : { kind: 'stale', observedAt: quant?.observedAt ?? null, reason: 'Owner observation is not current; last-known values shown.' };
  const cycles = reads?.cycles ?? null;
  const execution = reads?.execution ?? null;
  const points = reads?.day.points ?? [];
  return <article className="q-card fs-card" data-state={freshness.kind} aria-label={`${source.bot} fleet card`} style={{ ['--fs-accent' as string]: color }}>
    <header className="fs-head">
      <div className="fs-id">
        <h3><i aria-hidden="true" />{displayBotName(source.bot)}</h3>
        <p className="q-muted">{source.bot} · {source.server}</p>
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
    </div>
    <div className="fs-body">
      <section className="fs-pnl" aria-label="Net PnL">
        <div className="fs-pnl__head">
          <span className="q-muted">Net PnL · {net?.source ?? 'no net source'}</span>
          <strong className={toneClass(net?.value)}>{net?.value == null ? 'Unavailable' : formatSigned(net.value)}<small>{quote ?? ''}{net?.stale ? ' · last published' : ''}</small></strong>
          <span className="fs-deltas">
            <span className={toneClass(reads?.day.change)}>24h {reads?.day.change == null ? '—' : formatSigned(reads.day.change)}</span>
            <span className={toneClass(reads?.week.change)}>7d {reads?.week.change == null ? '—' : formatSigned(reads.week.change)}</span>
          </span>
        </div>
        {points.filter(point => point.value != null).length >= 2
          ? <SparkChart points={points.map(point => ({ time: point.time, value: point.value }))} positive={(reads?.day.change ?? 0) >= 0} height={78} unit={quote ?? undefined} format={value => formatSigned(value)} ariaLabel="24h saved net PnL" />
          : <p className="q-empty fs-empty">{reads?.day.reason ?? 'Reading saved performance…'}</p>}
      </section>
      <dl className="fs-stats">
        <div><dt>Positions</dt><dd>{openPairs == null ? '—' : `${openPairs} / ${reads?.view?.pairs.length ?? pairs.length}`}</dd></div>
        <div><dt>Inventory value</dt><dd>{owned == null ? '—' : `${formatDecimal(owned)} ${quant?.ownedValue.unit ?? ''}`}</dd></div>
        <div><dt>Realized · unrealized</dt><dd><span className={toneClass(reads?.controller.realized)}>{reads?.controller.realized == null ? '—' : formatSigned(reads.controller.realized)}</span> · <span className={toneClass(reads?.controller.unrealized)}>{reads?.controller.unrealized == null ? '—' : formatSigned(reads.controller.unrealized)}</span></dd></div>
        <div><dt>Win rate</dt><dd>{cycles ? winRateText(cycles.stats) : '—'}</dd></div>
        <div><dt>Fill ratio</dt><dd>{execution?.fillRatio == null ? '—' : `${(execution.fillRatio * 100).toFixed(1)}%`}</dd></div>
        <div><dt>Open orders</dt><dd>{orders == null ? '—' : orders}</dd></div>
        <div><dt>Fills · fees</dt><dd>{cycles ? `${cycles.stats.fillCount} · ${cycles.stats.fees == null ? '—' : formatDecimal(cycles.stats.fees, 4)}` : '—'}</dd></div>
        <div><dt>Heartbeat</dt><dd>{quant?.observedAt ? `${quant.observedAt.slice(11, 19)} UTC` : '—'}</dd></div>
      </dl>
    </div>
    {pairs.length > 0 && <ul className="fs-pairs" aria-label="Pairs">
      {pairs.map(pair => <li key={`${pair.controllerId ?? ''}:${pair.pair}`}>
        <Link to={`/trading-visuals?bot=${encodeURIComponent(source.bot)}&view=charts&pair=${encodeURIComponent(pair.pair)}`} title={`${pair.pair} · ${label(pair.state)} · ${pair.planMode ?? ''} ${pair.planNext ?? pair.nextCondition ?? ''}`.trim()}>
          <strong>{pair.pair}</strong>
          <span className="q-pill" data-tone={tone(pair.state)}>{label(pair.state).toLowerCase()}</span>
          <em className={toneClass(pair.unrealized)}>{pair.unrealized == null ? '' : formatSigned(pair.unrealized)}</em>
        </Link>
      </li>)}
    </ul>}
    <footer className="fs-actions">
      <Link className="q-chip" to={`/trading-visuals?bot=${encodeURIComponent(source.bot)}`}><BarChart3 size={13} aria-hidden="true" /> Charts</Link>
      <Link className="q-chip" to={`/capital?bot=${encodeURIComponent(source.bot)}`}><Wallet size={13} aria-hidden="true" /> Capital</Link>
      <Link className="q-chip" to={`/operations?bot=${encodeURIComponent(source.bot)}`}><Activity size={13} aria-hidden="true" /> Operations</Link>
    </footer>
  </article>;
}

/** B28: one rich card per registered bot. Cards fill the row; a lone bot spreads its stats beside its PnL. */
export function FleetStrip({ sources, readsByBot, page, netFor }: {
  sources: TradingVisualsSource[]; readsByBot: Record<string, OwnerReads>; page?: BotsPageResponse;
  netFor: (reads: OwnerReads) => BotNet;
}) {
  if (!sources.length) return null;
  return <section className="fs-grid" data-panel-id="B28" aria-label="Fleet">
    {sources.map((source, index) => {
      const reads = readsByBot[`${source.server}:${source.bot}`];
      return <FleetBotCard key={`${source.server}:${source.bot}`} source={source} reads={reads} color={ASSET_COLORS[index % ASSET_COLORS.length]}
        status={reads?.status ?? page?.bots.find(item => item.bot_name === source.bot)?.status ?? null} net={reads ? netFor(reads) : null} />;
    })}
  </section>;
}
