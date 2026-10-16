import type { HistoryPoint } from "./presentation";
import type { SeriesPoint } from "@/features/quant-ops/kit/series";
export type HistoryComparison = "returns" | "level" | "change" | "shareChange" | "velocity" | "acceleration";
export const HISTORY_COMPARISONS: Record<HistoryComparison, { label: string; unit: string }>;
export interface HistoryComparisonResult {
  series: { id: string; label: string; unit: string; points: SeriesPoint[] }[];
  markers: { time: number; label: string }[];
  rows: { time: number; snapshot: string | null; values: Record<string, number | null>;
    continuity: string; coverage: string; divergence: string; benchmark: string }[];
  unavailable: string | null;
  label: string;
  unit: string;
}
export function historyComparisons(samples: HistoryPoint[], horizon: string, interval: string,
  view: HistoryComparison, range?: [number, number] | null): HistoryComparisonResult;
