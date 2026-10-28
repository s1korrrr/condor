import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { feedFreshness, formatUsdAmount, marketFeatures, parseNonNegativeDecimal, qualifiedFeatureValue, selectedCohortCoverage, strategyAssessmentLabel, timestampAgeMs } from "../src/v5/evidence.ts";

const evidence = JSON.parse(readFileSync(new URL("./fixtures/v5-multi-venue-evidence-projection.json", import.meta.url), "utf8"));

test("market evidence keeps spot and perpetual feature namespaces separate", () => {
  const spot = marketFeatures(evidence, "spot.");
  const perpetual = marketFeatures(evidence, "derivatives.");
  assert.ok(spot.length > 0);
  assert.ok(perpetual.length > 0);
  assert.ok(spot.every((row) => row.id.startsWith("spot.")));
  assert.ok(perpetual.every((row) => row.id.startsWith("derivatives.")));
  assert.ok(!spot.some((row) => row.id.includes("spot_perp_return_divergence")));
  assert.equal(spot.find((row) => row.id === "spot.return_median_pct.1m").unit, "percent");
  assert.equal(spot.find((row) => row.id === "spot.pressure_original_1m").unit, "pressure_minus3_to_3");
  assert.equal(spot.find((row) => row.id === "spot.pressure_missingness_lower").unit, "normalized_pressure_minus1_to_1");
});

test("only QUALIFIED feature values are presented as values, including explicit zero", () => {
  const qualified = marketFeatures(evidence, "spot.").find((row) => row.id === "spot.decliners");
  const unavailable = marketFeatures(evidence, "baseline.").find((row) => row.id === "baseline.composite_score");
  assert.equal(qualifiedFeatureValue(qualified), "0");
  assert.equal(unavailableFeatureValue(unavailable), "Unavailable");
  assert.equal(evidence.baseline_binding_hash, null);
  assert.equal(evidence.strategy_assessment_eligible, false);
});

function unavailableFeatureValue(feature) {
  return feature ? qualifiedFeatureValue(feature) : "Unavailable";
}

test("missing feature rows stay missing and USDT cohort is not relabeled", () => {
  const incomplete = { ...evidence, features: { ...evidence.features } };
  delete incomplete.features["spot.return_median_pct.1m"];
  assert.equal(marketFeatures(incomplete, "spot.").some((row) => row.id === "spot.return_median_pct.1m"), false);
  assert.equal(evidence.quality.quote_cohort_by_market.spot[0], "USDT");
  assert.equal(evidence.quality.quote_conversion, "none");
  assert.equal(evidence.quality.target_row_states.missing, 1);
  assert.equal(evidence.quality.quote_cohort_by_market.perpetual[0], "USDT");
});

test("market evidence timestamps expose exact snapshot age and future or missing times stay unavailable", () => {
  assert.equal(timestampAgeMs(evidence.available_at_ms, evidence.available_at_ms + 30_000), 30_000);
  assert.equal(timestampAgeMs(evidence.available_at_ms, evidence.available_at_ms - 1), null);
  assert.equal(timestampAgeMs(null, evidence.available_at_ms), null);
  assert.equal(evidence.available_at_ms - evidence.cutoff_ms, 105_679);
});

test("feed freshness fails closed for missing or future owner timestamps", () => {
  const now = evidence.available_at_ms + 100_000;
  assert.equal(feedFreshness(evidence.available_at_ms, now), "CURRENT");
  assert.equal(feedFreshness(evidence.available_at_ms, evidence.available_at_ms + 180_001), "STALE");
  assert.equal(feedFreshness(null, now), "UNKNOWN");
  assert.equal(feedFreshness(now + 1, now), "UNKNOWN");
});

test("selected cohort is complete only when all asset and venue features are qualified and full", () => {
  const complete = selectedCohortCoverage(evidence);
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.dimensions.map(({ valid, expected }) => [valid, expected]), [[5, 5], [30, 30], [30, 30], [5, 5]]);
  assert.equal(strategyAssessmentLabel({ ...evidence, strategy_assessment_eligible: true }), "Eligible");
});

test("partial coverage and exact zero remain visible as partial, not complete", () => {
  const partialEvidence = structuredClone(evidence);
  partialEvidence.features["spot.assets_valid"].value = 4;
  partialEvidence.features["spot.asset_coverage_fraction"].value = 0.8;
  partialEvidence.features["spot.venues_valid"].value = 0;
  partialEvidence.features["spot.venue_coverage_fraction"].value = 0;
  partialEvidence.features["derivatives.matched_assets"].value = 4;
  const partial = selectedCohortCoverage(partialEvidence);
  assert.equal(partial.complete, false);
  assert.equal(partial.dimensions[0].valid, 4);
  assert.equal(partial.dimensions[0].expected, 5);
  assert.equal(partial.dimensions[1].valid, 0);
  assert.equal(partial.dimensions[3].valid, 4);
  partialEvidence.strategy_assessment_eligible = true;
  assert.equal(strategyAssessmentLabel(partialEvidence), "Unavailable · partial source");
});

test("unknown or unqualified selected coverage fails closed and stays unavailable", () => {
  const unknownEvidence = structuredClone(evidence);
  unknownEvidence.features["derivatives.venues_expected"].status = "UNAVAILABLE";
  unknownEvidence.features["derivatives.venues_expected"].value = null;
  const unknown = selectedCohortCoverage(unknownEvidence);
  assert.equal(unknown.complete, false);
  assert.equal(unknown.dimensions[2].valid, null);
  assert.equal(unknown.dimensions[2].expected, null);
  assert.equal(unknown.dimensions[2].fraction, 1);
});

test("dollar strings are parsed strictly and invalid or negative values remain unavailable", () => {
  assert.equal(parseNonNegativeDecimal("0.001000"), 0.001);
  assert.equal(formatUsdAmount("0.001000"), "$0.001000");
  assert.equal(formatUsdAmount("0"), "$0.00");
  assert.equal(formatUsdAmount("-0.01"), "Unavailable");
  assert.equal(formatUsdAmount(null), "Unavailable");
  assert.equal(parseNonNegativeDecimal("0"), 0);
  assert.equal(parseNonNegativeDecimal("-0.01"), null);
  assert.equal(parseNonNegativeDecimal("NaN"), null);
  assert.equal(parseNonNegativeDecimal("Infinity"), null);
  assert.equal(parseNonNegativeDecimal("1e3"), null);
  assert.equal(parseNonNegativeDecimal(""), null);
  assert.equal(parseNonNegativeDecimal(null), null);
  assert.equal(parseNonNegativeDecimal(Number.POSITIVE_INFINITY), null);
});
