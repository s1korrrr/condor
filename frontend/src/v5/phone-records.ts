export function phoneRecordTime(row: Record<string, unknown>): number | null {
  for (const key of ['event_at_ms', 'close_at_ms', 'created_at_ms']) {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}
