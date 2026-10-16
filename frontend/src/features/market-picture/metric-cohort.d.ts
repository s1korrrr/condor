import type { DisplayFrame } from "./presentation";

export type MetricCohortRequest =
  | { kind: "breadth"; horizon: "1" | "5" | "15" | "60" | "240" | "1440"; side: "advancing" | "declining" | "unchanged" }
  | { kind: "predicate"; key: string }
  | { kind: "daily-above"; period: "20" | "50" | "200" }
  | { kind: "daily-break"; key: "high_break" | "low_break" | "close_break_high" | "close_break_low" };

export interface MetricCohortSelection {
  request: MetricCohortRequest;
  label: string;
  definition: string | null;
  snapshotId: string | null;
  cutoff: number | null;
  status: "available" | "unavailable";
  reasons: string[];
  instrumentIds: string[];
  valid: number;
  expected: number;
}

/** Select a display-only cohort from fresh owner-computed observations in one frame. */
export function selectMetricCohort(
  frame: DisplayFrame | null,
  request: MetricCohortRequest,
  asOf: number,
  expectedDefinition?: string,
): MetricCohortSelection;
