export interface TimelineCell {
  pressure: number | null;
  positive: number | null;
  negative: number | null;
  flat: number | null;
}

export interface TimelineColumn {
  start: number;
  end: number;
  /** Recorded time of the shown observation; null when the bucket is a retained gap. */
  time: number | null;
  /** First own frame time in the bucket (equals `time` for a single or carried frame). */
  first: number | null;
  /** Own frames averaged into this column; 0 when carried or empty. */
  frames: number;
  /** The bucket repeats the previous column (sampling spacing, not a gap). */
  carried: boolean;
  /** Frames in this bucket before an owner-flagged gap; they are not averaged into the column. */
  framesBeforeGap: number;
  /** The owner flagged a retained gap before an observation in this bucket. */
  gapBefore: boolean;
  /** Membership, valid or expected count differs from the previous frame. */
  coverageChanged: boolean;
  snapshot: string | null;
  valid: number | null;
  expected: number | null;
  cells: Record<string, TimelineCell | null>;
}

export interface BreadthTimeline {
  columns: TimelineColumn[];
  start: number | null;
  end: number | null;
  bucketMinutes: number | null;
}

export function timelineBucketMinutes(spanMs: number, maxColumns?: number): number;
export function timelineTicks(domain: [number, number], width: number, minGapPx?: number): number[];
export function pressureTone(pressure: number | null | undefined): { side: "up" | "down" | "flat"; strength: number } | null;
export function shareBalance(cell: TimelineCell | null | undefined): string;
export function breadthTimeline(
  samples: Array<{
    time: number; gapBefore?: boolean; membership?: string; snapshot_id?: string | null; valid?: number; expected?: number;
    breadth?: Record<string, { positive: number | null; negative: number | null; flat: number | null; pressure: number | null }>;
  }>,
  horizons: readonly string[],
  options?: { range?: [number, number] | null; maxColumns?: number },
): BreadthTimeline;
