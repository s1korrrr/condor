/** Drawing projection of stored totals. No aggregation or cumulative-delta calculation. */
export function flowHistoryVisuals(points, quoteAsset) {
  const notional = { buy: [], sell: [], unknown: [] }, cvd = [], breaks = [];
  const numeric = value => value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
  const rows = points.map((point, index) => {
    const flow = point.flowHistory;
    const previous = index > 0 ? points[index - 1] : null;
    const previousFlow = previous?.flowHistory ?? null;
    const reasons = [];
    if (index === 0) reasons.push('window start');
    if (point.gapBefore) reasons.push('stored history gap');
    if (!flow) reasons.push('flow unavailable');
    else if (flow.cumulativeDeltaQuote == null) reasons.push('CVD unavailable');
    if (previous && !previousFlow) reasons.push('previous flow unavailable');
    else if (previousFlow && previousFlow.cumulativeDeltaQuote == null) reasons.push('previous CVD unavailable');
    if (flow && previousFlow && flow.scopeHash !== previousFlow.scopeHash) reasons.push('scope changed');
    if (flow && previousFlow && flow.resetAt !== previousFlow.resetAt) reasons.push('reset changed');
    if (flow && previousFlow && flow.quoteAsset !== previousFlow.quoteAsset) reasons.push('quote changed');
    if (previous && point.source_kind !== previous.source_kind) reasons.push('source changed');
    if (previous && (point.membership !== previous.membership || point.definitionRegistryHash !== previous.definitionRegistryHash)) reasons.push('cohort or definition changed');
    if (previous && point.time - previous.time !== 60_000) reasons.push('non-1m interval');
    const allSeries = [...Object.values(notional), cvd];
    if (index > 0 && reasons.length) {
      for (const series of allSeries) series.push({ time: point.time - 1, value: null });
      breaks.push({ time: point.time, label: reasons.join(', ') });
    }
    const selected = flow?.quoteAsset === quoteAsset ? flow : null;
    for (const [key, field] of [['buy','buyQuote'],['sell','sellQuote'],['unknown','unknownQuote']]) {
      notional[key].push({ time: point.time, value: numeric(selected?.[field]) });
    }
    cvd.push({ time: point.time, value: numeric(selected?.cumulativeDeltaQuote) });
    return { point, flow, continuity: reasons.length ? `Break · ${reasons.join(', ')}` : 'Continuous with prior stored point' };
  });
  return { rows, notional, cvd, breaks };
}
