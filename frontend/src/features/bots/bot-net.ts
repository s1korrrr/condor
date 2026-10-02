export type BotNet = { value: number | null; stale: boolean; source: 'controller report' | null };

export function botSourceFreshness(reads: { status: string | null; controller: { reason: string | null; observedAt: number | null }; quant: { freshness: string } | null }) {
  const lifecycleStates = ['running', 'starting', 'stopping', 'stopped', 'exited'];
  return {
    lifecycle: reads.status != null && lifecycleStates.includes(reads.status),
    performance: reads.controller.observedAt != null && (reads.controller.reason == null || reads.controller.reason === 'No current controllers reported.'),
    quant: reads.quant?.freshness === 'current',
  };
}

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
  if (owners.some(owner => !owner.qualified || owner.pairs.length === 0 || owner.pairs.some(pair => typeof pair !== 'string' || !/^[A-Z0-9]+-[A-Z0-9]+$/.test(pair)))) return false;
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
  return stats.winRate == null || stats.scored < stats.minSample ? `${stats.scored}/${stats.minSample} cycles` : `${(stats.winRate * 100).toFixed(1)}%`;
}

/** A money aggregate needs an explicit matching unit from every contributing owner. */
export function commonMetricQuote(units: readonly (string | null | undefined)[]): string | null {
  const first = units[0];
  return typeof first === 'string' && first.trim() !== '' && first !== 'unknown'
    && units.every(unit => unit === first) ? first : null;
}

/** Saved histories own their units and coverage independently of current reports. */
export function historyComparison(series: readonly { quote: string | null; points: readonly { value: number | null }[]; reason: string | null }[], allOwnersRead: boolean) {
  const quote = allOwnersRead ? commonMetricQuote(series.map(item => item.quote)) : null;
  const drawable = quote !== null && series.length > 0 && series.every(item => item.points.filter(point => point.value !== null && Number.isFinite(point.value)).length >= 2);
  return { quote, drawable, complete: drawable && series.every(item => item.reason === null) };
}

/** Missing quote evidence is not a currency disagreement unless observed quotes conflict. */
export function quoteUnavailableReason(units: readonly (string | null | undefined)[], staleBots = 0): string {
  if (staleBots > 0) return `${staleBots} bot${staleBots === 1 ? '' : 's'} stale; quote currency unknown until the owner publishes again.`;
  const quotes = new Set(units.filter((unit): unit is string => typeof unit === 'string' && unit.trim() !== '' && unit !== 'unknown'));
  return quotes.size > 1
    ? 'Bots report different quote currencies; no sum is published.'
    : 'Current controller quote currency is unavailable; no PnL sum is published.';
}
