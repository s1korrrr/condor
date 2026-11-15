export function breakEvenDistance(breakeven: unknown, close: unknown): string;
export function moneySampleState(row: { at_ms: number; snapshot_at_ms?: number | null; unit?: string | null; gap?: string } | null, now: number): { state: 'sample' | 'late'; next: number } | null;
export function activeLots(rows: Record<string, unknown>[]): Record<string, unknown>[];
export function sellOrderCount(rows: Record<string, unknown>[] | null): string | null;
export function exactSignedSum(left: unknown, right: unknown): string | null;
