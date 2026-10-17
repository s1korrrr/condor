import { qualifiedDivergence } from "./breadth-timeline.mjs";

/** Draw retained owner measurements, without recomputing returns or derivatives. */
export const HISTORY_COMPARISONS = {
  returns: { label: "Benchmark & cohort returns", unit: "%" },
  level: { label: "Matched pressure level", unit: "pressure" },
  change: { label: "Pressure change", unit: "pressure change" },
  shareChange: { label: "Advance-share change", unit: "pp" },
  velocity: { label: "Pressure velocity", unit: "pressure/minute" },
  acceleration: { label: "Pressure acceleration", unit: "pressure/minute²" },
};
const numeric = value => typeof value === "number" && Number.isFinite(value) ? value : null;

export function historyComparisons(samples, horizon, interval, view, range = null) {
  const selected = HISTORY_COMPARISONS[view];
  if (!selected) throw new Error("Unsupported historical comparison.");
  const definitions = view === "returns"
    ? [["benchmark", "BTC return"], ["equal", "Equal-weight return"], ["median", "Full-cohort median"], ["capped", "Prior-liquidity-capped return"]]
    : [[view, selected.label]];
  const series = definitions.map(([id, label]) => ({ id, label, unit: selected.unit, points: [] }));
  const markers = [], rows = [];
  let previous = null;
  for (const point of samples) {
    const trajectory = point.breadthTrajectory?.[`${horizon}/${interval}`];
    const contribution = point.contributions?.[horizon];
    const benchmark = point.benchmarkReturns;
    const flag = horizon === "15" ? qualifiedDivergence(point, interval) : null;
    const values = view === "returns" ? {
      benchmark: numeric(benchmark?.values[horizon]),
      equal: numeric(contribution?.equalReturn), median: numeric(contribution?.medianReturn),
      capped: numeric(contribution?.cappedReturn),
    } : { [view]: numeric(trajectory?.[view]) };
    const basis = JSON.stringify([
      point.membership, point.definitionRegistryHash ?? null, point.source_kind,
      view === "returns" ? null : trajectory?.membership ?? null,
      view === "returns" ? [benchmark?.instrumentId, benchmark?.quoteAsset, benchmark?.definitionHash] : null,
    ]);
    // The owner flags real gaps; downsampled windows are sampled at wider spacing without one.
    const gap = Boolean(previous && point.gapBefore);
    const changed = Boolean(previous && basis !== previous.basis);
    const continuity = gap ? "Retained gap" : changed ? "Source or cohort changed" : "Same retained basis";
    previous = { time: point.time, basis };
    if (range && (point.time < range[0] || point.time > range[1])) continue;
    if (gap || changed) {
      // A drawing-only sentinel splits the line; no raw observation is erased.
      for (const item of series) {
        if (item.points.length) item.points.push({ time: point.time - 1, value: null });
      }
      markers.push({ time: point.time, label: continuity });
    }
    for (const item of series) item.points.push({ time: point.time, value: values[item.id] });
    if (flag === 1) {
      markers.push({ time: point.time, label: `Price–breadth divergence · BTC · 15m / ${interval}m` });
    }
    rows.push({
      time: point.time, snapshot: point.snapshot_id, values, continuity,
      coverage: view === "returns"
        ? contribution ? `${contribution.valid}/${contribution.expected} · ${contribution.startCohortAvailable ? "frozen start cohort" : "start cohort unavailable"}` : "Cohort unavailable"
        : trajectory ? `${trajectory.matched}/${trajectory.expected} · matched cohort` : "Matched cohort unavailable",
      divergence: horizon !== "15" ? "Uses 15m horizon"
        : flag !== null ? flag === 1 ? "Observed" : "Not observed"
          : "Unavailable · retained provenance missing or inputs incomplete",
      benchmark: benchmark ? `${benchmark.instrumentId} · ${benchmark.quoteAsset} · ${benchmark.definitionId} · ${benchmark.definitionHash}` : "Benchmark unavailable",
    });
  }
  const unavailable = view !== "returns" && !["5", "15", "60"].includes(horizon)
    ? "Owner trajectory is defined only for 5m, 15m and 60m return horizons."
    : rows.some(row => Object.values(row.values).some(value => value !== null)) ? null
      : "No qualified owner observations are retained for this comparison and range.";
  return { series, markers, rows, unavailable, label: selected.label, unit: selected.unit };
}

/** First and last row that carries any value: empty edges (before a definition existed) are not plotted. */
export function valuedDomain(comparison) {
  const valued = comparison.rows.filter((row) => Object.values(row.values).some((value) => value !== null));
  return valued.length > 1 ? [valued[0].time, valued.at(-1).time] : undefined;
}
