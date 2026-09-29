import type { DisplayFrame, ViewSettings } from "./presentation";
export const HORIZONS: import("./presentation").Horizon[];
export const HORIZON_LABELS: string[];
export const BENCHMARKS: string[];
export function acceptFrame<
  T extends Pick<
    DisplayFrame,
    | "stream_id"
    | "epoch"
    | "sequence"
    | "snapshot_id"
    | "payload_digest"
    | "available_at_ms"
    | "cutoff_ms"
  >,
>(previous: T | null, incoming: T): T;
export function ageState(
  frame: DisplayFrame | null,
  now: number,
  frozen: boolean,
): { mode: string; freshness: string; ageMs: number | null };
export function normalizeView(value?: Partial<ViewSettings>): ViewSettings;
export function parseView(search: string): ViewSettings;
export function viewQuery(value: ViewSettings): string;
export function rankAssets<T extends { instrument_id: string }>(
  assets: T[],
  valueFor: (asset: T) => number | null,
  limit?: number,
): { leaders: T[]; laggards: T[] };
export function csvCell(value: unknown): string;
export function heatmapColor(value: number | null): string;
export function histogramBinIndex(value: number, edges: number[]): number;
export function histogramMembers<T extends { instrument_id: string }>(
  assets: T[],
  valueFor: (asset: T) => number | null,
  low: number,
  high: number,
  includeUpper: boolean,
): string[];
export function formatNumber(
  value: number | string | null,
  digits?: number,
  sign?: boolean,
): string;
export function downloadFile(
  filename: string,
  mime: string,
  text: string,
): void;
export function stableAssetOrder<
  T extends import("./presentation").DisplayAsset,
>(assets: T[], sort: string, previousIds?: string[] | null): T[];
export function pollDelay(failures: number, random?: number): number;

export function nativeViewSearch(search: string): string;
