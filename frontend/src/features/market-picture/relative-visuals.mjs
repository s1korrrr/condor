import { BENCHMARKS, relativePullbackCandidates } from "./model.mjs";
import { frameReason, metricReason } from "./metric-cohort.mjs";

const MAX_POINTS = 300;
const MAX_RANK_ITEMS_PER_SIDE = 5;

/**
 * Project owner return fields into the scatter without recalculating returns. A point needs a frame
 * and both metrics current at `asOf` (the page's assessment clock, also for historical inspection).
 */
export function projectRelativeStrength(assets, benchmark, frame, asOf) {
  const benchmarkKey = String(benchmark ?? "").toUpperCase();
  const members = Array.isArray(assets) ? assets : [];
  const reason = frameReason(frame, asOf);
  if (!BENCHMARKS.includes(benchmarkKey) || members.length > MAX_POINTS || reason) {
    return { benchmark: benchmarkKey, expected: members.length, valid: 0, omitted: members.length, reason, points: [] };
  }

  const eligible = members.filter((asset) =>
    metricReason(asset?.returns?.["60"], asOf) === null && metricReason(asset?.relative?.[benchmarkKey], asOf) === null);
  const pullbacks = new Set(
    relativePullbackCandidates(eligible, benchmarkKey, eligible.length).candidates
      .map((asset) => asset.instrument_id),
  );
  const points = eligible.map((asset) => ({
    instrumentId: asset.instrument_id,
    symbol: asset.symbol,
    oneHourReturn: asset.returns["60"].value,
    relativeReturn: asset.relative[benchmarkKey].value,
    pullback: pullbacks.has(asset.instrument_id),
  }));
  return {
    benchmark: benchmarkKey,
    expected: members.length,
    valid: points.length,
    omitted: members.length - points.length,
    reason: null,
    points,
  };
}

/** Return bounded, exact owner rank deltas only for the full one-hour cohort of a frame current at `asOf`. */
export function projectRelativeRankMovers(frame, asOf, limitPerSide = MAX_RANK_ITEMS_PER_SIDE) {
  const assets = Array.isArray(frame?.assets) ? frame.assets : [];
  const expected = Number.isSafeInteger(frame?.expected) ? frame.expected : assets.length;
  const changes = frame?.relativeStrengthChanges;
  const unavailable = (reason) => ({
    available: false,
    reason,
    baselineCutoff: changes?.baselineCutoff ?? null,
    expected,
    totalImproving: 0,
    totalWeakening: 0,
    unchanged: 0,
    displayed: 0,
    rows: [],
  });
  if (!changes) return unavailable("No owner rank comparison is attached.");
  const timing = frameReason(frame, asOf);
  if (timing) return unavailable(`The owner rank comparison is not current at this assessment time (${timing}).`);
  if (
    assets.length === 0 || assets.length !== expected || expected > MAX_POINTS ||
    changes.definitionId !== "relative_return" || changes.interval !== 3_600_000 ||
    changes.currentCutoff !== frame.cutoff_ms ||
    changes.baselineCutoff == null || changes.baselineSnapshotId == null ||
    changes.currentCutoff - changes.baselineCutoff !== changes.interval ||
    changes.expected !== expected || changes.valid !== expected ||
    changes.cohortHash == null || changes.reasons?.length > 0
  ) {
    return unavailable("The owner rank baseline or matched cohort is incomplete.");
  }

  const ids = assets.map((asset) => asset.instrument_id);
  if (new Set(ids).size !== ids.length || Object.keys(changes.rankDeltas ?? {}).length !== expected) {
    return unavailable("The owner rank vector does not match the frozen instruments.");
  }
  const ranks = ids.map((instrumentId) => changes.rankDeltas[instrumentId]);
  if (ranks.some((delta) => !Number.isSafeInteger(delta) || Math.abs(delta) >= expected) ||
      ranks.reduce((sum, delta) => sum + delta, 0) !== 0) {
    return unavailable("The owner rank vector is incomplete or incoherent.");
  }

  const byId = new Map(assets.map((asset) => [asset.instrument_id, asset]));
  const improving = ranks.map((delta, index) => ({ instrumentId: ids[index], delta }))
    .filter((row) => row.delta > 0)
    .sort((a, b) => b.delta - a.delta || a.instrumentId.localeCompare(b.instrumentId));
  const weakening = ranks.map((delta, index) => ({ instrumentId: ids[index], delta }))
    .filter((row) => row.delta < 0)
    .sort((a, b) => a.delta - b.delta || a.instrumentId.localeCompare(b.instrumentId));
  const limit = Number.isSafeInteger(limitPerSide)
    ? Math.max(0, Math.min(MAX_RANK_ITEMS_PER_SIDE, limitPerSide))
    : MAX_RANK_ITEMS_PER_SIDE;
  const rows = [
    ...improving.slice(0, limit).map((row) => ({ ...row, symbol: byId.get(row.instrumentId).symbol, direction: "improving" })),
    ...weakening.slice(0, limit).map((row) => ({ ...row, symbol: byId.get(row.instrumentId).symbol, direction: "weakening" })),
  ];
  return {
    available: true,
    reason: null,
    baselineCutoff: changes.baselineCutoff,
    expected,
    totalImproving: improving.length,
    totalWeakening: weakening.length,
    unchanged: expected - improving.length - weakening.length,
    displayed: rows.length,
    rows,
  };
}
