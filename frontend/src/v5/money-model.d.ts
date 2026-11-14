import type { SeriesPoint } from "@/features/quant-ops/kit/series";

export type MoneyRow = {
  bot: string; at_ms: number; gap?: string; unit?: string | null; snapshot_at_ms?: number | null;
  equity?: string | null; initial_funding?: string | null; external_flows?: string | null;
  realized?: string | null; unrealized?: string | null; fees?: string | null;
  coins?: Record<string, { realized: string | null; unrealized: string | null }>;
};
export type DailyRow = {
  day: number; samples: number; gaps: number; equityStart: number | null; equityEnd: number | null;
  equityChange: number | null; realizedChange: number | null; coverage: number;
};
export function botRows(rows: MoneyRow[], bot: string): MoneyRow[];
export function series(rows: MoneyRow[], bot: string, field: keyof MoneyRow): SeriesPoint[];
export function latest(rows: MoneyRow[], bot: string): { newest: MoneyRow | null; withValues: MoneyRow | null };
export function daily(rows: MoneyRow[], bot: string): DailyRow[];
export function holdReturn(closesByCoin: Record<string, [number, number][] | undefined>, startS: number, toleranceS?: number): { pct: number | null; coins: number; missing: string[] };
export function equityChangeSince(rows: MoneyRow[], bot: string, startMs: number, toleranceMs?: number): number | null;
