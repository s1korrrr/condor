import { holdingsAgeMs, holdingsFreshness, holdingsPair, holdingsValue, type BotHoldings, type HoldingsBot, type HoldingsPair, type HoldingsState, type HoldingsValue } from '@/lib/fleet-holdings';

type Row = Record<string, unknown>;
export const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
export function numeric(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value))) return null;
  const number = Number(value); return Number.isFinite(number) ? number : null;
}
const nonnegative = (value: unknown) => { const n = numeric(value); return n !== null && n >= 0 ? n : null; };
const positive = (value: unknown) => { const n = numeric(value); return n !== null && n > 0 ? n : null; };
const rows = (value: unknown) => Array.isArray(value) ? value.map(object) : null;
const text = (value: unknown) => typeof value === 'string' && value.trim() && value !== 'n/a' ? value : null;
/** Display conversion of a server decimal string; the exact text stays in `quantity` and on the holdings pair. */
const display = (value: string | null | undefined) => value == null ? null : numeric(value);

/**
 * One bot's inventory as the dashboard renders it: the server's `fleet-holdings.v1` entry with the contract's client
 * rules applied at `now`. This is the only inventory source on the Bots page; nothing here sums units or prices.
 * Without an admitted entry every inventory field is null (unavailable), never zero.
 */
export type BotInventory = {
  state: HoldingsState;
  /** Server reason code when unavailable, or why the dashboard has no entry for the bot. */
  reason: string | null;
  ageMs: number | null; observedAtMs: number | null;
  paper: boolean | null; quote: string | null;
  heldPairCount: number | null; registeredPairCount: number | null;
  inventoryComplete: boolean; valueComplete: boolean; incompleteReasons: string[];
  value: HoldingsValue; unrealized: string | null; entryCost: string | null;
  entry: HoldingsBot | null;
};

export function projectBotInventory(holdings: BotHoldings | null, now: number, issue: string | null = null): BotInventory {
  if (!holdings) return {
    state: 'unavailable', reason: issue ?? 'Fleet holdings not read', ageMs: null, observedAtMs: null, paper: null, quote: null,
    heldPairCount: null, registeredPairCount: null, inventoryComplete: false, valueComplete: false, incompleteReasons: [],
    value: { kind: 'none', amount: null }, unrealized: null, entryCost: null, entry: null,
  };
  const { entry } = holdings;
  const state = holdingsFreshness(holdings, now);
  return {
    state, reason: entry.reason, ageMs: holdingsAgeMs(holdings, now), observedAtMs: entry.observed_at_ms, paper: entry.paper, quote: entry.quote_asset,
    heldPairCount: entry.held_pair_count, registeredPairCount: entry.registered_pair_count,
    inventoryComplete: entry.inventory_complete, valueComplete: entry.value_complete, incompleteReasons: entry.incomplete_reasons,
    value: holdingsValue(entry), unrealized: entry.totals?.unrealized_pnl_quote ?? null, entryCost: entry.totals?.entry_cost_quote ?? null,
    entry: state === 'unavailable' ? null : entry,
  };
}

/** Human label of an inventory state, for notices and diagnostics. */
export function inventoryStateLabel(inventory: BotInventory): string {
  if (inventory.state === 'unavailable') return `Unavailable · ${(inventory.reason ?? 'no admitted observation').replaceAll('_', ' ')}`;
  const age = inventory.ageMs === null ? '' : ` · ${Math.round(inventory.ageMs / 1000)}s old`;
  const partial = inventory.inventoryComplete ? '' : ` · partial (${inventory.incompleteReasons.join(', ').replaceAll('_', ' ') || 'incomplete'})`;
  return `${inventory.state === 'current' ? 'Current' : 'Last known'}${age}${partial}`;
}

/** The contract's totals rule as text: exact total, "≥ known" for a partial book, or a dash. */
export function inventoryValueText(inventory: BotInventory, format: (amount: string) => string): string {
  if (inventory.value.kind === 'none') return '—';
  return `${inventory.value.kind === 'at_least' ? '≥ ' : ''}${format(inventory.value.amount)}`;
}

export type BotPairPosition = {
  id: string; controllerId: string | null; uniquePair: boolean; pair: string; baseAsset: string; quote: string;
  /** Inventory from the holdings pair with the same (controller, pair); null when absent. Display numbers only. */
  holding: HoldingsPair | null;
  quantity: string | null; base: number | null; price: number | null; markValue: number | null;
  breakeven: number | null; bagPnl: number | null; entryCost: number | null;
  /** Server small-holding grouping flag. */
  small: boolean;
  inventorySource: string;
  phase: string | null; reason: string | null; hold: string | null; riskClear: boolean | null;
  /** Row built by the API from the owner's symbol list (`native_owner_symbols`): no per-pair runtime report of its own. */
  projected: boolean;
  profitPrice: number | null; floor: number | null; peak: number | null; plannedReduction: number | null;
  inventoryEntries: Row[]; targetBase: number | null; planNext: string | null; executors: Row[]; pendingSells: Row[] | null; pendingSellsTruncated: boolean;
};

/**
 * The owner bootstrap supplies identity, lifecycle, plans, gates, executors, pending sells and orders. Inventory (units,
 * mark, marked value, breakeven, cost, open-position PnL, small grouping) comes only from `options.holdings`.
 * With `allowStale`, an old (but well-formed, same-owner) observation is returned marked `stale` instead of thrown away.
 * Missing timestamps, clock skew and identity mismatches still throw: staleness is a state, corruption is not.
 */
export function buildBotPositionView(payload: unknown, bot: string, now: number, options: { allowStale?: boolean; holdings?: BotHoldings | null; holdingsIssue?: string | null } = {}) {
  const root = object(payload), runtime = object(root.runtime_status), monitoring = object(root.monitoring);
  const observedAt = text(runtime.updated_at), timestamp = observedAt ? Date.parse(observedAt) : NaN;
  const threshold = positive(monitoring.stale_threshold_seconds);
  if (runtime.bot_name !== bot || monitoring.bot_name !== bot) throw new Error('Runtime source does not match this bot.');
  if (!Number.isFinite(timestamp) || threshold === null || timestamp > now + 5_000) throw new Error('Current bot state is unavailable: the owner observation is missing or has clock skew.');
  const stale = now - timestamp >= Math.min(threshold, 30) * 1000;
  if (stale && !options.allowStale) throw new Error('Current bot state is unavailable: the owner observation is missing, stale or has clock skew.');
  const controllers = rows(runtime.controllers), positions = rows(runtime.positions_held), executors = rows(runtime.active_executors);
  if (!controllers || !executors) throw new Error('The runtime observation is incomplete.');
  // Lifecycle includes closing executors until the owner transfers their inventory.
  // Never add both lists: active executors are a subset of this non-done set.
  const lifecycle = runtime.lifecycle_executors === undefined ? executors : rows(runtime.lifecycle_executors);
  if (!lifecycle) throw new Error('The executor lifecycle observation is incomplete.');
  if (executors.some(active => !lifecycle.some(row => row.executor_id === active.executor_id && row.pair === active.pair && row.controller_id === active.controller_id))) throw new Error('Active and lifecycle executor observations disagree.');
  const identities = controllers.map(row => text(row.controller_id)).filter(Boolean);
  if (new Set(identities).size !== identities.length) {
    const projected = controllers.every(row => row.pair_projection_source === 'native_owner_symbols' && text(row.controller_id) && text(row.pair) && /^[A-Z0-9]+-[A-Z0-9]+$/.test(String(row.pair)));
    const scoped = new Set(controllers.map(row => `${row.controller_id}:${row.pair}`));
    if (!projected || scoped.size !== controllers.length) throw new Error('Controller identity is duplicated in this observation.');
  }
  const inventory = projectBotInventory(options.holdings ?? null, now, options.holdingsIssue ?? null);
  const pairs: BotPairPosition[] = controllers.map((controller, index) => {
    const pair = text(controller.pair);
    if (!pair || !/^[A-Z0-9]+-[A-Z0-9]+$/.test(pair)) throw new Error('Controller pair identity is invalid.');
    const [baseAsset, quote] = pair.split('-');
    const id = text(controller.controller_id), single = controllers.filter(row => row.pair === pair).length === 1;
    const matches = (row: Row) => row.pair === pair && (id && row.controller_id ? row.controller_id === id : single);
    const failedObservation = controller.observation_status === 'unavailable';
    const projected = controller.pair_projection_source === 'native_owner_symbols';
    const held = failedObservation ? undefined : positions?.filter(matches), active = lifecycle.filter(matches);
    const info = failedObservation ? {} : object(controller.custom_info), episode = object(info.episode), trail = object(info.trailing_policy);
    const hasEpisode = !failedObservation && episode.enabled === true;
    // Join on the exact owner identity (controller, pair), and only when this observation lists it once: two rows
    // sharing one identity would otherwise show the same holdings twice.
    const uniqueIdentity = controllers.filter(row => text(row.controller_id) === id && row.pair === pair).length === 1;
    const holding = inventory.entry && uniqueIdentity ? holdingsPair(inventory.entry, id, pair) : null;
    const base = display(holding?.units);
    const ownerPhase = text(episode.phase) ?? text(controller.state);
    // A symbol-only row has no per-pair runtime state; the holdings pair carries the owner pair state.
    const phase = projected ? holding?.state ?? ownerPhase : ownerPhase, targetBase = hasEpisode ? nonnegative(episode.target_base) : null;
    // This is an inventory objective. The execution owner still sizes, quantizes and gates each order.
    const plannedReduction = hasEpisode && ['DISTRIBUTE', 'EXIT'].includes(phase ?? '') && base !== null && targetBase !== null && targetBase <= base ? base - targetBase : null;
    const inventorySource = holding ? `Fleet holdings · reporting owner${holding.mark_source ? ` · mark ${holding.mark_source.replaceAll('_', ' ')}` : ''}`
      : inventory.state === 'unavailable' ? `Inventory unavailable · ${(inventory.reason ?? 'no admitted observation').replaceAll('_', ' ')}`
      : 'Inventory unavailable · pair not in fleet holdings';
    const ownerReason = projected ? 'Per-pair accounting unavailable in native runtime report' : failedObservation ? 'Controller observation unavailable' : text(episode.reason) ?? text(controller.gate);
    return { id: projected ? `${id}:${pair}` : id ?? `${pair}:${index}`, controllerId: id, uniquePair: single, pair, baseAsset, quote,
      holding, quantity: holding?.units ?? null, base, price: display(holding?.mark_price), markValue: display(holding?.marked_value_quote),
      breakeven: display(holding?.breakeven_price), bagPnl: display(holding?.unrealized_pnl_quote), entryCost: display(holding?.entry_cost_quote),
      small: holding?.small === true, inventorySource, projected, phase,
      reason: projected && holding ? text(controller.plan_next) : ownerReason, hold: text(episode.hold_reason), riskClear: typeof episode.exit_risk_clear === 'boolean' ? episode.exit_risk_clear : null,
      inventoryEntries: hasEpisode ? [] : held ?? [],
      profitPrice: positive(episode.minimum_profit_price), floor: positive(trail.floor), peak: positive(trail.peak), plannedReduction, targetBase,
      planNext: text(controller.plan_next), executors: active, pendingSells: rows(info.pending_sell_requests)?.map(request => ({ ...request, request_state: request.termination_requested === true ? 'Cancellation requested' : positive(request.expires_at) !== null && now >= positive(request.expires_at)! * 1000 ? 'Expiry reached; awaiting owner' : request.termination_requested === false ? 'Pending owner request' : 'Request state unavailable' })) ?? null, pendingSellsTruncated: info.pending_sell_requests_truncated === true };
  });
  const count = nonnegative(runtime.active_orders_count);
  const orders = rows(runtime.active_orders), ordersStatus = object(runtime.active_orders_status);
  const completeOrderList = orders !== null && ordersStatus.complete === true;
  return { observedAt: observedAt!, stale, ageSeconds: Math.max(0, Math.floor((now - timestamp) / 1000)), pairs, inventory,
    activeOrderCount: completeOrderList ? orders.length : count !== null && Number.isInteger(count) ? count : null,
    orderCountLabel: completeOrderList ? "Active orders" : "Active limit orders",
    activeExecutorCount: executors.length, orders, ordersStatus };
}

/** Pair-state mix for a multi-asset bot. One pair never labels the rest. */
export function mixedOperationalLabel(pairs: { phase: string | null }[]): string {
  const counts = new Map<string, number>();
  for (const row of pairs) {
    const key = (row.phase || 'UNKNOWN').toUpperCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size === 0) return 'UNKNOWN';
  if (counts.size === 1) return [...counts.keys()][0];
  return `MIXED: ${[...counts.entries()].map(([state, n]) => `${n} ${state.toLowerCase()}`).join(' / ')}`;
}

/**
 * Display-only grouping by the server's `small` flag, the one rule every client uses. The server never flags a pair
 * with running executors, pending sell requests or an active owner state, so grouping never hides active execution.
 */
export function partitionBotInventory(pairs: BotPairPosition[]) {
  const small: BotPairPosition[] = [], primary: BotPairPosition[] = [];
  for (const row of pairs) (row.small ? small : primary).push(row);
  return { primary, small };
}
