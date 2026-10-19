// Relative with extension: the private workspace loads this module directly under Node, without the `@/` alias.
import { isPaperBot } from '../trading-visuals/sources.ts';

export type PerformancePoint = {
  timestamp: number; total_pnl_quote: string; realized_pnl_quote: string;
  unrealized_pnl_quote: string; quote: string; identity: string; segment: string;
};
export type PerformanceHistory = {
  source: 'native_mqtt_observer' | 'reporting_paper_runtime'; simulated?: boolean; bot_name: string; range: string;
  coverage_start: number | null; bucket_seconds?: number | null; points: PerformancePoint[]; truncated: boolean;
};
/** Condor reads longer ranges as the last stored sample per UTC bucket per segment; 1D returns every stored sample. */
export const PERFORMANCE_BUCKET_SECONDS: Readonly<Record<string, number | null>> = { '1D': null, '1W': 300, '1M': 1800, ALL: 3600 };
/** Longest spacing inside one segment: native samples are at most 90s apart, and a bucketed read adds its width. */
export function performanceGapMs(bucketSeconds: number | null): number {
  return 90_000 + (bucketSeconds ?? 0) * 1000;
}
/** A live bot's history is the native observer's; a paper bot's is simulated, recorded from reporting. Never crossed. */
export function historySourceMatches(data: { source?: unknown; simulated?: unknown }, bot: string): boolean {
  return isPaperBot(bot) ? data.source === 'reporting_paper_runtime' && data.simulated === true : data.source === 'native_mqtt_observer';
}
const isBackfill = (point: PerformancePoint) => point.segment.startsWith('backfill-');
/** Same ASCII decimal grammar, 128-character plain wire, and 38-significant-digit mobile budget as fleet_pnl.py. */
export function historyAmount(value: unknown): { number: number; key: string } | null {
  if (typeof value !== 'string' || value.length > 256) return null;
  const parts = /^([+-]?)(?:([0-9]+)(?:\.([0-9]*))?|\.([0-9]+))(?:[eE]([+-]?[0-9]+))?$/.exec(value);
  if (!parts || parts[0].length !== value.length) return null;
  let digits = `${parts[2] ?? ''}${parts[3] ?? parts[4] ?? ''}`.replace(/^0+/, '');
  if (!digits) return { number: 0, key: '0' };
  const zeros = /0*$/.exec(digits)![0].length;
  digits = digits.slice(0, digits.length - zeros);
  if (digits.length > 38) return null;
  const exponent = BigInt(parts[5] ?? '0') - BigInt((parts[3] ?? parts[4] ?? '').length) + BigInt(zeros);
  const point = BigInt(digits.length) + exponent;
  const width = BigInt(parts[1] === '-' ? 1 : 0) +
    (exponent >= 0n ? point : point > 0n ? BigInt(digits.length + 1) : 2n - point + BigInt(digits.length));
  if (width > 128n) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return null;
  return { number, key: `${parts[1] === '-' ? '-' : ''}${digits}e${exponent}` };
}

/** The 1e-6 owner balance tolerance is an exact admission rule, not a chart calculation. */
function balanced(amounts: { key: string }[]): boolean {
  const decimal = amounts.map(amount => {
    if (amount.key === '0') return { digits: 0n, exponent: 0n };
    const [, sign, digits, exponent] = /^(-?)([0-9]+)e(-?[0-9]+)$/.exec(amount.key)!;
    return { digits: BigInt(digits) * (sign ? -1n : 1n), exponent: BigInt(exponent) };
  });
  const scale = decimal.reduce((least, value) => value.digits !== 0n && value.exponent < least ? value.exponent : least, -6n);
  const aligned = decimal.map(value => value.digits * 10n ** (value.exponent - scale));
  const residual = aligned[0] - aligned[1] - aligned[2];
  const tolerance = 10n ** (-6n - scale);
  return residual >= -tolerance && residual <= tolerance;
}

/** Withhold a delta if binary conversion makes either nonzero operand disappear. */
export function checkedDifference(later: number, earlier: number): number | null {
  const result = later - earlier;
  return Number.isFinite(result) && (later === earlier || (
    result !== 0 && (later === 0 || result !== -earlier) && (earlier === 0 || result !== later)
  )) ? result : null;
}

/** Historical observations are not fresh current readings or an equity baseline. */
export function projectPerformanceHistory(payload: unknown, bot: string, now: number, expectedRange?: string) {
  const empty = (reason: string) => ({points: [] as {time:number;value:number|null;owner:number}[], owners:[] as number[], quote:null as string|null, change:null as number|null, start:null as number|null, end:null as number|null, reason, truncated:false, bucketSeconds:null as number|null, gapMs:performanceGapMs(null)});
  if (!payload || typeof payload !== 'object') return empty('Waiting for saved performance observations.');
  const data = payload as PerformanceHistory;
  // A server without bucketing returns every stored sample; a declared bucket must be the one its range is read at.
  const bucketSeconds = data.bucket_seconds ?? null;
  const validBucket = bucketSeconds === null || (Object.hasOwn(PERFORMANCE_BUCKET_SECONDS, data.range) && bucketSeconds === PERFORMANCE_BUCKET_SECONDS[data.range]);
  if (!historySourceMatches(data, bot) || data.bot_name !== bot || (expectedRange != null && data.range !== expectedRange) || !validBucket || !Array.isArray(data.points)) return empty('Performance history identity is invalid.');
  const gapMs = performanceGapMs(bucketSeconds);
  if (!data.points.length) return empty('Recording begins with the first verified native performance report. Earlier history is not reconstructed.');
  const points: {time:number;value:number|null;owner:number}[] = [];
  let owner = 0;
  let previous: PerformancePoint | null = null;
  let previousAmounts: ReturnType<typeof historyAmount>[] | null = null;
  let gap = false;
  const quote = data.points[0]?.quote;
  for (const point of data.points) {
    if (!point || typeof point !== 'object') return empty('Performance history contains an invalid observation.');
    const amounts = [point.total_pnl_quote, point.realized_pnl_quote, point.unrealized_pnl_quote].map(historyAmount);
    const [value, realized, unrealized] = amounts.map(amount => amount?.number ?? null);
    if (!Number.isFinite(point.timestamp) || point.timestamp <= 0 || point.timestamp*1000 > now || value === null || realized === null || unrealized === null || !balanced(amounts as { key: string }[]) || typeof point.identity !== 'string' || !point.identity || typeof point.segment !== 'string' || !point.segment || typeof point.quote !== 'string' || !/^[A-Z0-9]+$/.test(point.quote) || point.quote !== quote || (previous && point.timestamp <= previous.timestamp)) return empty('Performance history contains incompatible or invalid observations.');
    const bridged = previous !== null && (isBackfill(previous) || isBackfill(point));
    if (previous && (previous.identity === point.identity || bridged) && amounts.some((amount, index) =>
      previousAmounts![index]!.number === amount!.number && previousAmounts![index]!.key !== amount!.key)) return empty('Performance history contains incompatible or invalid observations.');
    // Rows rebuilt from the bot's own recorder (segment `backfill-<bot>`) fill the stretches Condor was not recording.
    // Native PnL is cumulative across restarts, so a backfill row joins its live neighbours: no gap marker and no owner change.
    if (previous && ((!bridged && (previous.segment !== point.segment || previous.identity !== point.identity)) || (point.timestamp-previous.timestamp)*1000 > gapMs)) {
      points.push({time:previous.timestamp*1000+1,value:null,owner});
      gap = true;
    }
    if (previous && previous.identity !== point.identity && !bridged) owner++;
    points.push({time:point.timestamp*1000,value,owner});
    previous=point;
    previousAmounts=amounts;
  }
  const change = points.length>1 && !gap && !data.truncated ? checkedDifference(points.at(-1)!.value!, points[0].value!) : null;
  return {points,owners:Array.from({length:owner+1},(_,index)=>index),quote,change,start:points[0].time,end:points.at(-1)!.time,reason:null,truncated:data.truncated,bucketSeconds,gapMs};
}

/** A read may be syntactically valid while its newest observation is no longer current. */
export function performanceHistoryFreshness(end: number | null, now: number, maxAgeMs = 90_000): boolean {
  return end != null && Number.isFinite(end) && now >= end && now - end <= maxAgeMs;
}

/**
 * Earliest point of the unbroken run that holds `time`. Gaps and owner or segment changes insert null
 * markers, and bucketed reads keep each segment's first sample, so a run that begins inside a window
 * starts at its real first observation rather than at the end of its first bucket.
 */
export function continuousRunStart(points: { time: number; value: number | null }[], time: number): number | null {
  let index = points.findIndex(point => point.time === time && point.value != null);
  if (index < 0) return null;
  while (index > 0 && points[index - 1].value != null) index -= 1;
  return points[index].time;
}

/** Require both edges of a requested interval to be represented by owner observations. */
export function performanceHistoryCovers(start: number | null, end: number | null, from: number, to: number, toleranceMs = 90_000): boolean {
  return start != null && end != null && Number.isFinite(from) && Number.isFinite(to) && from < to
    && start <= from + toleranceMs && end >= to - toleranceMs;
}
