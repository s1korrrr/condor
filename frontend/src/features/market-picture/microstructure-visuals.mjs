import { rowTimeState } from './observation-state.ts';

const tupleKey = values => JSON.stringify(values);
const decimal = value => {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const timeState = (frame, row, asOf) => rowTimeState(frame, row, asOf);

export function flowCohorts(flows) {
  const seen = new Map();
  const cohorts = [];
  for (const row of flows) {
    const cohort = {
      instrumentId: row.instrumentId,
      sourceId: row.sourceId,
      channel: row.channel,
      quoteAsset: row.quoteAsset,
      windowMs: row.windowEnd - row.windowStart,
      latestEnd: row.windowEnd,
    };
    const key = tupleKey([cohort.instrumentId, cohort.sourceId, cohort.channel, cohort.quoteAsset, cohort.windowMs]);
    const existingIndex = seen.get(key);
    if (existingIndex == null) { seen.set(key, cohorts.length); cohorts.push(cohort); }
    else cohorts[existingIndex].latestEnd = Math.max(cohorts[existingIndex].latestEnd, cohort.latestEnd);
  }
  return cohorts;
}

export function projectFlowSelection(flows, selection, frame, asOf, limit = 120) {
  const matches = flows.filter(row => row.instrumentId === selection.instrumentId && row.sourceId === selection.sourceId &&
    row.channel === selection.channel && row.quoteAsset === selection.quoteAsset &&
    row.windowEnd - row.windowStart === selection.windowMs)
    .sort((a, b) => a.windowEnd - b.windowEnd || a.windowStart - b.windowStart).slice(-limit);
  const rows = matches.map(row => {
    const freshness = timeState(frame, row, asOf);
    const qualified = row.capabilityUsable === true;
    const exact = freshness === 'FUTURE'
      ? { buyQuote: 'Unavailable', sellQuote: 'Unavailable', unknownQuote: 'Unavailable' }
      : { buyQuote: row.buyQuote, sellQuote: row.sellQuote, unknownQuote: row.unknownQuote };
    const numeric = Object.fromEntries(Object.entries(exact).map(([key, value]) => [key, decimal(value)]));
    const malformed = Object.values(numeric).some(value => value == null);
    let state = freshness;
    if (freshness === 'CURRENT') {
      if (!qualified) state = 'SOURCE NOT QUALIFIED';
      else if (malformed) state = 'INVALID VALUE';
      else if (!row.complete || row.reasons?.length) state = `PARTIAL${row.reasons?.length ? ` · ${row.reasons.join(', ')}` : ''}`;
      else state = 'COMPLETE';
    }
    const usable = freshness === 'CURRENT' && qualified && !malformed;
    return {
      label: new Date(row.windowEnd).toISOString(),
      buyQuote: usable ? numeric.buyQuote : null,
      sellQuote: usable ? numeric.sellQuote : null,
      unknownQuote: usable ? numeric.unknownQuote : null,
      exact,
      unit: row.quoteAsset,
      state,
      complete: freshness === 'FUTURE' ? null : row.complete,
      reason: freshness === 'FUTURE' ? null : row.reasons?.join(', ') || null,
      sourceId: row.sourceId,
      channel: row.channel,
      available: row.available,
      expires: row.expires,
      windowStart: row.windowStart,
      windowEnd: row.windowEnd,
      trades: freshness === 'FUTURE' ? null : row.trades,
      gaps: freshness === 'FUTURE' ? [] : row.gaps,
    };
  });
  return { rows, count: matches.length, plottedCount: rows.filter(row => row.buyQuote != null).length };
}

export function bookCohorts(rows) {
  const seen = new Set();
  const cohorts = [];
  for (const row of rows) {
    const cohort = {
      instrumentId: row.instrumentId,
      sourceId: row.sourceId,
      channel: row.channel,
      observed: row.observed,
      sizeUnit: row.sizeUnit,
    };
    const key = tupleKey([cohort.instrumentId, cohort.sourceId, cohort.channel, cohort.observed, cohort.sizeUnit]);
    if (!seen.has(key)) { seen.add(key); cohorts.push(cohort); }
  }
  return cohorts;
}

export function projectBookSelection(rows, selection, frame, asOf, measure = 'book') {
  const matches = rows.filter(row => row.instrumentId === selection.instrumentId && row.sourceId === selection.sourceId &&
    row.channel === selection.channel && row.observed === selection.observed && row.sizeUnit === selection.sizeUnit)
    .sort((a, b) => {
      const sizeA = decimal(a.requestedSize); const sizeB = decimal(b.requestedSize);
      return (sizeA ?? Number.POSITIVE_INFINITY) - (sizeB ?? Number.POSITIVE_INFINITY) || a.side.localeCompare(b.side);
    });
  const counts = new Map();
  for (const row of matches) {
    const key = tupleKey([row.requestedSize, row.side]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const output = matches.map(row => {
    const freshness = timeState(frame, row, asOf);
    const requested = decimal(row.requestedSize);
    const uncovered = decimal(row.uncovered);
    const coveredBase = decimal(row.coveredBase);
    const coveredQuote = decimal(row.coveredQuote);
    const covered = row.sizeUnit === 'base' ? coveredBase : row.sizeUnit === 'quote' ? coveredQuote : null;
    const coverageTolerance = requested == null ? 0 : Math.max(1e-9, requested * 1e-9);
    const coverageValid = requested != null && requested > 0 && uncovered != null && uncovered >= 0 && uncovered <= requested &&
      covered != null && covered >= 0 && covered <= requested && Math.abs(covered + uncovered - requested) <= coverageTolerance;
    const ratio = coverageValid ? (covered / requested) * 100 : null;
    const duplicate = counts.get(tupleKey([row.requestedSize, row.side])) > 1;
    const sourceQualified = row.capabilityUsable === true;
    const knownAccess = row.access !== 'unknown' && row.access != null && row.access !== '';
    let state = freshness;
    if (freshness === 'CURRENT') {
      if (!sourceQualified) state = 'SOURCE NOT QUALIFIED';
      else if (!knownAccess) state = 'ACCESS UNAVAILABLE';
      else if (!coverageValid || coveredBase == null || coveredQuote == null || ratio == null) state = 'INVALID COVERAGE';
      else if (duplicate) state = 'DUPLICATE SIZE/SIDE';
      else if (uncovered > 0) state = 'PARTIAL DEPTH';
      else state = row.reasons?.length ? row.reasons.join(', ') : 'COVERED';
    }
    const fullCoverage = coverageValid && uncovered === 0 && Math.abs(covered - requested) <= Math.max(1e-9, requested * 1e-9);
    const fullSizeCost = freshness === 'CURRENT' && sourceQualified && knownAccess && !duplicate &&
      fullCoverage && row.vwap != null && decimal(row.vwap) != null && row.costBps != null && decimal(row.costBps) != null;
    const feeQualified = row.feeBps != null && decimal(row.feeBps) != null && typeof row.feeSource === 'string' && row.feeSource.length > 0 &&
      row.totalCostBps != null && decimal(row.totalCostBps) != null && !row.reasons?.length;
    const cost = measure === 'total' ? (fullSizeCost && feeQualified ? decimal(row.totalCostBps) : null)
      : (fullSizeCost ? decimal(row.costBps) : null);
    if (measure === 'total' && fullSizeCost && !feeQualified && state === 'COVERED') state = 'FEE PROVENANCE UNAVAILABLE';
    return {
      label: freshness === 'FUTURE' ? `${row.side} · size unavailable` : `${row.side} · ${row.requestedSize} ${row.sizeUnit}`,
      side: row.side,
      size: row.requestedSize,
      sizeUnit: row.sizeUnit,
      costBps: cost,
      exactCostBps: freshness === 'FUTURE' ? null : measure === 'total' ? row.totalCostBps : row.costBps,
      coveragePercent: freshness === 'CURRENT' && sourceQualified && knownAccess && !duplicate ? ratio : null,
      coverage: freshness === 'FUTURE'
        ? { requested: 'Unavailable', coveredBase: 'Unavailable', coveredQuote: 'Unavailable', uncovered: 'Unavailable', covered: null }
        : { requested: row.requestedSize, coveredBase: row.coveredBase, coveredQuote: row.coveredQuote, uncovered: row.uncovered, covered },
      state,
      sourceId: row.sourceId,
      channel: row.channel,
      observed: row.observed,
      access: row.access,
      feeBps: freshness === 'FUTURE' ? null : row.feeBps,
      feeSource: row.feeSource,
      reasons: freshness === 'FUTURE' ? [] : row.reasons,
    };
  });
  return { rows: output, count: matches.length, unit: 'bps', measure, sizeUnit: selection.sizeUnit };
}
