export const PAPER_SNAPSHOT_FRESH_MS = 30_000;
export const PAPER_FUTURE_SKEW_MS = 5_000;
/**
 * Presentation cap for dimmed values (Falco 14 Nov option B), chosen from observed Bots reads of ~9 s, up to ~50 s
 * under load, with a 15 s refresh. This is not a guarantee of owner completion time. Older values are withheld.
 */
export const PAPER_DIMMED_MAX_MS = 120_000;

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
  return { stale, ageMs, retained, clockAhead:issue === 'future', label:`Last coherent owner snapshot · ${age} · ${state}` };
}

/**
 * Dimmed window: values from a complete snapshot older than the 30 s line but within the 120 s cap may be admitted
 * as of 1 s after its own time. State, safety, timestamp validation and ages still use the real clock. Outside the
 * window, or with an invalid or future timestamp, the normal stale rules apply.
 */
export function paperDimmedSnapshot(asOfMs: unknown, nowMs: number): { dimmed: boolean; snapshotAt: number | null; valuesAt: number } {
  if (typeof asOfMs !== 'number' || paperTimestampIssue(asOfMs, nowMs) !== null) return { dimmed: false, snapshotAt: null, valuesAt: nowMs };
  const ageMs = nowMs - asOfMs;
  const dimmed = ageMs > PAPER_SNAPSHOT_FRESH_MS && ageMs <= PAPER_DIMMED_MAX_MS;
  return { dimmed, snapshotAt: dimmed ? asOfMs : null, valuesAt: dimmed ? asOfMs + 1_000 : nowMs };
}
