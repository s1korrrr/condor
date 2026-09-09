/** Recorded events, deliberately independent of account equity and trade matching. */
export type RecordedRow = Record<string, unknown>;
export interface RecordedBotInput {
  fills: RecordedRow[];
  orders: RecordedRow[];
  executors: RecordedRow[];
  configuredPairs?: string[];
}

export function validateRecordedSource(bot: string, payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') throw new Error('Database health is unavailable');
  const { health, data_health: dataHealth } = payload as Record<string, unknown>;
  const h = health as Record<string, unknown> | undefined;
  const sources = (dataHealth as Record<string, unknown> | undefined)?.sources;
  if (!h || !Number.isInteger(h.active_db_count) || Number(h.active_db_count) < 1 || h.db_errors !== 0 ||
      !Array.isArray(sources) || sources.length !== h.active_db_count || sources.some(source =>
        !source || source.bot_name !== bot || source.db_status !== 'ok' || source.warning_count !== 0 ||
        typeof source.source_db_id !== 'string' || !source.source_db_id)) {
    throw new Error('Recorded statistics are unavailable: monitored databases are missing, incomplete or unreadable');
  }
  return sources.map(source => source.source_db_id);
}

export async function loadRecordedBotStatistics(bot: string, read: (path: string, signal: AbortSignal) => Promise<unknown>, signal: AbortSignal) {
  signal.throwIfAborted();
  const path = (dataset: string) => `/api/v1/trading-visuals/${dataset}?bot=${encodeURIComponent(bot)}`;
  const bootstrap = await read(path('bootstrap'), signal);
  const databases = validateRecordedSource(bot, bootstrap).sort();
  const botRows = (bootstrap as Record<string, unknown>).bots;
  const configuredPairs = Array.isArray(botRows) ? botRows.filter(row => row?.bot_name === bot && databases.includes(row?.source_db_id)).flatMap(row => Array.isArray(row.pairs) ? row.pairs : []) : [];
  const datasets = await Promise.all(['fills', 'orders', 'executors'].map(async dataset => {
    const payload = await read(path(dataset), signal);
    if (!payload || typeof payload !== 'object' || !('rows' in payload) || !Array.isArray(payload.rows)) throw new Error(`Recorded ${dataset} response is invalid`);
    if (payload.rows.some(row => !databases.includes(row?.source_db_id))) throw new Error('Recorded event database does not match the inspected source');
    return payload.rows as RecordedRow[];
  }));
  const after = validateRecordedSource(bot, await read(path('bootstrap'), signal)).sort();
  if (JSON.stringify(after) !== JSON.stringify(databases)) throw new Error('Monitored database selection changed during the read');
  signal.throwIfAborted();
  return buildRecordedBotStatistics(bot, { fills: datasets[0], orders: datasets[1], executors: datasets[2], configuredPairs });
}

function validateRows(value: unknown, bot: string, identity: string): RecordedRow[] {
  if (!Array.isArray(value)) throw new Error('Recorded event list is unavailable');
  const seen = new Set<string>();
  return value.map(row => {
    if (!row || typeof row !== 'object' || row.bot_name !== bot ||
        typeof row.source_db_id !== 'string' || !row.source_db_id ||
        typeof row[identity] !== 'string' || !row[identity] ||
        typeof row.pair !== 'string' || !/^[A-Z0-9]+-[A-Z0-9]+$/.test(row.pair)) {
      throw new Error('Recorded event identity is missing or does not match this bot');
    }
    const key = `${row.source_db_id}:${row[identity]}`;
    if (seen.has(key)) throw new Error('Duplicate recorded event identity');
    seen.add(key);
    return row;
  });
}

function sumKnown(rows: RecordedRow[], field: string): number | null {
  if (rows.some(row => typeof row[field] !== 'number' || !Number.isFinite(row[field]) || Number(row[field]) < 0)) return null;
  const total = rows.reduce((sum, row) => sum + Number(row[field]), 0);
  return Number.isFinite(total) ? total : null;
}

type DailyActivity = {
  startDate: string;
  endDate: string;
  buyVolume: number;
  sellVolume: number;
  fillCount: number;
};

function buildRecordedActivity(fills: RecordedRow[], orders: RecordedRow[], quote: string | null) {
  const statusCounts = new Map<string, number>();
  for (const order of orders) {
    const status = String(order.normalized_status);
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
  }
  const orderStatuses = [...statusCounts].sort(([a], [b]) => a.localeCompare(b))
    .map(([status, count]) => ({ status, count }));
  const volumeUnavailable = fills.length === 0 ? null : !quote ? 'mixed_quote_currencies'
    : sumKnown(fills, 'gross_volume_quote') === null ? 'missing_fill_volume' : null;
  const daily: DailyActivity[] = [];
  if (fills.length === 0 || volumeUnavailable) {
    return { daily, orderStatuses, volumeUnavailable, bucketDays: 1, daysWithoutRecordedFills: 0 };
  }

  const dayMillis = 86_400_000;
  const timed = fills.map(fill => ({ fill, day: Math.floor(Date.parse(String(fill.timestamp)) / dayMillis) }));
  const observedDays = [...new Set(timed.map(({ day }) => day))].sort((a, b) => a - b);
  const firstDay = observedDays[0];
  const lastDay = observedDays[observedDays.length - 1];
  const calendarDays = lastDay - firstDay + 1;
  // Bound rendered points, not retained evidence. Longer history uses wider
  // calendar buckets and still includes every observed fill.
  const bucketDays = Math.ceil(calendarDays / 90);
  const date = (day: number) => new Date(day * dayMillis).toISOString().split('T')[0];
  for (let start = firstDay; start <= lastDay; start += bucketDays) {
    daily.push({ startDate: date(start), endDate: date(Math.min(start + bucketDays - 1, lastDay)), buyVolume: 0, sellVolume: 0, fillCount: 0 });
  }
  for (const { fill, day } of timed) {
    const point = daily[Math.floor((day - firstDay) / bucketDays)];
    if (fill.side === 'buy') point.buyVolume += Number(fill.gross_volume_quote);
    else point.sellVolume += Number(fill.gross_volume_quote);
    point.fillCount += 1;
  }
  return { daily, orderStatuses, volumeUnavailable, bucketDays, daysWithoutRecordedFills: calendarDays - observedDays.length };
}

export function buildRecordedBotStatistics(bot: string, input: RecordedBotInput) {
  const fills = validateRows(input.fills, bot, 'fill_id');
  const orders = validateRows(input.orders, bot, 'order_id');
  const executors = validateRows(input.executors, bot, 'executor_id');
  if (fills.some(row => typeof row.timestamp !== 'string' || !Number.isFinite(Date.parse(row.timestamp)) || !['buy', 'sell'].includes(String(row.side))) ||
      orders.some(row => typeof row.normalized_status !== 'string' || !row.normalized_status) ||
      executors.some(row => !['open', 'closed'].includes(String(row.normalized_status)))) {
    throw new Error('Recorded event time, side or status is unavailable');
  }
  const all = [...fills, ...orders, ...executors];
  const configuredPairs = input.configuredPairs ?? [];
  if (!Array.isArray(configuredPairs) || configuredPairs.some(pair => typeof pair !== 'string' || !/^[A-Z0-9]+-[A-Z0-9]+$/.test(pair))) throw new Error('Configured pair identity is invalid');
  const pairNames = [...new Set([...all.map(row => String(row.pair)), ...configuredPairs])].sort();
  const quotes = new Set(pairNames.map(pair => pair.split('-')[1]));
  const quote = quotes.size === 1 ? [...quotes][0] : null;
  const timestamps = fills.map(row => row.timestamp).filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))).sort((a,b) => Date.parse(a)-Date.parse(b));
  const executedOrders = new Set(fills.filter(row => typeof row.order_id === 'string' && row.order_id).map(row => `${row.source_db_id}:${row.order_id}`));
  const pairs = pairNames.map(pair => {
    const pairFills = fills.filter(row => row.pair === pair);
    return {
      pair, quote: pair.split('-')[1], fillCount: pairFills.length,
      buyFills: pairFills.filter(row => row.side === 'buy').length,
      sellFills: pairFills.filter(row => row.side === 'sell').length,
      orderCount: orders.filter(row => row.pair === pair).length,
      fullyFilledOrderCount: orders.filter(row => row.pair === pair && row.normalized_status === 'filled').length,
      canceledOrderCount: orders.filter(row => row.pair === pair && row.normalized_status === 'canceled').length,
      volume: sumKnown(pairFills, 'gross_volume_quote'), fees: sumKnown(pairFills, 'fee_quote'),
      executorCount: executors.filter(row => row.pair === pair).length,
      connectors: [...new Set(all.filter(row => row.pair === pair).map(row => row.connector_name).filter((v): v is string => typeof v === 'string' && v.length > 0))].sort(),
    };
  });
  return {
    fillCount: fills.length,
    executedOrderCount: fills.some(row => typeof row.order_id !== 'string' || !row.order_id) ? null : executedOrders.size,
    orderCount: orders.length,
    fullyFilledOrderCount: orders.filter(row => row.normalized_status === 'filled').length,
    fullyFilledOrderShare: orders.length ? orders.filter(row => row.normalized_status === 'filled').length / orders.length : null,
    canceledOrderCount: orders.filter(row => row.normalized_status === 'canceled').length,
    failedOrderCount: orders.filter(row => row.normalized_status === 'failed').length,
    closedExecutorCount: executors.filter(row => row.normalized_status === 'closed').length,
    openExecutorCount: executors.filter(row => row.normalized_status === 'open').length,
    volume: quote ? sumKnown(fills, 'gross_volume_quote') : null,
    fees: quote ? sumKnown(fills, 'fee_quote') : null,
    quote, pairs,
    activity: buildRecordedActivity(fills, orders, quote),
    firstFillAt: timestamps[0] ?? null,
    lastFillAt: timestamps.at(-1) ?? null,
    // Executor termination is not a matched round trip; retained-position exits
    // and initial inventory require authoritative cost-basis reconciliation.
    completedTradeCount: null,
    tradeWinRate: null,
  };
}

export type RecordedBotStatistics = ReturnType<typeof buildRecordedBotStatistics>;
