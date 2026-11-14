import type { SeriesPoint } from "@/features/quant-ops/kit/series";

export type MoneyRow = {
  bot: string; at_ms: number; gap?: string; unit?: string | null; snapshot_at_ms?: number | null;
  equity?: string | null; initial_funding?: string | null; external_flows?: string | null;
  realized?: string | null; unrealized?: string | null; fees?: string | null;
  coins?: Record<string, { realized: string | null; unrealized: string | null }>;
};
export type DailyRow = {
  day: number; samples: number; gaps: number; valid: number; equity_start: string | null; equity_end: string | null;
  equity_change: string | null; realized_change: string | null; first_at_ms: number | null; last_at_ms: number | null;
};
export function botRows(rows: MoneyRow[], bot: string): MoneyRow[];
export function series(rows: MoneyRow[], bot: string, field: keyof MoneyRow, stepMs?: number): SeriesPoint[];
export function latest(rows: MoneyRow[], bot: string): { newest: MoneyRow | null; withValues: MoneyRow | null };
export function dayCoverage(entry: DailyRow | null | undefined): number | null;
export function holdReturn(closesByCoin: Record<string, [number, number][] | undefined>, startS: number, endS: number, toleranceS?: number): { pct: number | null; coins: number; missing: string[] };
export function equityChangeSince(rows: MoneyRow[], bot: string, startMs: number, endMs: number, toleranceMs?: number): number | null;
