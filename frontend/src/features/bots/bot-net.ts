export type BotNet = { value: number | null; stale: boolean; source: 'controller report' | null };

/** Controller PnL is the single headline scope shared with Capital. Retained-position
 * summaries have a different ownership boundary and must remain a separately named diagnostic. */
export function botNet(controllerTotal: number | null, stale = false): BotNet {
  return controllerTotal != null && Number.isFinite(controllerTotal)
    ? { value: controllerTotal, stale, source: 'controller report' }
    : { value: null, stale: false, source: null };
}

/** Realized and unrealized headline parts share the controller-report scope.
 * Pair marks are a diagnostic with different lifecycle coverage and cannot fill gaps here. */
export function controllerPnlPart(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

/** Stable effect key for publishing every economic and lifecycle field to page aggregates. */
export function ownerReadsFingerprint(reads: unknown): string {
  const encoded = JSON.stringify(reads);
  if (encoded === undefined) throw new TypeError('Owner reads must be serializable before publication.');
  return encoded;
}

/** Multi-owner PnL sums need fresh, nonempty pair ownership from every bot. */
export function pairOwnershipIsDisjoint(owners: readonly { pairs: readonly string[]; qualified: boolean }[]): boolean {
  if (owners.length <= 1) return true;
  if (owners.some(owner => !owner.qualified || owner.pairs.length === 0)) return false;
  const seen = new Set<string>();
  for (const owner of owners) {
    const ownerPairs = new Set(owner.pairs);
    for (const pair of ownerPairs) {
      if (seen.has(pair)) return false;
      seen.add(pair);
    }
  }
  return true;
}

/** Win rate text: a rate only once the owner's minimum scored sample exists, as on the KPI tile. */
export function winRateText(stats: { scored: number; minSample: number; winRate: number | null }): string {
  return stats.winRate == null || stats.scored < stats.minSample ? `Collecting ${stats.scored}/${stats.minSample}` : `${(stats.winRate * 100).toFixed(1)}%`;
}
