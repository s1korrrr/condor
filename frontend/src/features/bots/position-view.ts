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
function sum(values: (number | null)[]) { return values.every(value => value !== null) ? values.reduce<number>((total, value) => total + value!, 0) : null; }
export type BotPairPosition = {
  id: string; pair: string; baseAsset: string; quote: string; price: number | null; base: number | null;
  markValue: number | null; breakeven: number | null; bagPnl: number | null; inventorySource: string;
  phase: string | null; reason: string | null; hold: string | null; riskClear: boolean | null;
  profitPrice: number | null; floor: number | null; peak: number | null; plannedReduction: number | null;
  targetBase: number | null; planNext: string | null; executors: Row[]; pendingSells: Row[] | null; pendingSellsTruncated: boolean;
};
export function buildBotPositionView(payload: unknown, bot: string, now: number) {
  const root = object(payload), runtime = object(root.runtime_status), monitoring = object(root.monitoring);
  const observedAt = text(runtime.updated_at), timestamp = observedAt ? Date.parse(observedAt) : NaN;
  const threshold = positive(monitoring.stale_threshold_seconds);
  if (runtime.bot_name !== bot || monitoring.bot_name !== bot) throw new Error('Runtime source does not match this bot.');
  if (!Number.isFinite(timestamp) || threshold === null || timestamp > now + 5_000 || now - timestamp >= Math.min(threshold, 30) * 1000) throw new Error('Current bot state is unavailable: the owner observation is missing, stale or has clock skew.');
  const controllers = rows(runtime.controllers), positions = rows(runtime.positions_held), executors = rows(runtime.active_executors);
  if (!controllers || !executors) throw new Error('The runtime observation is incomplete.');
  const identities = controllers.map(row => text(row.controller_id)).filter(Boolean);
  if (new Set(identities).size !== identities.length) throw new Error('Controller identity is duplicated in this observation.');
  const pairs: BotPairPosition[] = controllers.map((controller, index) => {
    const pair = text(controller.pair);
    if (!pair || !/^[A-Z0-9]+-[A-Z0-9]+$/.test(pair)) throw new Error('Controller pair identity is invalid.');
    const [baseAsset, quote] = pair.split('-');
    const id = text(controller.controller_id), single = controllers.filter(row => row.pair === pair).length === 1;
    const matches = (row: Row) => row.pair === pair && (id && row.controller_id ? row.controller_id === id : single);
    const failedObservation = controller.observation_status === 'unavailable';
    const ambiguousInventory = !single && (!id || positions?.some(row => row.pair === pair && !text(row.controller_id)));
    const held = failedObservation || ambiguousInventory ? undefined : positions?.filter(matches), active = executors.filter(matches);
    const info = failedObservation ? {} : object(controller.custom_info), episode = object(info.episode), trail = object(info.trailing_policy);
    const hasEpisode = !failedObservation && episode.enabled === true;
    const base = hasEpisode ? nonnegative(episode.base) : held ? sum(held.map(row => nonnegative(row.amount_base))) : null;
    const price = positive(controller.price_quote), cost = hasEpisode && episode.cost_known === true ? nonnegative(episode.cost) : null;
    const markValue = base !== null && price !== null ? base * price : null;
    const basisCost = held?.length ? sum(held.map(row => { const amount = nonnegative(row.amount_base), basis = positive(row.breakeven_price); return amount !== null && basis !== null ? amount * basis : null; })) : null;
    const breakeven = base !== null && base > 0 ? hasEpisode ? cost === null ? null : cost / base : basisCost === null ? null : basisCost / base : null;
    const bagPnl = hasEpisode ? cost !== null && markValue !== null ? markValue - cost : null : held?.length ? sum(held.map(row => numeric(row.unrealized_pnl_quote))) : null;
    const phase = text(episode.phase) ?? text(controller.state), targetBase = hasEpisode ? nonnegative(episode.target_base) : null;
    // This is an inventory objective. The execution owner still sizes, quantizes and gates each order.
    const plannedReduction = hasEpisode && ['DISTRIBUTE', 'EXIT'].includes(phase ?? '') && base !== null && targetBase !== null && targetBase <= base ? base - targetBase : null;
    return { id: id ?? `${pair}:${index}`, pair, baseAsset, quote, price, base, markValue, breakeven, bagPnl,
      inventorySource: failedObservation ? 'Controller observation unavailable' : hasEpisode ? 'Controller episode bag' : 'Retained positions', phase,
      reason: failedObservation ? 'Controller observation unavailable' : text(episode.reason) ?? text(controller.gate), hold: text(episode.hold_reason), riskClear: typeof episode.exit_risk_clear === 'boolean' ? episode.exit_risk_clear : null,
      profitPrice: positive(episode.minimum_profit_price), floor: positive(trail.floor), peak: positive(trail.peak), plannedReduction, targetBase,
      planNext: text(controller.plan_next), executors: active, pendingSells: rows(info.pending_sell_requests)?.map(request => ({ ...request, request_state: request.termination_requested === true ? 'Cancellation requested' : positive(request.expires_at) !== null && now >= positive(request.expires_at)! * 1000 ? 'Expiry reached; awaiting owner' : request.termination_requested === false ? 'Pending owner request' : 'Request state unavailable' })) ?? null, pendingSellsTruncated: info.pending_sell_requests_truncated === true };
  });
  const count = nonnegative(runtime.active_orders_count);
  const orders = rows(runtime.active_orders), ordersStatus = object(runtime.active_orders_status);
  const completeOrderList = orders !== null && ordersStatus.complete === true;
  return { observedAt: observedAt!, pairs, activeOrderCount: completeOrderList ? orders.length : count !== null && Number.isInteger(count) ? count : null,
    orderCountLabel: completeOrderList ? "Active orders" : "Active limit orders",
    activeExecutorCount: executors.length, orders, ordersStatus };
}
