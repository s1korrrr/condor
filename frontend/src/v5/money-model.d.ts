import type { SeriesPoint } from "@/features/quant-ops/kit/series";

export type MoneyRow = {
  bot: string; at_ms: number; gap?: string; unit?: string | null; snapshot_at_ms?: number | null;
  equity?: string | null; initial_funding?: string | null; external_flows?: string | null;
  realized?: string | null; unrealized?: string | null; fees?: string | null; accounting_since_ms?: number | null;
  coins?: Record<string, { realized: string | null; unrealized: string | null }>;
};
export type DailyRow = {
  day: number; samples: number; gaps: number; valid: number; equity_start: string | null; equity_end: string | null;
  equity_change: string | null; realized_change: string | null; first_at_ms: number | null; last_at_ms: number | null;
};
export function botRows(rows: MoneyRow[], bot: string): MoneyRow[];
export function series(rows: MoneyRow[], bot: string, field: keyof MoneyRow): SeriesPoint[];
export function latest(rows: MoneyRow[], bot: string): { newest: MoneyRow | null; withValues: MoneyRow | null };
export function dayCoverage(entry: DailyRow | null | undefined): number | null;
export function holdReturn(closesByCoin: Record<string, [number, number][] | undefined>): { pct: number | null; startS: number | null; endS: number | null; missing: string[] };
export function equityChange(rows: MoneyRow[], bot: string): { pct: number | null; startMs: number | null; endMs: number | null };

/** Exact strings returned by the shared Python daily report and export CLI. */
export type DailyMoneyRow = {
  day: number; date: string; bot: "v5" | "helm"; unit: string;
  first_at_ms: number | null; last_at_ms: number | null;
  equity_start: string; equity_end: string; equity_change: string; equity_change_pct: string;
  realized_pnl: string; fees: string; unrealized_pnl_end: string;
  buys: string; sells: string; fills: string; cash_end: string; held_value_end: string;
  samples: number; expected_samples: number; present_slots: number; value_slots: number;
  missing_slots: number; gaps: number; partial: boolean; data_quality: string;
};

export function compareMoneyText(left: string, right: string): number;
