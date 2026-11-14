import type { helmHeadline } from "./helm-model.mjs";
export type StripTone = "green" | "amber" | "red" | "grey";
export type StripChip = { id: "v5" | "helm" | "data" | "equity"; label: string; to: string; tone: StripTone; text: string; short: string };
export type StripInput = {
  nowMs: number;
  v5: { bound: boolean; pending: boolean; current: boolean; entryHold: boolean | null; emergency?: boolean; lastOkMs: number | null };
  helm: { read: (Parameters<typeof helmHeadline>[0] & { status?: { age_s?: number; generated_at?: number } | null }) | null; failed: boolean; lastOkMs: number | null; receivedAtMs?: number | null };
  data: { configured: boolean; pending: boolean; failed: boolean; lanes: { total: number; live: number; lagS: number | null } | null; lastOkMs: number | null; receivedAtMs?: number | null };
  wallet: { current: boolean; equity: unknown; funding: unknown; flows: unknown; unit: unknown };
  updatedMs: number | null;
};
export const DATA_LAG_AMBER_S: number;
export const HELM_STALE_S: number;
export function utcClock(ms: unknown): string | null;
export function statusStrip(input: StripInput): { chips: StripChip[]; toCheck: number; checkText: string; shortCheckText: string; updated: string };
export function laneHealth(tiles: unknown): { total: number; live: number; lagS: number | null } | null;
