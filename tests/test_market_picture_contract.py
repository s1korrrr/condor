import copy
import hashlib
import json
from pathlib import Path

import pytest

from condor.web.market_picture_contract import (
    CORRELATION_WINDOW_HOURS,
    _compact_series,
    canonical,
    correlation_definition_id,
    validate_frame,
    validate_response,
)


def fixture(name="market-picture.v1.json"):
    return json.loads(
        Path(__file__).with_name("fixtures").joinpath(name).read_text()
    )


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
    series = next(s for s in frame["metric_series"] if s["metric_id"] == "asset_rvol_1h")
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
    assert {hours: correlation_definition_id(hours) for hours in CORRELATION_WINDOW_HOURS} == {
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
    row = validate_response("history", _history_read({key: "1.2", "trend_strength": None}))
    assert row["items"][0]["summary"][key] == "1.2"


def test_history_point_cannot_carry_both_relative_volume_keys():
    both = {"relative_volume_24h": "1", "relative_volume_1h": "1"}
    with pytest.raises(ValueError, match="mixes"):
        validate_response("history", _history_read(both))


def test_zero_baseline_rvol_cell_is_a_null_with_its_reason_not_a_value():
    frame = fixture()
    series = next(s for s in frame["metric_series"] if s["metric_id"] == "asset_rvol_1h")
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
