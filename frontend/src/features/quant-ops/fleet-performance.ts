import { projectPerformanceHistory } from './performance-history';

/**
 * Fleet-wide bot performance from saved native PnL history. Pure and unit-tested; the React hook that
 * feeds it lives in `fleet-reads.ts`.
 *
 * Why this is deposit independent: every bot reports its own cumulative PnL (`total_pnl_quote`), so a
 * wallet deposit or withdrawal never moves it. The fleet figure is the SUM of per-bot changes:
 *
 *  - a bot's change over a window is the sum of its within-owner-run changes. A run is the stretch
 *    between two owner (boot identity) changes, so a restart is a boundary and never a delta;
 *  - the first sample inside the window is the baseline. When history starts after the window opens,
 *    the change covers the observed span only and the result says where history starts;
 *  - a bot that appears mid-window contributes from its first sample, never a made-up opening value;
 *  - a bot without readable history is named in `missing`; totals state how many bots they cover.
 */

export type HistoryRange = '1D' | '1W' | '1M' | 'ALL';

export type BotSample = { time: number; total: number; realized: number; unrealized: number; owner: number };

export type BotHistory = {
  bot: string;
  range: HistoryRange;
  quote: string | null;
  samples: BotSample[];
  /** Longest same-run spacing of this read (bucketed reads add their bucket width). */
  gapMs: number;
  bucketSeconds: number | null;
  truncated: boolean;
  /** Why no sample is usable: failed read, invalid payload or recording not started. */
  reason: string | null;
};

type RawRow = { timestamp: number; realized_pnl_quote: string; unrealized_pnl_quote: string };

/** Validate one Condor performance-history payload and keep numeric samples with their owner run. */
export function parseBotHistory(payload: unknown, bot: string, range: HistoryRange, now: number, failed = false): BotHistory {
  if (failed) return { bot, range, quote: null, samples: [], gapMs: 90_000, bucketSeconds: null, truncated: false, reason: 'Performance history read failed.' };
  const view = projectPerformanceHistory(payload, bot, now, range);
  const rows = payload && typeof payload === 'object' && Array.isArray((payload as { points?: unknown }).points) ? (payload as { points: RawRow[] }).points : [];
  const byTime = new Map(rows.map(row => [row.timestamp * 1000, row]));
  const samples: BotSample[] = [];
  for (const point of view.points) {
    if (point.value == null) continue;
    const row = byTime.get(point.time);
    const realized = row ? Number(row.realized_pnl_quote) : NaN, unrealized = row ? Number(row.unrealized_pnl_quote) : NaN;
    if (Number.isFinite(realized) && Number.isFinite(unrealized)) samples.push({ time: point.time, total: point.value, realized, unrealized, owner: point.owner });
  }
  return { bot, range, quote: view.quote, samples, gapMs: view.gapMs, bucketSeconds: view.bucketSeconds, truncated: view.truncated, reason: view.reason };
}

/** Changes are taken only inside one owner run. Deltas never span a restart. */
function runDeltas(samples: BotSample[]): { total: number; realized: number; unrealized: number; restarts: number } {
  let total = 0, realized = 0, unrealized = 0, restarts = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const a = samples[index - 1], b = samples[index];
    if (a.owner !== b.owner) { restarts += 1; continue; }
    total += b.total - a.total; realized += b.realized - a.realized; unrealized += b.unrealized - a.unrealized;
  }
  return { total, realized, unrealized, restarts };
}

export type BotWindow = {
  bot: string;
  quote: string | null;
  change: number | null;
  realized: number | null;
  unrealized: number | null;
  firstAt: number | null;
  lastAt: number | null;
  samples: number;
  restarts: number;
  /** Time between consecutive samples inside the window that exceeds the read's spacing: changes are summed across it, but it was not observed. */
  uncoveredMs: number;
  /** First sample is within one sample spacing of the window start. */
  full: boolean;
  /** Newest sample is older than the read's spacing plus 90s at `now`. */
  stale: boolean;
};

/** One bot's change over [from, to]. `change` is null until two samples exist inside the window. */
export function botWindow(history: BotHistory, from: number, to: number, now: number): BotWindow {
  const inside = history.samples.filter(sample => sample.time >= from && sample.time <= to);
  const first = inside[0] ?? null, last = inside.at(-1) ?? null;
  const deltas = inside.length >= 2 ? runDeltas(inside) : null;
  return {
    bot: history.bot, quote: history.quote,
    change: deltas?.total ?? null, realized: deltas?.realized ?? null, unrealized: deltas?.unrealized ?? null,
    firstAt: first?.time ?? null, lastAt: last?.time ?? null, samples: inside.length, restarts: deltas?.restarts ?? 0,
    uncoveredMs: inside.slice(1).reduce((total, sample, index) => {
      const spacing = sample.time - inside[index].time;
      return spacing > history.gapMs ? total + spacing : total;
    }, 0),
    full: first != null && first.time <= from + history.gapMs,
    stale: last == null || now - last.time > history.gapMs + 90_000,
  };
}

export type FleetWindow = {
  from: number;
  to: number;
  quote: string | null;
  total: number | null;
  realized: number | null;
  unrealized: number | null;
  bots: BotWindow[];
  /** Registered bots that contribute to the totals. */
  counted: number;
  expected: number;
  missing: { bot: string; reason: string }[];
  /** Earliest first sample among counted bots; the span the totals cover begins here when `partial`. */
  since: number | null;
  /** True when any counted bot's history starts after the window opens. */
  partial: boolean;
  /** Counted bots whose history covers the whole window. */
  fullBots: number;
  /** Counted bots whose window contains a recording hole longer than their sample spacing. */
  gaps: { bot: string; uncoveredMs: number }[];
  latestAt: number | null;
};

const iso = (time: number) => new Date(time).toISOString().slice(0, 16).replace('T', ' ');

/**
 * Plain window label when every counted bot covers it. When none does: "since 2026-10-01 07:21 UTC (history starts here)".
 * When only some start late, the full-window label stays and the late bots are named with their start.
 */
export function windowLabel(window: FleetWindow, plain: string): string {
  if (window.total == null || window.since == null || !window.partial) return plain;
  if (window.fullBots === 0) return `since ${iso(window.since)} UTC (history starts here)`;
  const late = window.bots.filter(bot => !bot.full);
  const from = Math.min(...late.map(bot => bot.firstAt!));
  return `${plain} · ${late.map(bot => bot.bot).join(', ')} counted from ${iso(from)} UTC (history starts here)`;
}

/** "3 of 3 bots" or "2 of 3 bots · missing: ok_rsi" for tile notes. */
export function coverageLabel(window: Pick<FleetWindow, 'counted' | 'expected' | 'missing'>): string {
  const base = `${window.counted} of ${window.expected} bot${window.expected === 1 ? '' : 's'}`;
  return window.missing.length ? `${base} · missing: ${window.missing.map(item => item.bot).join(', ')}` : base;
}

/** Sum of per-bot changes over [from, to]. Quotes never mix: the most common quote wins, others are named missing. */
export function fleetWindow(histories: BotHistory[], bots: string[], from: number, to: number, now: number): FleetWindow {
  const missing: { bot: string; reason: string }[] = [];
  const windows: BotWindow[] = [];
  for (const bot of bots) {
    const history = histories.find(item => item.bot === bot);
    if (!history) { missing.push({ bot, reason: 'No performance history read for this bot.' }); continue; }
    if (!history.samples.length) { missing.push({ bot, reason: history.reason ?? 'No saved performance samples.' }); continue; }
    const window = botWindow(history, from, to, now);
    if (window.change == null) { missing.push({ bot, reason: `Needs two samples inside the window (has ${window.samples}).` }); continue; }
    windows.push(window);
  }
  const quotes = new Map<string, number>();
  for (const window of windows) if (window.quote) quotes.set(window.quote, (quotes.get(window.quote) ?? 0) + 1);
  const quote = [...quotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const counted = windows.filter(window => {
    if (window.quote === quote) return true;
    missing.push({ bot: window.bot, reason: `Quote ${window.quote ?? 'unknown'} differs from ${quote}; not summed.` });
    return false;
  });
  const sum = (key: 'change' | 'realized' | 'unrealized') => counted.length ? counted.reduce((total, window) => total + (window[key] ?? 0), 0) : null;
  const order = new Map(bots.map((bot, index) => [bot, index]));
  return {
    from, to, quote, total: sum('change'), realized: sum('realized'), unrealized: sum('unrealized'),
    bots: counted, counted: counted.length, expected: bots.length, missing: missing.sort((a, b) => (order.get(a.bot) ?? 0) - (order.get(b.bot) ?? 0)),
    since: counted.length ? Math.min(...counted.map(window => window.firstAt!)) : null,
    partial: counted.some(window => !window.full),
    fullBots: counted.filter(window => window.full).length,
    gaps: counted.filter(window => window.uncoveredMs > 0).map(window => ({ bot: window.bot, uncoveredMs: window.uncoveredMs })),
    latestAt: counted.length ? Math.max(...counted.map(window => window.lastAt!)) : null,
  };
}

export type FleetPoint = { time: number; value: number | null };

/** Histories in the most common quote (ties: first seen). Quotes never mix in sums, series or risk statistics. */
export function sameQuote(histories: BotHistory[]): BotHistory[] {
  const counts = new Map<string, number>();
  for (const history of histories) if (history.samples.length && history.quote) counts.set(history.quote, (counts.get(history.quote) ?? 0) + 1);
  const quote = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return quote ? histories.filter(history => history.quote === quote) : histories;
}

/**
 * Cumulative fleet PnL since the window opened, on one shared time grid.
 * Each bot's contribution starts at 0 at its first sample (a bot that appears later adds no step) and is
 * carried forward between its samples. Samples are snapped to `stepSeconds` buckets so bots that report
 * at different seconds line up; the newest sample in a bucket wins.
 */
export function fleetSeries(histories: BotHistory[], from: number, to: number, stepSeconds = 60): FleetPoint[] {
  const step = Math.max(1, stepSeconds) * 1000;
  const perBot: Map<number, { contribution: number; time: number }>[] = [];
  for (const history of sameQuote(histories)) {
    const inside = history.samples.filter(sample => sample.time >= from && sample.time <= to);
    if (!inside.length) continue;
    const buckets = new Map<number, { contribution: number; time: number }>();
    let contribution = 0;
    inside.forEach((sample, index) => {
      if (index > 0 && inside[index - 1].owner === sample.owner) contribution += sample.total - inside[index - 1].total;
      buckets.set(Math.floor(sample.time / step), { contribution, time: sample.time });
    });
    perBot.push(buckets);
  }
  const keys = [...new Set(perBot.flatMap(buckets => [...buckets.keys()]))].sort((a, b) => a - b);
  const current = perBot.map(() => 0);
  return keys.map(key => {
    let time = 0;
    perBot.forEach((buckets, index) => {
      const hit = buckets.get(key);
      if (hit) { current[index] = hit.contribution; time = Math.max(time, hit.time); }
    });
    return { time: time || key * step, value: current.reduce((total, value) => total + value, 0) };
  });
}

/** Owner changes inside the window, for chart markers. */
export function restartTimes(histories: BotHistory[], from: number, to: number): number[] {
  return histories.flatMap(history => history.samples.flatMap((sample, index) => index > 0 && history.samples[index - 1].owner !== sample.owner && sample.time >= from && sample.time <= to ? [sample.time] : [])).sort((a, b) => a - b);
}

export type FleetDay = { day: string; net: number; realized: number; unrealized: number; bots: number; cumulative: number; today: boolean };

const DAY_MS = 86_400_000;

/**
 * Fleet PnL per UTC day from every bot's same-run steps. A step between two samples belongs to the day of the
 * later sample, so a day keeps the movement across midnight and the bars add up to the window change.
 */
export function fleetDailyBars(histories: BotHistory[], now: number, from = -Infinity): FleetDay[] {
  const days = new Map<number, { net: number; realized: number; unrealized: number; bots: Set<string> }>();
  for (const history of sameQuote(histories)) {
    for (let index = 1; index < history.samples.length; index += 1) {
      const a = history.samples[index - 1], b = history.samples[index];
      // Both samples inside the window, as in `botWindow`, so the bars add up to the window change.
      if (a.owner !== b.owner || a.time < from || b.time > now) continue;
      const day = Math.floor(b.time / DAY_MS) * DAY_MS;
      const row = days.get(day) ?? { net: 0, realized: 0, unrealized: 0, bots: new Set<string>() };
      row.net += b.total - a.total; row.realized += b.realized - a.realized; row.unrealized += b.unrealized - a.unrealized; row.bots.add(history.bot);
      days.set(day, row);
    }
  }
  let cumulative = 0;
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  return [...days.entries()].sort(([a], [b]) => a - b).map(([day, row]) => {
    cumulative += row.net;
    return { day: new Date(day).toISOString().slice(0, 10), net: row.net, realized: row.realized, unrealized: row.unrealized, bots: row.bots.size, cumulative, today: day === today };
  });
}

/** Largest peak-to-trough fall of the fleet PnL curve, in quote units. The curve starts at 0. */
export function pnlDrawdown(points: FleetPoint[]): { depth: number; from: number; to: number } | null {
  let peak = 0, peakTime = points[0]?.time ?? 0, worst: { depth: number; from: number; to: number } | null = null;
  for (const point of points) {
    if (point.value == null) continue;
    if (point.value > peak) { peak = point.value; peakTime = point.time; }
    const depth = peak - point.value;
    if (depth > 0 && (!worst || depth > worst.depth)) worst = { depth, from: peakTime, to: point.time };
  }
  return worst;
}

export const RISK_MIN_DAYS = 14;
export const TAIL_MIN_DAYS = 60;

export type FleetRisk = {
  days: number;
  meanDaily: number;
  volatilityDaily: number | null;
  /** Annualised with sqrt(365): crypto trades every day. */
  sharpe: number | null;
  sortino: number | null;
  var95: number | null;
  expectedShortfall95: number | null;
  /** Statistic availability against the minimum sample sizes; callers render only what is non-null. */
  minDays: number;
  tailMinDays: number;
};

/**
 * Risk statistics on daily fleet bot-PnL returns (day PnL / equity). They are bot-reported and therefore
 * flow independent. Statistics that need more days than observed are null, so nothing is shown early.
 */
export function fleetRisk(dailyReturns: number[]): FleetRisk {
  const n = dailyReturns.length;
  const mean = n ? dailyReturns.reduce((sum, value) => sum + value, 0) / n : 0;
  const variance = n > 1 ? dailyReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1) : null;
  const volatility = variance == null ? null : Math.sqrt(variance);
  const enough = n >= RISK_MIN_DAYS && volatility != null;
  const downside = n ? Math.sqrt(dailyReturns.reduce((sum, value) => sum + Math.min(0, value) ** 2, 0) / n) : 0;
  const sorted = [...dailyReturns].sort((a, b) => a - b);
  const cut = Math.max(1, Math.floor(n * 0.05));
  const tail = n >= TAIL_MIN_DAYS;
  return {
    days: n, meanDaily: mean,
    volatilityDaily: enough ? volatility : null,
    sharpe: enough && volatility! > 0 ? (mean / volatility!) * Math.sqrt(365) : null,
    sortino: enough && downside > 0 ? (mean / downside) * Math.sqrt(365) : null,
    var95: tail ? -sorted[cut - 1] : null,
    expectedShortfall95: tail ? -(sorted.slice(0, cut).reduce((sum, value) => sum + value, 0) / cut) : null,
    minDays: RISK_MIN_DAYS, tailMinDays: TAIL_MIN_DAYS,
  };
}

/** Completed UTC days only, divided by one equity basis. Today is still moving and never enters a statistic. */
export function dailyReturns(days: FleetDay[], equity: number | null): number[] {
  if (equity == null || !Number.isFinite(equity) || equity <= 0) return [];
  return days.filter(day => !day.today).map(day => day.net / equity);
}
