/** Saved native PnL points for one window, as the durable observer stored them. */
export type PnlSeries = { points: { time: number; value: number | null; owner: number }[]; quote: string | null; change: number | null; reason: string | null };
const RANGE_SECONDS = { '1D': 86_400, '1W': 604_800 } as const;

export function pnlSeries(payload: unknown, bot: string, now: number, expectedRange: keyof typeof RANGE_SECONDS): PnlSeries {
  const empty = (reason: string): PnlSeries => ({ points: [], quote: null, change: null, reason });
  if (!payload || typeof payload !== 'object') return empty('Performance history requires a timestamped, comparable series.');
  const data = payload as { source?: unknown; bot_name?: unknown; range?: unknown; coverage_start?: unknown; points?: unknown; truncated?: unknown };
  if (data.source !== 'native_mqtt_observer' || data.bot_name !== bot || data.range !== expectedRange || !Array.isArray(data.points)) return empty('Performance history identity or requested window is invalid.');
  if (!data.points.length) return empty('Performance history requires a timestamped, comparable series. Recording begins with the first verified native report.');
  const points: PnlSeries['points'] = [];
  let owner = 0, previous: { timestamp: number; identity: string; segment: string; quote: string } | null = null, quote: string | null = null;
  for (const raw of data.points) {
    const row = raw as { timestamp: number; identity: string; segment: string; quote: string; total_pnl_quote: string };
    const value = Number(row.total_pnl_quote);
    if (!Number.isFinite(row.timestamp) || row.timestamp * 1000 > now + 5_000 || !Number.isFinite(value) || typeof row.quote !== 'string' || (quote && quote !== row.quote) || (previous && row.timestamp <= previous.timestamp)) return empty('Performance history contains incompatible observations.');
    quote = row.quote;
    if (previous && (previous.segment !== row.segment || previous.identity !== row.identity || row.timestamp - previous.timestamp > 90)) points.push({ time: previous.timestamp * 1000 + 1, value: null, owner });
    if (previous && previous.identity !== row.identity) owner += 1;
    points.push({ time: row.timestamp * 1000, value, owner });
    previous = row;
  }
  // A window change is comparable only with full edge coverage, one owner segment and no gaps.
  let change: number | null = null;
  const duration = RANGE_SECONDS[expectedRange];
  const start = now / 1000 - duration;
  const first = points.find(point => point.value !== null);
  const last = [...points].reverse().find(point => point.value !== null);
  const oneOwner = new Set(points.filter(point => point.value !== null).map(point => point.owner)).size === 1;
  const noGaps = points.every(point => point.value !== null);
  const completeEdges = first !== undefined && last !== undefined && first.time / 1000 <= start + 90 && last.time / 1000 >= now / 1000 - 90;
  const completeSource = data.truncated !== true && Number.isFinite(data.coverage_start) && Number(data.coverage_start) <= start + 90;
  const reason = completeEdges && completeSource && oneOwner && noGaps
    ? null
    : `${expectedRange} change requires complete window coverage from one owner without gaps.`;
  if (reason === null && first && last) change = last.value! - first.value!;
  return { points, quote, change, reason };
}
