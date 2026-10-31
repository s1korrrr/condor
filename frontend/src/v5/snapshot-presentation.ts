export const PAPER_SNAPSHOT_FRESH_MS = 30_000;
export const PAPER_FUTURE_SKEW_MS = 5_000;

export function paperTimestampIssue(value: unknown, nowMs: number): 'invalid' | 'future' | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(nowMs)) return 'invalid';
  return value > nowMs + PAPER_FUTURE_SKEW_MS ? 'future' : null;
}

export function paperAge(ageMs: number): string {
  const seconds = Math.max(0, Math.floor(ageMs / 1000));
  const minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  if (days) return `${days}d${hours % 24 ? ` ${hours % 24}h` : ''}`;
  if (hours) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
  if (minutes) return `${minutes}m${seconds % 60 ? ` ${seconds % 60}s` : ''}`;
  return `${seconds}s`;
}

export function paperSnapshotPresentation(asOfMs: number | null | undefined, nowMs: number, retained: boolean) {
  const issue = paperTimestampIssue(asOfMs, nowMs);
  const ageMs = issue === null ? Math.max(0, nowMs - asOfMs!) : null;
  const stale = ageMs === null || ageMs > PAPER_SNAPSHOT_FRESH_MS;
  const age = ageMs === null ? 'age unknown' : `${paperAge(ageMs)} old`;
  const state = issue === 'future' ? 'owner clock ahead; not current' : stale ? 'stale; not current' : 'snapshot only; not current';
  return { stale, ageMs, retained, clockAhead:issue === 'future', label:`Last complete owner snapshot · ${age} · ${state}` };
}
