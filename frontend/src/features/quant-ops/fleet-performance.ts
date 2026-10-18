import { checkedDifference, historyAmount, projectPerformanceHistory } from './performance-history';

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

const checkedAdd = (left: number, right: number): number | null => {
  const result = left + right;
  return Number.isFinite(result) && (left === 0 || result !== right) && (right === 0 || result !== left) ? result : null;
};
const checkedDelta = checkedDifference;

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
    const realized = historyAmount(row?.realized_pnl_quote)?.number, unrealized = historyAmount(row?.unrealized_pnl_quote)?.number;
    if (realized != null && unrealized != null) samples.push({ time: point.time, total: point.value, realized, unrealized, owner: point.owner });
  }
  return { bot, range, quote: view.quote, samples, gapMs: view.gapMs, bucketSeconds: view.bucketSeconds, truncated: view.truncated, reason: view.reason };
}

/** Changes are taken only inside one owner run. Deltas never span a restart. */
function runDeltas(samples: BotSample[]): { total: number; realized: number; unrealized: number; restarts: number } | null {
  let total = 0, realized = 0, unrealized = 0, restarts = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const a = samples[index - 1], b = samples[index];
    if (a.owner !== b.owner) { restarts += 1; continue; }
    const deltas = [checkedDelta(b.total, a.total), checkedDelta(b.realized, a.realized), checkedDelta(b.unrealized, a.unrealized)];
    if (deltas.some(delta => delta == null)) return null;
    const next = [checkedAdd(total, deltas[0]!), checkedAdd(realized, deltas[1]!), checkedAdd(unrealized, deltas[2]!)];
    if (next.some(value => value == null)) return null;
    [total, realized, unrealized] = next as number[];
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
  numericInvalid?: boolean;
};

/** Named as-of windows include their final observation; supplied historical bounds are half-open. */
export function botWindow(history: BotHistory, from: number, to: number, now: number, endExclusive = false): BotWindow {
  const inside = history.samples.filter(sample => sample.time >= from && (endExclusive ? sample.time < to : sample.time <= to));
  const first = inside[0] ?? null, last = inside.at(-1) ?? null;
  const deltas = inside.length >= 2 ? runDeltas(inside) : null;
  return {
    bot: history.bot, quote: history.quote,
    change: deltas?.total ?? null, realized: deltas?.realized ?? null, unrealized: deltas?.unrealized ?? null,
    firstAt: first?.time ?? null, lastAt: last?.time ?? null, samples: inside.length, restarts: deltas?.restarts ?? 0,
    numericInvalid: inside.length >= 2 && deltas == null,
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

/** Sum per-bot changes; supplied historical bounds use [from, to). Quotes never mix. */
export function fleetWindow(histories: BotHistory[], bots: string[], from: number, to: number, now: number, endExclusive = false): FleetWindow {
  const missing: { bot: string; reason: string }[] = [];
  const windows: BotWindow[] = [];
  for (const bot of bots) {
    const history = histories.find(item => item.bot === bot);
    if (!history) { missing.push({ bot, reason: 'No performance history read for this bot.' }); continue; }
    if (!history.samples.length) { missing.push({ bot, reason: history.reason ?? 'No saved performance samples.' }); continue; }
    const window = botWindow(history, from, to, now, endExclusive);
    if (window.change == null) { missing.push({ bot, reason: window.numericInvalid ? 'Performance history contains unrepresentable numeric changes.' : `Needs two samples inside the window (has ${window.samples}).` }); continue; }
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
  const sum = (key: 'change' | 'realized' | 'unrealized') => {
    if (!counted.length) return null;
    let total = 0;
    for (const window of counted) {
      const next = checkedAdd(total, window[key]!);
      if (next == null) return null;
      total = next;
    }
    return total;
  };
  const totals = [sum('change'), sum('realized'), sum('unrealized')];
  if (counted.length && totals.some(value => value == null)) {
    missing.push(...counted.map(window => ({ bot: window.bot, reason: 'Fleet sum is unrepresentable.' })));
    counted.length = 0;
  }
  const order = new Map(bots.map((bot, index) => [bot, index]));
  return {
    from, to, quote, total: counted.length ? totals[0] : null, realized: counted.length ? totals[1] : null, unrealized: counted.length ? totals[2] : null,
    bots: counted, counted: counted.length, expected: bots.length, missing: missing.sort((a, b) => (order.get(a.bot) ?? 0) - (order.get(b.bot) ?? 0)),
    since: counted.length ? Math.min(...counted.map(window => window.firstAt!)) : null,
    partial: counted.some(window => !window.full),
    fullBots: counted.filter(window => window.full).length,
    gaps: counted.filter(window => window.uncoveredMs > 0).map(window => ({ bot: window.bot, uncoveredMs: window.uncoveredMs })),
    latestAt: counted.length ? Math.max(...counted.map(window => window.lastAt!)) : null,
  };
}

export type FleetPoint = { time: number; value: number | null };

/** The window owns contributor and quote admission for every chart of its change. */
function windowHistories(histories: BotHistory[], from: number, to: number, selected?: FleetWindow, endExclusive = false): BotHistory[] {
  const window = selected ?? fleetWindow(histories, histories.map(history => history.bot), from, to, to, endExclusive);
  return window.bots.flatMap(bot => {
    const history = histories.find(history => history.bot === bot.bot && history.quote === window.quote);
    return history ? [history] : [];
  });
}

/**
 * Cumulative fleet PnL since the window opened, on one shared time grid.
 * Each bot's contribution starts at 0 at its first sample (a bot that appears later adds no step) and is
 * carried forward between its samples. Samples are snapped to `stepSeconds` buckets so bots that report
 * at different seconds line up; the newest sample in a bucket wins.
 */
export function fleetSeries(histories: BotHistory[], from: number, to: number, stepSeconds = 60, selected?: FleetWindow, endExclusive = false): FleetPoint[] {
  const step = Math.max(1, stepSeconds) * 1000;
  const perBot: Map<number, { contribution: number; time: number }>[] = [];
  for (const history of windowHistories(histories, from, to, selected, endExclusive)) {
    const inside = history.samples.filter(sample => sample.time >= from && (endExclusive ? sample.time < to : sample.time <= to));
    if (!inside.length) continue;
    const buckets = new Map<number, { contribution: number; time: number }>();
    let contribution = 0;
    for (const [index, sample] of inside.entries()) {
      if (index > 0 && inside[index - 1].owner === sample.owner) {
        const delta = checkedDelta(sample.total, inside[index - 1].total);
        const next = delta == null ? null : checkedAdd(contribution, delta);
        if (next == null) return [];
        contribution = next;
      }
      buckets.set(Math.floor(sample.time / step), { contribution, time: sample.time });
    }
    perBot.push(buckets);
  }
  const keys = [...new Set(perBot.flatMap(buckets => [...buckets.keys()]))].sort((a, b) => a - b);
  const current = perBot.map(() => 0);
  const points: FleetPoint[] = [];
  for (const key of keys) {
    let time = 0;
    perBot.forEach((buckets, index) => {
      const hit = buckets.get(key);
      if (hit) { current[index] = hit.contribution; time = Math.max(time, hit.time); }
    });
    let value = 0;
    for (const part of current) {
      const next = checkedAdd(value, part);
      if (next == null) return [];
      value = next;
    }
    points.push({ time: time || key * step, value });
  }
  return points;
}

/** Owner changes inside the window, for chart markers. */
export function restartTimes(histories: BotHistory[], from: number, to: number, selected?: FleetWindow, endExclusive = false): number[] {
  return windowHistories(histories, from, to, selected, endExclusive).flatMap(history => history.samples.flatMap((sample, index) => index > 0 && history.samples[index - 1].owner !== sample.owner && history.samples[index - 1].time >= from && sample.time >= from && (endExclusive ? sample.time < to : sample.time <= to) ? [sample.time] : [])).sort((a, b) => a - b);
}

export type FleetDay = { day: string; net: number; realized: number; unrealized: number; bots: number; cumulative: number; today: boolean };

const DAY_MS = 86_400_000;

/**
 * Fleet PnL per UTC day from every bot's same-run steps. A step between two samples belongs to the day of the
 * later sample, so a day keeps the movement across midnight and the bars add up to the window change.
 */
export function fleetDailyBars(histories: BotHistory[], now: number, from = -Infinity, selected?: FleetWindow, endExclusive = false): FleetDay[] {
  const days = new Map<number, { net: number; realized: number; unrealized: number; bots: Set<string> }>();
  for (const history of windowHistories(histories, from, now, selected, endExclusive)) {
    for (let index = 1; index < history.samples.length; index += 1) {
      const a = history.samples[index - 1], b = history.samples[index];
      // Both samples inside the window, as in `botWindow`, so the bars add up to the window change.
      if (a.owner !== b.owner || a.time < from || (endExclusive ? b.time >= now : b.time > now)) continue;
      const day = Math.floor(b.time / DAY_MS) * DAY_MS;
      const row = days.get(day) ?? { net: 0, realized: 0, unrealized: 0, bots: new Set<string>() };
      const deltas = [checkedDelta(b.total, a.total), checkedDelta(b.realized, a.realized), checkedDelta(b.unrealized, a.unrealized)];
      if (deltas.some(value => value == null)) return [];
      const next = [checkedAdd(row.net, deltas[0]!), checkedAdd(row.realized, deltas[1]!), checkedAdd(row.unrealized, deltas[2]!)];
      if (next.some(value => value == null)) return [];
      [row.net, row.realized, row.unrealized] = next as number[];
      row.bots.add(history.bot);
      days.set(day, row);
    }
  }
  let cumulative = 0;
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const bars: FleetDay[] = [];
  for (const [day, row] of [...days.entries()].sort(([a], [b]) => a - b)) {
    const next = checkedAdd(cumulative, row.net);
    if (next == null) return [];
    cumulative = next;
    bars.push({ day: new Date(day).toISOString().slice(0, 10), net: row.net, realized: row.realized, unrealized: row.unrealized, bots: row.bots.size, cumulative, today: day === today });
  }
  return bars;
}

/** Daily risk bars require every admitted bot to cover both UTC edges without a gap or owner change. */
export function qualifiedFleetDailyBars(histories: BotHistory[], to: number, from: number, selected: FleetWindow): FleetDay[] {
  const admitted = selected.bots.map(bot => histories.find(history => history.bot === bot.bot && history.quote === selected.quote));
  if (!admitted.length || admitted.some(history => !history) || !Number.isFinite(from) || !Number.isFinite(to)) return [];
  const byBotDay = admitted.map(history => {
    const days = new Map<number, BotSample[]>();
    for (const sample of history!.samples) {
      if (sample.time < from || sample.time >= to) continue;
      const day = Math.floor(sample.time / DAY_MS) * DAY_MS;
      const rows = days.get(day) ?? [];
      rows.push(sample);
      days.set(day, rows);
    }
    return days;
  });
  const days: FleetDay[] = [];
  let cumulative = 0;
  for (let start = Math.ceil(from / DAY_MS) * DAY_MS; start + DAY_MS <= to; start += DAY_MS) {
    let net = 0, realized = 0, unrealized = 0, complete = true;
    for (let index = 0; index < admitted.length; index += 1) {
      const history = admitted[index]!;
      const samples = byBotDay[index].get(start) ?? [];
      // The previous UTC day's last observation is this day's close-to-close baseline. Include the
      // step into midnight once; an exact midnight sample is the baseline only when no prior close exists.
      const prior = byBotDay[index].get(start - DAY_MS)?.at(-1);
      const first = prior && start - prior.time <= history.gapMs ? prior : samples[0]?.time === start ? samples[0] : null;
      const last = samples.at(-1);
      const observed = first && first.time < start ? [first, ...samples] : samples;
      if (!first || !last || first === last || start - first.time > history.gapMs || start + DAY_MS - last.time > history.gapMs ||
          observed.some((sample, rowIndex) => rowIndex > 0 && (sample.owner !== observed[rowIndex - 1].owner || sample.time - observed[rowIndex - 1].time > history.gapMs))) {
        complete = false;
        break;
      }
      const deltas = [checkedDelta(last.total, first.total), checkedDelta(last.realized, first.realized), checkedDelta(last.unrealized, first.unrealized)];
      if (deltas.some(value => value == null)) { complete = false; break; }
      const next = [checkedAdd(net, deltas[0]!), checkedAdd(realized, deltas[1]!), checkedAdd(unrealized, deltas[2]!)];
      if (next.some(value => value == null)) { complete = false; break; }
      [net, realized, unrealized] = next as number[];
    }
    if (!complete) continue;
    const next = checkedAdd(cumulative, net);
    if (next == null) return [];
    cumulative = next;
    days.push({ day: new Date(start).toISOString().slice(0, 10), net, realized, unrealized, bots: admitted.length, cumulative, today: false });
  }
  return days;
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
  meanDaily: number | null;
  volatilityDaily: number | null;
  /** Annualised with sqrt(365): crypto trades every day. */
  sharpe: number | null;
  sortino: number | null;
  var95: number | null;
  expectedShortfall95: number | null;
  /** Statistic availability against the minimum sample sizes; callers render only what is non-null. */
  minDays: number;
  tailMinDays: number;
  /** Finite owner returns whose aggregate statistic cannot be represented without overflow. */
  invalidReason: string | null;
};

/**
 * Risk statistics on daily fleet bot-PnL returns (day PnL / equity). They are bot-reported and therefore
 * flow independent. Statistics that need more days than observed are null, so nothing is shown early.
 */
export function fleetRisk(dailyReturns: number[]): FleetRisk {
  const n = dailyReturns.length;
  const finiteInput = dailyReturns.every(Number.isFinite);
  // An incremental mean preserves an exactly constant series and avoids overflowing its raw sum.
  let mean: number | null = finiteInput ? 0 : null;
  for (let index = 0; mean != null && index < n; index += 1) {
    const delta = dailyReturns[index] - mean;
    const next = mean + delta / (index + 1);
    mean = Number.isFinite(delta) && Number.isFinite(next) ? next : null;
  }
  const varianceSum = mean != null && n > 1
    ? dailyReturns.reduce((total, value) => total + (value - mean) ** 2, 0) : NaN;
  const variance = Number.isFinite(varianceSum) && n > 1 ? varianceSum / (n - 1) : null;
  const volatility = variance != null && Number.isFinite(variance) ? Math.sqrt(variance) : null;
  const enough = n >= RISK_MIN_DAYS && volatility != null;
  const downsideSum = finiteInput ? dailyReturns.reduce((total, value) => total + Math.min(0, value) ** 2, 0) : NaN;
  const downside = Number.isFinite(downsideSum) && n > 0 ? Math.sqrt(downsideSum / n) : null;
  const sorted = finiteInput ? [...dailyReturns].sort((a, b) => a - b) : [];
  const cut = Math.max(1, Math.floor(n * 0.05));
  const tail = n >= TAIL_MIN_DAYS;
  const sharpeValue = enough && volatility > 0 && mean != null ? (mean / volatility) * Math.sqrt(365) : null;
  const sortinoValue = n >= RISK_MIN_DAYS && downside != null && downside > 0 && mean != null ? (mean / downside) * Math.sqrt(365) : null;
  const varValue = tail && sorted.length ? -sorted[cut - 1] : null;
  const tailSum = tail && sorted.length ? sorted.slice(0, cut).reduce((total, value) => total + value, 0) : NaN;
  const shortfallValue = Number.isFinite(tailSum) ? -(tailSum / cut) : null;
  const unrepresentable = !finiteInput || mean == null ||
    (n >= RISK_MIN_DAYS && (volatility == null || downside == null || (sharpeValue != null && !Number.isFinite(sharpeValue)) || (sortinoValue != null && !Number.isFinite(sortinoValue)))) ||
    (tail && (varValue == null || !Number.isFinite(varValue) || shortfallValue == null || !Number.isFinite(shortfallValue)));
  return {
    days: n, meanDaily: mean,
    volatilityDaily: enough ? volatility : null,
    sharpe: sharpeValue != null && Number.isFinite(sharpeValue) ? sharpeValue : null,
    sortino: sortinoValue != null && Number.isFinite(sortinoValue) ? sortinoValue : null,
    var95: varValue != null && Number.isFinite(varValue) ? varValue : null,
    expectedShortfall95: shortfallValue != null && Number.isFinite(shortfallValue) ? shortfallValue : null,
    minDays: RISK_MIN_DAYS, tailMinDays: TAIL_MIN_DAYS,
    invalidReason: unrepresentable ? 'Daily risk statistic is unrepresentable at this observed wallet basis.' : null,
  };
}

/** Completed UTC days only, divided by one equity basis. Today is still moving and never enters a statistic. */
export function dailyReturns(days: FleetDay[], equity: number | null): number[] {
  if (equity == null || !Number.isFinite(equity) || equity <= 0) return [];
  const returns = days.filter(day => !day.today).map(day => day.net / equity);
  return returns.every(Number.isFinite) ? returns : [];
}
