import type { DailyRow, MoneyRow } from "./money-model.mjs";

export type MoneyRead = { sampler: boolean; started_at_ms: number | null; now_ms: number; range: string; rows: MoneyRow[]; daily: DailyRow[]; recorder_errors: { count: number; last: string | null; at_ms: number | null } };

export async function readMoney(range: string, signal?: AbortSignal): Promise<MoneyRead> {
  const response = await fetch(`/api/v5/money?range=${range}`, { credentials: "include", cache: "no-store", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(14_000)]) : AbortSignal.timeout(14_000) });
  if (!response.ok) throw new Error(`Money read failed (HTTP ${response.status})`);
  return response.json() as Promise<MoneyRead>;
}
