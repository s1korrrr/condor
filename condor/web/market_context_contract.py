"""Validate canonical market-context wire records without an execution dependency.

This is the API consumer boundary for the owner mc-json-1 contract. Calculations,
model fits, storage and readiness decisions remain with the market-context owner.
"""

from __future__ import annotations

import hashlib
import json
import math
import re

from fastapi import HTTPException

OWNER_REASON_CODES = frozenset(
    {
        "INPUT_UNCONFIRMED",
        "INPUT_GAP",
        "INPUT_STALE",
        "INPUT_REVISION_CONFLICT",
        "INPUT_NONFINITE",
        "INPUT_MISSING",
        "INPUT_INVALID",
        "CUTOFF_NOT_MONOTONIC",
        "MEMBERSHIP_UNAVAILABLE",
        "QUOTE_MISMATCH",
        "DUPLICATE_UNDERLYING",
        "CLASSIFICATION_UNKNOWN",
        "CLASSIFICATION_EXCLUDED",
        "LISTING_UNKNOWN",
        "LISTING_TOO_RECENT",
        "TURNOVER_UNAVAILABLE",
        "COVERAGE_LOW",
        "BENCHMARK_MISSING",
        "WARMUP_INCOMPLETE",
        "SCALE_DEGENERATE",
        "FACTOR_VARIANCE_LOW",
        "MODEL_UNAVAILABLE",
        "RANK_POPULATION_LOW",
        "STORE_UNAVAILABLE",
        "WRITER_FENCED",
        "PAYLOAD_TOO_LARGE",
        "CAPACITY_EXCEEDED",
        "SNAPSHOT_CONFLICT",
        "CONTEXT_EXPIRED",
        "CONTEXT_FUTURE",
        "VERSION_MISMATCH",
        "SOURCE_KIND_REJECTED",
        "SNAPSHOT_HASH_MISMATCH",
        "STREAM_MISMATCH",
        "VENUE_MISMATCH",
        "PROVENANCE_MISMATCH",
        "FEATURE_UNAVAILABLE",
        "EPOCH_UNCONFIRMED",
        "CONTEXT_UNAVAILABLE",
        "PAYLOAD_INVALID",
    }
)


_CONTEXT_FEATURE_STATUSES = frozenset(
    {
        "VALID",
        "WARMUP_INCOMPLETE",
        "INPUT_MISSING",
        "INPUT_STALE",
        "MODEL_UNAVAILABLE",
        "INVALID",
    }
)


_CONTEXT_ENVELOPE_STATUSES = frozenset({"READY", "DEGRADED", "WARMING", "INVALID"})


_CONTEXT_SOURCE_KINDS = frozenset({"observed", "modeled_availability", "synthetic"})


_CONTEXT_FEATURE_NAME = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


_CONTEXT_DIGEST = re.compile(r"^[0-9a-f]{64}$")


_CONTEXT_MAX_TIMESTAMP_MS = 253_402_300_799_000


_CONTEXT_ASSET = re.compile(r"^[A-Z0-9]{1,32}$")


_CONTEXT_INSTRUMENT = re.compile(r"^[A-Z0-9]{1,32}-[A-Z0-9]{1,32}$")


_CONTEXT_STREAM = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,63}$")


_CONTEXT_EPOCH = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


_CONTEXT_VENUE = re.compile(r"^[a-z0-9_]{1,32}$")


_CONTEXT_SCHEMA = re.compile(r"^[0-9]{1,3}\.[0-9]{1,3}$")


_CONTEXT_FIT_KEYS = frozenset(
    {
        "horizon_minutes",
        "status",
        "reasons",
        "training_samples",
        "history_cutoff_ms",
        "factor_id",
    }
)


_CONTEXT_TOP_KEYS = frozenset(
    {
        "schema_version",
        "snapshot_id",
        "stream_id",
        "epoch",
        "sequence",
        "source_kind",
        "available_at_ms",
        "expires_at_ms",
        "supersedes",
        "venue",
        "numeraire",
        "cutoff_ms",
        "max_input_available_at_ms",
        "provenance",
        "coverage",
        "status",
        "reasons",
        "market",
        "assets",
    }
)


_CONTEXT_PROVENANCE_KEYS = frozenset(
    {
        "code_digest",
        "config_digest",
        "universe_hash",
        "input_manifest_digest",
        "model_digest",
        "serializer_version",
        "artifact_refs",
    }
)


_CONTEXT_COVERAGE_KEYS = frozenset(
    {"expected_count", "valid_count", "valid_weight_fraction", "missing"}
)


_CONTEXT_MISSING_KEYS = frozenset({"asset_id", "reasons"})


_CONTEXT_ASSET_KEYS = frozenset(
    {"asset_id", "instrument_id", "reasons", "features", "fits"}
)


_CONTEXT_FEATURE_KEYS = frozenset(
    {
        "name",
        "value",
        "unit",
        "horizon_minutes",
        "status",
        "reasons",
        "valid_count",
        "expected_count",
        "valid_weight_fraction",
        "model_id",
        "input_available_at_ms",
    }
)


_CONTEXT_FIT_STATUS = _CONTEXT_FEATURE_STATUSES


_CONTEXT_UNITS = frozenset(
    {
        "return_fraction",
        "share",
        "share_change",
        "ordinal",
        "regression_coefficient",
        "standard_score",
    }
)


def _exact_keys(value: object, required: frozenset[str]) -> bool:
    return isinstance(value, dict) and value.keys() == required


def _valid_owner_reasons(value: object, *, required: bool = False) -> bool:
    return (
        isinstance(value, list)
        and len(value) <= 64
        and all(isinstance(item, str) and item in OWNER_REASON_CODES for item in value)
        and value == sorted(set(value))
        and (not required or bool(value))
    )


def _bounded_int(value: object, minimum: int, maximum: int) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and minimum <= value <= maximum
    )


def _nonnegative_integer(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _valid_timestamp(value: object, *, nullable: bool = False) -> bool:
    return (
        value is None and nullable or _bounded_int(value, 0, _CONTEXT_MAX_TIMESTAMP_MS)
    )


def _nonfinite_constant(value: str):
    raise ValueError(f"Non-finite JSON number: {value}")


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON object key")
        result[key] = value
    return result


def _context_features_are_valid(features: object) -> bool:
    if not isinstance(features, list) or len(features) > 256:
        return False
    names = []
    for feature in features:
        if not _exact_keys(feature, _CONTEXT_FEATURE_KEYS):
            return False
        status = feature.get("status")
        value = feature.get("value")
        name = feature.get("name")
        if not isinstance(name, str) or not _CONTEXT_FEATURE_NAME.fullmatch(name):
            return False
        names.append(name)
        if not isinstance(status, str) or status not in _CONTEXT_FEATURE_STATUSES:
            return False
        if value is not None and (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
        ):
            return False
        if (status == "VALID") != (value is not None):
            return False
        if not _valid_owner_reasons(feature.get("reasons"), required=status != "VALID"):
            return False
        if (
            not isinstance(feature.get("unit"), str)
            or feature["unit"] not in _CONTEXT_UNITS
            or not _bounded_int(feature.get("horizon_minutes"), 1, 1440)
            or not _bounded_int(feature.get("valid_count"), 0, 500)
            or not _bounded_int(feature.get("expected_count"), 0, 500)
            or feature["valid_count"] > feature["expected_count"]
        ):
            return False
        weight = feature.get("valid_weight_fraction")
        if weight is not None and (
            isinstance(weight, bool)
            or not isinstance(weight, (int, float))
            or not math.isfinite(weight)
            or not 0 <= weight <= 1
        ):
            return False
        available_at = feature.get("input_available_at_ms")
        if not _valid_timestamp(available_at, nullable=True):
            return False
        model_id = feature.get("model_id")
        if model_id is not None and (
            not isinstance(model_id, str) or not _CONTEXT_DIGEST.fullmatch(model_id)
        ):
            return False
    return names == sorted(set(names))


def _context_fits_are_valid(fits: object) -> bool:
    if not isinstance(fits, list) or len(fits) > 16:
        return False
    horizons = []
    for fit in fits:
        if not _exact_keys(fit, _CONTEXT_FIT_KEYS):
            return False
        horizon = fit["horizon_minutes"]
        status = fit["status"]
        cutoff = fit["history_cutoff_ms"]
        factor = fit["factor_id"]
        if (
            not _bounded_int(horizon, 1, 1440)
            or not isinstance(status, str)
            or status not in _CONTEXT_FIT_STATUS
            or not _valid_owner_reasons(fit["reasons"], required=status != "VALID")
            or not _nonnegative_integer(fit["training_samples"])
            or not _valid_timestamp(cutoff, nullable=True)
            or (
                factor is not None
                and (
                    not isinstance(factor, str) or not _CONTEXT_DIGEST.fullmatch(factor)
                )
            )
            or ((cutoff is not None and factor is not None) != (status == "VALID"))
        ):
            return False
        horizons.append(horizon)
    return horizons == sorted(set(horizons))


def validate_canonical_context(body: bytes) -> dict:
    """Validate the owner envelope and mc-json-1 digest without importing Hummingbot."""
    try:
        payload = json.loads(
            body.decode("utf-8"),
            parse_constant=_nonfinite_constant,
            object_pairs_hook=_unique_object,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError):
        raise HTTPException(
            502, "Market context source returned invalid JSON"
        ) from None
    if not _exact_keys(payload, _CONTEXT_TOP_KEYS):
        raise HTTPException(502, "Market context source returned an invalid envelope")
    schema_version = payload.get("schema_version")
    if (
        not isinstance(schema_version, str)
        or not _CONTEXT_SCHEMA.fullmatch(schema_version)
        or schema_version.split(".", maxsplit=1)[0] != "1"
    ):
        raise HTTPException(502, "Market context source returned an unsupported schema")
    snapshot_id = payload.get("snapshot_id")
    if not isinstance(snapshot_id, str) or not re.fullmatch(
        r"[0-9a-f]{64}", snapshot_id
    ):
        raise HTTPException(
            502, "Market context source returned an invalid snapshot identity"
        )
    if (
        not isinstance(payload.get("status"), str)
        or payload["status"] not in _CONTEXT_ENVELOPE_STATUSES
        or not isinstance(payload.get("source_kind"), str)
        or payload["source_kind"] not in _CONTEXT_SOURCE_KINDS
        or not isinstance(payload.get("stream_id"), str)
        or not _CONTEXT_STREAM.fullmatch(payload["stream_id"])
        or not isinstance(payload.get("epoch"), str)
        or not _CONTEXT_EPOCH.fullmatch(payload["epoch"])
        or not isinstance(payload.get("sequence"), int)
        or isinstance(payload.get("sequence"), bool)
        or payload["sequence"] < 1
        or not isinstance(payload.get("venue"), str)
        or not _CONTEXT_VENUE.fullmatch(payload["venue"])
        or not isinstance(payload.get("numeraire"), str)
        or not _CONTEXT_ASSET.fullmatch(payload["numeraire"])
        or (
            payload["supersedes"] is not None
            and (
                not isinstance(payload["supersedes"], str)
                or not _CONTEXT_DIGEST.fullmatch(payload["supersedes"])
            )
        )
        or not isinstance(payload.get("cutoff_ms"), int)
        or isinstance(payload.get("cutoff_ms"), bool)
        or not isinstance(payload.get("available_at_ms"), int)
        or isinstance(payload.get("available_at_ms"), bool)
        or not isinstance(payload.get("expires_at_ms"), int)
        or isinstance(payload.get("expires_at_ms"), bool)
        or not isinstance(payload.get("max_input_available_at_ms"), int | type(None))
        or isinstance(payload.get("max_input_available_at_ms"), bool)
        or (
            payload["max_input_available_at_ms"] is not None
            and not 0
            <= payload["max_input_available_at_ms"]
            <= _CONTEXT_MAX_TIMESTAMP_MS
        )
        or any(
            not 0 <= payload[key] <= _CONTEXT_MAX_TIMESTAMP_MS
            for key in ("cutoff_ms", "available_at_ms", "expires_at_ms")
        )
        or payload["available_at_ms"] < payload["cutoff_ms"]
        or payload["cutoff_ms"] % 60_000 != 0
        or payload["expires_at_ms"] <= payload["available_at_ms"]
        or not _valid_owner_reasons(
            payload.get("reasons"), required=payload.get("status") != "READY"
        )
        or not _exact_keys(payload.get("provenance"), _CONTEXT_PROVENANCE_KEYS)
        or not _exact_keys(payload.get("coverage"), _CONTEXT_COVERAGE_KEYS)
        or not isinstance(payload.get("market"), list)
        or not isinstance(payload.get("assets"), list)
        or not _context_features_are_valid(payload.get("market"))
    ):
        raise HTTPException(502, "Market context source returned an invalid envelope")
    if (payload["status"] == "READY") != (not payload["reasons"]):
        raise HTTPException(502, "Market context source returned an invalid envelope")
    if payload["max_input_available_at_ms"] is not None and (
        payload["available_at_ms"] < payload["max_input_available_at_ms"]
    ):
        raise HTTPException(
            502, "Market context source returned invalid publication timing"
        )
    provenance = payload["provenance"]
    if (
        any(
            not isinstance(provenance.get(key), str)
            or not _CONTEXT_DIGEST.fullmatch(provenance[key])
            for key in (
                "code_digest",
                "config_digest",
                "universe_hash",
                "input_manifest_digest",
                "model_digest",
            )
        )
        or provenance.get("serializer_version") != "mc-json-1"
        or not isinstance(provenance.get("artifact_refs"), list)
        or len(provenance["artifact_refs"]) > 32
        or any(
            not isinstance(ref, str) or not 1 <= len(ref) <= 256
            for ref in provenance["artifact_refs"]
        )
    ):
        raise HTTPException(502, "Market context source returned invalid provenance")
    coverage = payload["coverage"]
    if (
        not isinstance(coverage.get("expected_count"), int)
        or isinstance(coverage.get("expected_count"), bool)
        or not isinstance(coverage.get("valid_count"), int)
        or isinstance(coverage.get("valid_count"), bool)
        or not isinstance(coverage.get("valid_weight_fraction"), (int, float))
        or isinstance(coverage.get("valid_weight_fraction"), bool)
        or not math.isfinite(coverage["valid_weight_fraction"])
        or not 0 <= coverage["valid_count"] <= coverage["expected_count"] <= 500
        or not 0 <= coverage["valid_weight_fraction"] <= 1
        or not isinstance(coverage.get("missing"), list)
        or len(coverage["missing"]) > 500
        or len(coverage["missing"])
        != coverage["expected_count"] - coverage["valid_count"]
    ):
        raise HTTPException(502, "Market context source returned invalid coverage")
    missing_ids = []
    for missing in coverage["missing"]:
        if (
            not _exact_keys(missing, _CONTEXT_MISSING_KEYS)
            or not isinstance(missing.get("asset_id"), str)
            or not _CONTEXT_ASSET.fullmatch(missing["asset_id"])
            or not _valid_owner_reasons(missing.get("reasons"), required=True)
            or not missing["reasons"]
        ):
            raise HTTPException(502, "Market context source returned invalid coverage")
        missing_ids.append(missing["asset_id"])
    if missing_ids != sorted(set(missing_ids)):
        raise HTTPException(
            502, "Market context source returned invalid coverage ordering"
        )
    if len(payload["assets"]) > 500:
        raise HTTPException(502, "Market context source returned an oversized universe")
    for asset in payload["assets"]:
        if (
            not _exact_keys(asset, _CONTEXT_ASSET_KEYS)
            or not isinstance(asset.get("asset_id"), str)
            or not _CONTEXT_ASSET.fullmatch(asset["asset_id"])
            or not isinstance(asset.get("instrument_id"), str)
            or not _CONTEXT_INSTRUMENT.fullmatch(asset["instrument_id"])
            or not _valid_owner_reasons(asset.get("reasons"))
            or not _context_fits_are_valid(asset.get("fits"))
            or not _context_features_are_valid(asset.get("features"))
        ):
            raise HTTPException(
                502, "Market context source returned an invalid envelope"
            )
    asset_ids = [asset["asset_id"] for asset in payload["assets"]]
    if asset_ids != sorted(set(asset_ids)):
        raise HTTPException(
            502, "Market context source returned an invalid universe ordering"
        )
    try:
        canonical = json.dumps(
            {key: value for key, value in payload.items() if key != "snapshot_id"},
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError):
        raise HTTPException(
            502, "Market context source returned an invalid envelope"
        ) from None
    if hashlib.sha256(canonical).hexdigest() != snapshot_id:
        raise HTTPException(502, "Market context snapshot digest did not match")
    return payload
