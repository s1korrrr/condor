/**
 * Typed client for the server-side fleet holdings, `GET /api/v1/servers/{server}/fleet/holdings[?bot=<id>]` (schema
 * `fleet-holdings.v1`, documented in docs/reference/fleet-holdings-v1.md of the rsibot workspace).
 *
 * The reporting owner computes per-pair inventory (units, mark, marked value, cost, PnL) and Condor admits it once,
 * adding freshness, completeness, totals and small-holding grouping. This module only validates the wire shape and
 * applies the contract's client rules (age, current, totals). It never recomputes inventory: money and quantities stay
 * decimal strings, and an absent fact stays `null`, never `0`.
 */

export const FLEET_HOLDINGS_SCHEMA = 'fleet-holdings.v1';

export type HoldingsState = 'current' | 'stale' | 'unavailable';

export type HoldingsPair = {
  pair: string; controller_id: string | null; base_asset: string; quote_asset: string;
  /** Owner pair state (HOLDING, FLAT, BUILDING, ...). */
  state: string;
  units: string | null; entry_cost_quote: string | null; breakeven_price: string | null;
  mark_price: string | null; mark_source: string | null; marked_value_quote: string | null;
  unrealized_pnl_quote: string | null; realized_pnl_quote: string | null; fees_quote: string | null;
  /** Null from older owners: unknown, not zero. */
  running_executor_count: number | null;
  /** Display grouping only, decided by the server. Never an exit or venue-minimum claim. */
  small: boolean;
};

export type HoldingsTotals = {
  marked_value_quote: string | null;
  /** Sum of the valued held pairs; always a number when the bot is admitted. */
  known_marked_value_quote: string;
  unrealized_pnl_quote: string | null;
  entry_cost_quote: string | null;
};

export type HoldingsBot = {
  bot: string; paper: boolean; state: HoldingsState; reason: string | null;
  observed_at_ms: number | null; stale_after_ms: number;
  snapshot_id: string | null; owner_boot_id: string | null; quote_asset: string | null;
  inventory_complete: boolean; value_complete: boolean; incomplete_reasons: string[];
  registered_pair_count: number | null; held_pair_count: number | null;
  totals: HoldingsTotals | null;
  pairs: HoldingsPair[];
};

export type FleetHoldings = {
  schema: typeof FLEET_HOLDINGS_SCHEMA; server: string; generated_at_ms: number;
  /** When this response was served (stamped per response, outside the server cache). Ages start here. */
  served_at_ms: number;
  bots: HoldingsBot[];
};

/** One response together with the local time it was received; the age rule needs both. */
export type FleetHoldingsRead = { body: FleetHoldings; receivedAtMs: number };

/** One bot's entry from a read, carrying the response's serve time and local receipt time. */
export type BotHoldings = { entry: HoldingsBot; servedAtMs: number; receivedAtMs: number };

export class FleetHoldingsError extends Error {}

const STATES: readonly string[] = ['current', 'stale', 'unavailable'];
const PAIR = /^[A-Z0-9]+-[A-Z0-9]+$/;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const count = (value: unknown): value is number => integer(value) && value >= 0;
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
/** Plain decimal text as the server writes it: no exponent. A JSON number would already have lost exact digits. */
const decimal = (value: unknown): value is string => typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value);
const unsigned = (value: unknown): value is string => decimal(value) && !value.startsWith('-');
const nullable = <T>(value: unknown, ok: (value: unknown) => value is T): value is T | null => value === null || ok(value);

function parsePair(raw: unknown, bot: string): HoldingsPair {
  if (!object(raw) || typeof raw.pair !== 'string' || !PAIR.test(raw.pair)) throw new FleetHoldingsError(`Holdings pair of ${bot} has no valid identity.`);
  const where = `${bot} ${raw.pair}`;
  if (!nullable(raw.controller_id, text) || !text(raw.base_asset) || !text(raw.quote_asset) || !text(raw.state)) throw new FleetHoldingsError(`Holdings pair ${where} identity is invalid.`);
  for (const field of ['units', 'entry_cost_quote', 'breakeven_price', 'mark_price', 'marked_value_quote', 'fees_quote'] as const) {
    if (!nullable(raw[field], unsigned)) throw new FleetHoldingsError(`Holdings pair ${where} has an invalid ${field}.`);
  }
  for (const field of ['unrealized_pnl_quote', 'realized_pnl_quote'] as const) {
    if (!nullable(raw[field], decimal)) throw new FleetHoldingsError(`Holdings pair ${where} has an invalid ${field}.`);
  }
  if (!nullable(raw.mark_source, text) || !nullable(raw.running_executor_count, count) || typeof raw.small !== 'boolean') throw new FleetHoldingsError(`Holdings pair ${where} is invalid.`);
  return {
    pair: raw.pair, controller_id: raw.controller_id as string | null, base_asset: raw.base_asset as string, quote_asset: raw.quote_asset as string, state: raw.state as string,
    units: raw.units as string | null, entry_cost_quote: raw.entry_cost_quote as string | null, breakeven_price: raw.breakeven_price as string | null,
    mark_price: raw.mark_price as string | null, mark_source: raw.mark_source as string | null, marked_value_quote: raw.marked_value_quote as string | null,
    unrealized_pnl_quote: raw.unrealized_pnl_quote as string | null, realized_pnl_quote: raw.realized_pnl_quote as string | null, fees_quote: raw.fees_quote as string | null,
    running_executor_count: raw.running_executor_count as number | null, small: raw.small,
  };
}

function parseTotals(raw: unknown, bot: string): HoldingsTotals {
  if (!object(raw) || !unsigned(raw.known_marked_value_quote) || !nullable(raw.marked_value_quote, unsigned) || !nullable(raw.entry_cost_quote, unsigned) || !nullable(raw.unrealized_pnl_quote, decimal)) {
    throw new FleetHoldingsError(`Holdings totals of ${bot} are invalid.`);
  }
  return {
    marked_value_quote: raw.marked_value_quote as string | null, known_marked_value_quote: raw.known_marked_value_quote,
    unrealized_pnl_quote: raw.unrealized_pnl_quote as string | null, entry_cost_quote: raw.entry_cost_quote as string | null,
  };
}

function parseBot(raw: unknown): HoldingsBot {
  if (!object(raw) || !text(raw.bot)) throw new FleetHoldingsError('A holdings bot has no identity.');
  const bot = raw.bot;
  if (typeof raw.paper !== 'boolean' || !STATES.includes(raw.state as string)) throw new FleetHoldingsError(`Holdings of ${bot} have an invalid state.`);
  const state = raw.state as HoldingsState;
  if (!integer(raw.stale_after_ms) || raw.stale_after_ms <= 0 || !nullable(raw.observed_at_ms, count)) throw new FleetHoldingsError(`Holdings of ${bot} have invalid times.`);
  if (!nullable(raw.reason, text) || !nullable(raw.snapshot_id, text) || !nullable(raw.owner_boot_id, text) || !nullable(raw.quote_asset, text)) throw new FleetHoldingsError(`Holdings of ${bot} have invalid identity fields.`);
  if (typeof raw.inventory_complete !== 'boolean' || typeof raw.value_complete !== 'boolean' || !Array.isArray(raw.incomplete_reasons) || !raw.incomplete_reasons.every(text)) throw new FleetHoldingsError(`Holdings of ${bot} have invalid completeness.`);
  if (!nullable(raw.registered_pair_count, count) || !nullable(raw.held_pair_count, count)) throw new FleetHoldingsError(`Holdings of ${bot} have invalid pair counts.`);
  if (!Array.isArray(raw.pairs)) throw new FleetHoldingsError(`Holdings pairs of ${bot} are invalid.`);
  const pairs = raw.pairs.map(pair => parsePair(pair, bot));
  if (state === 'unavailable') {
    // Not an empty book: an unavailable bot publishes no pairs, totals or counts, and says why.
    if (raw.reason === null || pairs.length || raw.totals !== null || raw.held_pair_count !== null || raw.inventory_complete || raw.value_complete) throw new FleetHoldingsError(`Unavailable holdings of ${bot} are inconsistent.`);
  } else {
    if (raw.reason !== null || raw.observed_at_ms === null || raw.quote_asset === null || raw.registered_pair_count !== pairs.length) throw new FleetHoldingsError(`Admitted holdings of ${bot} are inconsistent.`);
    if ((raw.held_pair_count !== null) !== raw.inventory_complete || (raw.value_complete && !raw.inventory_complete)) throw new FleetHoldingsError(`Holdings completeness of ${bot} is inconsistent.`);
  }
  const totals = raw.totals === null ? null : parseTotals(raw.totals, bot);
  if (state !== 'unavailable' && totals === null) throw new FleetHoldingsError(`Admitted holdings of ${bot} have no totals.`);
  return {
    bot, paper: raw.paper, state, reason: raw.reason as string | null,
    observed_at_ms: raw.observed_at_ms as number | null, stale_after_ms: raw.stale_after_ms,
    snapshot_id: raw.snapshot_id as string | null, owner_boot_id: raw.owner_boot_id as string | null, quote_asset: raw.quote_asset as string | null,
    inventory_complete: raw.inventory_complete, value_complete: raw.value_complete, incomplete_reasons: [...raw.incomplete_reasons as string[]],
    registered_pair_count: raw.registered_pair_count as number | null, held_pair_count: raw.held_pair_count as number | null,
    totals, pairs,
  };
}

/**
 * Validate the body. Throws `FleetHoldingsError` for a different schema or any malformed part: a body that cannot be
 * read is an error, never an empty book. Unknown fields are ignored, because `fleet-holdings.v1` only adds fields.
 */
export function parseFleetHoldings(payload: unknown): FleetHoldings {
  if (!object(payload)) throw new FleetHoldingsError('Fleet holdings is not an object.');
  if (payload.schema !== FLEET_HOLDINGS_SCHEMA) throw new FleetHoldingsError(`Unsupported fleet holdings schema ${String(payload.schema)}.`);
  if (!text(payload.server) || !count(payload.generated_at_ms) || !count(payload.served_at_ms)) throw new FleetHoldingsError('Fleet holdings identity or serve time is invalid.');
  if (!Array.isArray(payload.bots)) throw new FleetHoldingsError('Fleet holdings bots are invalid.');
  const bots = payload.bots.map(parseBot);
  if (new Set(bots.map(row => row.bot)).size !== bots.length) throw new FleetHoldingsError('Fleet holdings list a bot twice.');
  return { schema: FLEET_HOLDINGS_SCHEMA, server: payload.server, generated_at_ms: payload.generated_at_ms, served_at_ms: payload.served_at_ms, bots };
}

export function fleetHoldingsPath(server: string, bot?: string): string {
  return `/api/v1/servers/${encodeURIComponent(server)}/fleet/holdings${bot ? `?bot=${encodeURIComponent(bot)}` : ''}`;
}

/** The bot's entry of a read, or null when there is no read or the server does not list the bot. */
export function botHoldings(read: FleetHoldingsRead | null | undefined, bot: string): BotHoldings | null {
  const entry = read?.body.bots.find(row => row.bot === bot);
  return read && entry ? { entry, servedAtMs: read.body.served_at_ms, receivedAtMs: read.receivedAtMs } : null;
}

/**
 * Contract age rule: `(served_at_ms - observed_at_ms) + (now - receivedAt)`. The browser clock is only compared with
 * the local receipt time, never with the owner's observation time. Null when the owner published no observation.
 */
export function holdingsAgeMs(holdings: BotHoldings, now: number): number | null {
  const observed = holdings.entry.observed_at_ms;
  if (observed === null) return null;
  return Math.max(0, holdings.servedAtMs - observed + Math.max(0, now - holdings.receivedAtMs));
}

/** Current only while the server says `current` and the age is below `stale_after_ms`; otherwise last known (stale) or unavailable. */
export function holdingsFreshness(holdings: BotHoldings, now: number): HoldingsState {
  const { entry } = holdings;
  if (entry.state === 'unavailable') return 'unavailable';
  const age = holdingsAgeMs(holdings, now);
  return entry.state === 'current' && age !== null && age < entry.stale_after_ms ? 'current' : 'stale';
}

/** Contract totals rule: the exact total when present, otherwise "≥ known" when the known part is positive, otherwise nothing. */
export type HoldingsValue = { kind: 'exact' | 'at_least'; amount: string } | { kind: 'none'; amount: null };
export function holdingsValue(entry: HoldingsBot): HoldingsValue {
  const totals = entry.totals;
  if (totals?.marked_value_quote != null) return { kind: 'exact', amount: totals.marked_value_quote };
  if (totals && Number(totals.known_marked_value_quote) > 0) return { kind: 'at_least', amount: totals.known_marked_value_quote };
  return { kind: 'none', amount: null };
}

/** The single holdings pair with this owner identity; null when there is none or the identity is not unique. */
export function holdingsPair(entry: HoldingsBot, controllerId: string | null, pair: string): HoldingsPair | null {
  const matches = entry.pairs.filter(row => row.pair === pair && row.controller_id === controllerId);
  return matches.length === 1 ? matches[0] : null;
}
