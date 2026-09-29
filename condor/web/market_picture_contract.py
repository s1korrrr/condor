"""Market Picture's presentation boundary, with no execution-package import.

The checked-in JSON Schema is generated from the owner contract. This module
adds content hashes and cross-record invariants which JSON Schema cannot express.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from decimal import Decimal
from functools import lru_cache
from pathlib import Path

from jsonschema import Draft202012Validator

MAX_BYTES = 2 * 1024 * 1024
HORIZONS = [1, 5, 15, 60, 240, 1440]
ASSET_UNITS = {
    "price": "price_quote",
    "ema21": "price_quote",
    "rsi14": "rsi_0_100",
    "adx14": "adx_0_100",
    "atr14_percent": "atr_percent",
    "atr14_percentile": "percentile_0_100",
    "rvol20": "ratio",
    "rvol_24h": "ratio",
    "realized_volatility_24h": "volatility_fraction_annualized",
    **{f"return_{h}m": "return_percent" for h in [*HORIZONS, 10080]},
    **{f"relative_24h_{b}": "percentage_points" for b in ["btc", "eth", "bnb", "sol"]},
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
SUMMARY_BINDINGS = {
    "market_participation": ("market_participation", "share_fraction", "above_ema21"),
    "relative_volume_24h": (
        "relative_volume_24h",
        "ratio",
        "median_relative_volume_24h",
    ),
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
    if set(frame["asset_metric_refs"]) != set(ASSET_UNITS) or set(
        frame["asset_predicate_refs"]
    ) != set(PREDICATES):
        raise ValueError("invalid semantic binding keys")
    for key, ref in frame["asset_metric_refs"].items():
        if by_id.get(ref["metric_id"], {}).get("series_unit") != ASSET_UNITS[key]:
            raise ValueError("asset metric unit differs from semantic binding")
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
    ]
    if any(ref["metric_id"] not in metrics for ref in refs):
        raise ValueError("unresolved aggregate reference")
    for key, (metric_id, unit, definition_id) in SUMMARY_BINDINGS.items():
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
            "relative_volume_24h": ("ratio_points", "rvol_delta"),
            "trend_strength": ("index_points", "trend_strength_delta"),
            "realized_volatility_24h": ("percentage_points", "volatility_delta"),
        }
        for key, ref in frame["comparisons"]["metric_refs"].items():
            family, semantic = key.split("/", 1)
            if family == "summary":
                unit, definition_id = summary_deltas[semantic]
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
    if family == "history":
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
            for values in row["breadth"].values():
                for key, value in values.items():
                    if value is not None:
                        low, high = (-3, 3) if key == "pressure" else (0, 1)
                        if not low <= _decimal(value) <= high:
                            raise ValueError("history metric exceeds its unit")
            for value in row["summary"].values():
                if value is not None:
                    _decimal(value)
    elif family == "correlations":
        for row in payload["items"]:
            count, expected = row["paired_sample_count"], row["expected_sample_count"]
            if not 0 <= count <= expected or expected != 2160:
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
