import type { QuantMetric } from './quant-roster';

export type BotNet = { value: number | null; stale: boolean; source: 'controller report' | 'owner native net' | null };

/**
 * Net PnL for one bot, most direct source first: the API controller report (active executors plus
 * retained positions), else the owner's native net from reporting, else its last published net
 * (stale). The source is always named because the two scopes can differ. Never a fabricated zero.
 */
export function botNet(controllerTotal: number | null, native: QuantMetric | null | undefined): BotNet {
  if (controllerTotal != null && Number.isFinite(controllerTotal)) return { value: controllerTotal, stale: false, source: 'controller report' };
  const current = native?.value != null ? Number(native.value) : NaN;
  if (Number.isFinite(current)) return { value: current, stale: native!.freshness !== 'fresh', source: 'owner native net' };
  const known = native?.lastKnown != null ? Number(native.lastKnown) : NaN;
  if (Number.isFinite(known)) return { value: known, stale: true, source: 'owner native net' };
  return { value: null, stale: false, source: null };
}

/** Win rate text: a rate only once the owner's minimum scored sample exists, as on the KPI tile. */
export function winRateText(stats: { scored: number; minSample: number; winRate: number | null }): string {
  return stats.winRate == null || stats.scored < stats.minSample ? `Collecting ${stats.scored}/${stats.minSample}` : `${(stats.winRate * 100).toFixed(1)}%`;
}
