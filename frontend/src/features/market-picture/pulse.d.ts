import type {
  DisplayAsset,
  DisplayCorrelation,
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
  score: number;
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
): Verdict | null;
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
  label: string;
  samples: HistoryPoint[];
};
export function hasCorrelationValues(correlations: DisplayCorrelation[]): boolean;
export function showDistribution(frame: DisplayFrame | null, horizon?: string): boolean;
