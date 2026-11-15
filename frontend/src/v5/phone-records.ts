import { paperTimestampIssue } from './snapshot-presentation';

export function phoneRecordTime(row: Record<string, unknown>, now: number, snapshotAt: unknown): number | null {
  if (typeof snapshotAt !== 'number' || paperTimestampIssue(snapshotAt, now) !== null) return null;
  for (const key of ['event_at_ms', 'close_at_ms', 'created_at_ms']) {
    const value = row[key];
    if (value == null) continue;
    return typeof value === 'number' && paperTimestampIssue(value, now) === null && value <= now && value <= snapshotAt ? value : null;
  }
  return null;
}
