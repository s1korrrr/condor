import type { HistoryPoint, DisplayFlowHistory } from './presentation';
import type { SeriesPoint } from '@/features/quant-ops/kit/series';
export function flowHistoryVisuals(points: HistoryPoint[], quoteAsset: string): {
  rows: { point: HistoryPoint; flow: DisplayFlowHistory | null; continuity: string }[];
  notional: Record<'buy'|'sell'|'unknown', SeriesPoint[]>;
  cvd: SeriesPoint[];
};
