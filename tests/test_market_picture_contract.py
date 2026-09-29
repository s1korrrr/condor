import copy
import hashlib
import json
from pathlib import Path

import pytest

from condor.web.market_picture_contract import (
    _compact_series,
    canonical,
    validate_frame,
)


def fixture():
    return json.loads(
        Path(__file__)
        .with_name("fixtures")
        .joinpath("market-picture.v1.json")
        .read_text()
    )


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
        frame["summary"]["metric_refs"]["relative_volume_24h"] = frame["breadth"][0][
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
        frame["comparisons"]["metric_refs"]["summary/relative_volume_24h"] = frame[
            "comparisons"
        ]["metric_refs"]["summary/trend_strength"]
    with pytest.raises(ValueError, match="semantic|distribution"):
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
