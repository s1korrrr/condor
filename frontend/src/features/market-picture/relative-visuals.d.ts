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
): RelativeStrengthProjection;
export function projectRelativeRankMovers(
  frame: Pick<DisplayFrame, "assets" | "expected" | "cutoff_ms" | "relativeStrengthChanges">,
  limitPerSide?: number,
): RelativeRankProjection;
