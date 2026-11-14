import type { helmHeadline } from "./helm-model.mjs";
export type StripTone = "green" | "amber" | "red" | "grey";
export type StripChip = { id: "v5" | "helm" | "data" | "equity"; label: string; to: string; tone: StripTone; text: string; short: string };
export type StripInput = {
  nowMs: number;
  v5: { bound: boolean; pending: boolean; current: boolean; entryHold: boolean | null; lastOkMs: number | null };
  helm: { read: Parameters<typeof helmHeadline>[0]; failed: boolean; lastOkMs: number | null };
  data: { configured: boolean; pending: boolean; failed: boolean; slowestLagS: number | null; lastOkMs: number | null };
  wallet: { current: boolean; equity: unknown; funding: unknown; flows: unknown; unit: unknown };
  updatedMs: number | null;
};
export const DATA_LAG_AMBER_S: number;
export function utcClock(ms: unknown): string | null;
export function statusStrip(input: StripInput): { chips: StripChip[]; toCheck: number; checkText: string; shortCheckText: string; updated: string };
export function slowestLaneAge(tiles: unknown): number | null;
