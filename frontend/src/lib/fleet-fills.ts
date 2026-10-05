/**
 * Typed client for the server-side fleet fills feed, `GET /api/v1/servers/{server}/fleet/fills` (schema
 * `fleet-fills.v1`, documented in docs/reference/fleet-fills-v1.md of the rsibot workspace).
 *
 * The server merges every bot's fills once, orders them newest first and pages them with an opaque cursor. This
 * module only validates the wire shape and merges pages; it never recomputes a number. Money stays a decimal
 * string, and an absent fact stays `null`: nothing here turns a missing amount, price, fee or PnL into zero.
 */

export const FLEET_FILLS_SCHEMA = 'fleet-fills.v1';
export const FLEET_FILLS_DEFAULT_LIMIT = 50;

export type FleetFillsStatus = 'ok' | 'partial' | 'missing';
export type FleetFillGeneration = 'V1' | 'V2' | 'V3';
export type FleetFillSide = 'buy' | 'sell';
/** `unrecognised` is a receipt value this client does not know: shown as such, never promoted to exact. */
export type FleetFillReceipt = 'exact' | 'legacy_6dp' | 'unavailable' | 'unrecognised';
export type FleetFillsBotStatus = 'ok' | 'unavailable' | 'excluded';

export type FleetFillItem = {
  id: string;
  bot: string;
  display_name: string;
  generation: FleetFillGeneration | null;
  fill_id: string;
  order_id: string | null;
  source_db_id: string | null;
  connector: string | null;
  pair: string | null;
  base: string | null;
  quote: string | null;
  side: FleetFillSide | null;
  order_type: string | null;
  amount: string | null;
  price: string | null;
  volume: string | null;
  fee: string | null;
  fee_unit: string | null;
  time_ms: number | null;
  receipt: FleetFillReceipt;
  simulated: boolean;
  /** Reserved by the contract: `null` in v1. Shown as an absent value, never as zero. */
  realized_pnl: string | null;
  /** Names of the nullable fields above that are `null` on this row. */
  missing: string[];
};

export type FleetFillsBot = {
  bot: string;
  display_name: string;
  generation: FleetFillGeneration | null;
  paper: boolean;
  status: FleetFillsBotStatus;
  reason: string | null;
  rows_read: number;
  rows_accepted: number;
  rejected: Record<string, number>;
  receipts: { exact: number; legacy_6dp: number; unavailable: number };
  saturated: boolean;
  oldest_ms: number | null;
  newest_ms: number | null;
};

export type FleetFillsPage = {
  schema_version: typeof FLEET_FILLS_SCHEMA;
  server: string;
  generated_at_ms: number;
  status: FleetFillsStatus;
  reason: string | null;
  partial: boolean;
  items: FleetFillItem[];
  limit: number;
  has_more: boolean;
  next_cursor: string | null;
  matched: number;
  window: { horizon_ms: number | null; truncated: boolean; owner_limit: number };
  bots: FleetFillsBot[];
  notes: { reason: string }[];
};

export type FleetFillsQuery = {
  limit?: number;
  /** The previous page's `next_cursor`; opaque, never parsed here. */
  before?: string | null;
  bots?: readonly string[];
  side?: FleetFillSide | null;
  pair?: string | null;
};

export class FleetFillsError extends Error {}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const text = (value: unknown): value is string => typeof value === 'string';
/** Money is a decimal string in plain notation. A JSON number would already have lost its exact digits. */
const decimal = (value: unknown): value is string => typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value);
const nullable = <T>(value: unknown, ok: (value: unknown) => value is T): value is T | null => value === null || ok(value);

const GENERATIONS: readonly string[] = ['V1', 'V2', 'V3'];
const generation = (value: unknown): FleetFillGeneration | null => typeof value === 'string' && GENERATIONS.includes(value) ? value as FleetFillGeneration : null;
const RECEIPTS: readonly string[] = ['exact', 'legacy_6dp', 'unavailable'];

function parseItem(raw: unknown): FleetFillItem {
  if (!object(raw) || !text(raw.id) || !raw.id || !text(raw.bot) || !raw.bot || !text(raw.fill_id) || !raw.fill_id) throw new FleetFillsError('A fleet fill has no identity.');
  const id = raw.id;
  for (const field of ['amount', 'price', 'volume', 'fee', 'realized_pnl'] as const) {
    if (!nullable(raw[field], decimal)) throw new FleetFillsError(`Fleet fill ${id} has an invalid ${field}.`);
  }
  if (!nullable(raw.time_ms, integer)) throw new FleetFillsError(`Fleet fill ${id} has an invalid time.`);
  for (const field of ['order_id', 'source_db_id', 'connector', 'pair', 'base', 'quote', 'order_type', 'fee_unit'] as const) {
    if (raw[field] !== undefined && !nullable(raw[field], text)) throw new FleetFillsError(`Fleet fill ${id} has an invalid ${field}.`);
  }
  if (!Array.isArray(raw.missing) || !raw.missing.every(text)) throw new FleetFillsError(`Fleet fill ${id} has an invalid missing list.`);
  const side = typeof raw.side === 'string' ? raw.side.toLowerCase() : null;
  return {
    id, bot: raw.bot, display_name: text(raw.display_name) && raw.display_name ? raw.display_name : raw.bot, generation: generation(raw.generation),
    fill_id: raw.fill_id, order_id: (raw.order_id as string | null | undefined) ?? null, source_db_id: (raw.source_db_id as string | null | undefined) ?? null, connector: (raw.connector as string | null | undefined) ?? null,
    pair: (raw.pair as string | null | undefined) ?? null, base: (raw.base as string | null | undefined) ?? null, quote: (raw.quote as string | null | undefined) ?? null,
    side: side === 'buy' || side === 'sell' ? side : null,
    order_type: (raw.order_type as string | null | undefined) ?? null,
    amount: raw.amount as string | null, price: raw.price as string | null, volume: raw.volume as string | null, fee: raw.fee as string | null,
    fee_unit: (raw.fee_unit as string | null | undefined) ?? null, time_ms: raw.time_ms as number | null,
    receipt: typeof raw.receipt === 'string' && RECEIPTS.includes(raw.receipt) ? raw.receipt as FleetFillReceipt : 'unrecognised',
    simulated: raw.simulated === true, realized_pnl: raw.realized_pnl as string | null, missing: raw.missing as string[],
  };
}

function parseBot(raw: unknown): FleetFillsBot {
  if (!object(raw) || !text(raw.bot) || !raw.bot) throw new FleetFillsError('A fleet fills bot account has no identity.');
  if (!text(raw.status)) throw new FleetFillsError(`Fleet fills bot ${raw.bot} has no status.`);
  // A status this client does not know must never read as "ok": the bot's fills may be missing from the feed.
  const status: FleetFillsBotStatus = raw.status === 'ok' || raw.status === 'excluded' ? raw.status : 'unavailable';
  const known = raw.status === 'ok' || raw.status === 'excluded' || raw.status === 'unavailable';
  const rejected: Record<string, number> = {};
  if (object(raw.rejected)) for (const [reason, count] of Object.entries(raw.rejected)) if (integer(count)) rejected[reason] = count;
  const receipts = object(raw.receipts) ? raw.receipts : {};
  const count = (value: unknown) => integer(value) ? value : 0;
  return {
    bot: raw.bot, display_name: text(raw.display_name) && raw.display_name ? raw.display_name : raw.bot, generation: generation(raw.generation), paper: raw.paper === true,
    status, reason: known ? (text(raw.reason) ? raw.reason : null) : `UNRECOGNISED_STATUS:${raw.status}`,
    rows_read: count(raw.rows_read), rows_accepted: count(raw.rows_accepted), rejected,
    receipts: { exact: count(receipts.exact), legacy_6dp: count(receipts.legacy_6dp), unavailable: count(receipts.unavailable) },
    saturated: raw.saturated === true, oldest_ms: integer(raw.oldest_ms) ? raw.oldest_ms : null, newest_ms: integer(raw.newest_ms) ? raw.newest_ms : null,
  };
}

/**
 * Validate one page. Throws `FleetFillsError` for a different schema (the caller should tell the user to update rather
 * than guess) or a malformed body. Unknown extra fields are ignored, because `fleet-fills.v1` only ever adds fields.
 */
export function parseFleetFills(payload: unknown): FleetFillsPage {
  if (!object(payload)) throw new FleetFillsError('Fleet fills is not an object.');
  if (payload.schema_version !== FLEET_FILLS_SCHEMA) throw new FleetFillsError(`Unsupported fleet fills schema ${String(payload.schema_version)}: update the dashboard.`);
  if (!text(payload.server) || !integer(payload.generated_at_ms)) throw new FleetFillsError('Fleet fills identity is invalid.');
  if (!text(payload.status)) throw new FleetFillsError('Fleet fills status is invalid.');
  // A status this client does not know is read as partial: it must not claim that every bot answered.
  const status: FleetFillsStatus = payload.status === 'ok' || payload.status === 'partial' || payload.status === 'missing' ? payload.status : 'partial';
  if (!Array.isArray(payload.items) || !Array.isArray(payload.bots)) throw new FleetFillsError('Fleet fills items or bots are invalid.');
  if (typeof payload.has_more !== 'boolean' || !integer(payload.limit) || !integer(payload.matched)) throw new FleetFillsError('Fleet fills paging is invalid.');
  if (!nullable(payload.next_cursor, text)) throw new FleetFillsError('Fleet fills cursor is invalid.');
  if (payload.has_more && !payload.next_cursor) throw new FleetFillsError('Fleet fills says more rows follow but gives no cursor.');
  const window = payload.window;
  if (!object(window) || typeof window.truncated !== 'boolean' || !integer(window.owner_limit) || !nullable(window.horizon_ms, integer)) throw new FleetFillsError('Fleet fills window is invalid.');
  return {
    schema_version: FLEET_FILLS_SCHEMA, server: payload.server, generated_at_ms: payload.generated_at_ms, status,
    reason: text(payload.reason) ? payload.reason : null, partial: status !== 'ok',
    items: payload.items.map(parseItem), limit: payload.limit, has_more: payload.has_more, next_cursor: payload.next_cursor,
    matched: payload.matched, window: { horizon_ms: window.horizon_ms, truncated: window.truncated, owner_limit: window.owner_limit },
    bots: payload.bots.map(parseBot),
    notes: Array.isArray(payload.notes) ? payload.notes.filter(object).flatMap(note => text(note.reason) ? [{ reason: note.reason }] : []) : [],
  };
}

/** `/api/v1/servers/{server}/fleet/fills?…`; a bot filter repeats `bot=`, and empty filters are left out. */
export function fleetFillsPath(server: string, query: FleetFillsQuery = {}): string {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.before) params.set('before', query.before);
  for (const bot of query.bots ?? []) params.append('bot', bot);
  if (query.side) params.set('side', query.side);
  const pair = query.pair?.trim();
  if (pair) params.set('pair', pair);
  const search = params.toString();
  return `/api/v1/servers/${encodeURIComponent(server)}/fleet/fills${search ? `?${search}` : ''}`;
}

/**
 * Rows of every loaded page in server order, each fill once. The first occurrence wins: a refresh that re-reads the
 * pages may report a row on two neighbouring pages when new fills arrived, and the row identity is `id`.
 */
export function mergeFleetFillPages(pages: readonly FleetFillsPage[]): FleetFillItem[] {
  const seen = new Set<string>();
  const rows: FleetFillItem[] = [];
  for (const page of pages) for (const item of page.items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    rows.push(item);
  }
  return rows;
}
