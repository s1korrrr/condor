import type { PanelState } from '@/features/quant-ops/panel-state';
import { formatDecimal } from '@/features/quant-ops/format';
import { openPairCount, type buildBotPositionView } from './position-view';
import type { ExecutionStats, QuantBotSummary, QuantCycles } from './quant-roster';
import { stackRestarts, type FleetHealth } from './fleet-health';

/**
 * Bot-focused fleet KPIs. Every tile is a sum or union over ALL registered bots, computed from the reads the
 * Bots page already holds; money PnL stays in Capital. A tile with no source in any bot is omitted, never
 * printed as "Unavailable". When only some bots have a source the tile says how many it covers.
 */

type View = Pick<ReturnType<typeof buildBotPositionView>, 'pairs' | 'orders' | 'ordersStatus' | 'activeOrderCount' | 'activeExecutorCount' | 'stale' | 'ageSeconds' | 'observedAt'>;

export type FleetBotInput = {
  bot: string; name: string; status: string | null;
  view: View | null;
  quant: Pick<QuantBotSummary, 'freshness' | 'observedAt' | 'pairs' | 'cycleCounts'> | null;
  cycles: QuantCycles | null;
  execution: ExecutionStats | null;
  health: FleetHealth | null;
  /** Lifetime totals from the owner's fill ledger; used only where the owner publishes no scored cycles (older reporting). */
  fillTotals?: FillTotals | null;
};

export type FillTotals = { count: number; fees: number | null; volume: number | null; quote: string | null; sinceMs: number | null };

/** Sums an owner's recorded fills. Fees and volume stay null when any row lacks a number, so a partial ledger is never presented as complete. */
export function fillTotals(rows: readonly { fee: string | null; volume: string | null; pair: string | null; timestamp: string | null }[]): FillTotals | null {
  if (!rows.length) return null;
  const quotes = new Set(rows.map(row => (row.pair ?? '').split('-')[1]).filter(Boolean));
  const sum = (pick: (row: (typeof rows)[number]) => string | null) => rows.every(row => finite(pick(row)) !== null) ? rows.reduce((total, row) => total + (finite(pick(row)) ?? 0), 0) : null;
  const times = rows.map(row => at(row.timestamp)).filter((value): value is number => value !== null);
  return { count: rows.length, fees: sum(row => row.fee), volume: sum(row => row.volume), quote: quotes.size === 1 ? [...quotes][0] : null, sinceMs: times.length ? Math.min(...times) : null };
}

export type BotStats = {
  bot: string; name: string; status: string | null;
  executors: number | null; executorsBasis: 'runtime' | 'lifecycle' | null;
  held: number | null; registered: number;
  orders: number | null;
  pendingEntries: number | null; unfilledEntries: number | null;
  fills: number | null; opened24h: number | null; closed24h: number | null;
  scored: number | null; wins: number | null; losses: number | null; breakeven: number | null; minSample: number;
  avgHoldSeconds: number | null;
  oldestLotSeconds: number | null; openLots: number | null;
  ordersCreated: number | null; ordersFilled: number | null; ordersCanceled: number | null; ordersRejected: number | null;
  fillRatio: number | null; makers: number | null; takers: number | null; orderSampleSufficient: boolean;
  fees: number | null; volume: number | null; quote: string | null;
  heartbeatAgeSeconds: number | null; heartbeatCurrent: boolean; stackHeartbeat: string | null; bootId: string | null; sequence: number | null;
};

const DAY_MS = 86_400_000;
const finite = (value: unknown): number | null => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const stage = (execution: ExecutionStats | null, name: string): number | null => execution?.funnel.find(row => row.stage === name)?.count ?? null;
const at = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
};

export function durationLabel(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86_400).toFixed(1)}d`;
}

/** One bot's counters from its own reads. Null means that bot has no source for the counter. */
export function projectBotStats(input: FleetBotInput, now: number): BotStats {
  const { view, quant, cycles, execution, health } = input;
  const runtimeExecutors = view ? view.activeExecutorCount : null;
  const lifecycleExecutors = cycles?.counts.open ?? quant?.cycleCounts.open ?? null;
  const executors = runtimeExecutors ?? lifecycleExecutors;
  const held = view ? openPairCount(view.pairs) : quant ? quant.pairs.filter(pair => (finite(pair.units) ?? 0) > 0).length : null;
  const registered = view?.pairs.length ?? quant?.pairs.length ?? 0;
  const orders = view?.orders != null && view.ordersStatus.complete === true ? view.orders.length
    : view?.activeOrderCount ?? (quant && quant.pairs.length > 0 && quant.pairs.every(pair => pair.workingOrders !== null) ? quant.pairs.reduce((total, pair) => total + pair.workingOrders!, 0) : null);
  const rows = cycles?.cycles ?? [];
  const since = now - DAY_MS;
  const opened24h = cycles ? rows.filter(row => { const time = at(row.firstFillAt ?? row.openedAt); return time !== null && time >= since && time <= now + 5_000; }).length : null;
  const closed24h = cycles ? rows.filter(row => { const time = at(row.closedAt); return time !== null && time >= since && time <= now + 5_000; }).length : null;
  const fillRows = rows.length ? rows.reduce((total, row) => total + row.fillCount, 0) : null;
  const stats = cycles?.stats ?? null;
  const lots = cycles?.inventoryAge ?? null;
  const ages = (lots?.lots ?? []).map(lot => lot.ageSeconds).filter((value): value is number => value != null);
  const oldestLot = lots ? lots.oldestSeconds ?? (ages.length ? Math.max(...ages) : null) : null;
  const created = stage(execution, 'orders_created');
  const observedAt = quant?.observedAt ?? view?.observedAt ?? null;
  const observedMs = at(observedAt);
  const age = observedMs === null ? null : Math.max(0, (now - observedMs) / 1000);
  return {
    bot: input.bot, name: input.name, status: input.status,
    executors, executorsBasis: runtimeExecutors != null ? 'runtime' : lifecycleExecutors != null ? 'lifecycle' : null,
    held, registered, orders,
    pendingEntries: cycles ? cycles.counts.entry_pending ?? 0 : null,
    unfilledEntries: cycles ? cycles.counts.entry_unfilled ?? 0 : null,
    fills: stats?.fillCount ?? fillRows ?? input.fillTotals?.count ?? null, opened24h, closed24h,
    scored: stats ? stats.scored : null, wins: stats ? stats.wins : null, losses: stats ? stats.losses : null, breakeven: stats ? stats.breakeven : null,
    minSample: stats?.minSample ?? 0,
    avgHoldSeconds: stats && stats.scored > 0 ? stats.averageHoldingSeconds : null,
    oldestLotSeconds: oldestLot, openLots: lots ? lots.lots.length : null,
    ordersCreated: created, ordersFilled: stage(execution, 'orders_filled'), ordersCanceled: stage(execution, 'orders_canceled'), ordersRejected: stage(execution, 'orders_rejected'),
    fillRatio: execution?.fillRatio ?? null, makers: execution?.makerCount ?? null, takers: execution?.takerCount ?? null,
    orderSampleSufficient: execution?.orderSampleSufficient === true,
    fees: stats ? finite(stats.fees) : input.fillTotals?.fees ?? null, volume: stats ? finite(stats.grossVolume) : input.fillTotals?.volume ?? null, quote: cycles?.quote ?? input.fillTotals?.quote ?? null,
    heartbeatAgeSeconds: age, heartbeatCurrent: quant?.freshness === 'current',
    stackHeartbeat: health?.heartbeat.state ?? null, bootId: health?.heartbeat.bootId ?? null, sequence: health?.heartbeat.sequence ?? null,
  };
}

export type FleetTile = {
  id: string; title: string; value: string; unit?: string;
  /** Short, named basis shown under the value. */
  basis: string;
  /** Per-bot values for the hover/footnote; omitted for a single bot. */
  perBot: { bot: string; name: string; text: string }[];
  state: PanelState;
};

const sum = (values: (number | null)[]): number | null => {
  const known = values.filter((value): value is number => value != null);
  return known.length ? known.reduce((total, value) => total + value, 0) : null;
};
const coverage = (known: number, total: number, source: string): PanelState =>
  known >= total ? { kind: 'fresh' } : { kind: 'incomplete', reason: `${source} read for ${known} of ${total} bots; the value covers those bots only.` };
const percent = (ratio: number, digits = 1) => `${(ratio * 100).toFixed(digits)}%`;

/** Tiles over the whole set of bots. Empty when no bot is registered. */
export function projectFleetTiles(inputs: readonly FleetBotInput[], now: number): FleetTile[] {
  const bots = inputs.map(input => projectBotStats(input, now));
  const total = bots.length;
  if (!total) return [];
  const tiles: FleetTile[] = [];
  const per = (read: (stats: BotStats) => string | null) => bots.flatMap(stats => { const text = read(stats); return text == null ? [] : [{ bot: stats.bot, name: stats.name, text }]; });
  const withValue = (read: (stats: BotStats) => number | null) => bots.filter(stats => read(stats) != null).length;

  // Bots: lifecycle plus owner heartbeat.
  const running = bots.filter(stats => stats.status === 'running').length;
  const known = bots.filter(stats => stats.status != null && ['running', 'starting', 'stopping', 'stopped', 'exited'].includes(stats.status)).length;
  const fresh = bots.filter(stats => stats.heartbeatCurrent).length;
  tiles.push({
    id: 'B01', title: 'Active bots', value: known === total ? `${running} / ${total}` : `${running} verified / ${total}`,
    basis: known === total ? `lifecycle status · heartbeat current ${fresh}/${total}` : `${total - known} bot${total - known === 1 ? '' : 's'} without a verified lifecycle · heartbeat current ${fresh}/${total}`,
    perBot: per(stats => `${(stats.status ?? 'unverified').replaceAll('_', ' ')}${stats.heartbeatCurrent ? '' : ' · heartbeat stale'}`),
    state: known === total && fresh === total ? { kind: 'fresh' } : { kind: 'stale', reason: known < total ? `Lifecycle status is stale or unknown for ${total - known} bot(s); only verified running bots are counted.` : `${total - fresh} bot heartbeat(s) are not current.` },
  });

  const executors = sum(bots.map(stats => stats.executors));
  if (executors !== null) {
    const known = withValue(stats => stats.executors);
    const runtime = bots.filter(stats => stats.executorsBasis === 'runtime').length;
    tiles.push({
      id: 'B26', title: 'Active executors', value: String(executors),
      basis: runtime === known ? 'runtime active executors' : runtime === 0 ? 'open lifecycle cycles' : 'runtime executors · lifecycle cycles for the rest',
      perBot: per(stats => stats.executors == null ? null : String(stats.executors)), state: coverage(known, total, 'Executor count'),
    });
  }

  const held = sum(bots.map(stats => stats.held));
  if (held !== null) {
    const readBots = bots.filter(stats => stats.held != null);
    tiles.push({
      id: 'B03', title: 'Open positions', value: `${held} / ${readBots.reduce((count, stats) => count + stats.registered, 0)}`,
      basis: 'pairs holding units / registered pairs',
      perBot: per(stats => stats.held == null ? null : `${stats.held}/${stats.registered}`), state: coverage(readBots.length, total, 'Inventory'),
    });
  }

  const orders = sum(bots.map(stats => stats.orders));
  if (orders !== null) {
    tiles.push({
      id: 'B27', title: 'Working orders', value: String(orders), basis: 'exchange orders resting now',
      perBot: per(stats => stats.orders == null ? null : String(stats.orders)), state: coverage(withValue(stats => stats.orders), total, 'Order list'),
    });
  }

  const pending = sum(bots.map(stats => stats.pendingEntries));
  if (pending !== null) {
    const unfilled = sum(bots.map(stats => stats.unfilledEntries)) ?? 0;
    tiles.push({
      id: 'B03-entries', title: 'Entries pending', value: String(pending), basis: `${unfilled} entr${unfilled === 1 ? 'y' : 'ies'} ended unfilled · lifecycle cycles`,
      perBot: per(stats => stats.pendingEntries == null ? null : `${stats.pendingEntries} pending · ${stats.unfilledEntries ?? 0} unfilled`), state: coverage(withValue(stats => stats.pendingEntries), total, 'Cycle projection'),
    });
  }

  const fills = sum(bots.map(stats => stats.fills));
  if (fills !== null) {
    const opened = sum(bots.map(stats => stats.opened24h)), closed = sum(bots.map(stats => stats.closed24h));
    tiles.push({
      id: 'B05', title: 'Trades', value: String(fills), unit: 'fills',
      basis: opened == null ? 'native fills, lifetime' : `lifetime fills · 24h ${opened} opened / ${closed ?? 0} closed cycles`,
      perBot: per(stats => stats.fills == null ? null : `${stats.fills} fills${stats.opened24h == null ? '' : ` · 24h ${stats.opened24h}/${stats.closed24h ?? 0}`}`), state: coverage(withValue(stats => stats.fills), total, 'Fill count'),
    });
  }

  const scored = sum(bots.map(stats => stats.scored));
  if (scored !== null) {
    const wins = sum(bots.map(stats => stats.wins)) ?? 0, losses = sum(bots.map(stats => stats.losses)) ?? 0, breakeven = sum(bots.map(stats => stats.breakeven)) ?? 0;
    const minSample = Math.max(0, ...bots.map(stats => stats.minSample));
    const sufficient = scored >= Math.max(1, minSample);
    tiles.push({
      id: 'B36', title: 'Win rate', value: sufficient ? percent(wins / scored) : `${wins}W / ${losses}L`,
      basis: `${wins}W / ${losses}L${breakeven ? ` / ${breakeven} even` : ''} · ${scored} scored closed cycle${scored === 1 ? '' : 's'}${sufficient ? '' : ` (rate after ${minSample})`}`,
      perBot: per(stats => stats.scored == null ? null : `${stats.wins}W/${stats.losses}L`),
      state: sufficient ? coverage(withValue(stats => stats.scored), total, 'Cycle projection') : { kind: 'collecting', sample: { have: scored, need: Math.max(1, minSample) }, reason: 'Scored closed cycles' },
    });
    const holdBots = bots.filter(stats => stats.avgHoldSeconds != null && (stats.scored ?? 0) > 0);
    const holdWeight = holdBots.reduce((count, stats) => count + stats.scored!, 0);
    if (holdBots.length && holdWeight > 0) {
      tiles.push({
        id: 'B36-hold', title: 'Average hold', value: durationLabel(holdBots.reduce((acc, stats) => acc + stats.avgHoldSeconds! * stats.scored!, 0) / holdWeight),
        basis: 'first fill to close · scored cycles, weighted',
        perBot: per(stats => stats.avgHoldSeconds == null ? null : durationLabel(stats.avgHoldSeconds)), state: coverage(holdBots.length, total, 'Holding time'),
      });
    }
  }

  const lotBots = bots.filter(stats => stats.openLots != null);
  if (lotBots.length) {
    const lots = lotBots.reduce((count, stats) => count + stats.openLots!, 0);
    const oldest = lotBots.reduce<number | null>((max, stats) => stats.oldestLotSeconds == null ? max : Math.max(max ?? 0, stats.oldestLotSeconds), null);
    if (lots === 0 || oldest !== null) {
      tiles.push({
        id: 'B39', title: 'Oldest open lot', value: lots === 0 ? 'No open lots' : durationLabel(oldest),
        basis: `${lots} open lot${lots === 1 ? '' : 's'} · from native fill times`,
        perBot: per(stats => stats.openLots == null ? null : stats.openLots === 0 ? 'none' : durationLabel(stats.oldestLotSeconds)), state: coverage(lotBots.length, total, 'Lot age'),
      });
    }
  }

  const created = sum(bots.map(stats => stats.ordersCreated));
  const filledOrders = sum(bots.map(stats => stats.ordersFilled));
  const ratios = bots.map(stats => stats.fillRatio);
  if (created !== null && created > 0 && filledOrders !== null) {
    const canceled = sum(bots.map(stats => stats.ordersCanceled)) ?? 0, rejected = sum(bots.map(stats => stats.ordersRejected)) ?? 0;
    const makers = sum(bots.map(stats => stats.makers)), takers = sum(bots.map(stats => stats.takers));
    const sufficient = bots.filter(stats => stats.ordersCreated != null).every(stats => stats.orderSampleSufficient);
    tiles.push({
      id: 'B37', title: 'Fill ratio', value: percent(filledOrders / created),
      basis: `${filledOrders}/${created} orders filled · ${canceled} canceled · ${rejected} rejected${makers != null || takers != null ? ` · maker ${makers ?? 0} / taker ${takers ?? 0}` : ''}`,
      perBot: per(stats => stats.fillRatio == null ? null : percent(stats.fillRatio)),
      state: !sufficient ? { kind: 'collecting', reason: 'Order sample is below the owner minimum for at least one bot; the ratio is provisional.' } : coverage(withValue(stats => stats.ordersCreated), total, 'Order funnel'),
    });
  } else if (ratios.some(ratio => ratio != null)) {
    const known = ratios.filter((ratio): ratio is number => ratio != null);
    tiles.push({
      id: 'B37', title: 'Fill ratio', value: percent(known.reduce((acc, ratio) => acc + ratio, 0) / known.length),
      basis: 'filled / placed orders · mean of per-bot ratios',
      perBot: per(stats => stats.fillRatio == null ? null : percent(stats.fillRatio)), state: coverage(known.length, total, 'Execution stats'),
    });
  }

  // Fees stay per quote currency; two quotes are shown side by side, never added.
  const feeBots = bots.filter(stats => stats.fees != null);
  if (feeBots.length) {
    const byQuote = new Map<string, { fees: number; volume: number | null }>();
    for (const stats of feeBots) {
      const key = stats.quote && stats.quote !== 'unknown' ? stats.quote : '';
      const entry = byQuote.get(key) ?? { fees: 0, volume: 0 };
      entry.fees += stats.fees!;
      entry.volume = entry.volume == null || stats.volume == null ? null : entry.volume + stats.volume;
      byQuote.set(key, entry);
    }
    const groups = [...byQuote.entries()];
    const bps = groups.length === 1 && groups[0][1].volume ? (groups[0][1].fees / groups[0][1].volume) * 10_000 : null;
    tiles.push({
      id: 'B38', title: 'Lifetime fees', value: groups.map(([quote, entry]) => `${formatDecimal(entry.fees, 4)}${quote && groups.length > 1 ? ` ${quote}` : ''}`).join(' + '),
      unit: groups.length === 1 ? groups[0][0] || undefined : undefined,
      basis: bps == null ? 'exact native fill fees' : `${bps.toFixed(1)} bps of ${formatDecimal(groups[0][1].volume!, 0)} traded`,
      perBot: per(stats => stats.fees == null ? null : `${formatDecimal(stats.fees, 4)}${stats.volume ? ` · ${((stats.fees / stats.volume) * 10_000).toFixed(1)} bps` : ''}`), state: coverage(feeBots.length, total, 'Fee receipts'),
    });
  }

  const ages = bots.filter(stats => stats.heartbeatAgeSeconds != null);
  if (ages.length) {
    const oldest = ages.reduce((max, stats) => stats.heartbeatAgeSeconds! > max.heartbeatAgeSeconds! ? stats : max);
    const healthy = bots.filter(stats => stats.stackHeartbeat === 'healthy').length, observed = bots.filter(stats => stats.stackHeartbeat != null).length;
    tiles.push({
      id: 'B01-heartbeat', title: 'Last report', value: durationLabel(oldest.heartbeatAgeSeconds),
      basis: `oldest owner heartbeat${observed ? ` · stack heartbeat healthy ${healthy}/${observed}` : ''}`,
      perBot: per(stats => stats.heartbeatAgeSeconds == null ? null : `${durationLabel(stats.heartbeatAgeSeconds)} ago`),
      state: bots.every(stats => stats.heartbeatCurrent) ? coverage(ages.length, total, 'Heartbeat') : { kind: 'stale', reason: 'At least one owner heartbeat is older than its 30 second freshness contract.' },
    });
  }

  const restarts = stackRestarts(inputs.map(input => input.health));
  if (restarts) {
    tiles.push({
      id: 'B38-restarts', title: 'Service restarts', value: String(restarts.restarts),
      basis: `${restarts.restarted} of ${restarts.services} stack service${restarts.services === 1 ? '' : 's'} restarted · operations read`,
      perBot: per(stats => stats.bootId ? `boot ${stats.bootId.slice(0, 8)}${stats.sequence != null ? ` · seq ${stats.sequence}` : ''}` : null), state: coverage(bots.filter(stats => stats.stackHeartbeat != null).length, total, 'Operations'),
    });
  }
  return tiles;
}

/** Per-tile footnote: the basis, then each bot's own value when more than one bot contributes. */
export function tileNote(tile: FleetTile): string {
  return tile.perBot.length > 1 ? `${tile.basis} · ${tile.perBot.map(row => `${row.name} ${row.text}`).join(' · ')}` : tile.basis;
}
