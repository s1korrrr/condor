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

/**
 * Choose a side for each scatter label in plot pixels: right of the point, else left, else none.
 * Pullback candidates go first, then points farthest from the origin. Labels never overlap each
 * other or leave the plot; unlabelled points stay in the table and tooltip.
 */
export function placeScatterLabels(points, xDomain, yDomain, { width, height, charWidth = 6.2, lineHeight = 12, gap = 7 }) {
  const placed = new Map();
  const [x0, x1] = xDomain, [y0, y1] = yDomain;
  if (!(x1 > x0) || !(y1 > y0) || !(width > 0) || !(height > 0)) return placed;
  const px = (x) => ((x - x0) / (x1 - x0)) * width;
  const py = (y) => (1 - (y - y0) / (y1 - y0)) * height;
  const boxes = [];
  const fits = (box) => box.left >= 0 && box.right <= width && box.top >= 0 && box.bottom <= height &&
    boxes.every((other) => box.right <= other.left || box.left >= other.right || box.bottom <= other.top || box.top >= other.bottom);
  const order = [...points].sort((a, b) => Number(b.pullback) - Number(a.pullback) ||
    Math.hypot(px(b.oneHourReturn) - px(0), py(b.relativeReturn) - py(0)) - Math.hypot(px(a.oneHourReturn) - px(0), py(a.relativeReturn) - py(0)) ||
    a.instrumentId.localeCompare(b.instrumentId));
  for (const point of order) {
    const x = px(point.oneHourReturn), y = py(point.relativeReturn), labelWidth = (point.label ?? point.symbol).length * charWidth;
    const vertical = { top: y - lineHeight / 2, bottom: y + lineHeight / 2 };
    const right = { ...vertical, left: x + gap, right: x + gap + labelWidth };
    const left = { ...vertical, left: x - gap - labelWidth, right: x - gap };
    const side = fits(right) ? "right" : fits(left) ? "left" : null;
    if (!side) continue;
    boxes.push(side === "right" ? right : left);
    placed.set(point.instrumentId, side);
  }
  return placed;
}

/**
 * One representative per exact (1h return, excess return) pair, pullback candidates first, then by
 * instrument id. `count` and `label` ("SOL ×3") state how many instruments share that position.
 */
export function groupCoincident(points) {
  const groups = new Map();
  for (const point of points) {
    const key = `${point.oneHourReturn}/${point.relativeReturn}`;
    const members = groups.get(key) ?? [];
    members.push(point);
    groups.set(key, members);
  }
  return [...groups.values()].map((members) => {
    const [representative] = [...members].sort((a, b) => Number(b.pullback) - Number(a.pullback) || a.instrumentId.localeCompare(b.instrumentId));
    return { ...representative, count: members.length, label: members.length > 1 ? `${representative.symbol} ×${members.length}` : representative.symbol };
  });
}
