/**
 * Pure projections for the Money page from the dashboard's own money samples (GET /api/v5/money). A gap row or a
 * missing interval stays a gap: series carry explicit nulls, daily rows say how many samples and gaps they hold,
 * and a comparison is shown only when both sides cover the same window.
 */

const SAMPLE_MS = 300_000;

const number = value => (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null);

/** Rows for one bot in time order. */
export function botRows(rows, bot) {
  return (Array.isArray(rows) ? rows : []).filter(row => row && row.bot === bot && Number.isInteger(row.at_ms)).sort((a, b) => a.at_ms - b.at_ms);
}

/**
 * One field over time at the server's step (5 minutes, or 1 hour for 30 days). A gap row, or one missed step
 * (more than 1.5 steps between rows), becomes an explicit null so a chart never joins across missing time.
 */
export function series(rows, bot, field, stepMs = SAMPLE_MS) {
  const out = [];
  let previous = null;
  for (const row of botRows(rows, bot)) {
    if (previous !== null && row.at_ms - previous > 1.5 * stepMs) out.push({ time: previous + stepMs, value: null });
    out.push({ time: row.at_ms, value: row.gap ? null : number(row[field]) });
    previous = row.at_ms;
  }
  return out;
}

/** The newest row with values, and the newest row of any kind (to say if the latest sample was a gap). */
export function latest(rows, bot) {
  const ordered = botRows(rows, bot);
  const newest = ordered[ordered.length - 1] ?? null;
  const withValues = [...ordered].reverse().find(row => !row.gap) ?? null;
  return { newest, withValues };
}

/** Share of a UTC day's 288 five-minute slots that hold values (not gaps, not missing). */
export function dayCoverage(entry) {
  return entry && Number.isInteger(entry.valid) ? Math.min(1, entry.valid / 288) : null;
}

/**
 * Equal-weight return of holding the whole basket over one window, from owner close series ([seconds, close][]).
 * Every coin needs a close within `toleranceS` of both the window start and end; otherwise the comparison is
 * unavailable and the coins that lack a boundary are named. The basket is never silently reduced.
 */
export function holdReturn(closesByCoin, startS, endS, toleranceS = 3600) {
  const returns = [];
  const missing = [];
  for (const [coin, points] of Object.entries(closesByCoin)) {
    const valid = (points ?? []).filter(point => Array.isArray(point) && Number.isFinite(point[1]) && point[1] > 0);
    const first = valid[0], last = valid[valid.length - 1];
    if (!first || first[0] - startS > toleranceS || endS - last[0] > toleranceS || last === first) { missing.push(coin); continue; }
    returns.push(last[1] / first[1] - 1);
  }
  const complete = missing.length === 0 && returns.length > 0;
  return { pct: complete ? (returns.reduce((sum, value) => sum + value, 0) / returns.length) * 100 : null, coins: returns.length, missing };
}

/** Equity change over the same window: values within `toleranceMs` of both its start and its end, else null. */
export function equityChangeSince(rows, bot, startMs, endMs, toleranceMs = 3_600_000) {
  const ordered = botRows(rows, bot).filter(row => !row.gap && number(row.equity) !== null);
  const first = ordered.find(row => row.at_ms >= startMs - toleranceMs);
  const last = [...ordered].reverse().find(row => row.at_ms <= endMs + toleranceMs);
  if (!first || !last || first === last || first.at_ms - startMs > toleranceMs || endMs - last.at_ms > toleranceMs) return null;
  return (number(last.equity) / number(first.equity) - 1) * 100;
}
