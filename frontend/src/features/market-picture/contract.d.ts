import type { DisplayFrame } from "./presentation";
export function decimal(value: unknown): number;
export function canonical(value: unknown): string;
export function digest(value: unknown): Promise<string>;
export function seriesDigest(series: Record<string, unknown>): Promise<string>;
export function resolveSeries(
  series: unknown,
): Record<string, Record<string, unknown>>;
export function validateMetric(metric: unknown, unit?: string): number | null;
export function validateFrame(
  frame: unknown,
  options?: { allowFixture?: boolean },
): Promise<Record<string, unknown>>;
export function projectFrame(frame: Record<string, unknown>): DisplayFrame;
