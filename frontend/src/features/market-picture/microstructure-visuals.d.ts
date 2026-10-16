export interface FlowCohort {
  instrumentId: string;
  sourceId: string;
  channel: string;
  quoteAsset: string;
  windowMs: number;
  latestEnd: number;
}
export interface BookCohort {
  instrumentId: string;
  sourceId: string;
  channel: string;
  observed: number;
  sizeUnit: string;
}
export function flowCohorts(flows: unknown[]): FlowCohort[];
export function projectFlowSelection(
  flows: unknown[],
  selection: FlowCohort,
  frame: { available_at_ms: number; expires_at_ms: number },
  asOf: number,
  limit?: number,
): {
  rows: Array<{
    label: string; buyQuote: number | null; sellQuote: number | null; unknownQuote: number | null;
    exact: { buyQuote: string; sellQuote: string; unknownQuote: string }; unit: string; state: string;
    complete: boolean | null; reason: string | null; sourceId: string; channel: string;
    windowStart: number; windowEnd: number; available: number; expires: number; trades: number | null; gaps: Array<[number, number]>;
  }>;
  count: number;
  plottedCount: number;
};
export function bookCohorts(rows: unknown[]): BookCohort[];
export function projectBookSelection(
  rows: unknown[],
  selection: BookCohort,
  frame: { available_at_ms: number; expires_at_ms: number },
  asOf: number,
  measure?: 'book' | 'total',
): {
  rows: Array<{
    label: string; side: string; size: string; sizeUnit: string; costBps: number | null; exactCostBps: string | null;
    coveragePercent: number | null;
    coverage: { requested: string; coveredBase: string; coveredQuote: string; uncovered: string; covered: number | null };
    state: string; sourceId: string; channel: string; observed: number; access: string;
    feeBps: string | null; feeSource: string | null; reasons: string[];
  }>;
  count: number;
  unit: 'bps';
  measure: 'book' | 'total';
  sizeUnit: string;
};
