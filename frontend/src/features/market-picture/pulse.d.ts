import type {
  DisplayAsset,
  DisplayCorrelation,
  DisplayEvent,
  DisplayFrame,
  HistoryPoint,
  Horizon,
} from "./presentation";
export interface VerdictComponent {
  id: string;
  label: string;
  score: number;
  detail: string;
}
export interface Verdict {
  state: "risk-on" | "mixed" | "risk-off";
  label: string;
  /** Score the state follows: the trailing mean when smoothed, otherwise the latest frame. */
  score: number;
  instantScore: number;
  smoothed: boolean;
  smoothedFrames: number;
  smoothingMinutes: number;
  /** The state is kept by the hold band rather than by the entry threshold. */
  held: boolean;
  horizon: Horizon;
  components: VerdictComponent[];
  rule: string;
  advancing: number | null;
  declining: number | null;
  unchanged: number | null;
  valid: number | null;
  expected: number;
}
export interface LadderRow {
  horizon: Horizon;
  label: string;
  advancing: number;
  declining: number;
  unchanged: number;
  valid: number;
  expected: number;
  up: number;
  down: number;
  flat: number;
  pressure: number | null;
}
export interface SeriesPointValue {
  time: number;
  value: number | null;
}
export const VERDICT_THRESHOLD: number;
export const VERDICT_HOLD: number;
export const SMOOTHING_MINUTES: number;
export const VERDICT_RULE: string;
export const REGIME_BASIS: string;
export const MIN_DISTRIBUTION_POPULATION: number;
export function horizonLabel(horizon: string): string;
export function impliedMove(
  annualVolatility: number | null | undefined,
  minutes: number,
): number | null;
export function marketVerdict(
  frame: DisplayFrame | null,
  horizon: Horizon,
  context?: { history?: HistoryPoint[]; smooth?: boolean },
): Verdict | null;
export function nextVerdictState(
  previous: Verdict["state"],
  score: number,
): Verdict["state"];
export function rollingMean(
  samples: HistoryPoint[],
  valueOf: (point: HistoryPoint) => number | null | undefined,
  minutes?: number,
): Array<number | null>;
export function isSingleBarRelativeVolume(
  metric: { definition?: string } | null | undefined,
): boolean;
export function isHourlyRelativeVolume(
  metric: { definition?: string } | null | undefined,
): boolean;
export function nullReasonLabel(
  metric: { value: number | null; reasons: string[] } | null | undefined,
): string | null;
export type CorrelationReadout =
  | { kind: "none" }
  | { kind: "values"; expected: number; samples: number; window: string; definition: string; partial: boolean }
  | { kind: "building"; expected: number; samples: number; needed: number; window: string; definition: string; share: number };
export function correlationWindowLabel(hours: number): string;
export function correlationReadout(correlations: DisplayCorrelation[]): CorrelationReadout;
export function breadthLadder(frame: DisplayFrame | null): LadderRow[];
export function returnHeat(
  asset: DisplayAsset,
  horizon: string,
): { value: number | null; intensity: number };
export function assetState(asset: DisplayAsset): {
  trend: string | null;
  adx: number | null;
  rsi: number | null;
  rsiZone: string | null;
  emaDistance: number | null;
};
export function derivedRegime(asset: DisplayAsset): {
  label: string;
  basis: "stored" | "derived";
  tags: string[];
  detail: string;
} | null;
export function regimeSummary(frame: DisplayFrame | null): Array<{
  key: string;
  label: string;
  rule: string;
  share: number;
  count: number;
  valid: number;
}>;
export function pulseSeries(
  history: HistoryPoint[],
  window: string,
  horizon: Horizon,
): {
  advancing: SeriesPointValue[];
  declining: SeriesPointValue[];
  pressure: SeriesPointValue[];
  /** Trailing 15-minute mean of the one-minute pressure; `pressure` stays the raw value. */
  smoothed: SeriesPointValue[];
  bucketMinutes: number;
  label: string;
  samples: HistoryPoint[];
};
export function hasCorrelationValues(correlations: DisplayCorrelation[]): boolean;
export function showDistribution(frame: DisplayFrame | null, horizon?: string): boolean;
export const SHORT_BREADTH_MINUTES: number;
export function isShortBreadthCrossing(event: DisplayEvent): boolean;
