export const PAPER_SNAPSHOT_FRESH_MS = 30_000;

export function paperSnapshotPresentation(asOfMs: number | null | undefined, nowMs: number, retained: boolean) {
  const ageMs = typeof asOfMs === 'number' && Number.isFinite(asOfMs) ? Math.max(0, nowMs - asOfMs) : null;
  const stale = ageMs === null || ageMs > PAPER_SNAPSHOT_FRESH_MS;
  const age = ageMs === null ? 'age unknown' : `${Math.floor(ageMs / 1000)} s old`;
  return { stale, ageMs, label: `${retained || stale ? 'Last complete owner snapshot' : 'Owner snapshot'} · ${age}${stale ? ' · stale; not current' : retained ? ' · retained; not current' : ''}` };
}
