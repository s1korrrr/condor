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
 * One field over time from raw five-minute rows. A gap row, a row without the field, or one missed slot (more than
 * 1.5 slots between rows) becomes an explicit null, so a chart never joins across missing time.
 */
export function series(rows, bot, field) {
  const out = [];
  let previous = null;
  for (const row of botRows(rows, bot)) {
    if (previous !== null && row.at_ms - previous > 1.5 * SAMPLE_MS) out.push({ time: previous + SAMPLE_MS, value: null });
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
 * Equal-weight return of holding the whole basket between the first and last minute at which EVERY coin has a close
 * ([seconds, close][] per coin). Those exact minutes are returned with the figure; a coin without closes withholds it.
 * Nothing is substituted: a minute where one coin lacks a close is not a shared boundary.
 */
export function holdReturn(closesByCoin) {
  const coins = Object.keys(closesByCoin);
  const byCoin = coins.map(coin => new Map((closesByCoin[coin] ?? []).filter(point => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]) && point[1] > 0).map(point => [point[0], point[1]])));
  const missing = coins.filter((_coin, index) => byCoin[index].size === 0);
  if (!coins.length || missing.length) return { pct: null, startS: null, endS: null, missing };
  const shared = [...byCoin[0].keys()].filter(time => byCoin.every(closes => closes.has(time))).sort((a, b) => a - b);
  if (shared.length < 2) return { pct: null, startS: null, endS: null, missing: [] };
  const startS = shared[0], endS = shared[shared.length - 1];
  const pct = (byCoin.reduce((sum, closes) => sum + (closes.get(endS) / closes.get(startS) - 1), 0) / byCoin.length) * 100;
  return { pct, startS, endS, missing: [] };
}

/** V5 equity change between its own first and last sample with a value in the given rows, with those exact times. */
export function equityChange(rows, bot) {
  const ordered = botRows(rows, bot).filter(row => !row.gap && number(row.equity) !== null);
  const first = ordered[0], last = ordered[ordered.length - 1];
  if (!first || first === last) return { pct: null, startMs: null, endMs: null };
  return { pct: (number(last.equity) / number(first.equity) - 1) * 100, startMs: first.at_ms, endMs: last.at_ms };
}
