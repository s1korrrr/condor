import type { MarketEvidence } from "./contracts.ts";
import { decimalShift, fixed, ownerDisplay, rationalPercent } from "./format.mjs";
import { featureText } from "./market-model.mjs";

export interface MarketFeature {
  id: string;
  label: string;
  status: string;
  unit: string;
  value: number | string | null;
}

export interface CohortCoverageDimension {
  key: string;
  label: string;
  valid: number | null;
  expected: number | null;
  fraction: number | null;
  fractionSource: string | null;
  fractionDerived: boolean;
}

const COHORT_DIMENSIONS = [
  { key: "spot-assets", label: "Spot assets", valid: "spot.assets_valid", expected: "spot.assets_expected", fraction: "spot.asset_coverage_fraction" },
  { key: "spot-venues", label: "Spot venue pairs qualified", valid: "spot.venues_valid", expected: "spot.venues_expected", fraction: "spot.venue_coverage_fraction" },
  { key: "perpetual-venues", label: "Perpetual venue pairs qualified", valid: "derivatives.venues_valid", expected: "derivatives.venues_expected", fraction: "derivatives.venue_coverage_fraction" },
  { key: "matched-assets", label: "Matched spot / perpetual assets", valid: "derivatives.matched_assets", expected: "spot.assets_expected", fraction: null },
] as const;

function qualifiedNumber(evidence: MarketEvidence, key: string): number | null {
  const feature = evidence.features?.[key];
  if (!feature || feature.status !== "QUALIFIED") return null;
  const value = parseNonNegativeDecimal(feature.value);
  return value != null && Number.isFinite(value) ? value : null;
}

export function selectedCohortCoverage(evidence: MarketEvidence): { complete: boolean; dimensions: CohortCoverageDimension[] } {
  const dimensions = COHORT_DIMENSIONS.map(({ key, label, valid, expected, fraction }) => {
    const validValue = qualifiedNumber(evidence, valid);
    const expectedValue = qualifiedNumber(evidence, expected);
    const reportedFraction = fraction == null ? null : qualifiedNumber(evidence, fraction);
    const fractionValue = reportedFraction;
    const countsValid = validValue != null && expectedValue != null && expectedValue > 0 && Number.isInteger(validValue) && Number.isInteger(expectedValue) && validValue <= expectedValue;
    return {
      key,
      label,
      valid: countsValid ? validValue : null,
      expected: countsValid ? expectedValue : null,
      fraction: fractionValue != null && fractionValue <= 1 ? fractionValue : null,
      fractionSource: fraction != null && reportedFraction != null ? String(evidence.features?.[fraction]?.value) : null,
      fractionDerived: fraction == null,
    };
  });
  return {
    complete: dimensions.every((row) => row.valid != null && row.expected != null && row.valid === row.expected && (row.fractionDerived || row.fraction === 1)),
    dimensions,
  };
}

export function cohortCoverageDisplay(row: CohortCoverageDimension, digits: number): { text: string; exact: string } | null {
  if (!row.fractionDerived) return row.fraction == null || row.fractionSource == null ? null : { text: `${fixed(decimalShift(row.fractionSource, 2), digits)}%`, exact: row.fractionSource };
  if (!Number.isSafeInteger(row.valid) || !Number.isSafeInteger(row.expected) || row.expected! <= 0) return null;
  const result = rationalPercent(BigInt(row.valid!) * 100n, BigInt(row.expected!), digits);
  return result ? { text: `${fixed(result.value, digits)}%`, exact: `${row.valid} / ${row.expected}; exact percentage ${result.exact}` } : null;
}

export function strategyAssessmentLabel(evidence: MarketEvidence): string {
  if (evidence.strategy_assessment_eligible === false) return "Not eligible";
  if (evidence.strategy_assessment_eligible === true) {
    return selectedCohortCoverage(evidence).complete ? "Eligible" : "Unavailable · partial source";
  }
  return "Unavailable";
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
  return ownerDisplay(feature.value, "price").tone === "none" ? String(feature.value) : featureText(feature.value, feature.unit);
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
  if (parseNonNegativeDecimal(value) == null) return "Unavailable";
  const shown = fixed(value);
  return shown === "—" ? "Unavailable" : `$${shown}`;
}

export function timestampAgeMs(timestamp: unknown, nowMs: number): number | null {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) return null;
  if (!Number.isFinite(nowMs) || nowMs < timestamp) return null;
  return nowMs - timestamp;
}

export function feedFreshness(timestamp: unknown, nowMs: number, staleAfterMs = 180_000): "CURRENT" | "STALE" | "UNKNOWN" {
  const age = timestampAgeMs(timestamp, nowMs);
  if (age == null) return "UNKNOWN";
  return age <= staleAfterMs ? "CURRENT" : "STALE";
}
