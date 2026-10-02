export type PerformancePoint = {
  timestamp: number; total_pnl_quote: string; realized_pnl_quote: string;
  unrealized_pnl_quote: string; quote: string; identity: string; segment: string;
};
export type PerformanceHistory = {
  source: 'native_mqtt_observer'; bot_name: string; range: string;
  coverage_start: number | null; bucket_seconds?: number | null; points: PerformancePoint[]; truncated: boolean;
};
/** Condor reads longer ranges as the last stored sample per UTC bucket per segment; 1D returns every stored sample. */
export const PERFORMANCE_BUCKET_SECONDS: Readonly<Record<string, number | null>> = { '1D': null, '1W': 300, '1M': 1800, ALL: 3600 };
/** Longest spacing inside one segment: native samples are at most 90s apart, and a bucketed read adds its width. */
export function performanceGapMs(bucketSeconds: number | null): number {
  return 90_000 + (bucketSeconds ?? 0) * 1000;
}
const isBackfill = (point: PerformancePoint) => point.segment.startsWith('backfill-');
const amount = (value: unknown) => typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null;

/** Historical observations are not fresh current readings or an equity baseline. */
export function projectPerformanceHistory(payload: unknown, bot: string, now: number, expectedRange?: string) {
  const empty = (reason: string) => ({points: [] as {time:number;value:number|null;owner:number}[], owners:[] as number[], quote:null as string|null, change:null as number|null, start:null as number|null, end:null as number|null, reason, truncated:false, bucketSeconds:null as number|null, gapMs:performanceGapMs(null)});
  if (!payload || typeof payload !== 'object') return empty('Waiting for saved performance observations.');
  const data = payload as PerformanceHistory;
  // A server without bucketing returns every stored sample; a declared bucket must be the one its range is read at.
  const bucketSeconds = data.bucket_seconds ?? null;
  const validBucket = bucketSeconds === null || (Object.hasOwn(PERFORMANCE_BUCKET_SECONDS, data.range) && bucketSeconds === PERFORMANCE_BUCKET_SECONDS[data.range]);
  if (data.source !== 'native_mqtt_observer' || data.bot_name !== bot || (expectedRange != null && data.range !== expectedRange) || !validBucket || !Array.isArray(data.points)) return empty('Performance history identity is invalid.');
  const gapMs = performanceGapMs(bucketSeconds);
  if (!data.points.length) return empty('Recording begins with the first verified native performance report. Earlier history is not reconstructed.');
  const points: {time:number;value:number|null;owner:number}[] = [];
  let owner = 0;
  let previous: PerformancePoint | null = null;
  let gap = false;
  const quote = data.points[0]?.quote;
  for (const point of data.points) {
    if (!point || typeof point !== 'object') return empty('Performance history contains an invalid observation.');
    const value = amount(point.total_pnl_quote);
    const realized = amount(point.realized_pnl_quote);
    const unrealized = amount(point.unrealized_pnl_quote);
    if (!Number.isFinite(point.timestamp) || point.timestamp <= 0 || point.timestamp*1000 > now || value === null || realized === null || unrealized === null || Math.abs(value-realized-unrealized)>0.000001 || typeof point.identity !== 'string' || !point.identity || typeof point.segment !== 'string' || !point.segment || typeof point.quote !== 'string' || !/^[A-Z0-9]+$/.test(point.quote) || point.quote !== quote || (previous && point.timestamp <= previous.timestamp)) return empty('Performance history contains incompatible or invalid observations.');
    // Rows rebuilt from the bot's own recorder (segment `backfill-<bot>`) fill the stretches Condor was not recording.
    // Native PnL is cumulative across restarts, so a backfill row joins its live neighbours: no gap marker and no owner change.
    const bridged = previous !== null && (isBackfill(previous) || isBackfill(point));
    if (previous && ((!bridged && (previous.segment !== point.segment || previous.identity !== point.identity)) || (point.timestamp-previous.timestamp)*1000 > gapMs)) {
      points.push({time:previous.timestamp*1000+1,value:null,owner});
      gap = true;
    }
    if (previous && previous.identity !== point.identity && !bridged) owner++;
    points.push({time:point.timestamp*1000,value,owner});
    previous=point;
  }
  return {points,owners:Array.from({length:owner+1},(_,index)=>index),quote,change:points.length>1 && !gap && !data.truncated ? points.at(-1)!.value!-points[0].value! : null,start:points[0].time,end:points.at(-1)!.time,reason:null,truncated:data.truncated,bucketSeconds,gapMs};
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
