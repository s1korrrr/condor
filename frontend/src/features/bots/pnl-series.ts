/** Saved native PnL points for one window, as the durable observer stored them. */
export type PnlSeries = { points: { time: number; value: number | null; owner: number }[]; quote: string | null; change: number | null; reason: string | null };
export function pnlSeries(payload: unknown, bot: string, now: number): PnlSeries {
  const empty = (reason: string): PnlSeries => ({ points: [], quote: null, change: null, reason });
  if (!payload || typeof payload !== 'object') return empty('Performance history requires a timestamped, comparable series.');
  const data = payload as { source?: unknown; bot_name?: unknown; points?: unknown; truncated?: unknown };
  if (data.source !== 'native_mqtt_observer' || data.bot_name !== bot || !Array.isArray(data.points)) return empty('Performance history identity is invalid.');
  if (!data.points.length) return empty('Performance history requires a timestamped, comparable series. Recording begins with the first verified native report.');
  const points: PnlSeries['points'] = [];
  let owner = 0, previous: { timestamp: number; identity: string; segment: string; quote: string } | null = null, quote: string | null = null, gap = false;
  for (const raw of data.points) {
    const row = raw as { timestamp: number; identity: string; segment: string; quote: string; total_pnl_quote: string };
    const value = Number(row.total_pnl_quote);
    if (!Number.isFinite(row.timestamp) || row.timestamp * 1000 > now + 5_000 || !Number.isFinite(value) || typeof row.quote !== 'string' || (quote && quote !== row.quote) || (previous && row.timestamp <= previous.timestamp)) return empty('Performance history contains incompatible observations.');
    quote = row.quote;
    if (previous && (previous.segment !== row.segment || previous.identity !== row.identity || row.timestamp - previous.timestamp > 90)) { points.push({ time: previous.timestamp * 1000 + 1, value: null, owner }); gap = true; }
    if (previous && previous.identity !== row.identity) owner += 1;
    points.push({ time: row.timestamp * 1000, value, owner });
    previous = row;
  }
  // Window change = sum of within-owner changes. Sampling gaps keep the line broken but contribute nothing; owner boundaries contribute nothing.
  void gap;
  let change: number | null = null;
  if (points.length > 1 && data.truncated !== true) {
    change = 0;
    let runStart: { value: number; owner: number } | null = null, runLast: { value: number; owner: number } | null = null;
    for (const point of points) {
      if (point.value == null) continue;
      if (!runStart || runStart.owner !== point.owner) { if (runStart && runLast) change += runLast.value - runStart.value; runStart = { value: point.value, owner: point.owner }; }
      runLast = { value: point.value, owner: point.owner };
    }
    if (runStart && runLast) change += runLast.value - runStart.value;
  }
  return { points, quote, change, reason: null };
}

