export const PAPER_SNAPSHOT_FRESH_MS = 30_000;
export const PAPER_FUTURE_SKEW_MS = 5_000;
/**
 * Hard cap for dimmed values (Falco 14 Nov option B). Today a full Bots read takes ~9 s (up to ~50 s under load) and
 * refreshes every 15 s, so a healthy owner always produces a complete snapshot well within 120 s (= 4x the 30 s line,
 * about 2x the worst observed gap). Older than that means the owner or the read path is failing: values are withheld.
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
 * Dimmed window: a complete snapshot older than the 30 s line but within the 120 s cap stays on screen, dimmed, judged
 * as of 1 s after its own time (so the page renders its values, never calls them current). Outside the window, or with
 * an invalid or future timestamp, nothing is dimmed and the normal stale rules apply at the real clock.
 */
export function paperDimmedSnapshot(asOfMs: unknown, nowMs: number): { dimmed: boolean; snapshotAt: number | null; judgedAt: number } {
  if (typeof asOfMs !== 'number' || paperTimestampIssue(asOfMs, nowMs) !== null) return { dimmed: false, snapshotAt: null, judgedAt: nowMs };
  const ageMs = nowMs - asOfMs;
  const dimmed = ageMs > PAPER_SNAPSHOT_FRESH_MS && ageMs <= PAPER_DIMMED_MAX_MS;
  return { dimmed, snapshotAt: dimmed ? asOfMs : null, judgedAt: dimmed ? asOfMs + 1_000 : nowMs };
}
