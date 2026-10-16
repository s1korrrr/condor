/**
 * Pure projection behind the Market Pulse breadth timeline: one column per time bucket, one cell per
 * return horizon. A column shows the mean of the frames recorded in its bucket (labelled as such). A
 * bucket without its own frame repeats the previous column ("carried", labelled with its real time)
 * unless the owner flagged a retained gap before the next frame; then it stays empty.
 */

const BUCKET_MINUTES = [1, 2, 5, 10, 15, 30, 60, 120, 240, 360, 720, 1440];
const TICK_MINUTES = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880];
const finite = (value) => typeof value === "number" && Number.isFinite(value);

/** Smallest bucket that keeps the column count at or below `maxColumns` for the span. */
export function timelineBucketMinutes(spanMs, maxColumns = 160) {
  const span = Math.max(0, finite(spanMs) ? spanMs : 0);
  return BUCKET_MINUTES.find((minutes) => span / (minutes * 60_000) <= maxColumns) ?? BUCKET_MINUTES.at(-1);
}

/** UTC-aligned tick times inside [start, end] at least `minGapPx` apart on a `width`-pixel axis. */
export function timelineTicks([start, end], width, minGapPx = 72) {
  if (!finite(start) || !finite(end) || end <= start || !(width > 0)) return [];
  const msPerPx = (end - start) / width;
  const minutes = TICK_MINUTES.find((m) => (m * 60_000) / msPerPx >= minGapPx) ?? TICK_MINUTES.at(-1);
  const step = minutes * 60_000;
  const ticks = [];
  for (let time = Math.ceil(start / step) * step; time <= end && ticks.length < 64; time += step) ticks.push(time);
  return ticks;
}

/** Diverging fill for a pressure on the fixed -3..+3 scale; zero is the neutral swatch, null has none. */
export function pressureTone(pressure) {
  if (!finite(pressure)) return null;
  const t = Math.max(-1, Math.min(1, pressure / 3));
  if (t === 0) return { side: "flat", strength: 0 };
  return { side: t > 0 ? "up" : "down", strength: Math.abs(t) };
}

const percent = (value) => (finite(value) ? `${Math.round(value * 100)}%` : "—");
/**
 * Stored history carries breadth shares but no per-horizon denominator (a horizon may qualify fewer
 * instruments than the frame), so the timeline states shares only; owner counts come from the frame.
 */
export function shareBalance(cell) {
  if (!cell) return "No observation";
  return `${percent(cell.positive)} up · ${percent(cell.negative)} down${cell.flat ? ` · ${percent(cell.flat)} flat` : ""}`;
}

/** Mean of each breadth field over the bucket's own frames; a field with no finite value stays null. */
function meanCell(points, horizon) {
  const fields = ["pressure", "positive", "negative", "flat"];
  const sums = Object.fromEntries(fields.map((field) => [field, [0, 0]]));
  for (const point of points) {
    const row = point?.breadth?.[horizon];
    if (!row) continue;
    for (const field of fields) if (finite(row[field])) { sums[field][0] += row[field]; sums[field][1] += 1; }
  }
  const values = Object.fromEntries(fields.map((field) => [field, sums[field][1] ? sums[field][0] / sums[field][1] : null]));
  return Object.values(values).some(finite) ? values : null;
}

/**
 * @param samples chronologically ordered retained history points
 * @param horizons horizon keys (rows)
 * @param options.range optional [from, to] visible UTC range (zoom)
 * @param options.maxColumns column budget for the bucket choice
 */
export function breadthTimeline(samples, horizons, { range = null, maxColumns = 160 } = {}) {
  const ordered = (samples ?? []).filter((point) => finite(point?.time));
  if (!ordered.length) return { columns: [], start: null, end: null, bucketMinutes: null };
  const first = ordered[0].time, last = ordered.at(-1).time;
  const from = range && finite(range[0]) ? Math.max(first, range[0]) : first;
  const to = range && finite(range[1]) ? Math.min(last, range[1]) : last;
  if (!(to >= from)) return { columns: [], start: null, end: null, bucketMinutes: null };
  const minutes = timelineBucketMinutes(Math.max(to - from, 60_000), maxColumns);
  const size = minutes * 60_000;
  const firstBucket = Math.floor(from / size), lastBucket = Math.floor(to / size);
  const columns = [];
  // A carried column repeats one recorded frame (never a bucket mean), with that frame's time and counts.
  const frameColumn = (point) => ({ time: point.time, snapshot: point.snapshot_id ?? null, valid: point.valid ?? null, expected: point.expected ?? null,
    cells: Object.fromEntries(horizons.map((horizon) => [horizon, meanCell([point], horizon)])) });
  let cursor = 0;
  // Only frames inside [from, to] are averaged; the latest earlier frame may only be carried.
  while (cursor < ordered.length && ordered[cursor].time < from) cursor++;
  const before = cursor > 0 ? ordered[cursor - 1] : null;
  let carried = before ? frameColumn(before) : null;
  // Coverage changes within a partial universe are as material as a membership change.
  const coverage = (point) => JSON.stringify([point.membership ?? null, point.valid ?? null, point.expected ?? null]);
  let previousCoverage = before ? coverage(before) : null;
  let seen = Boolean(before);
  for (let index = firstBucket; index <= lastBucket; index++) {
    const bucketStart = index * size, bucketEnd = bucketStart + size;
    const own = [];
    let gap = false, segmentStart = 0;
    while (cursor < ordered.length && ordered[cursor].time < bucketEnd && ordered[cursor].time <= to) {
      const point = ordered[cursor];
      if (point.gapBefore && (own.length || seen)) {
        gap = true;
        // Never average across an owner-flagged gap: the column keeps only the frames after it.
        segmentStart = own.length;
      }
      seen = true;
      own.push(point);
      cursor++;
    }
    const segment = own.slice(segmentStart);
    // A carried value may only bridge sampling spacing, never a retained gap the owner flagged.
    const next = ordered[cursor];
    const bridged = !own.length && carried && next && !next.gapBefore;
    const newest = own.at(-1);
    let coverageChanged = false;
    for (const point of own) {
      const current = coverage(point);
      if (previousCoverage !== null && current !== previousCoverage) coverageChanged = true;
      previousCoverage = current;
    }
    const shown = newest ? {
      time: newest.time, snapshot: newest.snapshot_id ?? null, valid: newest.valid ?? null, expected: newest.expected ?? null,
      cells: Object.fromEntries(horizons.map((horizon) => [horizon, meanCell(segment, horizon)])),
    } : bridged ? carried : null;
    columns.push({
      start: bucketStart,
      end: bucketEnd,
      time: shown?.time ?? null,
      first: segment.length ? segment[0].time : shown?.time ?? null,
      frames: segment.length,
      framesBeforeGap: segmentStart,
      carried: Boolean(shown && !own.length),
      gapBefore: gap,
      coverageChanged,
      snapshot: shown?.snapshot ?? null,
      valid: shown?.valid ?? null,
      expected: shown?.expected ?? null,
      cells: shown ? shown.cells : Object.fromEntries(horizons.map((horizon) => [horizon, null])),
    });
    carried = newest ? frameColumn(newest) : shown;
  }
  return { columns, start: firstBucket * size, end: (lastBucket + 1) * size, bucketMinutes: minutes };
}
