/**
 * Pure projections for the Money page from the dashboard's own money samples (GET /api/v5/money). A gap row or a
 * missing interval stays a gap: series carry explicit nulls, daily rows say how many samples and gaps they hold,
 * and a comparison is shown only when both sides cover the same window.
 */

const SAMPLE_MS = 300_000;
const DAY_MS = 86_400_000;

const number = value => (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null);

/** Rows for one bot in time order. */
export function botRows(rows, bot) {
  return (Array.isArray(rows) ? rows : []).filter(row => row && row.bot === bot && Number.isInteger(row.at_ms)).sort((a, b) => a.at_ms - b.at_ms);
}

/** One field over time; a gap row or a hole longer than two sample intervals becomes an explicit null. */
export function series(rows, bot, field) {
  const out = [];
  let previous = null;
  for (const row of botRows(rows, bot)) {
    if (previous !== null && row.at_ms - previous > 2 * SAMPLE_MS) out.push({ time: previous + SAMPLE_MS, value: null });
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

/** Per UTC day: first and last sampled equity and realized, their change, and the samples and gaps behind them. */
export function daily(rows, bot) {
  const days = new Map();
  for (const row of botRows(rows, bot)) {
    const day = Math.floor(row.at_ms / DAY_MS) * DAY_MS;
    const entry = days.get(day) ?? { day, samples: 0, gaps: 0, first: null, last: null };
    entry.samples += 1;
    if (row.gap) entry.gaps += 1;
    else { entry.first = entry.first ?? row; entry.last = row; }
    days.set(day, entry);
  }
  return [...days.values()].sort((a, b) => b.day - a.day).map(entry => {
    const pick = (row, field) => (row ? number(row[field]) : null);
    const change = (field) => {
      const start = pick(entry.first, field), end = pick(entry.last, field);
      return start === null || end === null ? null : end - start;
    };
    return {
      day: entry.day, samples: entry.samples, gaps: entry.gaps,
      equityStart: pick(entry.first, 'equity'), equityEnd: pick(entry.last, 'equity'),
      equityChange: change('equity'), realizedChange: change('realized'),
      // A day's values only cover the sampled part of it; 288 samples is a whole day.
      coverage: Math.min(1, entry.samples / (DAY_MS / SAMPLE_MS)),
    };
  });
}

/**
 * Equal-weight return of holding the given coins over a window, from owner close series ([seconds, close][]).
 * A coin counts only if its first close is within `toleranceS` of the window start and it has a last close.
 */
export function holdReturn(closesByCoin, startS, toleranceS = 3600) {
  const returns = [];
  const missing = [];
  for (const [coin, points] of Object.entries(closesByCoin)) {
    const valid = (points ?? []).filter(point => Array.isArray(point) && Number.isFinite(point[1]) && point[1] > 0);
    if (!valid.length || valid[0][0] - startS > toleranceS) { missing.push(coin); continue; }
    returns.push(valid[valid.length - 1][1] / valid[0][1] - 1);
  }
  return { pct: returns.length ? (returns.reduce((sum, value) => sum + value, 0) / returns.length) * 100 : null, coins: returns.length, missing };
}

/** Equity change over the same window, only when the record reaches back to its start (within one hour). */
export function equityChangeSince(rows, bot, startMs, toleranceMs = 3_600_000) {
  const ordered = botRows(rows, bot).filter(row => !row.gap && number(row.equity) !== null);
  const first = ordered.find(row => row.at_ms >= startMs - toleranceMs);
  const last = ordered[ordered.length - 1];
  if (!first || !last || first.at_ms - startMs > toleranceMs) return null;
  return (number(last.equity) / number(first.equity) - 1) * 100;
}
