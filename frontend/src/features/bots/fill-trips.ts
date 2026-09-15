import { validateRecordedSource, type RecordedRow } from '@/lib/native-bot-statistics';

type Qty = { digits: bigint; scale: number };

export type TripOutcome = 'filled' | 'in_bag' | 'hold' | 'cancelled' | 'unknown_cost';

export type TripFill = {
  fillId: string;
  orderId: string | null;
  side: 'buy' | 'sell';
  amountBase: string;
  priceQuote: number;
  feeQuote: number | null;
  timestamp: string;
  realizedPnlQuote: number | null;
};

export type FillTrip = {
  pair: string;
  quote: string;
  sourceDbId: string;
  openedAt: string;
  closedAt: string | null;
  outcome: TripOutcome;
  pnlUnavailableReason: string | null;
  buyAmountBase: string;
  sellAmountBase: string;
  remainingBase: string;
  remainingCostQuote: number | null;
  realizedPnlQuote: number | null;
  feesQuote: number | null;
  fills: TripFill[];
};

function isHold(value: unknown): boolean {
  return value === 10 || value === '10' || value === 'POSITION_HOLD';
}

function isWalletReason(value: unknown): boolean {
  return value === 'unknown_wallet_acquisition_cost' || value === 'wallet_sale_native_accounting_unavailable';
}

function parseQty(value: unknown): Qty | null {
  const text = typeof value === 'number' && Number.isFinite(value) && value > 0 ? String(value) : value;
  if (typeof text !== 'string' || !/^\+?(?:\d+\.?\d*|\.\d+)$/.test(text)) return null;
  const [whole, frac = ''] = text.split('.');
  const digits = BigInt((whole || '0') + frac);
  return digits > 0n ? { digits, scale: frac.length } : null;
}

function zero(): Qty {
  return { digits: 0n, scale: 0 };
}

function align(left: Qty, right: Qty) {
  const scale = Math.max(left.scale, right.scale);
  return {
    left: left.digits * 10n ** BigInt(scale - left.scale),
    right: right.digits * 10n ** BigInt(scale - right.scale),
    scale,
  };
}

function addQty(left: Qty, right: Qty): Qty {
  const { left: a, right: b, scale } = align(left, right);
  return { digits: a + b, scale };
}

function subQty(left: Qty, right: Qty): Qty {
  const { left: a, right: b, scale } = align(left, right);
  return { digits: a - b, scale };
}

function cmpQty(left: Qty, right: Qty): number {
  const { left: a, right: b } = align(left, right);
  return a === b ? 0 : a < b ? -1 : 1;
}

function isZero(qty: Qty): boolean {
  return qty.digits === 0n;
}

function formatQty(qty: Qty): string {
  if (qty.digits === 0n) return '0';
  const text = qty.digits.toString().padStart(qty.scale + 1, '0');
  if (!qty.scale) return text;
  return `${text.slice(0, -qty.scale)}.${text.slice(-qty.scale)}`.replace(/\.?0+$/, '') || '0';
}

function toNumber(qty: Qty): number {
  return Number(formatQty(qty));
}

function feeOf(row: RecordedRow): number | null {
  if (row.fee_quote === null || row.fee_quote === undefined) return null;
  const fee = Number(row.fee_quote);
  return Number.isFinite(fee) && fee >= 0 ? fee : null;
}

function isFutures(row: RecordedRow): boolean {
  const pair = String(row.pair || '');
  const connector = String(row.connector_name || '').toLowerCase();
  return pair.split('-').length > 2 || /perp|perpetual|future/.test(connector) || /PERP/.test(pair);
}

function verifiedAmount(fill: RecordedRow): Qty | null {
  return fill.economics_available === true ? parseQty(fill.exact_amount) : null;
}

function displayAmount(fill: RecordedRow): Qty | null {
  return verifiedAmount(fill) ?? parseQty(fill.amount_base);
}

function addSide(trip: OpenTrip, side: 'buy' | 'sell', amount: Qty | null) {
  if (!amount) return;
  if (side === 'buy') trip.buy = addQty(trip.buy, amount);
  else trip.sell = addQty(trip.sell, amount);
}

function leg(fill: RecordedRow, side: 'buy' | 'sell', amount: Qty | null, realized: number | null): TripFill {
  return {
    fillId: String(fill.fill_id),
    orderId: typeof fill.order_id === 'string' && fill.order_id ? fill.order_id : null,
    side,
    amountBase: amount ? formatQty(amount) : String(fill.amount_base ?? ''),
    priceQuote: Number(fill.price_quote) || 0,
    feeQuote: feeOf(fill),
    timestamp: String(fill.timestamp),
    realizedPnlQuote: realized,
  };
}

function addFee(current: number | null, fee: number | null): number | null {
  return current === null || fee === null ? null : current + fee;
}

function outcomeLabelReason(outcome: TripOutcome, reason: string | null): string | null {
  return outcome === 'unknown_cost' ? reason : null;
}

type OpenTrip = {
  pair: string;
  quote: string;
  sourceDbId: string;
  openedAt: string;
  fills: TripFill[];
  buy: Qty;
  sell: Qty;
  realized: number | null;
  fees: number | null;
  unknown: boolean;
  reason: string | null;
};

function snapshot(trip: OpenTrip, remaining: Qty, avg: number, outcome: TripOutcome, closedAt: string | null): FillTrip {
  const available = !trip.unknown && trip.realized !== null;
  return {
    pair: trip.pair,
    quote: trip.quote,
    sourceDbId: trip.sourceDbId,
    openedAt: trip.openedAt,
    closedAt,
    outcome,
    pnlUnavailableReason: outcomeLabelReason(outcome, trip.reason),
    buyAmountBase: formatQty(trip.buy),
    sellAmountBase: formatQty(trip.sell),
    remainingBase: formatQty(remaining),
    remainingCostQuote: available && !isZero(remaining) ? toNumber(remaining) * avg : available && isZero(remaining) ? 0 : null,
    realizedPnlQuote: available ? trip.realized : null,
    feesQuote: trip.fees,
    fills: trip.fills,
  };
}

export function buildFillTrips(input: { fills: RecordedRow[]; orders: RecordedRow[]; executors: RecordedRow[] }): FillTrip[] {
  const trips: FillTrip[] = [];
  const grouped = new Map<string, RecordedRow[]>();
  for (const fill of input.fills) {
    if (isFutures(fill)) continue;
    const key = `${fill.source_db_id}\0${fill.pair}`;
    const rows = grouped.get(key);
    if (rows) rows.push(fill);
    else grouped.set(key, [fill]);
  }

  for (const [key, fills] of grouped) {
    const [sourceDbId, pair] = key.split('\0');
    const quote = pair.split('-')[1] || '';
    const chronological = [...fills].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    let qty = zero();
    let avg = 0;
    let open: OpenTrip | null = null;
    let unknown: OpenTrip | null = null;
    const wallet = input.executors.some(row =>
      row.source_db_id === sourceDbId && row.pair === pair && isWalletReason(row.pnl_unavailable_reason));
    const hold = input.executors.some(row =>
      row.source_db_id === sourceDbId && row.pair === pair && isHold(row.close_type) && row.normalized_status !== 'closed');

    const start = (fill: RecordedRow): OpenTrip => ({
      pair, quote, sourceDbId, openedAt: String(fill.timestamp), fills: [], buy: zero(), sell: zero(),
      realized: 0, fees: 0, unknown: false, reason: null,
    });

    const publish = (trip: OpenTrip, remaining: Qty, costAvg: number, outcome: TripOutcome, closedAt: string | null) => {
      trips.push(snapshot(trip, remaining, costAvg, outcome, closedAt));
    };

    const flushUnknown = () => {
      if (!unknown) return;
      unknown.unknown = true;
      unknown.realized = null;
      if (wallet) unknown.reason = unknown.reason && isWalletReason(unknown.reason) ? unknown.reason : 'unknown_wallet_acquisition_cost';
      publish(unknown, zero(), 0, 'unknown_cost', unknown.fills.at(-1)?.timestamp ?? null);
      unknown = null;
    };

    const recordUnknown = (fill: RecordedRow, side: 'buy' | 'sell' | null, reason: string) => {
      const knownSide = side ?? 'buy';
      unknown ??= { ...start(fill), unknown: true, realized: null, reason };
      unknown.reason ??= reason;
      addSide(unknown, knownSide, displayAmount(fill));
      unknown.fees = addFee(unknown.fees, feeOf(fill));
      unknown.fills.push(leg(fill, knownSide, displayAmount(fill), null));
    };

    const closeVerified = (outcome: TripOutcome, closedAt: string | null) => {
      if (!open) return;
      publish(open, qty, avg, outcome, closedAt);
      open = null;
    };

    for (const fill of chronological) {
      const side = fill.side === 'buy' || fill.side === 'sell' ? fill.side : null;
      const amount = verifiedAmount(fill);
      const price = Number(fill.price_quote);
      const timestamp = String(fill.timestamp);
      const verified = side !== null && amount !== null && Number.isFinite(price) && price > 0;

      if (!verified) {
        recordUnknown(fill, side, String(fill.economics_unavailable_reason || 'unverified_fill_receipt'));
        continue;
      }

      if (side === 'sell' && cmpQty(amount, qty) > 0) {
        recordUnknown(fill, side, wallet ? 'unknown_wallet_acquisition_cost' : 'missing_entry_basis');
        continue;
      }

      flushUnknown();

      if (side === 'buy') {
        if (isZero(qty)) open = start(fill);
        open ??= start(fill);
        const total = toNumber(qty) * avg + toNumber(amount) * price;
        qty = addQty(qty, amount);
        avg = toNumber(qty) ? total / toNumber(qty) : 0;
        addSide(open, side, amount);
        open.fees = addFee(open.fees, feeOf(fill));
        open.fills.push(leg(fill, side, amount, null));
        continue;
      }

      const realized = (price - avg) * toNumber(amount);
      qty = subQty(qty, amount);
      if (isZero(qty)) avg = 0;
      open ??= start(fill);
      addSide(open, side, amount);
      open.realized = (open.realized ?? 0) + realized;
      open.fees = addFee(open.fees, feeOf(fill));
      open.fills.push(leg(fill, side, amount, realized));
      if (isZero(qty)) closeVerified('filled', timestamp);
    }

    flushUnknown();
    if (open) {
      if (wallet) {
        open.unknown = true;
        open.realized = null;
        open.reason = 'unknown_wallet_acquisition_cost';
        closeVerified('unknown_cost', null);
      } else {
        closeVerified(hold ? 'hold' : 'in_bag', null);
      }
    }
  }

  const filledOrders = new Set(input.fills.map(fill => `${fill.source_db_id}:${fill.order_id}`));
  for (const order of input.orders) {
    if (isFutures(order) || String(order.normalized_status) !== 'canceled') continue;
    const orderId = String(order.order_id || '');
    if (!orderId || filledOrders.has(`${order.source_db_id}:${orderId}`)) continue;
    const pair = String(order.pair);
    trips.push({
      pair,
      quote: pair.split('-')[1] || '',
      sourceDbId: String(order.source_db_id),
      openedAt: String(order.timestamp || order.created_at || ''),
      closedAt: String(order.timestamp || order.created_at || '') || null,
      outcome: 'cancelled',
      pnlUnavailableReason: null,
      buyAmountBase: '0',
      sellAmountBase: '0',
      remainingBase: '0',
      remainingCostQuote: null,
      realizedPnlQuote: null,
      feesQuote: 0,
      fills: [],
    });
  }

  trips.sort((a, b) => String(b.openedAt).localeCompare(String(a.openedAt)) || a.pair.localeCompare(b.pair));
  return trips;
}

export async function loadBotFillTrips(
  bot: string,
  read: (path: string, signal: AbortSignal) => Promise<unknown>,
  signal: AbortSignal,
): Promise<FillTrip[]> {
  signal.throwIfAborted();
  const path = (dataset: string) => `/api/v1/trading-visuals/${dataset}?bot=${encodeURIComponent(bot)}`;
  const bootstrap = await read(path('bootstrap'), signal);
  const databases = validateRecordedSource(bot, bootstrap).sort();
  const [fills, orders, executors] = await Promise.all((['fills', 'orders', 'executors'] as const).map(async dataset => {
    const payload = await read(path(dataset), signal);
    if (!payload || typeof payload !== 'object' || !('rows' in payload) || !Array.isArray(payload.rows)) {
      throw new Error(`Recorded ${dataset} response is invalid`);
    }
    if (payload.rows.some(row => !databases.includes(row?.source_db_id))) {
      throw new Error('Recorded event database does not match the inspected source');
    }
    return payload.rows as RecordedRow[];
  }));
  const after = validateRecordedSource(bot, await read(path('bootstrap'), signal)).sort();
  if (JSON.stringify(after) !== JSON.stringify(databases)) throw new Error('Monitored database selection changed during the read');
  signal.throwIfAborted();
  return buildFillTrips({ fills, orders, executors });
}

export function openTripForPair(trips: FillTrip[], pair: string): FillTrip | undefined {
  return trips.find(trip => trip.pair === pair && (trip.outcome === 'in_bag' || trip.outcome === 'hold'))
    ?? trips.find(trip => trip.pair === pair && trip.outcome === 'unknown_cost');
}

export const tripOutcomeLabel: Record<TripOutcome, string> = {
  filled: 'Filled',
  in_bag: 'In the bag',
  hold: 'Hold',
  cancelled: 'Cancelled',
  unknown_cost: 'Unknown cost',
};
