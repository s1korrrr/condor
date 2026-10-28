import type { MarketEvidence } from "./contracts.ts";

export interface MarketFeature {
  id: string;
  label: string;
  status: string;
  unit: string;
  value: number | string | null;
}

export function marketFeatures(evidence: MarketEvidence, prefix: string): MarketFeature[] {
  return Object.entries(evidence.features ?? {})
    .filter(([id]) => id.startsWith(prefix))
    .map(([id, row]) => ({
      id,
      label: id.slice(prefix.length).replaceAll("_", " "),
      status: row.status,
      unit: row.unit,
      value: row.value,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function qualifiedFeatureValue(feature: MarketFeature): string {
  if (feature.status !== "QUALIFIED" || feature.value == null) return "Unavailable";
  return String(feature.value);
}

export function parseNonNegativeDecimal(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(candidate)) return null;
  const parsed = Number(candidate);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function formatUsdAmount(value: unknown): string {
  const parsed = parseNonNegativeDecimal(value);
  if (parsed == null) return "Unavailable";
  if (typeof value === "string") {
    const [whole = "0", fraction = ""] = value.trim().split(".");
    return `$${BigInt(whole).toLocaleString()}${fraction.length ? `.${fraction.padEnd(2, "0")}` : ".00"}`;
  }
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 12,
  }).format(parsed);
}

export function timestampAgeMs(timestamp: unknown, nowMs: number): number | null {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) return null;
  if (!Number.isFinite(nowMs) || nowMs < timestamp) return null;
  return nowMs - timestamp;
}
