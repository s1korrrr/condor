import copy
import hashlib
import json
from decimal import Decimal, localcontext
from fractions import Fraction
from pathlib import Path

import pytest
from jsonschema.exceptions import ValidationError

from condor.web.market_picture_contract import (
    CORRELATION_WINDOW_HOURS,
    _cohort_window_start_ms,
    _compact_series,
    _validate_candle_anomalies,
    _validate_relative_strength_changes,
    canonical,
    correlation_definition_id,
    validate_frame,
    validate_response,
)


def fixture(name="market-picture.v1.json"):
    return json.loads(Path(__file__).with_name("fixtures").joinpath(name).read_text())


def with_cohort_median_refs(frame):
    for contribution in frame["contribution_summaries"]:
        horizon = contribution["horizon_minutes"]
        breadth = next(
            row for row in frame["breadth"] if row["horizon_minutes"] == horizon
        )
        contribution["median_return_ref"] = copy.deepcopy(
            breadth["metric_refs"]["median_return"]
        )
        series_id = frame["asset_metric_refs"][f"return_{horizon}m"]["metric_id"]
        series = next(
            row for row in frame["metric_series"] if row["metric_id"] == series_id
        )
        values = sorted(Decimal(cell["value"]) for cell in series["cells"])
        middle = len(values) // 2
        if len(values) % 2:
            median = values[middle]
        else:
            midpoint = (Fraction(values[middle - 1]) + Fraction(values[middle])) / 2
            with localcontext() as context:
                context.prec = max(
                    28,
                    len(str(abs(midpoint.numerator)))
                    + len(str(midpoint.denominator))
                    + 4,
                )
                median = Decimal(midpoint.numerator) / Decimal(midpoint.denominator)
        metric_id = breadth["metric_refs"]["median_return"]["metric_id"]
        frame["market_metrics"][metric_id]["value"] = str(median)
    return frame


def legacy_fixture():
    return fixture("market-picture.legacy-rvol24h.v1.json")


def reseal_series(frame, metric_id):
    series = next(s for s in frame["metric_series"] if s["metric_id"] == metric_id)
    series["payload_digest"] = hashlib.sha256(
        canonical(
            _compact_series({k: v for k, v in series.items() if k != "payload_digest"})
        )
    ).hexdigest()
    return series


def test_compact_cell_quality_defaults_are_hash_equivalent_and_expand_in_frame():
    frame = fixture()
    series = next(
        row for row in frame["metric_series"] if row["metric_id"] == "asset_price"
    )
    explicit = copy.deepcopy(series)
    cell = explicit["cells"][0]
    assert "computation_status" not in cell
    cell.update(computation_status="VALID", coverage_status="COMPLETE", reason_codes=[])
    assert _compact_series(explicit) == _compact_series(series)
    series["payload_digest"] = hashlib.sha256(
        canonical(
            _compact_series(
                {key: value for key, value in series.items() if key != "payload_digest"}
            )
        )
    ).hexdigest()
    validate_frame(seal(frame), allow_fixture=True)
    frame["metric_series"][frame["metric_series"].index(series)] = explicit
    validate_frame(seal(frame), allow_fixture=True)


def test_owner_candle_context_rows_and_source_capabilities_validate_and_bind_to_metrics():
    frame = with_candle_context(fixture())
    parsed = validate_frame(seal(frame), allow_fixture=True)
    assert len(parsed["normalized_breadth"]) == 6
    assert len(parsed["breadth_trajectory"]) == 9
    assert len(parsed["breadth_divergence"]) == 3
    assert len(parsed["contribution_summaries"]) == 4
    assert parsed["source_capabilities"][0]["qualification"] == "not_probed"

    bad_ref = with_candle_context(fixture())
    bad_ref["breadth_trajectory"][0]["metric_refs"]["acceleration"][
        "metric_id"
    ] = "breadth_pressure_velocity_5_5m"
    with pytest.raises(ValueError, match="semantic metric binding"):
        validate_frame(seal(bad_ref), allow_fixture=True)

    bad_capability = with_candle_context(fixture())
    bad_capability["source_capabilities"][0]["operational"] = "healthy"
    with pytest.raises(ValueError, match="unprobed capability"):
        validate_frame(seal(bad_capability), allow_fixture=True)


def test_owner_builder_fixture_is_accepted_by_gateway_schema_and_semantic_checks():
    frame = fixture("market-picture.m1.fixture.json")
    validate_frame(frame, allow_fixture=True)


def test_optional_cohort_median_ref_is_bound_to_exact_full_member_breadth_median():
    frame = with_cohort_median_refs(fixture("market-picture.m1.fixture.json"))
    validate_frame(seal(frame), allow_fixture=True)


@pytest.mark.parametrize(
    "mutation",
    [
        "start_cohort_unavailable",
        "contribution_incomplete",
        "breadth_incomplete",
        "different_horizon_median",
        "wrong_definition",
        "wrong_unit",
        "wrong_coverage",
        "wrong_window",
        "not_member_median",
        "unavailable_member",
        "cohort_started_inside_horizon",
    ],
)
def test_optional_cohort_median_ref_rejects_unproven_claims(mutation):
    frame = with_cohort_median_refs(fixture("market-picture.m1.fixture.json"))
    contribution = frame["contribution_summaries"][0]
    horizon = contribution["horizon_minutes"]
    breadth = next(row for row in frame["breadth"] if row["horizon_minutes"] == horizon)
    metric_id = breadth["metric_refs"]["median_return"]["metric_id"]
    metric = frame["market_metrics"][metric_id]
    if mutation == "start_cohort_unavailable":
        contribution["start_cohort_available"] = False
    elif mutation == "contribution_incomplete":
        contribution["valid_count"] -= 1
    elif mutation == "breadth_incomplete":
        breadth["valid_count"] -= 1
    elif mutation == "different_horizon_median":
        other = next(row for row in frame["breadth"] if row["horizon_minutes"] == 15)
        contribution["median_return_ref"] = copy.deepcopy(
            other["metric_refs"]["median_return"]
        )
    elif mutation == "wrong_definition":
        metric["definition"]["definition_id"] = "cohort_equal_weight_return"
    elif mutation == "wrong_unit":
        metric["unit"] = "percentage_points"
        metric["definition"]["unit"] = "percentage_points"
    elif mutation == "wrong_coverage":
        metric["sample_count"] -= 1
    elif mutation == "wrong_window":
        metric["window_start_ms"] += 60_000
    elif mutation == "not_member_median":
        metric["value"] = "0"
    elif mutation == "unavailable_member":
        series = next(
            row
            for row in frame["metric_series"]
            if row["metric_id"]
            == frame["asset_metric_refs"][f"return_{horizon}m"]["metric_id"]
        )
        series["cells"][0]["value"] = None
        series["cells"][0]["computation_status"] = "UNAVAILABLE"
        series["cells"][0]["coverage_status"] = "PARTIAL"
        series["cells"][0]["reason_codes"] = ["INSUFFICIENT_COVERAGE"]
        reseal_series(frame, series["metric_id"])
    else:
        frame["universe"]["effective_at_ms"] = frame["cutoff_ms"] - horizon * 60_000 + 1
    with pytest.raises(ValueError, match="cohort median|semantic metric binding"):
        validate_frame(seal(frame), allow_fixture=True)


def test_cohort_median_window_start_uses_owner_zero_clamp():
    assert _cohort_window_start_ms(120_000, 5) == 0
    assert _cohort_window_start_ms(300_000, 5) == 0
    assert _cohort_window_start_ms(360_000, 5) == 60_000


def test_divergence_flag_requires_a_positive_matched_cohort():
    frame = with_candle_context(fixture("market-picture.m1.fixture.json"))
    row = frame["breadth_divergence"][0]
    row["matched_count"] = 0
    row["matched_membership_hash"] = None
    with pytest.raises(ValueError, match="divergence"):
        validate_frame(seal(frame), allow_fixture=True)


@pytest.mark.parametrize(
    "mutation",
    [
        "positive_without_hash",
        "hash_without_matches",
        "invalid_flag",
        "matched_exceeds_expected",
    ],
)
def test_divergence_flag_rejects_incoherent_count_or_value(mutation):
    frame = with_candle_context(fixture("market-picture.m1.fixture.json"))
    row = frame["breadth_divergence"][0]
    metric = frame["market_metrics"][row["metric_ref"]["metric_id"]]
    if mutation == "positive_without_hash":
        row.update(matched_count=1, matched_membership_hash=None)
    elif mutation == "hash_without_matches":
        row.update(matched_count=0, matched_membership_hash="b" * 64)
    elif mutation == "invalid_flag":
        metric["value"] = "2"
    else:
        row.update(matched_count=3, expected_count=2, matched_membership_hash="b" * 64)
    with pytest.raises(ValueError, match="divergence cohort|divergence flag"):
        validate_frame(seal(frame), allow_fixture=True)


def test_unavailable_divergence_allows_zero_matched_cohort():
    frame = with_candle_context(fixture("market-picture.m1.fixture.json"))
    row = frame["breadth_divergence"][0]
    row.update(matched_count=0, matched_membership_hash=None)
    metric = frame["market_metrics"][row["metric_ref"]["metric_id"]]
    metric.update(
        value=None,
        computation_status="UNAVAILABLE",
        coverage_status="PARTIAL",
        reason_codes=["INSUFFICIENT_COVERAGE"],
        numerator=None,
        denominator=0,
        sample_count=0,
    )
    validate_frame(seal(frame), allow_fixture=True)


def test_exact_one_hour_rank_projection_is_typed_and_bound_to_the_frozen_cohort():
    frame = fixture("market-picture.relative-ranks.1h.fixture.json")
    parsed = validate_frame(frame, allow_fixture=True)
    changes = parsed["relative_strength_changes"]
    assert changes["baseline_cutoff_ms"] == changes["current_cutoff_ms"] - 3_600_000
    assert changes["rank_deltas"] == [-1, 1]
    assert changes["valid_count"] == changes["expected_count"] == len(parsed["assets"])

    for mutation in (
        "wrong_definition",
        "wrong_cohort",
        "non_permutation",
        "wrong_interval",
        "unavailable_with_cohort",
    ):
        invalid = copy.deepcopy(frame)
        changes = invalid["relative_strength_changes"]
        if mutation == "wrong_definition":
            changes["definition_hash"] = "f" * 64
        elif mutation == "wrong_cohort":
            changes["cohort_hash"] = "f" * 64
        elif mutation == "non_permutation":
            changes["rank_deltas"] = [0, 1]
        elif mutation == "unavailable_with_cohort":
            changes.update(
                valid_count=0,
                rank_deltas=[None] * len(invalid["assets"]),
                reason_codes=["INSUFFICIENT_COVERAGE"],
                cohort_hash="a" * 64,
            )
        else:
            changes["baseline_cutoff_ms"] += 60_000
        resealed = seal(invalid)
        if mutation == "unavailable_with_cohort":
            with pytest.raises(ValueError, match="unavailable relative-strength rank"):
                _validate_relative_strength_changes(resealed)
        else:
            with pytest.raises(
                ValueError, match="relative-strength|rank change|permutation"
            ):
                validate_frame(resealed, allow_fixture=True)


def test_owner_combined_fixture_keeps_daily_flow_and_partial_depth_at_the_gateway():
    frame = fixture("market-picture.m1-components.fixture.json")
    parsed = validate_frame(frame, allow_fixture=True)
    assert len(parsed["daily_internals"]) == len(parsed["assets"]) == 5
    assert parsed["microstructure"]["replay_class"] == "snapshot_only"
    assert parsed["microstructure"]["raw_inputs_retained"] is False
    flow = parsed["microstructure"]["flows"]
    books = parsed["microstructure"]["liquidity"]
    assert flow and books
    assert all(row["source_contract_hash"] for row in flow + books)
    partial = next(row for row in books if Decimal(row["uncovered_size"]) > 0)
    assert partial["vwap"] is None
    assert partial["cost_bps"] is None
    assert parsed["source_capabilities"]

    private = copy.deepcopy(frame)
    private["source_capabilities"][0]["family"] = "private_exposure"
    private["source_capabilities"][0]["access"] = "separately_authorized_private"
    with pytest.raises(ValueError, match="private source metadata"):
        validate_frame(seal(private), allow_fixture=True)


def test_owner_combined_fixture_carries_valid_hourly_candle_anomalies():
    frame = fixture("market-picture.m1-components.fixture.json")
    parsed = validate_frame(frame, allow_fixture=True)
    anomalies = parsed["candle_anomalies"]
    assert anomalies["cutoff_ms"] == frame["cutoff_ms"] // 3_600_000 * 3_600_000
    assert anomalies["decision_available_at_ms"] == frame["available_at_ms"]
    assert anomalies["expected_count"] == len(frame["assets"])
    assert len(anomalies["source_hash"]) == 64

    for mutation in (
        "wrong_cutoff",
        "wrong_source_count",
        "short_vector",
        "nonbinary",
        "wrong_high_count",
        "wrong_definition",
        "wrong_share",
        "unknown_metric",
    ):
        invalid = copy.deepcopy(frame)
        panel = invalid["candle_anomalies"]
        metric = panel["metrics"]["dictionary_rvol_1h_high"]
        if mutation == "wrong_cutoff":
            panel["cutoff_ms"] += 3_600_000
        elif mutation == "wrong_source_count":
            panel["source_count"] -= 1
        elif mutation == "short_vector":
            metric["values"].pop()
        elif mutation == "nonbinary":
            metric["values"][0] = 2
        elif mutation == "wrong_high_count":
            metric["high_count"] = 999
        elif mutation == "wrong_definition":
            metric["definition_hash"] = "f" * 64
        elif mutation == "wrong_share":
            metric["share_fraction"] = "1.1"
        else:
            panel["metrics"]["unreviewed"] = metric
        with pytest.raises(ValueError, match="candle-anomaly"):
            _validate_candle_anomalies(seal(invalid))


@pytest.mark.parametrize(
    "mutation",
    ["flow_after_component", "book_after_frame", "book_observed_after_cutoff"],
)
def test_microstructure_rows_cannot_cross_component_or_frame_decision_time(mutation):
    frame = fixture("market-picture.m1-components.fixture.json")
    component = frame["microstructure"]
    if mutation == "flow_after_component":
        component["available_at_ms"] -= 1
        component["flows"][0]["available_at_ms"] = frame["available_at_ms"]
    elif mutation == "book_after_frame":
        component["liquidity"][0]["available_at_ms"] = frame["available_at_ms"] + 1
        component["liquidity"][0]["expires_at_ms"] += 1
    else:
        component["liquidity"][0]["observed_at_ms"] = frame["cutoff_ms"] + 1
    component["component_id"] = hashlib.sha256(
        canonical(
            {key: value for key, value in component.items() if key != "component_id"}
        )
    ).hexdigest()
    with pytest.raises(ValueError, match="decision-time bounds"):
        validate_frame(seal(frame), allow_fixture=True)


@pytest.mark.parametrize(
    "mutation",
    [
        "quantity",
        "covered_vwap",
        "full_vwap",
        "missing_full_cost",
        "negative_cost",
        "sell_cost_bound",
        "zero_spread",
        "fee_bound",
        "total_cost",
        "band_imbalance",
        "unknown_access",
        "unknown_spread",
        "unknown_band",
        "unknown_percentile",
    ],
)
def test_liquidity_execution_and_cost_fields_reconcile_before_publication(mutation):
    frame = fixture("market-picture.m1-components.fixture.json")
    row = next(
        item
        for item in frame["microstructure"]["liquidity"]
        if item["uncovered_size"] == "0"
    )
    if mutation == "quantity":
        row["uncovered_size"] = "0.1"
    elif mutation == "covered_vwap":
        row["covered_vwap"] = "22"
    elif mutation == "full_vwap":
        row["vwap"] = "22"
    elif mutation == "missing_full_cost":
        row["cost_bps"] = None
    elif mutation == "negative_cost":
        row["cost_bps"] = "-1"
    elif mutation == "sell_cost_bound":
        row["cost_bps"] = "10000"
    elif mutation == "zero_spread":
        row["spread_bps"] = "0"
    elif mutation == "fee_bound":
        row["fee_bps"] = "10001"
    elif mutation == "total_cost":
        row["total_cost_bps"] = "30"
    elif mutation == "band_imbalance":
        row["band_imbalance"] = "0.5"
    elif mutation == "unknown_access":
        row["access_basis"] = "unknown"
    elif mutation in {"unknown_spread", "unknown_band", "unknown_percentile"}:
        row.update(
            access_basis="unknown",
            covered_base="0",
            covered_quote="0",
            uncovered_size=row["requested_size"],
            covered_vwap=None,
            vwap=None,
            cost_bps=None,
            fee_bps=None,
            fee_source=None,
            total_cost_bps=None,
            spread_bps=None,
            band_bid_covered_quote="0",
            band_ask_covered_quote="0",
            band_complete=False,
            band_imbalance=None,
            cost_percentile_7d=None,
            cost_percentile_sample_count=0,
            cost_percentile_expected_samples=10080,
            cost_percentile_reason_codes=["INSUFFICIENT_HISTORY"],
            cost_percentile_reference_digest=None,
        )
        if mutation == "unknown_spread":
            row["spread_bps"] = "1"
        elif mutation == "unknown_band":
            row["band_bid_covered_quote"] = "1"
        else:
            row.update(
                cost_percentile_7d="0.5",
                cost_percentile_sample_count=9500,
                cost_percentile_reason_codes=[],
                cost_percentile_reference_digest="c" * 64,
            )
    component = frame["microstructure"]
    component["component_id"] = hashlib.sha256(
        canonical(
            {key: value for key, value in component.items() if key != "component_id"}
        )
    ).hexdigest()
    if frame["flow_ref"]["status"] == "available":
        frame["flow_ref"]["snapshot_id"] = component["component_id"]
    with pytest.raises(ValueError):
        validate_frame(seal(frame), allow_fixture=True)


def test_unavailable_cell_still_requires_explicit_status_and_reasons():
    for missing in ("computation_status", "reason_codes"):
        frame = fixture()
        series = next(
            row for row in frame["metric_series"] if row["metric_id"] == "asset_adx14"
        )
        series["cells"][0].pop(missing)
        series["payload_digest"] = hashlib.sha256(
            canonical(
                _compact_series(
                    {
                        key: value
                        for key, value in series.items()
                        if key != "payload_digest"
                    }
                )
            )
        ).hexdigest()
        with pytest.raises(ValueError):
            validate_frame(seal(frame), allow_fixture=True)


def seal(frame):
    frame = copy.deepcopy(frame)
    frame.pop("snapshot_id", None)
    frame.pop("payload_digest", None)
    frame["snapshot_id"] = hashlib.sha256(canonical(frame)).hexdigest()
    frame["payload_digest"] = hashlib.sha256(canonical(frame)).hexdigest()
    return frame


def with_candle_context(frame):
    """Add owner-shaped optional M1 rows while reusing source-bound aggregate provenance."""
    base = copy.deepcopy(frame["market_metrics"]["breadth_1440_advances"])

    def add(metric_id, unit, definition_id, value="0"):
        metric = copy.deepcopy(base)
        metric.update(
            metric_id=metric_id,
            value=value,
            unit=unit,
            computation_status="VALID",
            coverage_status="COMPLETE",
            reason_codes=[],
            definition={
                **metric["definition"],
                "definition_id": definition_id,
                "unit": unit,
            },
            denominator=2,
            expected_denominator=2,
            sample_count=2,
        )
        frame["market_metrics"][metric_id] = metric
        return {"metric_id": metric_id}

    normalized = []
    for horizon in (1, 5, 15, 60, 240, 1440):
        normalized.append(
            {
                "horizon_minutes": horizon,
                "valid_count": 2,
                "expected_count": 2,
                "cutoff_ms": frame["cutoff_ms"],
                "metric_refs": {
                    "advances": add(
                        f"breadth_1bp_{horizon}_advances",
                        "instruments",
                        "breadth_instrument_count",
                        "1",
                    ),
                    "declines": add(
                        f"breadth_1bp_{horizon}_declines",
                        "instruments",
                        "breadth_instrument_count",
                        "1",
                    ),
                    "unchanged": add(
                        f"breadth_1bp_{horizon}_unchanged",
                        "instruments",
                        "breadth_instrument_count",
                    ),
                    "pressure": add(
                        f"breadth_pressure_1bp_{horizon}",
                        "index_minus1_to1",
                        "breadth_pressure_1bp",
                    ),
                },
            }
        )
    trajectory = []
    for horizon in (5, 15, 60):
        for interval in (5, 15, 60):
            trajectory.append(
                {
                    "horizon_minutes": horizon,
                    "interval_minutes": interval,
                    "cutoff_ms": frame["cutoff_ms"],
                    "matched_count": 2,
                    "expected_count": 2,
                    "matched_membership_hash": "b" * 64,
                    "metric_refs": {
                        "level": add(
                            f"breadth_pressure_level_{horizon}_{interval}m",
                            "index_minus1_to1",
                            "breadth_pressure_1bp",
                        ),
                        "change": add(
                            f"breadth_pressure_change_{horizon}_{interval}m",
                            "index_points",
                            "breadth_pressure_change",
                        ),
                        "velocity": add(
                            f"breadth_pressure_velocity_{horizon}_{interval}m",
                            "index_points_per_minute",
                            "breadth_pressure_velocity",
                        ),
                        "acceleration": add(
                            f"breadth_pressure_acceleration_{horizon}_{interval}m",
                            "index_points_per_minute_squared",
                            "breadth_pressure_acceleration",
                        ),
                    },
                }
            )
    divergences = [
        {
            "benchmark": "btc",
            "horizon_minutes": 15,
            "interval_minutes": interval,
            "cutoff_ms": frame["cutoff_ms"],
            "matched_count": 2,
            "expected_count": 2,
            "matched_membership_hash": "b" * 64,
            "metric_ref": add(
                f"breadth_divergence_btc_15_{interval}m",
                "count",
                "breadth_price_divergence",
            ),
        }
        for interval in (5, 15, 60)
    ]
    contributions = []
    for horizon in (5, 15, 60, 1440):
        contributions.append(
            {
                "horizon_minutes": horizon,
                "expected_count": 2,
                "valid_count": 2,
                "start_cohort_available": True,
                "prior_liquidity_weights_available": False,
                "equal_weight_return_ref": add(
                    f"cohort_equal_return_{horizon}",
                    "return_percent",
                    "cohort_equal_weight_return",
                ),
                "capped_liquidity_return_ref": add(
                    f"cohort_capped_liquidity_return_{horizon}",
                    "return_percent",
                    "cohort_capped_liquidity_return",
                ),
                "top5_abs_equal_ref": add(
                    f"contribution_top5_abs_equal_{horizon}",
                    "share_fraction",
                    "return_concentration_abs_top5_equal",
                    "0.5",
                ),
                "top5_abs_capped_ref": add(
                    f"contribution_top5_abs_capped_{horizon}",
                    "share_fraction",
                    "return_concentration_abs_top5_capped_liquidity",
                    "0.5",
                ),
            }
        )
    frame["normalized_breadth"] = normalized
    frame["breadth_trajectory"] = trajectory
    frame["breadth_divergence"] = divergences
    frame["contribution_summaries"] = contributions
    frame["source_capabilities"] = [
        {
            "source_id": "okx.spot_flow",
            "family": "spot_flow",
            "venue_profile": "okx_spot",
            "endpoint": "trades.public",
            "qualification": "not_probed",
            "operational": "unavailable",
            "source_contract_hash": "a" * 64,
            "instrument_ids": frame["universe"]["member_instrument_ids"],
            "units": ["notional_usd"],
            "history_semantics": "venue trade event time",
            "access": "anonymous",
            "cadence_ms": 1000,
            "max_records": 1000,
            "license_basis": "public venue terms",
            "reasons": [],
        }
    ]
    return frame


def with_regime(frame):
    provider = frame["providers"]["observation"]
    regime = {
        "regime_id": "regime-btc-1",
        "instrument_id": frame["assets"][0]["instrument_id"],
        "source_bar_close_ms": frame["cutoff_ms"],
        "origin": "market_observation",
        "producer_id": "market-picture",
        "controller_id": None,
        "regime_label": "up",
        "regime_definition_id": "observed-trend-v1",
        "calibration_status": "unknown",
        "provider_ref": provider,
        "available_at_ms": frame["available_at_ms"],
        "expires_at_ms": frame["expires_at_ms"],
        "source_epoch": provider["epoch"],
        "source_sequence": provider["sequence"],
    }
    frame["regime_observations"] = [regime]
    frame["assets"][0]["regime_refs"] = [regime["regime_id"]]
    return frame


@pytest.mark.parametrize(
    "mutation", ["cross_asset", "provider", "bar", "availability", "expiry"]
)
def test_resealed_regimes_must_bind_asset_provider_and_decision_time(mutation):
    frame = with_regime(fixture())
    validate_frame(seal(frame), allow_fixture=True)
    if mutation == "cross_asset":
        frame["assets"][0]["regime_refs"] = []
        frame["assets"][1]["regime_refs"] = ["regime-btc-1"]
    elif mutation == "provider":
        frame["regime_observations"][0]["provider_ref"] = dict(
            frame["providers"]["observation"], source_digest="a" * 64
        )
    elif mutation == "bar":
        frame["regime_observations"][0]["source_bar_close_ms"] -= 60_000
    elif mutation == "availability":
        frame["regime_observations"][0]["available_at_ms"] += 1
    else:
        frame["regime_observations"][0]["expires_at_ms"] = frame["published_at_ms"]
    with pytest.raises(ValueError, match="regime"):
        validate_frame(seal(frame), allow_fixture=True)


def test_fixture_is_valid_but_cannot_be_selected_as_production():
    frame = fixture()
    assert validate_frame(frame, allow_fixture=True) is frame
    with pytest.raises(ValueError, match="fixture"):
        validate_frame(frame)


def test_optional_flow_reference_requires_component_provenance_and_reason():
    frame = fixture()
    frame["flow_ref"] = {"status": "unavailable", "reason_codes": ["SOURCE_DISABLED"]}
    validate_frame(seal(frame), allow_fixture=True)
    frame["flow_ref"] = {
        "status": "available",
        "snapshot_id": "a" * 64,
        "cutoff_ms": frame["cutoff_ms"],
        "expires_at_ms": frame["expires_at_ms"],
        "reason_codes": [],
    }
    validate_frame(seal(frame), allow_fixture=True)
    for ref in (
        {"status": "available", "reason_codes": []},
        {"status": "unavailable", "reason_codes": []},
    ):
        frame["flow_ref"] = ref
        with pytest.raises(ValueError, match="flow"):
            validate_frame(seal(frame), allow_fixture=True)


@pytest.mark.parametrize("value", [True, "", "NaN", "Infinity", 0])
def test_invalid_metric_is_rejected_even_after_frame_resealing(value):
    frame = fixture()
    frame["metric_series"][0]["cells"][0]["value"] = value
    with pytest.raises(Exception):
        validate_frame(seal(frame), allow_fixture=True)


def test_universe_and_partition_invariants_are_enforced():
    frame = fixture()
    frame["assets"][1]["asset_id"] = frame["assets"][0]["asset_id"]
    with pytest.raises(ValueError, match="duplicate"):
        validate_frame(seal(frame), allow_fixture=True)
    frame = fixture()
    frame["breadth"][0]["valid_count"] = 1
    with pytest.raises(ValueError, match="partition"):
        validate_frame(seal(frame), allow_fixture=True)
    frame = fixture()
    frame["distribution"][0]["counts"][0] += 1
    with pytest.raises(ValueError, match="histogram"):
        validate_frame(seal(frame), allow_fixture=True)


def test_false_finite_claim_does_not_pass_a_unit_bound():
    frame = fixture()
    series = next(s for s in frame["metric_series"] if s["series_unit"] == "rsi_0_100")
    series["cells"][0]["value"] = "101"
    series["cells"][0]["computation_status"] = "VALID"
    series["payload_digest"] = hashlib.sha256(
        canonical(
            _compact_series({k: v for k, v in series.items() if k != "payload_digest"})
        )
    ).hexdigest()
    with pytest.raises(ValueError, match="bounds"):
        validate_frame(seal(frame), allow_fixture=True)


def test_inner_series_hash_survives_outer_frame_resealing():
    frame = fixture()
    frame["metric_series"][0]["cells"][0]["value"] = "12"
    with pytest.raises(ValueError, match="series hash"):
        validate_frame(seal(frame), allow_fixture=True)


def test_float_rounding_cannot_admit_a_fractional_instrument_count():
    frame = fixture()
    metric = frame["market_metrics"][
        frame["breadth"][0]["metric_refs"]["unchanged"]["metric_id"]
    ]
    metric["value"] = metric["value"] + ".0000000000000000001"
    with pytest.raises(ValueError, match="fractional"):
        validate_frame(seal(frame), allow_fixture=True)


@pytest.mark.parametrize(
    "mutation",
    ["summary", "breadth_horizon", "pressure_horizon", "distribution", "comparison"],
)
def test_resealed_wrong_semantic_references_are_rejected(mutation):
    frame = fixture()
    if mutation == "summary":
        frame["summary"]["metric_refs"]["relative_volume_1h"] = frame["breadth"][0][
            "metric_refs"
        ]["advances"]
    elif mutation == "breadth_horizon":
        frame["breadth"][0]["metric_refs"]["advance_share"] = frame["breadth"][1][
            "metric_refs"
        ]["advance_share"]
    elif mutation == "pressure_horizon":
        frame["pressure"][0]["metric_id"] = frame["pressure"][1]["metric_id"]
    elif mutation == "distribution":
        frame["distribution"][0]["definition_ref"]["definition_id"] = "breadth_share"
    else:
        frame["comparisons"]["metric_refs"]["summary/relative_volume_1h"] = frame[
            "comparisons"
        ]["metric_refs"]["summary/trend_strength"]
    with pytest.raises(ValueError, match="semantic|distribution"):
        validate_frame(seal(frame), allow_fixture=True)


def test_both_relative_volume_generations_validate_with_their_own_keys():
    current, legacy = fixture(), legacy_fixture()
    assert "rvol_1h" in current["asset_metric_refs"]
    assert "relative_volume_1h" in current["summary"]["metric_refs"]
    assert "summary/relative_volume_1h" in current["comparisons"]["metric_refs"]
    assert "rvol_24h" in legacy["asset_metric_refs"]
    assert "relative_volume_24h" in legacy["summary"]["metric_refs"]
    assert "summary/relative_volume_24h" in legacy["comparisons"]["metric_refs"]
    assert current["definition_registry_hash"] != legacy["definition_registry_hash"]
    assert validate_frame(current, allow_fixture=True) is current
    assert validate_frame(legacy, allow_fixture=True) is legacy


def mix_asset_refs(frame):
    frame["asset_metric_refs"]["rvol_24h"] = frame["asset_metric_refs"]["rvol_1h"]


def mix_summary_refs(frame):
    refs = frame["summary"]["metric_refs"]
    refs["relative_volume_24h"] = refs.pop("relative_volume_1h")


def mix_comparison_refs(frame):
    refs = frame["comparisons"]["metric_refs"]
    refs["summary/relative_volume_24h"] = refs.pop("summary/relative_volume_1h")


def drop_summary_ref(frame):
    del frame["summary"]["metric_refs"]["relative_volume_1h"]


def wrong_series_definition(frame):
    series = next(
        s for s in frame["metric_series"] if s["metric_id"] == "asset_rvol_1h"
    )
    series["definition_ref"]["definition_id"] = "rvol24h"
    reseal_series(frame, "asset_rvol_1h")


def wrong_summary_definition(frame):
    frame["market_metrics"]["relative_volume_1h"]["definition"][
        "definition_id"
    ] = "median_relative_volume_24h"


@pytest.mark.parametrize(
    "mutation",
    [
        mix_asset_refs,
        mix_summary_refs,
        mix_comparison_refs,
        drop_summary_ref,
        wrong_series_definition,
        wrong_summary_definition,
    ],
)
def test_resealed_frames_cannot_mix_or_misbind_relative_volume_generations(mutation):
    frame = fixture()
    mutation(frame)
    with pytest.raises(ValueError, match="semantic|binding|mix"):
        validate_frame(seal(frame), allow_fixture=True)


def test_legacy_frame_cannot_borrow_current_relative_volume_keys():
    frame = legacy_fixture()
    frame["summary"]["metric_refs"]["relative_volume_1h"] = frame["summary"][
        "metric_refs"
    ].pop("relative_volume_24h")
    with pytest.raises(ValueError, match="mix"):
        validate_frame(seal(frame), allow_fixture=True)


@pytest.mark.parametrize(
    "mutation",
    ["unit_ref", "early_cell", "late_expiry", "binary_predicate", "histogram_shape"],
)
def test_resealed_semantic_contract_violations_are_rejected(mutation):
    frame = fixture()
    series = frame["metric_series"][0]
    if mutation == "unit_ref":
        frame["asset_metric_refs"]["price"] = frame["asset_metric_refs"]["rsi14"]
    elif mutation == "early_cell":
        series["cells"][0]["available_at_ms"] = (
            series["provider_ref"]["available_at_ms"] - 1
        )
    elif mutation == "late_expiry":
        series["cells"][0]["expires_at_ms"] = series["expires_at_ms"] + 1
    elif mutation == "binary_predicate":
        ref = frame["asset_predicate_refs"]["above_ema21"]["metric_id"]
        series = next(s for s in frame["metric_series"] if s["metric_id"] == ref)
        series["cells"][0].update(value="2", computation_status="VALID")
    else:
        frame["distribution"][0]["counts"] = [0] * 39
    series["payload_digest"] = hashlib.sha256(
        canonical(
            _compact_series({k: v for k, v in series.items() if k != "payload_digest"})
        )
    ).hexdigest()
    with pytest.raises(ValueError):
        validate_frame(seal(frame), allow_fixture=True)


def _correlation_read(expected, paired, value):
    return json.dumps(
        {
            "schema_version": "market-picture.v1",
            "snapshot_id": "a" * 64,
            "read_at_ms": 1,
            "items": [
                {
                    "instrument_a_id": "okx:spot:BTC-USDC",
                    "instrument_b_id": "okx:spot:ETH-USDC",
                    "correlation": value,
                    "paired_sample_count": paired,
                    "expected_sample_count": expected,
                    "reason_codes": [] if value else ["INSUFFICIENT_HISTORY"],
                    "trend": [],
                    "window_end_ms": 1,
                }
            ],
        }
    ).encode()


def test_correlation_reads_accept_the_full_window_and_shorter_labelled_windows():
    for hours in sorted(CORRELATION_WINDOW_HOURS):
        row = validate_response("correlations", _correlation_read(hours, hours, "0.5"))
        assert row["items"][0]["expected_sample_count"] == hours
    # An unqualified history stays null with its real sample size, at any window.
    row = validate_response("correlations", _correlation_read(2160, 177, None))
    assert row["items"][0]["paired_sample_count"] == 177


@pytest.mark.parametrize(
    ("expected", "paired", "value"),
    [(100, 100, "0.5"), (168, 120, "0.5"), (2160, 177, "0.5")],
)
def test_correlation_reads_reject_unlisted_windows_and_unqualified_coefficients(
    expected, paired, value
):
    with pytest.raises(ValueError):
        validate_response("correlations", _correlation_read(expected, paired, value))


def test_correlation_windows_map_to_owner_definition_ids():
    assert {
        hours: correlation_definition_id(hours) for hours in CORRELATION_WINDOW_HOURS
    } == {
        24: "pearson_log_1h_24h",
        72: "pearson_log_1h_72h",
        168: "pearson_log_1h_168h",
        336: "pearson_log_1h_336h",
        720: "pearson_log_1h_720h",
        2160: "pearson_log_1h_90d",
    }
    with pytest.raises(ValueError):
        correlation_definition_id(100)


def test_correlation_gate_is_95_percent_of_each_windows_own_hours():
    for hours in sorted(CORRELATION_WINDOW_HOURS):
        gate = -(-hours * 95 // 100)
        validate_response("correlations", _correlation_read(hours, gate, "0.5"))
        with pytest.raises(ValueError, match="unqualified"):
            validate_response("correlations", _correlation_read(hours, gate - 1, "0.5"))


def test_correlation_page_cannot_mix_windows():
    first = json.loads(_correlation_read(168, 168, "0.5"))
    second = json.loads(_correlation_read(2160, 2160, "0.5"))
    first["items"].append(second["items"][0])
    with pytest.raises(ValueError, match="mixes"):
        validate_response("correlations", json.dumps(first).encode())


def _history_read(summary):
    point = {
        "snapshot_id": "a" * 64,
        "cutoff_ms": 60_000,
        "available_at_ms": 61_000,
        "expires_at_ms": 120_000,
        "source_kind": "observed",
        "coverage": {
            "expected_instruments": 2,
            "valid_instruments": 2,
            "omitted_instruments": 0,
            "valid_fraction": "1",
            "aligned_instrument_ids": [],
            "omitted_instrument_ids": [],
            "policy": "newest_fresh_recorded_close.v1",
        },
        "membership_hash": "b" * 64,
        "definition_registry_hash": "c" * 64,
        "breadth": {
            str(h): {"positive": "0.5", "negative": "0.5", "flat": "0", "pressure": "0"}
            for h in (1, 5, 15, 60, 240, 1440)
        },
        "summary": summary,
    }
    return json.dumps(
        {
            "schema_version": "market-picture.v1",
            "snapshot_id": "a" * 64,
            "stream_id": "market-picture",
            "window": "24h",
            "resolution": "1m",
            "items": [point],
            "next_cursor": None,
            "read_at_ms": 1,
        }
    ).encode()


@pytest.mark.parametrize("key", ["relative_volume_24h", "relative_volume_1h"])
def test_history_points_read_either_relative_volume_key(key):
    row = validate_response(
        "history", _history_read({key: "1.2", "trend_strength": None})
    )
    assert row["items"][0]["summary"][key] == "1.2"


def test_history_point_cannot_carry_both_relative_volume_keys():
    both = {"relative_volume_24h": "1", "relative_volume_1h": "1"}
    with pytest.raises(ValueError, match="mixes"):
        validate_response("history", _history_read(both))


@pytest.mark.parametrize(
    "divergence",
    [
        {
            "value": "1",
            "matched_count": 0,
            "expected_count": 2,
            "matched_membership_hash": None,
        },
        {
            "value": "0",
            "matched_count": 0,
            "expected_count": 2,
            "matched_membership_hash": None,
        },
        {
            "value": "2",
            "matched_count": 1,
            "expected_count": 2,
            "matched_membership_hash": "d" * 64,
        },
        {
            "value": "1",
            "matched_count": 1,
            "expected_count": 2,
            "matched_membership_hash": None,
        },
        {
            "value": "1",
            "matched_count": 3,
            "expected_count": 2,
            "matched_membership_hash": "d" * 64,
        },
    ],
)
def test_history_rejects_incoherent_divergence_cohort(divergence):
    payload = json.loads(_history_read({}).decode())
    payload["items"][0]["breadth_divergence"] = {"5": divergence}
    with pytest.raises((ValueError, ValidationError), match="divergence"):
        validate_response("history", json.dumps(payload).encode())


def test_history_accepts_unavailable_divergence_without_a_matched_cohort():
    payload = json.loads(_history_read({}).decode())
    payload["items"][0]["breadth_divergence"] = {
        "5": {
            "value": None,
            "matched_count": 0,
            "expected_count": 2,
            "matched_membership_hash": None,
        }
    }
    result = validate_response("history", json.dumps(payload).encode())
    assert result["items"][0]["breadth_divergence"]["5"]["value"] is None


def test_zero_baseline_rvol_cell_is_a_null_with_its_reason_not_a_value():
    frame = fixture()
    series = next(
        s for s in frame["metric_series"] if s["metric_id"] == "asset_rvol_1h"
    )
    series["cells"][0] = {
        "instrument_id": series["cells"][0]["instrument_id"],
        "computation_status": "UNAVAILABLE",
        "coverage_status": "PARTIAL",
        "reason_codes": ["ZERO_BASELINE"],
        "sample_count": 1500,
    }
    reseal_series(frame, "asset_rvol_1h")
    validate_frame(seal(frame), allow_fixture=True)
    series["cells"][0].pop("reason_codes")
    reseal_series(frame, "asset_rvol_1h")
    with pytest.raises(ValueError):
        validate_frame(seal(frame), allow_fixture=True)


def _unavailable_anomaly(frame, *, omit):
    """The owner may omit null-default counts for an anomaly with no valid instruments."""
    metric = frame["candle_anomalies"]["metrics"]["extreme_realized_volatility_1h_95p"]
    metric["values"] = [None] * len(metric["values"])
    metric["valid_count"] = 0
    metric["reason_codes"] = ["BAR_GAP", "INSUFFICIENT_HISTORY"]
    for key in ("high_count", "share_fraction"):
        if key in omit:
            metric.pop(key, None)
        else:
            metric[key] = None
    return metric


@pytest.mark.parametrize("omit", [(), ("high_count", "share_fraction")])
def test_unavailable_candle_anomaly_accepts_omitted_or_explicit_null_counts(omit):
    frame = fixture("market-picture.m1-components.fixture.json")
    _unavailable_anomaly(frame, omit=omit)
    parsed = validate_frame(seal(frame), allow_fixture=True)
    metric = parsed["candle_anomalies"]["metrics"]["extreme_realized_volatility_1h_95p"]
    assert metric["valid_count"] == 0


@pytest.mark.parametrize("key", ["high_count", "share_fraction"])
def test_available_candle_anomaly_without_counts_is_rejected_as_incoherent(key):
    frame = fixture("market-picture.m1-components.fixture.json")
    frame["candle_anomalies"]["metrics"]["dictionary_rvol_1h_high"].pop(key)
    with pytest.raises(ValueError, match="candle-anomaly"):
        _validate_candle_anomalies(seal(frame))


def test_candle_anomaly_panel_without_sources_may_omit_null_expiry_and_counts():
    frame = fixture("market-picture.m1-components.fixture.json")
    panel = frame["candle_anomalies"]
    for metric in panel["metrics"].values():
        metric.update(
            values=[None] * len(metric["values"]),
            valid_count=0,
            reason_codes=["INSUFFICIENT_HISTORY"],
        )
        metric.pop("high_count", None)
        metric.pop("share_fraction", None)
    panel["source_count"] = 0
    panel.pop("expires_at_ms", None)
    _validate_candle_anomalies(seal(frame))


@pytest.mark.parametrize("family", ["breadth_trajectory", "breadth_divergence"])
def test_matched_cohort_requires_its_membership_hash_even_when_compacted(family):
    frame = fixture("market-picture.m1-components.fixture.json")
    row = next(row for row in frame[family] if row["matched_count"] > 0)
    row.pop("matched_membership_hash")
    with pytest.raises(ValueError, match="cohort differs from universe"):
        validate_frame(seal(frame), allow_fixture=True)
