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

/** Why a frame cannot supply current observations at `asOf`, or null when it can. */
export function frameReason(
  frame: Pick<DisplayFrame, "cutoff_ms" | "available_at_ms" | "expires_at_ms"> | null,
  asOf: number,
): string | null;
/** Why one owner metric is not usable at `asOf` (value, status, availability, expiry), or null. */
export function metricReason(
  metric: { status?: string; value?: number | null; available?: number | null; expires?: number | null } | null | undefined,
  asOf: number,
  options?: { partial?: boolean },
): string | null;
