import type { MetricEntry } from "@/lib/parse-agent";

export interface PnlDataPoint {
  time: number;
  value: number;
}

export function metricsToDataPoints(metrics: MetricEntry[]): PnlDataPoint[] {
  return metrics
    .filter((metric) => metric.timestamp)
    .map((metric) => ({
      time: Math.floor(new Date(metric.timestamp).getTime() / 1000),
      value: metric.pnl,
    }))
    .sort((a, b) => a.time - b.time);
}

export function sessionsToDataPoints(
  sessions: { session_num: number; total_pnl: number | null; status: string; current_book_status?: string }[],
): PnlDataPoint[] {
  if (
    sessions.length === 0 ||
    sessions.some(
      (session) =>
        session.total_pnl == null ||
        (session.current_book_status != null && session.current_book_status !== "available"),
    )
  ) return [];
  const base = Math.floor(Date.now() / 1000) - sessions.length * 3600;
  let cumulativePnl = 0;
  return sessions
    .slice()
    .sort((a, b) => a.session_num - b.session_num)
    .map((session, index) => {
      cumulativePnl += session.total_pnl ?? 0;
      return { time: base + index * 3600, value: cumulativePnl };
    });
}
