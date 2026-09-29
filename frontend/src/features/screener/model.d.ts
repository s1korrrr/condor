import type {
  MetricValue,
  ResearchQuery,
  ScreenerEnvelope,
  ScreenerNote,
  ScreenerRow,
  ScreenerStorage,
  SharedView,
} from "./contracts";

export function scopeKey(
  user: string | null,
  server: string | null,
  bot: string | null,
  lane?: string,
  quote?: string,
  interval?: string,
): string;
export function storageScopeKey(
  user: string | null,
  server: string | null,
  bot: string | null,
  lane?: string,
  quote?: string,
): string;
export function storageRead(
  storage: Storage,
  key: string,
): { value: ScreenerStorage | null; error: string | null };
export function storageWrite(
  storage: Storage,
  key: string,
  value: ScreenerStorage,
): string | null;
export function metricFor(
  row: ScreenerRow,
  aliases: string[],
): MetricValue | null;
export function metricSortValue(
  metric: MetricValue | null | undefined,
): number | null;
export function formatDisplayNumber(
  value: string | null | undefined,
  digits?: number,
  price?: boolean,
): string;
export function csvEscape(value: unknown): string;
export function snapshotCsv(snapshot: ScreenerEnvelope): string;
export function makeViewUrl(view: SharedView): string;
export function parseViewParams(
  search: string,
): { value: SharedView; error?: never } | { value?: never; error: string };
export function makeResearchPacket(
  snapshot: ScreenerEnvelope,
  query: ResearchQuery,
  selected: ScreenerRow | null,
  annotations?: ScreenerNote[],
): Record<string, unknown>;
export function matchTransitions(
  before: ScreenerEnvelope | null,
  after: ScreenerEnvelope | null,
): Array<{ kind: "entered" | "left"; instrumentId: string; symbol: string }>;
export const SCREENS: Array<[string, string]>;
export const COLUMNS: Array<[string, string, string[]]>;
export function snapshotFreshness(
  snapshot: ScreenerEnvelope | null,
  now: number,
  intervalMs: number,
  failed?: boolean,
): string;
