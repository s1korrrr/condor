import type { ScreenerEnvelope } from "./contracts";

export function scopeKey(user: string | null, server: string | null, bot: string | null, lane?: string, quote?: string, interval?: string): string;
export function storageScopeKey(user: string | null, server: string | null, bot: string | null, lane?: string, quote?: string): string;
export function storageRead(storage: Storage, key: string): { value: any; error: string | null };
export function storageWrite(storage: Storage, key: string, value: any): string | null;
export function metricFor(row: any, aliases: string[]): any;
export function metricSortValue(metric: any): number | null;
export function formatDisplayNumber(value: string | null | undefined, digits?: number, price?: boolean): string;
export function sortRows(rows: any[], metricId: string, direction?: "asc" | "desc"): any[];
export function scopeMatches(expected: string, current: string): boolean;
export function csvEscape(value: unknown): string;
export function snapshotCsv(snapshot: any): string;
export function makeViewUrl(view: any): string;
export function parseViewParams(search: string): { value?: any; error?: string };
export function makeResearchPacket(snapshot: any, query: any, selected: any, annotations?: any[]): any;
export function matchTransitions(before: any, after: any): Array<{kind: "entered" | "left"; instrumentId: string; symbol: string}>;
export const SCREENS: Array<[string, string]>;
export const COLUMNS: Array<[string, string, string[]]>;

export function snapshotFreshness(snapshot: ScreenerEnvelope | null, now: number, intervalMs: number, failed?: boolean): string;
