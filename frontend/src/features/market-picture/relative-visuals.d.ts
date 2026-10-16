import type { DisplayAsset, DisplayFrame } from "./presentation";

export interface RelativeScatterPoint {
  instrumentId: string;
  symbol: string;
  oneHourReturn: number;
  relativeReturn: number;
  pullback: boolean;
}

export interface RelativeStrengthProjection {
  benchmark: string;
  expected: number;
  valid: number;
  omitted: number;
  /** Frame-level timing reason when no point can qualify at the assessment time. */
  reason: string | null;
  points: RelativeScatterPoint[];
}

export interface RelativeRankMover {
  instrumentId: string;
  symbol: string;
  delta: number;
  direction: "improving" | "weakening";
}

export interface RelativeRankProjection {
  available: boolean;
  reason: string | null;
  baselineCutoff: number | null;
  expected: number;
  totalImproving: number;
  totalWeakening: number;
  unchanged: number;
  displayed: number;
  rows: RelativeRankMover[];
}

export function projectRelativeStrength(
  assets: DisplayAsset[],
  benchmark: string,
  frame: Pick<DisplayFrame, "cutoff_ms" | "available_at_ms" | "expires_at_ms">,
  asOf: number,
): RelativeStrengthProjection;
export function projectRelativeRankMovers(
  frame: Pick<DisplayFrame, "assets" | "expected" | "cutoff_ms" | "available_at_ms" | "expires_at_ms" | "relativeStrengthChanges">,
  asOf: number,
  limitPerSide?: number,
): RelativeRankProjection;

/** Side for each scatter label in plot pixels; missing ids are left unlabelled to avoid overlap. */
export function placeScatterLabels(
  points: (RelativeScatterPoint & { label?: string })[],
  xDomain: [number, number],
  yDomain: [number, number],
  plot: { width: number; height: number; charWidth?: number; lineHeight?: number; gap?: number },
): Map<string, "left" | "right">;

export interface RelativeScatterGroup extends RelativeScatterPoint {
  /** Instruments sharing this exact pair. */
  count: number;
  /** Symbol, with "×n" when several instruments share the pair. */
  label: string;
}
/** One representative per exact pair, pullbacks first, with the shared count. */
export function groupCoincident(points: RelativeScatterPoint[]): RelativeScatterGroup[];
