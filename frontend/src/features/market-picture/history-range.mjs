/** Collect the finite, unique chart timestamps in chronological order. */
export function historyRangeTimes(series) {
  const times = new Set();
  for (const item of series ?? []) {
    for (const point of item.points ?? []) {
      if (Number.isFinite(point?.time)) times.add(point.time);
    }
  }
  return [...times].sort((a, b) => a - b);
}

/** Clamp chart-point indexes and restore ascending bounds; null means the full retained view. */
export function normalizeHistoryRange(times, range) {
  if (range == null || !Array.isArray(times) || times.length === 0) return null;
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end)) return null;
  const last = times.length - 1;
  const clamp = (value) => Math.min(last, Math.max(0, Math.round(value)));
  const firstIndex = clamp(range.start);
  const lastIndex = clamp(range.end);
  return { start: Math.min(firstIndex, lastIndex), end: Math.max(firstIndex, lastIndex) };
}

/** Select inclusive time bounds without changing, recalculating, or copying any source point. */
export function selectHistoryPoints(points, times, range) {
  const normalized = normalizeHistoryRange(times, range);
  if (normalized === null) return points;
  const start = times[normalized.start];
  const end = times[normalized.end];
  return points.filter((point) => Number.isFinite(point.time) && point.time >= start && point.time <= end);
}
