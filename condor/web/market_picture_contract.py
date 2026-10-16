"""Market Picture's presentation boundary, with no execution-package import.

The checked-in JSON Schema is generated from the owner contract. This module
adds content hashes and cross-record invariants which JSON Schema cannot express.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from decimal import Decimal, localcontext
from fractions import Fraction
from functools import lru_cache
from pathlib import Path

from jsonschema import Draft202012Validator

MAX_BYTES = 2 * 1024 * 1024
HORIZONS = [1, 5, 15, 60, 240, 1440]
CANONICAL_HISTORY_HORIZONS = tuple(str(horizon) for horizon in HORIZONS)
CANONICAL_HISTORY_POINTS = 361
RELATIVE_RETURN_DEFINITION_HASH = (
    "54936e39a1c8ba50b1226d16efd45aa683165fe82a958e9b577f2856849f3259"
)
CANDLE_ANOMALY_DEFINITION_HASHES = {
    "dictionary_rvol_1h_high": "a135842c5f5f1b10ab1c00409120df65075433b4f886a9e2accc104e7dcd4a53",
    "bollinger_inside_ema_atr_compression_1h": "6ddb769fd95517e7b72809bf771aca5774eb16007b7611212f8c48b2ce0ae9e4",
    "extreme_realized_volatility_1h_95p": "2c2911d4a45369b6143b7f9616bb9c94b0307216447383b1327db26704460e9c",
}
_COMMON_ASSET_UNITS = {
    "price": "price_quote",
    "ema21": "price_quote",
    "rsi14": "rsi_0_100",
    "adx14": "adx_0_100",
    "atr14_percent": "atr_percent",
    "atr14_percentile": "percentile_0_100",
    "rvol20": "ratio",
    "realized_volatility_24h": "volatility_fraction_annualized",
    **{f"return_{h}m": "return_percent" for h in [*HORIZONS, 10080]},
    **{f"relative_24h_{b}": "percentage_points" for b in ["btc", "eth", "bnb", "sol"]},
}
# Relative-volume generations. Frames stored before the hourly definition carry the single-minute
# ``rvol_24h`` keys; they stay readable (immutable history) while new frames use ``rvol_1h``.
# A frame belongs to exactly one generation: asset, summary and comparison keys never mix.
RVOL_GENERATIONS = {
    "current": {
        "asset_key": "rvol_1h",
        "asset_series": "asset_rvol_1h",
        "asset_definition": "rvol1h",
        "summary_key": "relative_volume_1h",
        "summary_definition": "median_relative_volume_1h",
    },
    "legacy": {
        "asset_key": "rvol_24h",
        "asset_series": "asset_rvol_24h",
        "asset_definition": "rvol24h",
        "summary_key": "relative_volume_24h",
        "summary_definition": "median_relative_volume_24h",
    },
}
PREDICATES = [
    "above_ema21",
    "compression",
    "elevated_rvol",
    "high_volatility",
    "rsi_above_50",
    "rsi_above_70",
    "rsi_below_30",
    "trending",
]
_COMMON_SUMMARY_BINDINGS = {
    "market_participation": ("market_participation", "share_fraction", "above_ema21"),
    "trend_strength": ("trend_strength", "adx_0_100", "mean_adx14"),
    "realized_volatility_24h": (
        "realized_volatility_24h",
        "volatility_fraction_annualized",
        "median_realized_volatility_24h",
    ),
    "new_highs_24h": ("new_highs_24h", "instruments", "market_high_break_count_24h"),
    "new_lows_24h": ("new_lows_24h", "instruments", "market_low_break_count_24h"),
    "highs_52w": ("highs_52w", "instruments", "market_high_break_count_52w"),
    "lows_52w": ("lows_52w", "instruments", "market_low_break_count_52w"),
    "coverage": ("coverage", "share_fraction", "instrument_coverage"),
    "above_ema21": (
        "participation_above_ema21",
        "share_fraction",
        "above_ema21_membership",
    ),
}
BREADTH_BINDINGS = {
    **{
        key: ("instruments", "breadth_instrument_count")
        for key in ("advances", "declines", "unchanged")
    },
    **{
        key: ("share_fraction", "breadth_share")
        for key in ("advance_share", "decline_share", "unchanged_share")
    },
    "mean_return": ("return_percent", "breadth_return_mean"),
    "median_return": ("return_percent", "breadth_return_median"),
    "dispersion": ("percentage_points", "breadth_return_dispersion"),
    "downside_magnitude": ("return_percent", "breadth_downside_magnitude"),
}
PARTICIPATION_DEFINITIONS = {
    "above_ema21": "above_ema21_membership",
    "compression": "atr14_compression_p20_membership",
    "elevated_rvol": "rvol20_above_1_5_membership",
    "high_volatility": "rv24h_above_80pct_membership",
    "rsi_above_50": "rsi_above_50_membership",
    "rsi_above_70": "rsi_above_70_membership",
    "rsi_below_30": "rsi_below_30_membership",
    "trending": "adx14_above_25_membership",
}
# Hourly-return windows the owner may publish: the full 90 days, or a shorter window while that much
# history exists (7D when seven days are stored). Every coefficient must still have >= 95% paired
# samples of its own window, so a short history is labelled with its real size, never padded.
CORRELATION_WINDOW_HOURS = frozenset({24, 72, 168, 336, 720, 2160})


def correlation_definition_id(window_hours: int) -> str:
    """Owner definition id of an allowed window; the 90D window keeps its original id."""
    if window_hours not in CORRELATION_WINDOW_HOURS:
        raise ValueError("correlation sample window is invalid")
    return (
        "pearson_log_1h_90d"
        if window_hours == 2160
        else f"pearson_log_1h_{window_hours}h"
    )


def rvol_generation(frame) -> dict:
    """The relative-volume generation a frame was published under, from its asset bindings."""
    refs = frame["asset_metric_refs"]
    present = [
        name for name, row in RVOL_GENERATIONS.items() if row["asset_key"] in refs
    ]
    if len(present) != 1:
        raise ValueError("invalid semantic binding keys")
    return RVOL_GENERATIONS[present[0]]


def _validate_source_capabilities(rows):
    ids = [row["source_id"] for row in rows]
    if ids != sorted(set(ids)):
        raise ValueError("source capabilities must be sorted and unique")
    for row in rows:
        if row["access"] != "anonymous" or row["family"] == "private_exposure":
            raise ValueError(
                "private source metadata cannot enter the public market frame"
            )
        if row["qualification"] == "not_probed" and (
            row.get("probe_receipt_hash") is not None or row["operational"] == "healthy"
        ):
            raise ValueError("unprobed capability cannot claim a healthy probe")
        if (
            row["qualification"] not in {"not_probed", "not_qualified"}
            and row.get("probe_receipt_hash") is None
        ):
            raise ValueError("qualified capability lacks probe receipt")
        if (
            row["qualification"] in {"collecting", "qualified"}
            and row.get("collection_receipt_hash") is None
        ):
            raise ValueError("collection capability lacks receipt")
        if row["qualification"] == "qualified" and (
            row.get("qualification_receipt_hash") is None
            or row.get("qualification_contract_hash") != row["source_contract_hash"]
        ):
            raise ValueError("qualified capability lacks a contract-bound receipt")
        if row["qualification"] == "not_qualified" and not row["reasons"]:
            raise ValueError("unqualified capability needs evidence limits")
        if (row.get("probe_receipt_hash") is None) != (row.get("probed_at_ms") is None):
            raise ValueError("probe time and receipt must occur together")
        if (row.get("collection_receipt_hash") is None) != (
            row.get("collected_at_ms") is None
        ):
            raise ValueError("collection time and receipt must occur together")
        if (row.get("qualification_receipt_hash") is None) != (
            row.get("qualified_at_ms") is None
        ):
            raise ValueError("qualification time and receipt must occur together")
        probed, collected, qualified = (
            row.get("probed_at_ms"),
            row.get("collected_at_ms"),
            row.get("qualified_at_ms"),
        )
        if (collected is not None and probed is not None and collected < probed) or (
            qualified is not None and collected is not None and qualified < collected
        ):
            raise ValueError("source capability receipt chronology is inconsistent")


def _validate_microstructure(frame):
    component = frame.get("microstructure")
    if component is None:
        return
    if (
        component["schema_version"] != "market-picture.microstructure.v1"
        or component["source_kind"] != frame["source_kind"]
        or component["cutoff_ms"] != frame["cutoff_ms"]
        or component["available_at_ms"] > frame["available_at_ms"]
        or component["replay_class"] != "snapshot_only"
        or component["raw_inputs_retained"] is not False
        or component["component_id"] != _digest(component, "component_id")
    ):
        raise ValueError("microstructure component provenance or digest mismatch")
    capabilities = {
        row["source_id"]: row for row in frame.get("source_capabilities", [])
    }
    members = set(frame["universe"]["member_instrument_ids"])
    flows = component["flows"]
    flow_keys = [(row["instrument_id"], row["source_id"]) for row in flows]
    if flow_keys != sorted(set(flow_keys)):
        raise ValueError("microstructure flow rows must be sorted and unique")
    for row in flows:
        capability = capabilities.get(row["source_id"])
        if (
            row["instrument_id"] not in members
            or capability is None
            or capability["family"] != "spot_flow"
            or capability["source_contract_hash"] != row["source_contract_hash"]
            or capability["qualification"] != "qualified"
            or capability["operational"] != "healthy"
            or capability["access"] != "anonymous"
            or row["instrument_id"] not in capability["instrument_ids"]
            or row["quote_asset"] != frame["universe"]["selected_numeraire"]
            or row["window_end_ms"] != component["cutoff_ms"]
            or row["window_end_ms"] - row["window_start_ms"] != 60_000
            or row["window_end_ms"] % 60_000
            or row["available_at_ms"] < row["window_end_ms"]
            or row["available_at_ms"] > component["available_at_ms"]
            or row["available_at_ms"] > frame["available_at_ms"]
            or row["expires_at_ms"] <= row["available_at_ms"]
        ):
            raise ValueError(
                "microstructure flow lacks qualified source or valid decision-time bounds"
            )
        if (
            not _HASH.fullmatch(row["input_digest"])
            or row["reset_at_ms"] > row["window_start_ms"]
            or row["coverage_start_ms"] > row["coverage_end_ms"]
            or row["coverage_end_ms"] > row["available_at_ms"]
        ):
            raise ValueError(
                "microstructure flow input or coverage provenance is invalid"
            )
        prior_end = row["window_start_ms"] - 1
        for left, right in row["gap_intervals"]:
            if (
                not row["window_start_ms"] <= left < right <= row["window_end_ms"]
                or left <= prior_end
            ):
                raise ValueError(
                    "microstructure flow gaps are not ordered within the window"
                )
            prior_end = right
        if (
            row["complete"] != ("INCOMPLETE_STREAM" not in row["reason_codes"])
            or row["complete"]
            and (
                row["gap_intervals"]
                or row["coverage_start_ms"] > row["window_start_ms"]
                or row["coverage_end_ms"] < row["window_end_ms"]
            )
        ):
            raise ValueError("microstructure flow completeness contradicts coverage")
        buy, sell, unknown = (
            Decimal(row[key]) for key in ("buy_quote", "sell_quote", "unknown_quote")
        )
        if min(buy, sell, unknown) < 0:
            raise ValueError("negative microstructure flow notional")
        for key in ("known_imbalance", "confirmation_imbalance"):
            if row[key] is not None and not Decimal("-1") <= Decimal(
                row[key]
            ) <= Decimal("1"):
                raise ValueError("microstructure imbalance outside [-1,1]")
        if row["confirmation_imbalance"] is not None and (
            not row["complete"] or unknown != 0 or row["reason_codes"]
        ):
            raise ValueError("unqualified flow cannot confirm price")
        if row["cumulative_delta_quote"] is not None:
            if (
                row["cumulative_delta_before_quote"] is None
                or row["reason_codes"]
                or not row["complete"]
                or unknown != 0
                or Decimal(row["cumulative_delta_quote"])
                != Decimal(row["cumulative_delta_before_quote"]) + buy - sell
            ):
                raise ValueError(
                    "flow cumulative delta does not reconcile across a complete window"
                )
    books = component["liquidity"]
    book_keys = [
        (
            row["instrument_id"],
            row["source_id"],
            row["side"],
            row["size_unit"],
            row["requested_size"],
        )
        for row in books
    ]
    if book_keys != sorted(set(book_keys)):
        raise ValueError("microstructure liquidity rows must be sorted and unique")
    for row in books:
        capability = capabilities.get(row["source_id"])
        if (
            row["instrument_id"] not in members
            or capability is None
            or capability["family"] != "spot_liquidity"
            or capability["source_contract_hash"] != row["source_contract_hash"]
            or capability["qualification"] != "qualified"
            or capability["operational"] != "healthy"
            or capability["access"] != "anonymous"
            or row["instrument_id"] not in capability["instrument_ids"]
            or row["available_at_ms"] < row["observed_at_ms"]
            or row["available_at_ms"] > component["available_at_ms"]
            or row["available_at_ms"] > frame["available_at_ms"]
            or row["observed_at_ms"] > frame["cutoff_ms"]
            or row["expires_at_ms"] <= row["observed_at_ms"]
        ):
            raise ValueError(
                "microstructure book lacks qualified source or valid decision-time bounds"
            )
        if not _HASH.fullmatch(row["input_digest"]):
            raise ValueError("microstructure book input digest is invalid")
        size, uncovered = Decimal(row["requested_size"]), Decimal(row["uncovered_size"])
        if size <= 0 or not Decimal("0") <= uncovered <= size:
            raise ValueError("invalid microstructure requested or uncovered size")
        base, quote = Decimal(row["covered_base"]), Decimal(row["covered_quote"])
        if row["access_basis"] == "unknown" and (
            base
            or quote
            or row["covered_vwap"] is not None
            or row["vwap"] is not None
            or row["cost_bps"] is not None
            or row["spread_bps"] is not None
            or row["band_complete"]
            or row["band_imbalance"] is not None
            or Decimal(row["band_bid_covered_quote"])
            or Decimal(row["band_ask_covered_quote"])
        ):
            raise ValueError(
                "unknown book access cannot qualify visible execution or depth"
            )
        covered = base if row["size_unit"] == "base" else quote
        if not _reconciles(covered + uncovered, size):
            raise ValueError(
                "microstructure covered and uncovered quantities do not reconcile"
            )
        if (base == 0) != (quote == 0) or (base == 0) != (row["covered_vwap"] is None):
            raise ValueError(
                "microstructure covered VWAP requires positive covered quantities"
            )
        if row["covered_vwap"] is not None and (
            Decimal(row["covered_vwap"]) <= 0
            or not _reconciles(Decimal(row["covered_vwap"]), quote / base)
        ):
            raise ValueError("microstructure covered VWAP does not reconcile")
        if uncovered == 0 and (
            row["vwap"] is None
            or row["cost_bps"] is None
            or row["covered_vwap"] is None
            or Decimal(row["vwap"]) <= 0
            or not _reconciles(Decimal(row["vwap"]), Decimal(row["covered_vwap"]))
        ):
            raise ValueError(
                "full-size microstructure cost requires its covered VWAP and cost"
            )
        if uncovered > 0 and any(
            row[key] is not None for key in ("vwap", "cost_bps", "total_cost_bps")
        ):
            raise ValueError("partial depth cannot describe full-size execution cost")
        if row["cost_bps"] is not None and (
            Decimal(row["cost_bps"]) < 0
            or row["side"] == "sell"
            and Decimal(row["cost_bps"]) >= 10_000
        ):
            raise ValueError("microstructure cost is outside its side-specific range")
        if (
            row["spread_bps"] is not None
            and not 0 < Decimal(row["spread_bps"]) < 20_000
        ):
            raise ValueError(
                "microstructure spread is outside its positive-price range"
            )
        if row["fee_bps"] is not None and not 0 <= Decimal(row["fee_bps"]) <= 10_000:
            raise ValueError("microstructure fee is outside [0,10000] bps")
        if row["fee_bps"] is None and (
            row["fee_source"] is not None or row["total_cost_bps"] is not None
        ):
            raise ValueError("total cost requires fee provenance")
        if row["fee_bps"] is not None and not row["fee_source"]:
            raise ValueError("known fee lacks provenance")
        if row["fee_bps"] is not None and row["cost_bps"] is not None:
            cost, fee = Decimal(row["cost_bps"]), Decimal(row["fee_bps"])
            price_ratio = (
                1 + cost / 10_000 if row["side"] == "buy" else 1 - cost / 10_000
            )
            if row["total_cost_bps"] is None or not _reconciles(
                Decimal(row["total_cost_bps"]), cost + fee * price_ratio
            ):
                raise ValueError(
                    "microstructure total cost does not reconcile with quote fee"
                )
        elif row["total_cost_bps"] is not None:
            raise ValueError(
                "microstructure total cost requires full-size cost and fee"
            )
        bid, ask = Decimal(row["band_bid_covered_quote"]), Decimal(
            row["band_ask_covered_quote"]
        )
        if min(bid, ask) < 0 or not 0 < Decimal(row["band_bps"]) <= 10_000:
            raise ValueError("invalid microstructure depth band")
        if not row["band_complete"] and row["band_imbalance"] is not None:
            raise ValueError("partial book band cannot describe band imbalance")
        expected_band = (
            None
            if not row["band_complete"] or bid + ask == 0
            else (bid - ask) / (bid + ask)
        )
        if (row["band_imbalance"] is None) != (expected_band is None) or (
            expected_band is not None
            and (
                not -1 <= Decimal(row["band_imbalance"]) <= 1
                or not _reconciles(Decimal(row["band_imbalance"]), expected_band)
            )
        ):
            raise ValueError("microstructure band imbalance does not reconcile")
        percentile = row.get("cost_percentile_7d")
        percentile_samples = row.get("cost_percentile_sample_count", 0)
        percentile_expected = row.get("cost_percentile_expected_samples", 10080)
        percentile_reasons = row.get(
            "cost_percentile_reason_codes",
            ["INSUFFICIENT_HISTORY"] if percentile is None else [],
        )
        percentile_reference = row.get("cost_percentile_reference_digest")
        if percentile is not None:
            if (
                not 0 <= Decimal(percentile) <= 1
                or row["access_basis"] == "unknown"
                or row["cost_bps"] is None
                or percentile_samples < 9072
                or percentile_expected != 10080
                or percentile_reasons
                or percentile_reference is None
                or not _HASH.fullmatch(percentile_reference)
            ):
                raise ValueError(
                    "book cost percentile lacks comparable qualified history"
                )
        elif not percentile_reasons or percentile_expected != 10080:
            raise ValueError(
                "unavailable book cost percentile requires its expected sample count and reason"
            )
    flow_ref = frame.get("flow_ref", {})
    if flow_ref.get("status") == "available" and (
        not flows or flow_ref.get("snapshot_id") != component["component_id"]
    ):
        raise ValueError(
            "flow reference does not identify the embedded observation component"
        )


def _validate_microstructure_reference(frame):
    reference = frame.get("microstructure_ref")
    if reference is None:
        return
    if frame.get("microstructure") is not None or frame.get("source_capabilities"):
        raise ValueError("microstructure companion cannot coexist with inline content")
    if reference["status"] == "available":
        if (
            not _HASH.fullmatch(reference.get("component_id") or "")
            or reference["reason_codes"]
            or any(
                reference.get(key) != frame[key]
                for key in ("cutoff_ms", "available_at_ms")
            )
            or reference.get("expires_at_ms") is None
            or not 0 <= reference["expires_at_ms"] <= frame["expires_at_ms"]
        ):
            raise ValueError("microstructure reference does not match its frame")
    elif (
        not reference["reason_codes"]
        or any(
            reference.get(key) is not None
            for key in ("component_id", "cutoff_ms", "available_at_ms", "expires_at_ms")
        )
        or frame.get("flow_ref", {}).get("status") == "available"
    ):
        raise ValueError("unavailable microstructure reference carries an identity")


def _validate_microstructure_response(payload):
    companion = payload["companion"]
    scope = companion["scope"]
    if (
        companion["component_id"] != _digest(companion, "component_id")
        or scope["stream_id"] != payload["stream_id"]
        or not scope["cutoff_ms"] <= scope["available_at_ms"] < scope["expires_at_ms"]
        or scope["cutoff_ms"] % 60_000
        or scope["member_instrument_ids"] != sorted(set(scope["member_instrument_ids"]))
    ):
        raise ValueError("microstructure companion digest, scope or timing is invalid")
    _validate_source_capabilities(companion["capabilities"])
    for capability in companion["capabilities"]:
        if any(
            capability.get(key) is not None
            and capability[key] > scope["available_at_ms"]
            for key in ("probed_at_ms", "collected_at_ms", "qualified_at_ms")
        ):
            raise ValueError(
                "source capability receipt occurs after companion decision time"
            )
    _validate_microstructure(
        {
            **scope,
            "universe": {
                "member_instrument_ids": scope["member_instrument_ids"],
                "selected_numeraire": scope["selected_numeraire"],
            },
            "source_capabilities": companion["capabilities"],
            "microstructure": companion["microstructure"],
        }
    )


def _validate_relative_strength_changes(frame):
    changes = frame.get("relative_strength_changes")
    if changes is None:
        return
    ids = [asset["instrument_id"] for asset in frame["assets"]]
    deltas = changes["rank_deltas"]
    reasons = changes.get("reason_codes", [])
    if (
        changes["current_cutoff_ms"] != frame["cutoff_ms"]
        or changes.get("interval_ms", 3_600_000) != 3_600_000
        or changes.get("definition_id", "relative_return") != "relative_return"
        or changes["definition_hash"] != RELATIVE_RETURN_DEFINITION_HASH
        or changes["expected_count"] != len(ids)
        or len(deltas) != len(ids)
        or changes["valid_count"] != sum(value is not None for value in deltas)
        or changes["valid_count"] > changes["expected_count"]
    ):
        raise ValueError(
            "relative-strength rank projection differs from its owner contract"
        )
    if changes.get("baseline_snapshot_id") is None:
        if (
            changes.get("baseline_cutoff_ms") is not None
            or changes.get("source_hash") is not None
            or changes.get("cohort_hash") is not None
            or changes["valid_count"] != 0
            or not reasons
            or any(value is not None for value in deltas)
        ):
            raise ValueError(
                "rank change without a baseline must be explicitly unavailable"
            )
        return
    if changes.get("baseline_cutoff_ms") is None or changes.get("source_hash") is None:
        raise ValueError("rank change baseline requires exact time and source identity")
    if changes["valid_count"] == changes["expected_count"]:
        if (
            changes["baseline_cutoff_ms"]
            != changes["current_cutoff_ms"] - changes.get("interval_ms", 3_600_000)
            or changes.get("cohort_hash") is None
            or reasons
            or any(
                not isinstance(value, int) or abs(value) >= changes["expected_count"]
                for value in deltas
            )
            or sum(deltas) != 0
        ):
            raise ValueError(
                "complete relative-strength ranks need an exact one-hour permutation"
            )
        cohort_hash = hashlib.sha256(canonical(sorted(ids))).hexdigest()
        if changes.get("cohort_hash") != cohort_hash:
            raise ValueError(
                "relative-strength rank cohort differs from the frozen universe"
            )
    elif changes["valid_count"] == 0:
        if (
            changes.get("cohort_hash") is not None
            or not reasons
            or any(value is not None for value in deltas)
        ):
            raise ValueError(
                "unavailable relative-strength rank needs a reason and null vector"
            )
    else:
        raise ValueError("partial-cohort relative-strength ranks are not published")


def _validate_candle_anomalies(frame):
    anomalies = frame.get("candle_anomalies")
    if anomalies is None:
        return
    ids = frame["universe"]["member_instrument_ids"]
    expected = len(ids)
    cutoff = frame["cutoff_ms"] // 3_600_000 * 3_600_000
    if (
        anomalies["interval_ms"] != 3_600_000
        or anomalies["cutoff_ms"] != cutoff
        or anomalies["decision_available_at_ms"] != frame["available_at_ms"]
        or anomalies["cutoff_ms"] > anomalies["decision_available_at_ms"]
        or anomalies["source_kind"] != frame["source_kind"]
        or not _HASH.fullmatch(anomalies["source_hash"])
        or anomalies["expected_count"] != expected
        or not 0 <= anomalies["source_count"] <= expected
        or (anomalies["source_count"] == 0) != (anomalies.get("expires_at_ms") is None)
        or (
            anomalies.get("expires_at_ms") is not None
            and anomalies["expires_at_ms"] <= frame["available_at_ms"]
        )
    ):
        raise ValueError(
            "candle-anomaly source identity, timing or coverage differs from the frame"
        )
    metrics = anomalies["metrics"]
    if set(metrics) != set(CANDLE_ANOMALY_DEFINITION_HASHES):
        raise ValueError(
            "candle-anomaly metric dictionary differs from its owner contract"
        )
    contributing_instruments = set()
    for metric_id, definition_hash in CANDLE_ANOMALY_DEFINITION_HASHES.items():
        metric = metrics[metric_id]
        if (
            metric["definition_id"] != metric_id
            or metric["definition_hash"] != definition_hash
            or metric["expected_count"] != expected
            or not 0 <= metric["valid_count"] <= expected
            or len(metric["values"]) != expected
            or any(
                value not in (None, 0, 1) or isinstance(value, bool)
                for value in metric["values"]
            )
            or metric["valid_count"]
            != sum(value is not None for value in metric["values"])
        ):
            raise ValueError("candle-anomaly definition, vector or coverage is invalid")
        contributing_instruments.update(
            ids[index]
            for index, value in enumerate(metric["values"])
            if value is not None
        )
        high_count = sum(value == 1 for value in metric["values"] if value is not None)
        reasons = metric.get("reason_codes", [])
        if (
            len(reasons) > 8
            or len(set(reasons)) != len(reasons)
            or reasons != sorted(reasons)
            or any(
                not isinstance(reason, str)
                or not re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", reason)
                for reason in reasons
            )
        ):
            raise ValueError("candle-anomaly reason codes are invalid")
        # Schema defaults: the owner omits null counts when no instrument is valid.
        high, share_fraction = metric.get("high_count"), metric.get("share_fraction")
        if metric["valid_count"] == 0:
            if high is not None or share_fraction is not None or not reasons:
                raise ValueError(
                    "unavailable candle anomaly must remain null with a reason"
                )
        else:
            if share_fraction is None:
                raise ValueError(
                    "candle-anomaly count, share or missingness is incoherent"
                )
            _decimal(share_fraction)
            share = Decimal(share_fraction)
            if (
                type(high) is not int
                or high != high_count
                or high > metric["valid_count"]
                or not Decimal(0) <= share <= Decimal(1)
                or share != Decimal(high_count) / Decimal(metric["valid_count"])
                or (metric["valid_count"] < expected) != bool(reasons)
            ):
                raise ValueError(
                    "candle-anomaly count, share or missingness is incoherent"
                )
    if anomalies["source_count"] != len(contributing_instruments):
        raise ValueError(
            "candle-anomaly source coverage differs from contributing instruments"
        )


_DECIMAL = re.compile(r"^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$")
_HASH = re.compile(r"^[0-9a-f]{64}$")
_SCHEMA = json.loads(Path(__file__).with_name("market_picture.schema.json").read_text())
Draft202012Validator.check_schema(_SCHEMA)
_FRAME = Draft202012Validator(_SCHEMA)
_RESPONSE_SCHEMAS = json.loads(
    Path(__file__).with_name("market_picture_responses.schema.json").read_text()
)
for _schema in _RESPONSE_SCHEMAS.values():
    Draft202012Validator.check_schema(_schema)
_RESPONSES = {
    name: Draft202012Validator(schema) for name, schema in _RESPONSE_SCHEMAS.items()
}


def canonical(value) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False
    ).encode("utf-8")


def _digest(value, *exclude) -> str:
    return hashlib.sha256(
        canonical({k: v for k, v in value.items() if k not in exclude})
    ).hexdigest()


def _compact_series(value):
    if isinstance(value, dict):
        compact = {
            key: _compact_series(item)
            for key, item in value.items()
            if item is not None and not (key == "fixture_only" and item is False)
        }
        if isinstance(compact.get("cells"), list):
            defaults = {
                "computation_status": "VALID",
                "coverage_status": "COMPLETE",
                "reason_codes": [],
            }
            compact["cells"] = [
                {
                    key: item
                    for key, item in cell.items()
                    if key not in defaults or item != defaults[key]
                }
                if isinstance(cell, dict)
                else cell
                for cell in compact["cells"]
            ]
        return compact
    if isinstance(value, list):
        return [_compact_series(item) for item in value]
    return value


def _object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate JSON key")
        value[key] = item
    return value


def _decimal(value) -> float:
    if not isinstance(value, str) or len(value) > 128 or not _DECIMAL.fullmatch(value):
        raise ValueError("noncanonical decimal")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("nonfinite decimal")
    return number


def _validate_canonical_history(payload: dict) -> None:
    """Validate canonical replay rows without treating incomplete history as an error.

    Completeness is decision-frame-specific and belongs to the browser consumer. This
    gateway checks typed provenance and numeric bounds, while preserving owner gaps/nulls.
    """
    rows = payload["items"]
    if len(rows) > CANONICAL_HISTORY_POINTS:
        raise ValueError("canonical history exceeds its bounded row count")
    previous = -1
    snapshots = set()
    for row in rows:
        cutoff, available = row["cutoff_ms"], row["available_at_ms"]
        if cutoff <= previous or available < cutoff:
            raise ValueError("canonical history clocks are not ordered")
        previous = cutoff
        if row["snapshot_id"] in snapshots:
            raise ValueError("canonical history repeats a source snapshot")
        snapshots.add(row["snapshot_id"])
        coverage = row["coverage"]
        valid, expected = (
            coverage["valid_instruments"],
            coverage["expected_instruments"],
        )
        if not 1 <= expected <= 300 or not 0 <= valid <= expected:
            raise ValueError("canonical history coverage is invalid")
        if set(row["breadth"]) != set(CANONICAL_HISTORY_HORIZONS):
            raise ValueError("canonical history horizons are incomplete")
        for values in row["breadth"].values():
            pressure = values["pressure"]
            if pressure is not None and not Decimal(-3) <= Decimal(pressure) <= Decimal(
                3
            ):
                raise ValueError("canonical history pressure exceeds its owner scale")


def _exact_member_median(values, instrument_ids):
    """Return the exact full-cohort median, or None when any member is absent."""
    if set(values) != set(instrument_ids) or not instrument_ids:
        return None
    try:
        parsed = [
            Decimal(str(values[instrument_id])) for instrument_id in instrument_ids
        ]
    except (ArithmeticError, TypeError, ValueError):
        return None
    if any(not value.is_finite() for value in parsed):
        return None
    parsed.sort()
    middle = len(parsed) // 2
    if len(parsed) % 2:
        return parsed[middle]
    midpoint = (Fraction(parsed[middle - 1]) + Fraction(parsed[middle])) / 2
    with localcontext() as context:
        context.prec = max(
            28,
            len(str(abs(midpoint.numerator))) + len(str(midpoint.denominator)) + 4,
        )
        return Decimal(midpoint.numerator) / Decimal(midpoint.denominator)


def _cohort_window_start_ms(cutoff_ms: int, horizon_minutes: int) -> int:
    """Match the owner frame's non-negative return-window boundary."""
    return max(0, cutoff_ms - horizon_minutes * 60_000)


def _reconciles(actual: Decimal, expected: Decimal) -> bool:
    return abs(actual - expected) <= max(abs(actual), abs(expected)) * Decimal("1e-24")


def _metric(metric, unit=None):
    value = metric.get("value")
    if (metric.get("computation_status") == "VALID") != (value is not None):
        raise ValueError("invalid metric null semantics")
    reasons = metric.get("reason_codes", [])
    if reasons != sorted(set(reasons)) or (value is None and not reasons):
        raise ValueError("metric reasons must be explicit and canonical")
    if value is None:
        return None
    number = _decimal(value)
    unit = metric.get("unit", unit)
    if (
        unit in {"count", "instruments"}
        and Decimal(value) != Decimal(value).to_integral_value()
    ):
        raise ValueError("fractional count observation")
    bounds = {
        "share_fraction": (0, 1),
        "rsi_0_100": (0, 100),
        "adx_0_100": (0, 100),
        "percentile_0_100": (0, 100),
        "correlation_minus1_to1": (-1, 1),
        "index_minus3_to3": (-3, 3),
        "index_minus1_to1": (-1, 1),
    }
    if unit in bounds and not bounds[unit][0] <= number <= bounds[unit][1]:
        raise ValueError("metric outside declared unit bounds")
    if (
        unit
        in {
            "price_quote",
            "volume_quote",
            "quote_volume",
            "ratio",
            "volatility_fraction_annualized",
            "instruments",
            "count",
            "milliseconds",
        }
        and number < 0
    ):
        raise ValueError("negative unsigned metric")
    return number


def _require_binding(metrics, actual_id, expected_id, unit, definition_id):
    metric = metrics.get(actual_id)
    if (
        actual_id != expected_id
        or metric is None
        or metric["unit"] != unit
        or metric["definition"]["definition_id"] != definition_id
    ):
        raise ValueError("semantic metric binding mismatch")


def _timing(metric, provider, series=None):
    series = metric if series is None else series
    available = metric.get("available_at_ms")
    if available is None:
        available = series["available_at_ms"]
    expires = metric.get("expires_at_ms")
    if expires is None:
        expires = series["expires_at_ms"]
    end = metric.get("window_end_ms")
    if end is None:
        end = series.get("window_end_ms")
    if (
        not provider["available_at_ms"]
        <= available
        < expires
        <= provider["expires_at_ms"]
        or expires > series["expires_at_ms"]
        or (end is not None and end > available)
    ):
        raise ValueError("metric effective timing exceeds its source")


def _walk(value, depth=0):
    if depth > 32:
        raise ValueError("payload nesting limit exceeded")
    if isinstance(value, dict):
        for item in value.values():
            _walk(item, depth + 1)
    elif isinstance(value, list):
        for item in value:
            _walk(item, depth + 1)
    elif isinstance(value, (float, int)) and not isinstance(value, bool):
        if (
            not math.isfinite(value)
            or not float(value).is_integer()
            or abs(value) > 9_007_199_254_740_991
        ):
            raise ValueError("JSON numbers must be safe integers; decimals use strings")


def validate_frame(frame, *, allow_fixture=False):
    _FRAME.validate(frame)
    if frame.get("fixture_marker") is not None and not allow_fixture:
        raise ValueError("fixture content cannot be a production source")
    if frame["payload_digest"] != _digest(frame, "payload_digest") or frame[
        "snapshot_id"
    ] != _digest(frame, "snapshot_id", "payload_digest"):
        raise ValueError("frame content hash mismatch")
    if (
        not frame["cutoff_ms"]
        <= frame["available_at_ms"]
        <= frame["published_at_ms"]
        < frame["expires_at_ms"]
        or frame["cutoff_ms"] % 60_000
    ):
        raise ValueError("frame clocks are inconsistent")
    flow = frame.get("flow_ref")
    if flow is not None and (
        (
            flow["status"] == "available"
            and any(
                flow.get(key) is None
                for key in ("snapshot_id", "cutoff_ms", "expires_at_ms")
            )
        )
        or (flow["status"] == "unavailable" and not flow["reason_codes"])
    ):
        raise ValueError("flow reference is inconsistent")
    _validate_microstructure_reference(frame)
    _validate_source_capabilities(frame.get("source_capabilities", []))
    for capability in frame.get("source_capabilities", []):
        times = [
            capability.get(key)
            for key in ("probed_at_ms", "collected_at_ms", "qualified_at_ms")
            if capability.get(key) is not None
        ]
        if any(value > frame["available_at_ms"] for value in times):
            raise ValueError(
                "source capability receipt occurs after frame decision time"
            )
    _validate_microstructure(frame)
    universe = frame["universe"]
    ids = universe["member_instrument_ids"]
    if (
        ids != sorted(set(ids))
        or ids != [a["instrument_id"] for a in frame["assets"]]
        or len(ids) != universe["expected_instrument_count"]
    ):
        raise ValueError("asset and universe identities differ")
    if (
        len({a["asset_id"] for a in frame["assets"]}) != len(ids)
        or len({a["quote_asset_id"] for a in frame["assets"]}) != 1
        or any(
            a["instrument_id"].rsplit("-", 1)[-1] != universe["selected_numeraire"]
            for a in frame["assets"]
        )
    ):
        raise ValueError("duplicate base asset or mixed quote universe")
    _validate_relative_strength_changes(frame)
    _validate_candle_anomalies(frame)
    regimes = frame["regime_observations"]
    regimes_by_id = {row["regime_id"]: row for row in regimes}
    if len(regimes_by_id) != len(regimes):
        raise ValueError("duplicate regime observation")
    for regime in regimes:
        if (
            regime["instrument_id"] not in ids
            or regime["provider_ref"] not in frame["providers"].values()
            or regime["provider_ref"]["source_kind"] != frame["source_kind"]
            or regime["source_bar_close_ms"] != frame["cutoff_ms"]
            or regime["available_at_ms"] > frame["available_at_ms"]
            or regime["expires_at_ms"] <= frame["published_at_ms"]
            or regime["source_epoch"] != regime["provider_ref"]["epoch"]
            or regime["source_sequence"] != regime["provider_ref"]["sequence"]
            or regime["available_at_ms"]
            < max(
                regime["source_bar_close_ms"], regime["provider_ref"]["available_at_ms"]
            )
            or regime["expires_at_ms"] > regime["provider_ref"]["expires_at_ms"]
        ):
            raise ValueError("regime source or decision time differs from frame")
    for asset in frame["assets"]:
        if any(
            ref not in regimes_by_id
            or regimes_by_id[ref]["instrument_id"] != asset["instrument_id"]
            for ref in asset["regime_refs"]
        ):
            raise ValueError("asset references another instrument's regime observation")
    series_ids = [s["metric_id"] for s in frame["metric_series"]]
    if series_ids != sorted(set(series_ids)):
        raise ValueError("series identities must be sorted and unique")
    for series in frame["metric_series"]:
        if series.get("fixture_only") and not allow_fixture:
            raise ValueError("fixture series cannot be a production source")
        if [cell["instrument_id"] for cell in series["cells"]] != ids:
            raise ValueError("series members differ from the universe")
        if series["series_unit"] != series["definition_ref"]["unit"]:
            raise ValueError("metric unit mismatch")
        if (
            series["provider_ref"]["source_kind"] != frame["source_kind"]
            or series["provider_ref"] not in frame["providers"].values()
            or series["available_at_ms"] > frame["available_at_ms"]
            or series["window_end_ms"] > frame["cutoff_ms"]
        ):
            raise ValueError("series source or time is outside the frame")
        _timing(series, series["provider_ref"])
        if series["payload_digest"] != _digest(
            _compact_series(series), "payload_digest"
        ):
            raise ValueError("metric series hash mismatch")
        for cell in series["cells"]:
            _metric(
                {
                    "computation_status": "VALID",
                    "coverage_status": "COMPLETE",
                    "reason_codes": [],
                    **cell,
                },
                series["series_unit"],
            )
            _timing(cell, series["provider_ref"], series)
            if (
                cell.get("available_at_ms", series["available_at_ms"])
                > frame["available_at_ms"]
                or cell.get("window_end_ms", series["window_end_ms"])
                > frame["cutoff_ms"]
            ):
                raise ValueError("cell time is outside the frame")
    by_id = {s["metric_id"]: s for s in frame["metric_series"]}
    generation = rvol_generation(frame)
    asset_units = {**_COMMON_ASSET_UNITS, generation["asset_key"]: "ratio"}
    if set(frame["asset_metric_refs"]) != set(asset_units) or set(
        frame["asset_predicate_refs"]
    ) != set(PREDICATES):
        raise ValueError("invalid semantic binding keys")
    for key, ref in frame["asset_metric_refs"].items():
        if by_id.get(ref["metric_id"], {}).get("series_unit") != asset_units[key]:
            raise ValueError("asset metric unit differs from semantic binding")
    rvol_ref = frame["asset_metric_refs"][generation["asset_key"]]["metric_id"]
    if (
        rvol_ref != generation["asset_series"]
        or by_id[rvol_ref]["definition_ref"]["definition_id"]
        != generation["asset_definition"]
    ):
        raise ValueError("semantic metric binding mismatch: relative volume generation")
    for ref in frame["asset_predicate_refs"].values():
        if by_id.get(ref["metric_id"], {}).get("series_unit") != "count":
            raise ValueError("predicate binding unit must be count")
    metrics = frame["market_metrics"]
    for key, metric in metrics.items():
        if key != metric["metric_id"] or metric["unit"] != metric["definition"]["unit"]:
            raise ValueError("aggregate metric identity mismatch")
        _metric(metric)
        _timing(metric, metric["source_ref"])
    refs = [
        *frame["summary"]["metric_refs"].values(),
        *(ref for b in frame["breadth"] for ref in b["metric_refs"].values()),
        *frame["pressure"],
        *frame["participation"],
        *((frame.get("comparisons") or {}).get("metric_refs", {}).values()),
        *(
            ref
            for row in frame.get("normalized_breadth", [])
            for ref in row["metric_refs"].values()
        ),
        *(
            ref
            for row in frame.get("breadth_trajectory", [])
            for ref in row["metric_refs"].values()
        ),
        *(row["metric_ref"] for row in frame.get("breadth_divergence", [])),
        *(
            row[key]
            for row in frame.get("contribution_summaries", [])
            for key in (
                "equal_weight_return_ref",
                "capped_liquidity_return_ref",
                "top5_abs_equal_ref",
                "top5_abs_capped_ref",
            )
        ),
        *(
            row["median_return_ref"]
            for row in frame.get("contribution_summaries", [])
            if row.get("median_return_ref") is not None
        ),
    ]
    if any(ref["metric_id"] not in metrics for ref in refs):
        raise ValueError("unresolved aggregate reference")
    summary_bindings = {
        **_COMMON_SUMMARY_BINDINGS,
        generation["summary_key"]: (
            generation["summary_key"],
            "ratio",
            generation["summary_definition"],
        ),
    }
    if set(frame["summary"]["metric_refs"]) != set(summary_bindings):
        raise ValueError("semantic binding keys mix relative-volume generations")
    for key, (metric_id, unit, definition_id) in summary_bindings.items():
        _require_binding(
            metrics,
            frame["summary"]["metric_refs"][key]["metric_id"],
            metric_id,
            unit,
            definition_id,
        )
    for row in frame["breadth"]:
        for key, (unit, definition_id) in BREADTH_BINDINGS.items():
            _require_binding(
                metrics,
                row["metric_refs"][key]["metric_id"],
                f"breadth_{row['horizon_minutes']}_{key}",
                unit,
                definition_id,
            )
    for row in frame["pressure"]:
        _require_binding(
            metrics,
            row["metric_id"],
            f"pressure_{row['horizon_minutes']}",
            "index_minus3_to3",
            "breadth_pressure",
        )
    for row in frame["participation"]:
        key = row["predicate_id"]
        _require_binding(
            metrics,
            row["metric_id"],
            f"participation_{key}",
            "share_fraction",
            PARTICIPATION_DEFINITIONS[key],
        )
    for row in frame["distribution"]:
        definition = row["definition_ref"]
        if (
            definition["definition_id"] != "return_distribution_40_bins"
            or definition["unit"] != "return_percent"
        ):
            raise ValueError("distribution semantic definition mismatch")
    if frame.get("comparisons") is not None:
        summary_deltas = {
            "market_participation": ("percentage_points", "share_delta"),
            generation["summary_key"]: ("ratio_points", "rvol_delta"),
            "trend_strength": ("index_points", "trend_strength_delta"),
            "realized_volatility_24h": ("percentage_points", "volatility_delta"),
        }
        for key, ref in frame["comparisons"]["metric_refs"].items():
            family, semantic = key.split("/", 1)
            if family == "summary":
                if semantic not in summary_deltas:
                    raise ValueError(
                        "semantic binding keys mix relative-volume generations"
                    )
                unit, definition_id = summary_deltas[semantic]
            elif family == "relative_strength":
                if semantic not in {"btc", "eth", "bnb", "sol"}:
                    raise ValueError("invalid relative-strength comparison key")
                unit, definition_id = "percentage_points", "relative_return_delta"
            elif family in {"participation", "breadth"}:
                unit, definition_id = "percentage_points", "share_delta"
            else:
                unit, definition_id = "index_points", "breadth_pressure_delta"
            _require_binding(
                metrics,
                ref["metric_id"],
                f"delta.{family}.{semantic}",
                unit,
                definition_id,
            )

    def require_aggregate(ref, metric_id, unit, definition_id):
        metric = metrics.get(ref["metric_id"])
        if (
            ref["metric_id"] != metric_id
            or metric is None
            or metric["unit"] != unit
            or metric["definition"]["definition_id"] != definition_id
        ):
            raise ValueError("semantic metric binding mismatch")

    normalized = frame.get("normalized_breadth", [])
    if normalized:
        if [row["horizon_minutes"] for row in normalized] != HORIZONS:
            raise ValueError("normalized breadth horizons are incomplete")
        for row in normalized:
            if (
                row["expected_count"] != len(ids)
                or row["valid_count"] > row["expected_count"]
            ):
                raise ValueError("normalized breadth coverage differs from universe")
            for key in ("advances", "declines", "unchanged"):
                require_aggregate(
                    row["metric_refs"][key],
                    f"breadth_1bp_{row['horizon_minutes']}_{key}",
                    "instruments",
                    "breadth_instrument_count",
                )
            require_aggregate(
                row["metric_refs"]["pressure"],
                f"breadth_pressure_1bp_{row['horizon_minutes']}",
                "index_minus1_to1",
                "breadth_pressure_1bp",
            )
    trajectory = frame.get("breadth_trajectory", [])
    if trajectory:
        expected_pairs = [
            (h, interval) for h in (5, 15, 60) for interval in (5, 15, 60)
        ]
        if [
            (row["horizon_minutes"], row["interval_minutes"]) for row in trajectory
        ] != expected_pairs:
            raise ValueError("breadth trajectory rows are incomplete or reordered")
        units = {
            "level": ("index_minus1_to1", "breadth_pressure_1bp"),
            "change": ("index_points", "breadth_pressure_change"),
            "velocity": ("index_points_per_minute", "breadth_pressure_velocity"),
            "acceleration": (
                "index_points_per_minute_squared",
                "breadth_pressure_acceleration",
            ),
        }
        for row in trajectory:
            if (
                row["expected_count"] != len(ids)
                or row["matched_count"] > row["expected_count"]
                or (row["matched_count"] == 0)
                != (row.get("matched_membership_hash") is None)
            ):
                raise ValueError("trajectory cohort differs from universe")
            for field, (unit, definition_id) in units.items():
                require_aggregate(
                    row["metric_refs"][field],
                    f"breadth_pressure_{field}_{row['horizon_minutes']}_{row['interval_minutes']}m",
                    unit,
                    definition_id,
                )
    divergences = frame.get("breadth_divergence", [])
    if divergences:
        if [
            (row["benchmark"], row["horizon_minutes"], row["interval_minutes"])
            for row in divergences
        ] != [("btc", 15, interval) for interval in (5, 15, 60)]:
            raise ValueError("breadth divergence rows are incomplete or reordered")
        for row in divergences:
            if (
                not 1 <= row["expected_count"] <= 300
                or row["expected_count"] != len(ids)
                or not 0 <= row["matched_count"] <= row["expected_count"]
                or (row["matched_count"] == 0)
                != (row.get("matched_membership_hash") is None)
            ):
                raise ValueError("divergence cohort differs from universe")
            require_aggregate(
                row["metric_ref"],
                f"breadth_divergence_btc_15_{row['interval_minutes']}m",
                "count",
                "breadth_price_divergence",
            )
            value = metrics[row["metric_ref"]["metric_id"]].get("value")
            if value not in (None, "0", "1"):
                raise ValueError(
                    "breadth divergence flag must be zero, one, or unavailable"
                )
            if value is not None and row["matched_count"] == 0:
                raise ValueError(
                    "observed divergence requires a positive matched cohort"
                )
    contributions = frame.get("contribution_summaries", [])
    if contributions:
        breadth_by_horizon = {row["horizon_minutes"]: row for row in frame["breadth"]}
        if [row["horizon_minutes"] for row in contributions] != [5, 15, 60, 1440]:
            raise ValueError("contribution horizons are incomplete or reordered")
        for row in contributions:
            horizon = row["horizon_minutes"]
            window_start_ms = _cohort_window_start_ms(frame["cutoff_ms"], horizon)
            if (
                row["expected_count"] != len(ids)
                or row["valid_count"] > row["expected_count"]
            ):
                raise ValueError("contribution cohort differs from universe")
            require_aggregate(
                row["equal_weight_return_ref"],
                f"cohort_equal_return_{horizon}",
                "return_percent",
                "cohort_equal_weight_return",
            )
            require_aggregate(
                row["capped_liquidity_return_ref"],
                f"cohort_capped_liquidity_return_{horizon}",
                "return_percent",
                "cohort_capped_liquidity_return",
            )
            require_aggregate(
                row["top5_abs_equal_ref"],
                f"contribution_top5_abs_equal_{horizon}",
                "share_fraction",
                "return_concentration_abs_top5_equal",
            )
            require_aggregate(
                row["top5_abs_capped_ref"],
                f"contribution_top5_abs_capped_{horizon}",
                "share_fraction",
                "return_concentration_abs_top5_capped_liquidity",
            )
            median_ref = row.get("median_return_ref")
            if median_ref is None:
                continue
            breadth = breadth_by_horizon[horizon]
            if (
                not row["start_cohort_available"]
                or row["valid_count"] != row["expected_count"]
                or row["expected_count"] != len(ids)
                or frame["universe"]["effective_at_ms"] > window_start_ms
                or breadth["valid_count"] != breadth["expected_count"]
                or breadth["expected_count"] != row["expected_count"]
                or median_ref["metric_id"]
                != breadth["metric_refs"]["median_return"]["metric_id"]
            ):
                raise ValueError(
                    "cohort median must reuse the same-horizon full-cohort breadth median"
                )
            metric = metrics[median_ref["metric_id"]]
            if (
                metric["definition"]["definition_id"] != "breadth_return_median"
                or metric["unit"] != "return_percent"
                or metric["computation_status"] != "VALID"
                or metric["coverage_status"] != "COMPLETE"
                or metric["sample_count"] != row["expected_count"]
                or metric["required_samples"] != row["expected_count"]
                or metric["expected_denominator"] != row["expected_count"]
                or metric["horizon_minutes"] != horizon
                or metric["window_start_ms"] != window_start_ms
                or metric["window_end_ms"] != frame["cutoff_ms"]
            ):
                raise ValueError(
                    "cohort median does not prove complete same-horizon owner coverage"
                )
            return_series = by_id[
                frame["asset_metric_refs"][f"return_{horizon}m"]["metric_id"]
            ]
            member_values = {
                cell["instrument_id"]: (
                    cell.get("value")
                    if cell.get("computation_status", "VALID") == "VALID"
                    else None
                )
                for cell in return_series["cells"]
            }
            median = _exact_member_median(member_values, ids)
            if (
                median is None
                or metric.get("value") is None
                or Decimal(metric["value"]) != median
            ):
                raise ValueError(
                    "cohort median aggregate differs from exact frozen member returns"
                )
    daily_rows = frame.get("daily_internals", [])
    if daily_rows:
        if [row["instrument_id"] for row in daily_rows] != ids:
            raise ValueError("daily internals must follow the frozen universe")

        bindings = [
            ("daily_high_break_20d", "count", 21),
            ("daily_low_break_20d", "count", 21),
            ("daily_close_break_high_20d", "count", 21),
            ("daily_close_break_low_20d", "count", 21),
        ]
        for window in (20, 50, 200):
            bindings.extend(
                (
                    (f"daily_sma_{window}", "price_quote", window),
                    (f"daily_sma_{window}_above_close", "share_fraction", window),
                    (
                        f"daily_sma_{window}_slope_pct_per_day",
                        "percentage_points",
                        window + 1,
                    ),
                    (f"daily_sma_{window}_cross", "index_points", window + 1),
                )
            )
        for row in daily_rows:
            coverage = row["source_coverage"]
            if (
                row["cutoff_ms"] != frame["cutoff_ms"] // 86_400_000 * 86_400_000
                or coverage["valid_daily_bars"] > coverage["expected_daily_bars"]
            ):
                raise ValueError("daily internals use a different frame decision time")
            source_reasons = row.get("source_reason_codes", [])
            source = row.get("source")
            if source is None:
                if row["source_coverage_status"] != "UNAVAILABLE" or not source_reasons:
                    raise ValueError(
                        "daily source identity missing without unavailable status"
                    )
            elif (
                source["cutoff_ms"] != row["cutoff_ms"]
                or source["available_at_ms"] > frame["available_at_ms"]
                or source["expires_at_ms"] <= frame["available_at_ms"]
                or source["source_kind"] != frame["source_kind"]
            ):
                raise ValueError(
                    "daily source is stale or belongs to another instrument/frame"
                )
            contiguous = row["contiguous_daily_bars"]
            if not 0 <= contiguous <= 201 or len(row["values"]) != 16:
                raise ValueError("daily fixed vector or contiguous suffix is invalid")
            reasons_by_index = row.get("feature_reasons", {})
            if set(reasons_by_index) - {str(index) for index in range(16)}:
                raise ValueError("daily feature reason index is invalid")
            used_reasons = set()
            for index, (metric_id, unit, required_samples) in enumerate(bindings):
                value = row["values"][index]
                samples = min(contiguous, required_samples)
                reasons = reasons_by_index.get(str(index), source_reasons)
                if value is None:
                    if not reasons:
                        raise ValueError("null daily feature lacks an owner reason")
                    if str(index) in reasons_by_index:
                        used_reasons.add(str(index))
                elif (
                    source is None
                    or source_reasons
                    or contiguous < required_samples
                    or str(index) in reasons_by_index
                    or samples != required_samples
                ):
                    raise ValueError(
                        "valid daily feature lacks complete source samples"
                    )
                if value is not None:
                    number = _decimal(value)
                    if unit in {"count", "share_fraction"} and number not in {0, 1}:
                        raise ValueError("daily boolean metric must be zero or one")
                    if unit == "index_points" and number not in {-1, 0, 1}:
                        raise ValueError("daily cross must be minus one, zero, or one")
                    if unit == "price_quote" and number <= 0:
                        raise ValueError("daily price must be positive")
                if str(index) in reasons_by_index and (
                    value is not None or not reasons_by_index[str(index)]
                ):
                    raise ValueError("daily feature reason must explain a null value")
            if used_reasons != set(reasons_by_index):
                raise ValueError("daily feature reasons are not bound to null cells")
    for family in ("breadth", "distribution", "pressure"):
        if [row["horizon_minutes"] for row in frame[family]] != HORIZONS:
            raise ValueError("missing or reordered horizons")
    for row in frame["breadth"]:
        refs = row["metric_refs"]
        resolved = {name: metrics[ref["metric_id"]] for name, ref in refs.items()}
        counts = [
            _metric(resolved[key]) for key in ("advances", "declines", "unchanged")
        ]
        if (
            any(v is None or not v.is_integer() or v < 0 for v in counts)
            or sum(counts) != row["valid_count"]
        ):
            raise ValueError("breadth partition mismatch")
        if row["expected_count"] != len(ids) or sum(
            row["omission_reasons"].values()
        ) + row["valid_count"] != len(ids):
            raise ValueError("breadth omissions mismatch")
    for row in frame["distribution"]:
        edges = [_decimal(edge) for edge in row["edges"]]
        if (
            len(edges) != 41
            or len(row["counts"]) != 40
            or any(b <= a for a, b in zip(edges, edges[1:]))
        ):
            raise ValueError("invalid histogram edges")
        if row["unit"] != "return_percent" or row["expected_count"] != len(ids):
            raise ValueError("invalid histogram unit or universe")
        if (
            sum(row["counts"]) + row["underflow_count"] + row["overflow_count"]
            != row["valid_count"]
        ):
            raise ValueError("histogram population mismatch")
    if [p["predicate_id"] for p in frame["participation"]] != PREDICATES:
        raise ValueError("invalid participation predicates")
    for row in frame["participation"]:
        if (
            not 0
            <= row["numerator"]
            <= row["denominator"]
            <= row["expected_denominator"]
            == len(ids)
        ):
            raise ValueError("participation denominator mismatch")
        _metric(metrics[row["metric_id"]])
        if (
            frame["asset_predicate_refs"][row["predicate_id"]]["metric_id"]
            != row["membership_metric_id"]
        ):
            raise ValueError("participation predicate reference mismatch")
        eligible = [
            c
            for c in by_id[row["membership_metric_id"]]["cells"]
            if c.get("computation_status", "VALID") == "VALID"
        ]
        if (
            len(eligible) != row["denominator"]
            or any(c.get("value") not in ("0", "1") for c in eligible)
            or sum(int(c["value"]) for c in eligible) != row["numerator"]
        ):
            raise ValueError("predicate membership differs from participation")
        metric = metrics[row["metric_id"]]
        if metric["unit"] != "share_fraction" or any(
            metric[key] != row[key]
            for key in ("numerator", "denominator", "expected_denominator")
        ):
            raise ValueError("participation metric coverage mismatch")
    above = next(
        p for p in frame["participation"] if p["predicate_id"] == "above_ema21"
    )
    if (
        frame["summary"]["metric_refs"]["above_ema21"]["metric_id"]
        != above["metric_id"]
    ):
        raise ValueError("summary participation must reference the same metric")
    return frame


@lru_cache(maxsize=4)
def validate_response(path: str, raw: bytes):
    if not 0 < len(raw) <= MAX_BYTES:
        raise ValueError("invalid payload size")
    payload = json.loads(
        raw.decode("utf-8"),
        object_pairs_hook=_object,
        parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite JSON")),
    )
    if not isinstance(payload, dict):
        raise ValueError("expected JSON object")
    _walk(payload)
    if path == "latest" or path.startswith("snapshots/"):
        return validate_frame(payload)
    family = path.split("/", 1)[0]
    if family not in _RESPONSES:
        raise ValueError("unsupported Market Picture response")
    _RESPONSES[family].validate(payload)
    if family != "status" and not _HASH.fullmatch(payload["snapshot_id"]):
        raise ValueError("stored read is not bound to a frame")
    if family == "microstructure":
        _validate_microstructure_response(payload)
    if family == "history":
        if payload.get("projection") == "canonical_state":
            _validate_canonical_history(payload)
            return payload
        previous = -1
        for row in payload["items"]:
            if (
                not _HASH.fullmatch(row["snapshot_id"])
                or not _HASH.fullmatch(row["membership_hash"])
                or not _HASH.fullmatch(row["definition_registry_hash"])
                or not previous
                < row["cutoff_ms"]
                <= row["available_at_ms"]
                < row["expires_at_ms"]
            ):
                raise ValueError("history identity or availability is invalid")
            previous = row["cutoff_ms"]
            coverage = row["coverage"]
            valid, expected = (
                coverage["valid_instruments"],
                coverage["expected_instruments"],
            )
            if (
                not 0 <= valid <= expected <= 300
                or expected == 0
                or coverage["omitted_instruments"] != expected - valid
                or not math.isclose(
                    _decimal(coverage["valid_fraction"]),
                    valid / expected,
                    rel_tol=1e-14,
                )
            ):
                raise ValueError("history coverage is invalid")
            if set(row["breadth"]) != {str(h) for h in HORIZONS}:
                raise ValueError("history horizons are incomplete")
            # Stored history is a separate public boundary from frame validation.
            # Preserve points from older generations that omit this field, but
            # validate every divergence row when the owner supplied one.
            for divergence in row.get("breadth_divergence", {}).values():
                matched, expected = (
                    divergence["matched_count"],
                    divergence["expected_count"],
                )
                cohort_hash = divergence.get("matched_membership_hash")
                value = divergence.get("value")
                if (
                    type(expected) is not int
                    or type(matched) is not int
                    or not 1 <= expected <= 300
                    or not 0 <= matched <= expected
                    or (matched == 0) != (cohort_hash is None)
                    or (cohort_hash is not None and not _HASH.fullmatch(cohort_hash))
                    or value not in (None, "0", "1")
                    or (value is not None and matched == 0)
                ):
                    raise ValueError("history divergence cohort or flag is invalid")
            for values in row["breadth"].values():
                for key, value in values.items():
                    if value is not None:
                        low, high = (-3, 3) if key == "pressure" else (0, 1)
                        if not low <= _decimal(value) <= high:
                            raise ValueError("history metric exceeds its unit")
            # A point is stored under the key set of its own generation; both read, never mixed.
            if {"relative_volume_24h", "relative_volume_1h"} <= set(row["summary"]):
                raise ValueError("history point mixes relative-volume generations")
            for value in row["summary"].values():
                if value is not None:
                    _decimal(value)
    elif family == "correlations":
        # One stored snapshot publishes one window, bound to its owner definition id.
        if len({row["expected_sample_count"] for row in payload["items"]}) > 1:
            raise ValueError("correlation page mixes sample windows")
        for row in payload["items"]:
            count, expected = row["paired_sample_count"], row["expected_sample_count"]
            correlation_definition_id(expected)
            if not 0 <= count <= expected:
                raise ValueError("correlation sample window is invalid")
            if row["correlation"] is None:
                if not row["reason_codes"]:
                    raise ValueError("missing correlation needs a reason")
            elif not -1 <= _decimal(row["correlation"]) <= 1 or count < math.ceil(
                expected * 0.95
            ):
                raise ValueError("unqualified correlation")
            previous = -1
            for point in row["trend"]:
                if not previous < point["cutoff_ms"] <= row["window_end_ms"]:
                    raise ValueError("correlation trend is not ordered")
                previous = point["cutoff_ms"]
                if (
                    point["correlation"] is not None
                    and not -1 <= _decimal(point["correlation"]) <= 1
                ):
                    raise ValueError("correlation trend exceeds its unit")
    elif family == "assets":
        for metric in payload["metrics"].values():
            _metric(metric)
    return payload
