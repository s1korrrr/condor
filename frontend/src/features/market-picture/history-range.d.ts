export interface HistoryRange {
  start: number;
  end: number;
}

export interface HistorySeriesPoints {
  points: Array<{ time: number }>;
}

export function historyRangeTimes(series: HistorySeriesPoints[]): number[];
export function normalizeHistoryRange(times: number[], range: HistoryRange | null): HistoryRange | null;
export function selectHistoryPoints<T extends { time: number }>(
  points: T[],
  times: number[],
  range: HistoryRange | null,
): T[];
