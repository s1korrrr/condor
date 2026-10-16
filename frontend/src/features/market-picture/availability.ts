/** Pure source-family and availability readings shared by the Market summary, evidence and availability line. */
import { horizonLabel } from "./pulse.mjs";
import { dailyFeatureText, metricTitle, type DisplayFrame, type DisplayMetric, type Horizon } from "./presentation";
import type { MetricCohortRequest } from "./metric-cohort.mjs";
import { historyComparisons } from "./history-comparisons.mjs";
import type { HistoryPoint } from "./presentation";

const TRAJECTORY_KEYS = ["level", "change", "velocity", "acceleration", "shareChange"] as const;
/** Shared retention rules: a history panel is drawn exactly when its rule holds, and named here otherwise. */
export function returnsHistoryRetained(samples: HistoryPoint[], horizon: string) {
  return historyComparisons(samples, horizon, "15", "returns").series.some(item => item.points.some(point => point.value !== null));
}
export function trajectoryHistoryRetained(samples: HistoryPoint[]) {
  return samples.some(point => (Object.values(point.breadthTrajectory ?? {}) as HistoryPoint["breadthTrajectory"][string][])
    .some(row => TRAJECTORY_KEYS.some(key => row[key] != null)));
}
/** The flow-history panel reads the newest 300 stored points of the window. */
export const FLOW_HISTORY_POINTS = 300;
export function flowHistoryRetained(samples: HistoryPoint[]) {
  return samples.slice(-FLOW_HISTORY_POINTS).some(point => point.flowHistory != null);
}
import { rowTimeState } from "./observation-state";

export interface SourceFamilyReading {
  key: string; family: string; state: string; evidence: string;
  qualified: boolean; freshness: string; scope: string;
}

/** Shared source-family qualification for the summary and its evidence panel. */
export function sourceFamilyReadings(frame: DisplayFrame, asOf: number): SourceFamilyReading[] {
  const sourceReference = frame.flow ?? { status: "unavailable", reasons: ["SOURCE_UNAVAILABLE"] };
  const capabilityFor = (families: string[]) => {
    const capabilities = (frame.sourceCapabilities ?? []).filter(capability => families.includes(capability.family));
    if (!capabilities.length) return { state: "NOT PROBED", detail: "No owner source-capability receipt is attached." };
    const states = capabilities.map(capability => {
      const qualification = capability.qualification.replaceAll("_", " ").toUpperCase();
      const operational = capability.operational.replaceAll("_", " ").toUpperCase();
      const usable = capability.qualification === "qualified" && capability.operational === "healthy";
      return {
        state: usable ? "QUALIFIED · HEALTHY" : `${qualification} · ${operational}`,
        detail: `${capability.sourceId}: ${qualification}; operational ${operational}${capability.reasons.length ? ` · ${capability.reasons.join(", ")}` : ""}. Source status alone does not qualify a frame metric.`,
      };
    });
    return {
      state: states.map(item => item.state).join("; "),
      detail: states.map(item => item.detail).join(" "),
    };
  };
  const spotFlow = capabilityFor(["spot_flow"]);
  const spotLiquidity = capabilityFor(["spot_liquidity"]);
  const observedFlows = frame.microstructure?.flows ?? [];
  const observedBooks = frame.microstructure?.liquidity ?? [];
  const currentFlows = observedFlows.filter(row => rowTimeState(frame, row, asOf) === "CURRENT");
  const flowQualified = currentFlows.some(row => row.capabilityUsable && row.complete && !row.reasons.length);
  const bookQualified = observedBooks.some(row => row.capabilityUsable && !row.reasons.length && rowTimeState(frame, row, asOf) === "CURRENT");
  const flowFuture = observedFlows.some(row => rowTimeState(frame, row, asOf) === "FUTURE");
  const bookFuture = observedBooks.some(row => rowTimeState(frame, row, asOf) === "FUTURE");
  const flowExpired = observedFlows.length > 0 && observedFlows.every(row => rowTimeState(frame, row, asOf) === "EXPIRED");
  const bookExpired = observedBooks.length > 0 && observedBooks.every(row => rowTimeState(frame, row, asOf) === "EXPIRED");
  const derivatives = capabilityFor(["derivatives", "liquidations"]);
  const options = capabilityFor(["options"]);
  const external = capabilityFor(["external_context"]);
  const privateExposure = capabilityFor(["private_exposure"]);
  const research = capabilityFor(["conditional_outcomes"]);
  return [
    {
      key: "spot_flow", family: "Executed spot flow", qualified: flowQualified,
      freshness: flowFuture && !flowQualified ? "FUTURE" : flowExpired ? "EXPIRED" : currentFlows.length ? "CURRENT" : "UNAVAILABLE",
      scope: `${currentFlows.filter(row => row.capabilityUsable && row.complete && !row.reasons.length).length}/${observedFlows.length} complete qualified flow rows`,
      state: flowQualified ? "OBSERVED · QUALIFIED" : flowFuture ? "OBSERVED · FUTURE" : flowExpired ? "OBSERVED · EXPIRED" : spotFlow.state,
      evidence: `${spotFlow.detail} ${observedFlows.length ? `${observedFlows.length} stored flow rows; ${currentFlows.filter(row => row.complete && !row.reasons.length).length} complete, reason-free, available and unexpired at ${new Date(asOf).toISOString()}.` : "No executed-flow component is attached."} Status-only pointer: ${sourceReference.status}${sourceReference.reasons.length ? ` · ${sourceReference.reasons.join(", ")}` : ""}.`,
    },
    { key: "spot_liquidity", family: "Displayed liquidity", qualified: bookQualified, freshness: bookFuture && !bookQualified ? "FUTURE" : bookExpired ? "EXPIRED" : observedBooks.some(row => rowTimeState(frame, row, asOf) === "CURRENT") ? "CURRENT" : "UNAVAILABLE", scope: `${observedBooks.filter(row => row.capabilityUsable && !row.reasons.length && rowTimeState(frame, row, asOf) === "CURRENT").length}/${observedBooks.length} qualified size scenarios`, state: bookQualified ? "OBSERVED · QUALIFIED" : bookFuture ? "OBSERVED · FUTURE" : bookExpired ? "OBSERVED · EXPIRED" : spotLiquidity.state, evidence: `${spotLiquidity.detail} ${observedBooks.length ? `${observedBooks.length} stored order-size scenarios; partial coverage stays visibly partial.` : "No visible-book component is attached."}` },
    { key: "derivatives", family: "Derivatives positioning", qualified: false, freshness: "UNAVAILABLE", scope: "No qualified derivatives metric", state: derivatives.state, evidence: `${derivatives.detail} No qualified derivatives metric is attached.` },
    { key: "options", family: "Options", qualified: false, freshness: "UNAVAILABLE", scope: "No qualified observation", state: options.state, evidence: `${options.detail} Options remain outside the qualified evidence set.` },
    { key: "external_context", family: "External context", qualified: false, freshness: "UNAVAILABLE", scope: "No qualified observation", state: external.state, evidence: `${external.detail} External observations remain outside the qualified evidence set.` },
    { key: "private_exposure", family: "Private exposure", qualified: false, freshness: "UNAVAILABLE", scope: "No qualified observation", state: privateExposure.state, evidence: `${privateExposure.detail} No private owner data is read or projected here.` },
    { key: "conditional_outcomes", family: "Conditional outcomes", qualified: false, freshness: "UNAVAILABLE", scope: "No qualified observation", state: research.state === "NOT PROBED" ? "UNQUALIFIED" : research.state, evidence: `${research.detail} Deferred pending separately approved research and after-cost evidence.` },
  ];
}

const ANOMALY_LABELS: Record<string, string> = {
  dictionary_rvol_1h_high: "High 1h relative volume tag",
  bollinger_inside_ema_atr_compression_1h: "Compression tag",
  extreme_realized_volatility_1h_95p: "Extreme volatility tag",
};

const REASON_WORDS: Record<string, string> = {
  INSUFFICIENT_HISTORY: "building history",
  SOURCE_DISABLED: "source off",
  NOT_PROBED: "not probed",
  BAR_GAP: "bar gap",
  WARMING: "warming up",
};
/** Short operator wording for owner reason codes; the full codes stay in the chip title. */
export function reasonWords(reasons: string[]): string {
  const words = [...new Set(reasons.map(code => REASON_WORDS[code] ?? code.toLowerCase().replaceAll("_", " ")))];
  return words.length ? words.slice(0, 2).join(", ") : "unavailable";
}

export interface AvailabilityItem { key: string; label: string; reason: string; detail: string }

/**
 * Everything this frame cannot show, named once. Panels whose values are all unavailable render
 * nothing and appear here instead, so the page stays honest without walls of "Unavailable".
 */
export function availabilityItems(frame: DisplayFrame, asOf: number, horizon: Horizon, benchmark = "BTC",
  history: { samples: HistoryPoint[]; fault: string | null } | null = null): AvailabilityItem[] {
  const items: AvailabilityItem[] = [];
  for (const reading of sourceFamilyReadings(frame, asOf)) {
    if (reading.qualified || !["spot_flow", "spot_liquidity", "derivatives", "options"].includes(reading.key)) continue;
    const off = frame.flow?.reasons.includes("SOURCE_DISABLED") && reading.key === "spot_flow";
    items.push({ key: reading.key, label: reading.family, reason: off ? "source off" : reading.state.toLowerCase(), detail: reading.evidence });
  }
  const trajectoryValues = frame.breadthTrajectory.flatMap(row => [row.level, row.change, row.velocity, row.acceleration, row.shareChange].filter(Boolean)) as DisplayMetric[];
  // An absent projection counts as missing, exactly like a projection whose values are all unavailable.
  const trajectoryMissing = trajectoryValues.every(metric => metric.value == null);
  // A trajectory-bearing frame without any qualified divergence row cannot show the divergence reading.
  const divergenceMissing = frame.breadthDivergence.every(row => row.metric.value == null);
  if (trajectoryMissing || divergenceMissing)
    items.push({ key: "trajectory", label: trajectoryMissing && divergenceMissing ? "Breadth trajectory & divergence" : trajectoryMissing ? "Breadth trajectory" : "Price–breadth divergence",
      reason: reasonWords([...trajectoryValues, ...frame.breadthDivergence.map(row => row.metric)].flatMap(metric => metric.reasons)),
      detail: [trajectoryMissing ? (frame.breadthTrajectory.length ? `No matched trajectory value in ${frame.breadthTrajectory.length} horizon/interval pairs` : "No owner trajectory projection is attached") : "",
        divergenceMissing ? "No qualified BTC price–breadth divergence comparison" : ""].filter(Boolean).join(" · ") });
  const contribution = frame.contributions?.[horizon];
  const equalReturn = contribution?.equalReturn;
  const returnFuture = equalReturn?.available != null && equalReturn.expires != null &&
    rowTimeState(frame, { available: equalReturn.available, expires: equalReturn.expires }, asOf) === "FUTURE";
  if (equalReturn?.value == null || returnFuture)
    items.push({ key: "equal_return", label: `Equal-weight return (${horizonLabel(horizon)})`, reason: returnFuture ? "not yet available" : reasonWords(equalReturn?.reasons ?? []),
      detail: contribution ? metricTitle(contribution.equalReturn) : "No owner-computed frozen start-cohort return is attached." });
  const normalized = Object.values(frame.normalizedBreadth ?? {});
  if (normalized.every(row => row.pressure.value == null))
    items.push({ key: "normalized", label: "One-basis-point breadth", reason: normalized.length ? reasonWords(normalized.flatMap(row => row.pressure.reasons)) : "not attached",
      detail: normalized.length ? "No horizon has a qualified one-basis-point breadth pressure." : "Owner one-basis-point breadth metrics were not included in this frame." });
  if (history) {
    if (!returnsHistoryRetained(history.samples, horizon))
      items.push({ key: "returns_history", label: "Benchmark & cohort returns history", reason: history.fault ? "read degraded" : "not retained",
        detail: `No retained BTC or full-cohort ${horizonLabel(horizon)} return in this window${history.fault ? ` · ${history.fault}` : ""}.` });
    if (!trajectoryMissing && !trajectoryHistoryRetained(history.samples))
      items.push({ key: "trajectory_history", label: "Breadth trajectory history", reason: "not retained", detail: "No retained matched trajectory value in this window." });
    if (!flowHistoryRetained(history.samples) && !history.fault)
      items.push({ key: "flow_history", label: "Stored executed-flow history", reason: "not retained",
        detail: `No stored executed-flow aggregate in the newest ${FLOW_HISTORY_POINTS} points of this window. Current flow, if qualified, is not retained history.` });
  }
  // An absent projection is named as plainly as an unqualified metric inside one.
  if (!frame.hourlyInternals)
    items.push({ key: "hourly", label: "Hourly internals", reason: "not attached", detail: "This frame has no owner-computed hourly cohort projection." });
  if (!frame.candleAnomalies)
    items.push({ key: "anomaly", label: "Hourly candle tags", reason: "not attached", detail: "This frame has no owner-computed hourly candle anomaly projection." });
  const hourlyMissing = Object.entries(frame.hourlyInternals?.metrics ?? {}).filter(([, metric]) => metric.value == null);
  if (hourlyMissing.length)
    items.push({ key: "hourly", label: `Hourly internals · ${hourlyMissing.length} of ${Object.keys(frame.hourlyInternals!.metrics).length}`,
      reason: reasonWords(hourlyMissing.flatMap(([, metric]) => metric.reasons)),
      detail: hourlyMissing.map(([key, metric]) => `${key.replaceAll("_", " ")}: ${metric.status}${metric.reasons.length ? ` (${metric.reasons.join(", ")})` : ""}`).join(" · ") });
  for (const [key, metric] of Object.entries(frame.candleAnomalies?.metrics ?? {}))
    if (metric.valid === 0)
      items.push({ key: `anomaly/${key}`, label: ANOMALY_LABELS[key] ?? key.replaceAll("_", " "), reason: reasonWords(metric.reasons), detail: `${metric.definitionId} · 0/${metric.expected} valid · ${metric.reasons.join(", ")}` });
  const relativeChange = frame.comparisons?.[`relative_strength/${benchmark.toLowerCase()}`];
  if (relativeChange?.status !== "VALID" || relativeChange.value == null)
    items.push({ key: "relative_change", label: `Relative-strength change vs ${benchmark}`, reason: relativeChange ? reasonWords(relativeChange.reasons) : "no prior reference",
      detail: "Unavailable · no qualified prior relative-strength reference. The matched one-hour comparison needs a compatible baseline frame." });
  // Same column rule as the daily grid: every measure the grid leaves out is named here.
  const dailyMissing = DAILY_COLUMNS.filter(column => !dailyColumnQualified(column, frame.dailyInternals));
  if (dailyMissing.length) {
    const cells = frame.dailyInternals.flatMap(row => dailyMissing.map(column => column.cell(row)).filter(cell => cell !== undefined));
    const all = dailyMissing.length === DAILY_COLUMNS.length;
    items.push({ key: "daily", label: all ? "Daily range & SMAs" : `Daily · ${dailyMissing.length} of ${DAILY_COLUMNS.length} measures`,
      reason: reasonWords(cells.flatMap(cell => cell!.metric.reasons)),
      detail: frame.dailyInternals.length
        ? `${dailyMissing.map(column => column.label).join(", ")} · not qualified for any of ${frame.dailyInternals.length} instruments`
        : "This frame has no owner-qualified daily-internals projection." });
  }
  return items;
}


export type DailyRow = DisplayFrame["dailyInternals"][number];
export type DailyColumn = { key: string; label: string; cell: (row: DailyRow) => DailyRow["breaks"][string] | undefined; note?: (row: DailyRow, quote: string) => string | null; request?: MetricCohortRequest };
export const DAILY_COLUMNS: DailyColumn[] = [
  ...(["20", "50", "200"] as const).flatMap(period => [
    // The SMA price and the close-above-SMA fact qualify separately; one never stands in for the other.
    { key: `sma-${period}`, label: `SMA${period}`, cell: (row: DailyRow) => row.averages[period]?.sma },
    { key: `above-${period}`, label: `Above SMA${period}`, cell: (row: DailyRow) => row.averages[period]?.above_close,
      note: (row: DailyRow, quote: string) => row.averages[period]?.sma?.metric.value != null ? `SMA${period} ${dailyFeatureText(row.averages[period].sma.metric, row.averages[period].sma.metricId, null, quote)}` : null,
      request: { kind: "daily-above" as const, period } },
    { key: `slope-${period}`, label: `SMA${period} slope`, cell: (row: DisplayFrame["dailyInternals"][number]) => row.averages[period]?.slope_percent_per_day },
    { key: `cross-${period}`, label: `SMA${period} cross`, cell: (row: DisplayFrame["dailyInternals"][number]) => row.averages[period]?.cross },
  ]),
  ...([["high_break", "High > 20d high"], ["low_break", "Low < 20d low"], ["close_break_high", "Close > 20d high"], ["close_break_low", "Close < 20d low"]] as const)
    .map(([key, label]) => ({ key, label, cell: (row: DisplayFrame["dailyInternals"][number]) => row.breaks[key], request: { kind: "daily-break" as const, key } })),
];

/** The single qualification rule shared by the daily grid and the availability line. */
export function dailyColumnQualified(column: DailyColumn, rows: DailyRow[]) {
  return rows.some(row => column.cell(row)?.metric.value != null);
}
