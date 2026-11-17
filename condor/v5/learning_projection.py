"""Condor binding for the frozen V5 Learning / Factory / Lineage projection.

Read-only, authority NONE. Contracts: rsibot ``1d8c0ab6`` (A) and ``bf9f3c14`` (B), vendored verbatim in
``schemas/learning_projection``. Four parts:

* strict parsing and canonical hashing (``parse_strict``, ``canonical``);
* envelope and error validation against the vendored JSON Schemas plus the appendix's relational/byte
  invariants (``validate_envelope``, ``validate_error``). One violation rejects the whole envelope;
* a NEW bounded HTTP client with its own response cap (``OwnerProjectionClient``). It is not ``V5Upstream``
  (bearer-token files, 256 000 B shared constant) and not the 64 MiB research bridge reader;
* ``ResearchOwnerLearningSource``: query validation, typed error mapping, receipt expiry.

There is no fixture fallback anywhere in this module. A failed or invalid read clears receipts and returns a
typed error; it never substitutes a previous or synthetic answer.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import time
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Awaitable, Callable, Literal
from urllib.parse import unquote_to_bytes

import aiohttp
from fastapi import APIRouter, Request, Response
from jsonschema import Draft202012Validator, ValidationError
from jsonschema import validators as _jsonschema_validators
from referencing import Registry, Resource
from yarl import URL

logger = logging.getLogger(__name__)

SCHEMA_DIR = Path(__file__).resolve().parent / "schemas" / "learning_projection"
SCOPE_DIR = SCHEMA_DIR.with_name("learning_scopes")
STAGE_B_SCOPE_SHA256 = "1f65d67fc990262e049e808961b1a23068f26692b9171112eb441be0157e7c16"
SCOPE_ARTIFACTS = {
    "a3a34ee765c75616da6f606a66156cdbf0e8736c91052966607fa6b59936bd18": "scope-okx-spot-dca.json",
    STAGE_B_SCOPE_SHA256: "scope-okx-spot-dca-stage-b.json",
}
SCHEMA_URN = "urn:rsibot:v5-lfl:stage-a:r2:"

# Appendix wire-contract limits (frozen).
MAX_PROJECTION_RESPONSE_BYTES = 256_000  # this client's own cap; unrelated to V5Upstream / read_bridge
MAX_ERROR_BYTES = 2_048
MAX_TARGET_BYTES = 4_096
MAX_ROW_BYTES = 8_192
MAX_REF_BYTES = 512
MAX_ISSUE_BYTES = 256
MAX_DESCRIPTOR_BYTES = 1_024
MAX_ROW_NESTED_OBJECTS = 16
MAX_ROW_DEPTH = 8
MAX_VERIFICATION_AGE_MS = 90_000
MAX_FUTURE_SKEW_MS = 5_000
TOTAL_TIMEOUT_SECONDS = 4.0
SAFE_INT_MAX = 9_007_199_254_740_991
MAX_RETIRED_SNAPSHOTS = 4_096
FreshnessMiss = Literal["retired", "ignored", "expired"]

STAGE_A_DATASETS = ("manifest", "lessons", "records", "jobs")
STAGE_B_DATASETS = ("candidates", "campaigns", "assessments")
ALL_DATASETS = STAGE_A_DATASETS + STAGE_B_DATASETS
STAGE_B_REVISION = json.loads((SCHEMA_DIR / "wire-contract-stage-b.json").read_bytes())["projection_revision"]
REASON_OVERFLOW = "Reason summary truncated; inspect row issues and dataset pages."
PROJECTION_PATHS = frozenset(f"/api/v5/learning/{dataset}" for dataset in ALL_DATASETS)
MANIFEST_ORDER = ("lessons", "records", "jobs", "candidates", "campaigns", "assessments")
OWNER_PATH_PREFIX = "/api/knowledge/v5-projection/v1/"
ERROR_SCHEMA = "research_knowledge.v5_projection_error.v1"
LEGACY_UNAVAILABLE_NOTE = "Learning projection source is not configured"

# status -> codes (browser-contract.json error_mapping, wire-contract.json errors)
ERROR_STATUS_CODES: dict[int, frozenset[str]] = {
    400: frozenset({"INVALID_QUERY", "INVALID_CURSOR"}),
    404: frozenset({"ROOT_NOT_IN_SCOPE", "DATASET_NOT_ENABLED", "ROUTE_NOT_FOUND"}),
    405: frozenset({"METHOD_NOT_ALLOWED"}),
    409: frozenset({"SNAPSHOT_CHANGED"}),
    413: frozenset({"REQUEST_BODY_NOT_ALLOWED"}),
    414: frozenset({"TARGET_TOO_LONG"}),
    502: frozenset({"UPSTREAM_INVALID", "INVALID_OWNER_PROJECTION"}),
    503: frozenset(
        {
            "PROJECTION_BUSY",
            "PROJECTION_DEADLINE",
            "WARMING",
            "VERIFICATION_UNAVAILABLE",
            "PUBLICATION_UNAVAILABLE",
            "UPSTREAM_UNAVAILABLE",
        }
    ),
}
CODE_STATUS = {code: status for status, codes in ERROR_STATUS_CODES.items() for code in codes}

_HASH = re.compile(r"[0-9a-f]{64}\Z")
_RELATIVE_SEGMENT_BAD = {"", ".", ".."}
_POINTER_ESCAPE = re.compile(r"~(?![01])")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_RETRY_AFTER = re.compile(r"[0-9]{1,2}\Z")


class ContractViolation(ValueError):
    """The owner response breaks the frozen contract. Never shown to the browser verbatim."""


class QueryViolation(ValueError):
    """The browser query is invalid for its route."""


class CursorViolation(QueryViolation):
    """A recognized cursor does not meet its query schema."""


class ProjectionTransportError(RuntimeError):
    """``kind`` is ``unavailable`` (timeout / connect) or ``invalid`` (framing, size, encoding, redirect)."""

    def __init__(self, kind: str, detail: str):
        super().__init__(f"{kind}: {detail}")
        self.kind = kind


# ---------------------------------------------------------------------------
# Strict parsing and canonical JSON (appendix wire-contract.json canonical_json)
# ---------------------------------------------------------------------------


def _reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ContractViolation("duplicate JSON key")
        result[key] = value
    return result


def _reject_float(token: str) -> Any:
    raise ContractViolation("non-integer number token")


def _reject_constant(token: str) -> Any:
    raise ContractViolation("non-finite number")


def _parse_int(token: str) -> int:
    if token.startswith("-") or (len(token) > 1 and token.startswith("0")):
        raise ContractViolation("negative or padded integer")
    if len(token) > len(str(SAFE_INT_MAX)):
        raise ContractViolation("integer beyond the safe range")
    value = int(token)
    if value > SAFE_INT_MAX:
        raise ContractViolation("integer beyond the safe range")
    return value


def canonical(value: Any) -> bytes:
    """``C(value)``: sorted keys, compact, raw Unicode, unsigned integers only. Raises on lone surrogates."""
    try:
        return json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
        ).encode("utf-8")
    except (UnicodeEncodeError, ValueError, TypeError) as error:
        raise ContractViolation("value has no canonical form") from error


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def parse_strict(raw: bytes) -> Any:
    """Strict JSON: no BOM, valid UTF-8, no duplicate keys, integers only, no lone surrogates."""
    if raw.startswith(b"\xef\xbb\xbf"):
        raise ContractViolation("byte order mark")
    try:
        text = raw.decode("utf-8")
        value = json.loads(
            text,
            object_pairs_hook=_reject_duplicates,
            parse_float=_reject_float,
            parse_constant=_reject_constant,
            parse_int=_parse_int,
        )
    except UnicodeDecodeError as error:
        raise ContractViolation("invalid UTF-8") from error
    except json.JSONDecodeError as error:
        raise ContractViolation("malformed JSON") from error
    except RecursionError as error:
        raise ContractViolation("excess nesting") from error
    canonical(value)  # rejects unpaired surrogates anywhere in the tree
    return value


# ---------------------------------------------------------------------------
# Vendored JSON Schemas (verbatim) with two engine-level strictness fixes
# ---------------------------------------------------------------------------


@lru_cache(maxsize=None)
def _strict_pattern(pattern: str) -> re.Pattern[str]:
    # Python's ``$`` also matches before a trailing newline; ECMA 262 (JSON Schema) does not.
    return re.compile(re.sub(r"\$(?=\)*$)", r"\\Z", pattern))


def _pattern_keyword(validator, pattern, instance, schema):
    if validator.is_type(instance, "string") and not _strict_pattern(pattern).search(instance):
        yield ValidationError(f"{instance!r} does not match {pattern!r}")


def _max_utf8_bytes_keyword(validator, limit, instance, schema):
    if validator.is_type(instance, "string") and len(instance.encode("utf-8")) > limit:
        yield ValidationError(f"string exceeds {limit} UTF-8 bytes")


_Validator = _jsonschema_validators.extend(
    Draft202012Validator,
    {"pattern": _pattern_keyword, "x-maxUtf8Bytes": _max_utf8_bytes_keyword},
)


@lru_cache(maxsize=None)
def _registry() -> Registry:
    registry: Registry = Registry()
    for path in sorted(SCHEMA_DIR.glob("*.schema.json")):
        document = json.loads(path.read_bytes())
        registry = registry.with_resource(document["$id"], Resource.from_contents(document))
    return registry


@lru_cache(maxsize=None)
def _validator(name: str):
    schema = json.loads((SCHEMA_DIR / f"{name}.schema.json").read_bytes())
    return _Validator(schema, registry=_registry())


def schema_errors(name: str, document: Any) -> str | None:
    """First schema violation as a short description, or None when the document conforms."""
    error = next(iter(_validator(name).iter_errors(document)), None)
    if error is None:
        return None
    path = "/".join(str(part) for part in error.absolute_path)
    return f"{name}:{path}: {error.message[:120]}"


# ---------------------------------------------------------------------------
# Envelope validation
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ScopeMembership:
    program_id: str
    family_lane_pairs: tuple[tuple[str, str], ...]

    def summary(self) -> dict[str, Any]:
        return {
            "program_id": self.program_id,
            "family_lane_pairs": [{"family_id": family, "lane": lane} for family, lane in self.family_lane_pairs],
        }


def load_scope_membership(scope_id: str, scope_sha256: str) -> ScopeMembership:
    name = SCOPE_ARTIFACTS.get(scope_sha256)
    if name is None:
        raise ContractViolation("V5_LEARNING_SCOPE_SHA256 must name a pinned scope artifact")
    try:
        artifact = parse_strict((SCOPE_DIR / name).read_bytes())
    except OSError as error:
        raise ContractViolation("pinned learning scope artifact is unavailable") from error
    if sha256_hex(canonical(artifact)) != scope_sha256:
        raise ContractViolation("pinned learning scope artifact digest mismatch")
    if artifact["scope_id"] != scope_id:
        raise ContractViolation("V5_LEARNING_SCOPE_ID does not match the pinned scope artifact")
    return ScopeMembership(artifact["program_id"], tuple(
        (pair["family_id"], pair["lane"]) for pair in artifact["family_lane_pairs"]
    ))


@dataclass(frozen=True)
class ExpectedBinding:
    """What Condor was configured to accept; an envelope for anything else is rejected."""

    scope_id: str
    scope_sha256: str
    projection_revision: str
    membership: ScopeMembership


@dataclass(frozen=True)
class RequestShape:
    dataset: str
    record_type: str | None = None
    idea_revision_id: str | None = None


def _objects_below(value: Any) -> int:
    """Nested *objects* below ``value`` (arrays do not count), excluding ``value`` itself."""
    total = 0
    stack = [value]
    first = True
    while stack:
        current = stack.pop()
        if isinstance(current, dict):
            if not first:
                total += 1
            stack.extend(current.values())
        elif isinstance(current, list):
            stack.extend(current)
        first = False
    return total


def _depth(value: Any) -> int:
    if isinstance(value, dict):
        return 1 + max((_depth(child) for child in value.values()), default=0)
    if isinstance(value, list):
        return 1 + max((_depth(child) for child in value), default=0)
    return 0


def _refs_of(row: dict[str, Any]) -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = []
    for field_name in ("supersedes", "experiment_ref", "from_ref", "to_ref", "run_ref"):
        if isinstance(row.get(field_name), dict):
            refs.append(row[field_name])
    for field_name in ("outcome_refs", "contradictory_refs", "artifact_refs", "experiment_refs", "assessment_refs", "attempt_refs", "candidate_refs"):
        refs.extend(row.get(field_name) or [])
    return refs


def _safe_relative_path(path: str) -> bool:
    if path.startswith("/") or "\\" in path or "\x00" in path:
        return False
    return not any(part in _RELATIVE_SEGMENT_BAD for part in path.split("/"))


@lru_cache(maxsize=1)
def _stage_b_regions() -> dict[str, Any]:
    return json.loads((SCHEMA_DIR / "row-regions-stage-b.json").read_bytes())["variants"]


def _check_stage_b_regions(row: dict[str, Any], variant: str, context: str) -> None:
    regions = _stage_b_regions()[variant]
    fields = {
        "fixed": regions["fixed_keys"],
        "references": regions["reference_keys"],
        "row_scope": ["row_scope"],
        "sources": ["sources"],
        "issues": ["issues"],
    }
    if set(row) - {key for keys in fields.values() for key in keys}:
        raise ContractViolation(f"{context}: unbudgeted Stage-B row member")
    sizes = {region: len(canonical({key: row[key] for key in keys if key in row})) - 2 for region, keys in fields.items()}
    sizes["outer_punctuation"] = len(canonical(row)) - sum(sizes.values())
    if any(size > regions["region_caps_bytes"][region] for region, size in sizes.items()):
        raise ContractViolation(f"{context}: Stage-B row region too large")


def _check_row(row: dict[str, Any], *, context: str, variant: str | None = None) -> None:
    sources = row["sources"]
    for source in sources:
        if not _safe_relative_path(source["relative_path"]):
            raise ContractViolation(f"{context}: unsafe source path")
        pointer = source["pointer"]
        if _CONTROL.search(pointer) or _POINTER_ESCAPE.search(pointer):
            raise ContractViolation(f"{context}: bad JSON pointer")
        if len(canonical(source)) > MAX_REF_BYTES:
            raise ContractViolation(f"{context}: source receipt too large")
    refs = _refs_of(row)
    if len(refs) > 4:
        raise ContractViolation(f"{context}: more than four references")
    for ref in refs:
        if len(canonical(ref)) > MAX_REF_BYTES:
            raise ContractViolation(f"{context}: reference too large")
        if ref["source_index"] is not None and ref["source_index"] >= len(sources):
            raise ContractViolation(f"{context}: reference source index out of range")
        if ref["resolution"] == "OUT_OF_SCOPE" and (
            ref["kind"] != "OPAQUE" or ref["revision"] is not None or ref["source_index"] is not None
        ):
            raise ContractViolation(f"{context}: out-of-scope reference exposes more than an opaque ID")
    for issue in row["issues"]:
        if len(canonical(issue)) > MAX_ISSUE_BYTES:
            raise ContractViolation(f"{context}: issue too large")
    body = {key: value for key, value in row.items() if key != "row_sha256"}
    encoded = canonical(body)
    if len(encoded) + 80 > MAX_ROW_BYTES:
        raise ContractViolation(f"{context}: row exceeds {MAX_ROW_BYTES} bytes")
    if sha256_hex(encoded) != row["row_sha256"]:
        raise ContractViolation(f"{context}: row hash mismatch")
    if _objects_below(row) > MAX_ROW_NESTED_OBJECTS or _depth(row) - 1 > MAX_ROW_DEPTH:
        raise ContractViolation(f"{context}: row nesting exceeds the contract")
    if variant is not None:
        _check_stage_b_regions(row, variant, context)
        return
    if len(canonical(row["row_scope"])) > 768:
        raise ContractViolation(f"{context}: row_scope too large")
    if sum(len(canonical(source)) for source in sources) > 1_024:
        raise ContractViolation(f"{context}: source region too large")
    if sum(len(canonical(ref)) for ref in refs) > 2_048:
        raise ContractViolation(f"{context}: reference region too large")
    if sum(len(canonical(issue)) for issue in row["issues"]) > 512:
        raise ContractViolation(f"{context}: issue region too large")
    scalar_region = (
        len(canonical(row))
        - len(canonical(row["row_scope"]))
        - sum(len(canonical(source)) for source in sources)
        - sum(len(canonical(ref)) for ref in refs)
        - sum(len(canonical(issue)) for issue in row["issues"])
    )
    if scalar_region > 3_072 + 512:
        raise ContractViolation(f"{context}: scalar region exceeds the contract")


def _check_dataset_row(row: dict[str, Any], dataset: str, request: RequestShape, *, context: str) -> None:
    stub = row["row_status"] == "UNAVAILABLE"
    if dataset == "records":
        kind = row["native_kind"]
        if request.record_type == "node" and (kind == "edge" or (not stub and row.get("record_type") != "node")):
            raise ContractViolation(f"{context}: edge in a node page")
        if request.record_type == "edge" and (kind != "edge" or (not stub and row.get("record_type") != "edge")):
            raise ContractViolation(f"{context}: node in an edge page")
        if row.get("record_type") == "edge" and row["edge_id"] != row["record_id"]:
            raise ContractViolation(f"{context}: edge_id differs from record_id")
    if dataset == "jobs" and not stub:
        started, finished = row["started_at_ms"], row["finished_at_ms"]
        if started is not None and finished is not None and finished < started:
            raise ContractViolation(f"{context}: job finished before it started")
        if row["completion"] == "RECORDED" and finished is None:
            codes = {issue["code"] for issue in row["issues"]}
            if row["row_status"] != "PARTIAL" or "COMPLETION_NOT_RECORDED" not in codes:
                raise ContractViolation(f"{context}: recorded completion without a time must be PARTIAL")
    if stub:
        return
    if dataset in ("candidates", "campaigns") and row["reference_total"] is not None and row["reference_total"] < len(_refs_of(row)):
        raise ContractViolation(f"{context}: reference preview exceeds the known total")
    if dataset == "candidates":
        if row["record_id"] != row["idea_revision_id"]:
            raise ContractViolation(f"{context}: candidate does not identify its exact revision")
        tuples = []
        for field in ("experiment_refs", "assessment_refs"):
            identities = [(ref["owner"], ref["kind"], ref["record_id"], ref["revision"] or "") for ref in row[field]]
            if identities != sorted(identities):
                raise ContractViolation(f"{context}: candidate preview is not owner ordered")
            tuples.extend(identities)
        if len(tuples) != len(set(tuples)):
            raise ContractViolation(f"{context}: duplicate candidate references")
        codes = {issue["code"] for issue in row["issues"]}
        if row["reference_total"] is None and "INDEX_INCOMPLETE" not in codes:
            raise ContractViolation(f"{context}: unknown reference census has no issue")
    if dataset == "campaigns":
        prefix = "" if row["native_kind"] == "paper_campaign" else "decision:campaign:"
        if row["record_id"] != prefix + row["campaign_id"]:
            raise ContractViolation(f"{context}: campaign identity mismatch")
    if dataset == "assessments":
        if row["record_id"] != "assessment:" + row["assessment_id"] or row["idea_revision_id"] != request.idea_revision_id:
            raise ContractViolation(f"{context}: assessment identity or filter mismatch")
        comparison = row["comparison"]
        if comparison and any(comparison[key] != comparison["conditions"][key] for key in ("baseline_id", "metric", "unit")):
            raise ContractViolation(f"{context}: inconsistent comparison conditions")


def _stage_b_variant(dataset: str, row: dict[str, Any]) -> str:
    if row["row_status"] == "UNAVAILABLE":
        return "UnavailableRowStub"
    if dataset == "records":
        return "RecordEdge" if row["record_type"] == "edge" else "RecordNode"
    if dataset == "campaigns":
        return "PaperCampaign" if row["native_kind"] == "paper_campaign" else "AutonomousCampaign"
    return "Assessment" if dataset == "assessments" else "Candidate"


def _has_gap(envelope: dict[str, Any]) -> bool:
    dataset = envelope["dataset"]
    if envelope["coverage"]["state"] != "COMPLETE" or envelope["reason_codes"] or envelope["issues"]:
        return True
    coverage = envelope["coverage"]
    if coverage["unresolved_membership_items"] or coverage["omitted_items"]:
        return True
    for item in envelope["items"]:
        if dataset == "manifest":
            if item["capabilities"]["read"] and (item["availability"] != "BOUND" or item["reason_codes"]):
                return True
        elif item["row_status"] != "COMPLETE" or item["issues"]:
            return True
        elif dataset == "lessons" and item.get("contradiction_state") != "RECORDED":
            return True
    return False


def _check_stage_b_reasons(envelope: dict[str, Any]) -> None:
    actual = envelope["reason_codes"]
    visible = {issue["code"] for issue in envelope["issues"]}
    if envelope["dataset"] == "manifest":
        for descriptor in envelope["items"]:
            reasons = descriptor["reason_codes"]
            if reasons != sorted(reasons):
                raise ContractViolation("manifest descriptor reasons are not sorted")
            visible.update(reasons)
    else:
        visible.update(issue["code"] for row in envelope["items"] for issue in row["issues"])
    overflow = any(issue["code"] == "INDEX_INCOMPLETE" and issue["detail"] == REASON_OVERFLOW for issue in envelope["issues"])
    if actual != sorted(actual) or (not overflow and not visible.issubset(actual)):
        raise ContractViolation("invalid Stage-B reason summary")
    if overflow and (len(actual) != 4 or "INDEX_INCOMPLETE" not in actual or envelope["status"] == "BOUND"):
        raise ContractViolation("invalid Stage-B reason overflow marker")


def validate_envelope(
    document: Any,
    *,
    request: RequestShape,
    expected: ExpectedBinding,
    now_ms: int,
) -> dict[str, Any]:
    """Validate one 200 body. Returns the document; raises ``ContractViolation`` on any violation."""
    dataset = request.dataset
    stage_b = expected.projection_revision == STAGE_B_REVISION
    if dataset not in (ALL_DATASETS if stage_b else STAGE_A_DATASETS):
        raise ContractViolation("dataset is not enabled in the configured stage")
    name = f"{dataset}-stage-b" if stage_b and dataset in ("manifest", "records") else dataset
    problem = schema_errors(name, document)
    if problem:
        raise ContractViolation(problem)
    if document["dataset"] != dataset:
        raise ContractViolation("envelope answers a different dataset")
    if document["projection_revision"] != expected.projection_revision:
        raise ContractViolation("projection revision mismatch")
    scope = document["scope"]
    if scope is not None and (scope["scope_id"] != expected.scope_id or scope["scope_sha256"] != expected.scope_sha256):
        raise ContractViolation("scope mismatch")
    membership = expected.membership
    if scope is not None and (
        scope["program_id"] != membership.program_id
        or tuple((pair["family_id"], pair["lane"]) for pair in scope["family_lane_pairs"]) != membership.family_lane_pairs
    ):
        raise ContractViolation("scope membership differs from the pinned scope artifact")
    if any(len(canonical(issue)) > MAX_ISSUE_BYTES for issue in document["issues"]):
        raise ContractViolation("envelope issue too large")

    status = document["status"]
    items = document["items"]
    coverage = document["coverage"]
    page = document["page"]

    # Counts and pagination.
    if coverage["returned_items"] != len(items):
        raise ContractViolation("returned_items differs from items")
    total = coverage["total_items"]
    if total is not None and total < len(items):
        raise ContractViolation("total_items below returned_items")
    if page["has_more"] != (page["next_cursor"] is not None):
        raise ContractViolation("has_more disagrees with next_cursor")
    if dataset == "manifest" and (page["limit"] != 6 or page["next_cursor"] is not None):
        raise ContractViolation("manifest is unpaginated")
    if status != "UNAVAILABLE" and coverage["pending_events"] != 0:
        raise ContractViolation("pending events on an available envelope")

    # Times and freshness (BOUND/PARTIAL carry all of them; UNAVAILABLE may not).
    verified, generated, served = document["verified_at_ms"], document["generated_at_ms"], document["served_at_ms"]
    if generated is not None and verified is not None and generated > verified:
        raise ContractViolation("generated after verified")
    if verified is not None and verified > served:
        raise ContractViolation("verified after served")
    if status != "UNAVAILABLE":
        if served - verified > MAX_VERIFICATION_AGE_MS:
            raise ContractViolation("verification older than 90 s")
    for label, value in (("verified", verified), ("served", served), ("generated", generated)):
        if value is not None and value > now_ms + MAX_FUTURE_SKEW_MS:
            raise ContractViolation(f"{label} time is in the future")

    # Hash bindings.
    if status != "UNAVAILABLE":
        snapshot = canonical(
            {
                "schema": document["schema"],
                "projection_revision": document["projection_revision"],
                "scope_sha256": scope["scope_sha256"],
                "publication_sha256": document["publication_sha256"],
                "database_sha256": document["database_sha256"],
                "source_revision": document["source_revision"],
                "source_snapshot": document["source_snapshot"],
                "event_signature": document["event_signature"],
            }
        )
        if sha256_hex(snapshot) != document["snapshot_id"]:
            raise ContractViolation("snapshot_id does not bind the publication identity")
    body = {key: value for key, value in document.items() if key != "envelope_sha256"}
    if sha256_hex(canonical(body)) != document["envelope_sha256"]:
        raise ContractViolation("envelope hash mismatch")

    # Items.
    ids: list[bytes] = []
    for index, item in enumerate(items):
        context = f"{dataset}[{index}]"
        if dataset == "manifest":
            if item["dataset"] != MANIFEST_ORDER[index]:
                raise ContractViolation("manifest descriptors out of order")
            if len(canonical(item)) > MAX_DESCRIPTOR_BYTES:
                raise ContractViolation(f"{context}: descriptor too large")
            if status == "UNAVAILABLE" and (item["availability"] != "UNAVAILABLE" or item["total_items"] is not None):
                raise ContractViolation(f"{context}: unavailable manifest advertises data")
            continue
        row_scope = item["row_scope"]
        if scope is None or (row_scope["family_id"], row_scope["lane"]) not in membership.family_lane_pairs:
            raise ContractViolation(f"{context}: row family/lane is outside the pinned scope")
        program = membership.program_id
        if row_scope["program_id"] not in (None, program) or (
            row_scope["membership_basis"] == "LESSON_PROGRAM" and row_scope["program_id"] != program
        ) or ("program_id" in item and item["program_id"] != program and not (stage_b and item["program_id"] is None)):
            raise ContractViolation(f"{context}: row program is outside the pinned scope")
        recorded_scope = row_scope["recorded_scope"]
        window = recorded_scope["window"] if recorded_scope is not None else None
        if isinstance(window, dict) and window["start"] >= window["end_exclusive"]:
            raise ContractViolation(f"{context}: recorded window is not ordered")
        variant = _stage_b_variant(dataset, item) if stage_b and dataset in (*STAGE_B_DATASETS, "records") else None
        _check_row(item, context=context, variant=variant)
        _check_dataset_row(item, dataset, request, context=context)
        ids.append(item["record_id"].encode("utf-8"))
    if any(left >= right for left, right in zip(ids, ids[1:])):
        raise ContractViolation("items are not strictly ascending by record_id")

    # Status semantics.
    if status == "UNAVAILABLE" and ((items and dataset != "manifest") or page["next_cursor"] is not None):
        raise ContractViolation("unavailable envelope carries rows or continuation")
    if status == "BOUND":
        if coverage["unresolved_membership_items"] != 0 or coverage["omitted_items"] != 0 or _has_gap(document):
            raise ContractViolation("BOUND envelope hides a gap")
    if status == "PARTIAL" and not _has_gap(document):
        raise ContractViolation("PARTIAL envelope names no gap")
    if stage_b and dataset not in ("lessons", "jobs"):
        _check_stage_b_reasons(document)
    return document


def validate_error(status: int, document: Any) -> dict[str, Any]:
    """Validate a projection error body for its HTTP status."""
    problem = schema_errors("error", document)
    if problem:
        raise ContractViolation(problem)
    if document["code"] not in ERROR_STATUS_CODES.get(status, frozenset()):
        raise ContractViolation("error code does not match the HTTP status")
    return document


def error_body(code: str, snapshot_id: str | None = None) -> bytes:
    """A Condor-originated projection error, exactly the five-key owner shape."""
    status = CODE_STATUS[code]
    return json.dumps(
        {
            "schema": ERROR_SCHEMA,
            "owner": "research_os",
            "code": code,
            "retryable": status == 503,
            "snapshot_id": snapshot_id,
        },
        separators=(",", ":"),
    ).encode("utf-8")


# ---------------------------------------------------------------------------
# Browser query validation
# ---------------------------------------------------------------------------

_BAD_PERCENT = re.compile(r"%(?![0-9A-Fa-f]{2})")
_RAW_QUERY = re.compile(r"[A-Za-z0-9._~!$&'()*+,;=:@/?%\-]*\Z")


def parse_query(raw: str) -> dict[str, str]:
    """Once-decoded name/value map. Duplicates, blank values and malformed encodings are rejected."""
    if raw == "":
        return {}
    result: dict[str, str] = {}
    for part in raw.split("&"):
        name_raw, separator, value_raw = part.partition("=")
        if not name_raw or not separator or not value_raw:
            raise QueryViolation("blank query component")
        decoded = []
        for piece in (name_raw, value_raw):
            if _BAD_PERCENT.search(piece):
                raise QueryViolation("malformed percent encoding")
            try:
                decoded.append(unquote_to_bytes(piece.replace("+", " ")).decode("utf-8"))
            except UnicodeDecodeError as error:
                raise QueryViolation("query is not UTF-8") from error
        name, value = decoded
        if name in result:
            raise QueryViolation("repeated query parameter")
        result[name] = value
    return result


def validate_query(dataset: str, raw: str, scope_id: str) -> dict[str, str]:
    """Validate the decoded query; callers forward the original, not this map."""
    if not _RAW_QUERY.fullmatch(raw):
        raise QueryViolation("invalid raw query characters")
    parsed = parse_query(raw)
    if parsed.get("scope_id") != scope_id:
        raise QueryViolation("missing or mismatched scope_id")
    errors = list(_validator(f"query-{dataset}").iter_errors(parsed))
    if errors:
        if all(list(error.absolute_path) == ["cursor"] for error in errors):
            raise CursorViolation("invalid cursor")
        raise QueryViolation("query does not match the route schema")
    return parsed


# ---------------------------------------------------------------------------
# Bounded HTTP client
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class OwnerResponse:
    status: int
    body: bytes
    retry_after: str | None


class OwnerProjectionClient:
    """One GET, no retries, no redirects, identity encoding only, its own byte cap, no credentials."""

    def __init__(
        self,
        base_url: str,
        *,
        session_factory: Callable[..., Any] = aiohttp.ClientSession,
        timeout_seconds: float = TOTAL_TIMEOUT_SECONDS,
        max_bytes: int = MAX_PROJECTION_RESPONSE_BYTES,
    ):
        self.base_url = base_url
        self.session_factory = session_factory
        self.timeout_seconds = timeout_seconds
        self.max_bytes = max_bytes

    async def get(self, dataset: str, raw_query: str) -> OwnerResponse:
        target = f"{OWNER_PATH_PREFIX}{dataset}" + (f"?{raw_query}" if raw_query else "")
        if len(target.encode("utf-8")) > MAX_TARGET_BYTES:
            raise ProjectionTransportError("invalid", "target too long")
        headers = {"Accept": "application/json", "Accept-Encoding": "identity"}
        try:
            async with asyncio.timeout(self.timeout_seconds):
                timeout = aiohttp.ClientTimeout(total=self.timeout_seconds)
                async with self.session_factory(
                    timeout=timeout, auto_decompress=False, cookie_jar=aiohttp.DummyCookieJar()
                ) as session:
                    session._retry_connection = False
                    async with session.get(URL(self.base_url + target, encoded=True), headers=headers, allow_redirects=False) as response:
                        return await self._read(response)
        except (asyncio.TimeoutError, TimeoutError) as error:
            raise ProjectionTransportError("unavailable", "timeout") from error
        except (aiohttp.ClientPayloadError, aiohttp.ClientResponseError, aiohttp.InvalidURL) as error:
            raise ProjectionTransportError("invalid", "bad framing") from error
        except aiohttp.ClientError as error:
            raise ProjectionTransportError("unavailable", "connect") from error
        except OSError as error:
            raise ProjectionTransportError("unavailable", "connect") from error

    async def _read(self, response) -> OwnerResponse:
        encodings = response.headers.getall("Content-Encoding", [])
        if len(encodings) > 1 or (encodings and encodings[0].strip().lower() not in {"", "identity"}):
            raise ProjectionTransportError("invalid", "duplicate or compressed response encoding")
        media = response.headers.get("Content-Type", "").split(";")[0].strip().lower()
        if media != "application/json":
            raise ProjectionTransportError("invalid", "not JSON")
        length = response.headers.get("Content-Length")
        declared = None
        if length is not None:
            digits = length.lstrip("0") or "0"
            if not length.isascii() or not length.isdigit() or len(digits) > len(str(self.max_bytes)):
                raise ProjectionTransportError("invalid", "invalid declared length")
            declared = int(digits)
            if declared > self.max_bytes:
                raise ProjectionTransportError("invalid", "declared length beyond the cap")
        body = bytearray()
        while True:  # count the actual dechunked bytes; never trust Content-Length
            chunk = await response.content.read(self.max_bytes + 1 - len(body))
            if not chunk:
                break
            body.extend(chunk)
            if len(body) > self.max_bytes:
                raise ProjectionTransportError("invalid", "response beyond the cap")
        if declared is not None and declared != len(body):
            raise ProjectionTransportError("invalid", "length mismatch")
        retry = response.headers.getall("Retry-After", [])
        return OwnerResponse(response.status, bytes(body), retry[0] if len(retry) == 1 else None)


# ---------------------------------------------------------------------------
# Production source
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class LearningProjectionConfig:
    owner_url: str
    scope_id: str
    scope_sha256: str
    projection_revision: str
    membership: ScopeMembership

    @property
    def stage_b(self) -> bool:
        return self.projection_revision == STAGE_B_REVISION

    @property
    def expected(self) -> ExpectedBinding:
        return ExpectedBinding(self.scope_id, self.scope_sha256, self.projection_revision, self.membership)


@dataclass(frozen=True)
class ProjectionResult:
    """What the browser route sends back: exact owner bytes on success and passthrough errors."""

    status: int
    body: bytes
    retry_after: int | None = None
    freshness: FreshnessMiss | None = None


@dataclass
class Receipt:
    status: str
    expires_at: float  # monotonic seconds


def normalize_retry_after(value: str | None) -> int:
    """Exactly one ASCII decimal integer in 1..30, otherwise 1."""
    if value is not None and _RETRY_AFTER.fullmatch(value) and 1 <= int(value) <= 30:
        return int(value)
    return 1


def local_result(code: str, snapshot_id: str | None = None, *, freshness: FreshnessMiss | None = None) -> ProjectionResult:
    """A Condor-originated typed error: the five-key owner shape, Retry-After: 1 on 503."""
    status = CODE_STATUS[code]
    return ProjectionResult(status, error_body(code, snapshot_id), 1 if status == 503 else None, freshness)


class ResearchOwnerLearningSource:
    """Read-only Research OS projection source. Owns receipt expiry; holds no rows and no fixtures."""

    def __init__(
        self,
        config: LearningProjectionConfig,
        *,
        client: OwnerProjectionClient | None = None,
        clock: Callable[[], int] = lambda: time.time_ns() // 1_000_000,
        monotonic: Callable[[], float] = time.monotonic,
    ):
        self.config = config
        self.client = client or OwnerProjectionClient(config.owner_url)
        self.clock = clock
        self.monotonic = monotonic
        self._receipts: dict[str, Receipt] = {}
        self._global_max_verified_at_ms = -1
        self._current_snapshot_id: str | None = None
        self._retired_snapshots: set[str] = set()
        self._deadlines: dict[str, float] = {}

    # --- receipt state -------------------------------------------------------------------------------------

    def invalidate(self, dataset: str | None = None) -> None:
        """Drop one dataset's receipt, or all of them (transport, auth or contract failure)."""
        if dataset is None:
            self._receipts.clear()
        else:
            self._receipts.pop(dataset, None)

    def state(self) -> dict[str, str]:
        """Per-dataset status now. A receipt expires 90 s after the owner's ``verified_at_ms``; polls do not extend it."""
        now = self.monotonic()
        result = {}
        for dataset, receipt in list(self._receipts.items()):
            if now >= receipt.expires_at:
                del self._receipts[dataset]
                continue
            result[dataset] = receipt.status
        return {dataset: result.get(dataset, "UNAVAILABLE") for dataset in (ALL_DATASETS if self.config.stage_b else STAGE_A_DATASETS)}

    def receipt_expiry(self, dataset: str) -> float | None:
        """Monotonic instant at which this dataset's receipt expires, or None when there is none."""
        receipt = self._receipts.get(dataset)
        return receipt.expires_at if receipt else None

    def _accept(self, dataset: str, envelope: dict[str, Any]) -> FreshnessMiss | None:
        status = envelope["status"]
        snapshot = envelope["snapshot_id"]
        verified = envelope["verified_at_ms"]
        current = self._current_snapshot_id
        maximum = self._global_max_verified_at_ms
        if snapshot in self._retired_snapshots:
            return "retired"
        if verified is not None and (verified < maximum or (verified == maximum and snapshot != current)):
            return "ignored"
        now = self.monotonic()
        if status == "UNAVAILABLE":
            deadline = self._deadlines.get(dataset) if verified == maximum else None
            if deadline is not None and now >= deadline:
                return "expired"
            self.invalidate(dataset)
            return None
        if verified > maximum:
            if current is not None and snapshot != current:
                if len(self._retired_snapshots) >= MAX_RETIRED_SNAPSHOTS:
                    return "ignored"
                self._retired_snapshots.add(current)
                self.invalidate()
            self._current_snapshot_id = snapshot
            self._global_max_verified_at_ms = verified
            self._deadlines.clear()
        remaining_ms = MAX_VERIFICATION_AGE_MS - (envelope["served_at_ms"] - verified)
        expires_at = self._deadlines.setdefault(dataset, now + remaining_ms / 1000)
        if now >= expires_at:
            return "expired"
        self._receipts[dataset] = Receipt(status, expires_at)
        return None

    # --- reads ---------------------------------------------------------------------------------------------

    async def read(
        self, dataset: str, raw_query: str, *, disconnected: Callable[[], Awaitable[bool]] | None = None,
    ) -> ProjectionResult:
        """One browser request -> at most one owner request. No retry, no cache hit, no fallback."""
        if dataset in STAGE_B_DATASETS and not self.config.stage_b:
            return local_result("DATASET_NOT_ENABLED")  # checked before query validation, like the owner
        if dataset not in ALL_DATASETS:
            return local_result("ROUTE_NOT_FOUND")
        try:
            parsed = validate_query(dataset, raw_query, self.config.scope_id)
        except CursorViolation:
            return local_result("INVALID_CURSOR")
        except QueryViolation:
            return local_result("INVALID_QUERY")
        try:
            response = await self.client.get(dataset, raw_query)
        except ProjectionTransportError as error:
            if disconnected is not None and await disconnected():
                return local_result("UPSTREAM_UNAVAILABLE")
            logger.warning("learning projection %s transport failure: %s", dataset, error)
            self.invalidate()
            return local_result("UPSTREAM_UNAVAILABLE" if error.kind == "unavailable" else "INVALID_OWNER_PROJECTION")
        if disconnected is not None and await disconnected():
            return local_result("UPSTREAM_UNAVAILABLE")
        try:
            return self._interpret(dataset, parsed, response)
        except ContractViolation as violation:
            logger.warning("learning projection %s rejected: %s", dataset, violation)
            self.invalidate()
            return local_result("INVALID_OWNER_PROJECTION")

    def _interpret(self, dataset: str, parsed: dict[str, str], response: OwnerResponse) -> ProjectionResult:
        if response.status == 200:
            document = parse_strict(response.body)
            request = RequestShape(dataset, parsed.get("record_type"), parsed.get("idea_revision_id"))
            envelope = validate_envelope(document, request=request, expected=self.config.expected, now_ms=self.clock())
            miss = self._accept(dataset, envelope)
            if miss is not None:
                code = "SNAPSHOT_CHANGED" if miss == "retired" else "VERIFICATION_UNAVAILABLE"
                return local_result(code, envelope["snapshot_id"], freshness=miss)
            return ProjectionResult(200, response.body)
        if response.status not in ERROR_STATUS_CODES:
            raise ContractViolation("unknown upstream status")
        if len(response.body) > MAX_ERROR_BYTES:
            raise ContractViolation("error body too large")
        validate_error(response.status, parse_strict(response.body))
        self.invalidate(dataset)
        retry = normalize_retry_after(response.retry_after) if response.status == 503 else None
        return ProjectionResult(response.status, response.body, retry)


# ---------------------------------------------------------------------------
# Browser routes: /api/v5/learning/{manifest,lessons,records,jobs,candidates,campaigns,assessments}
# ---------------------------------------------------------------------------

def _response(result: ProjectionResult, *, extra: dict[str, str] | None = None) -> Response:
    headers = {"Cache-Control": "no-store"}
    if result.retry_after is not None:
        headers["Retry-After"] = str(result.retry_after)
    if result.freshness is not None:
        headers["X-V5-Projection-Freshness"] = result.freshness
    if extra:
        headers.update(extra)
    return Response(content=result.body, status_code=result.status, media_type="application/json", headers=headers)


def add_projection_routes(router: APIRouter, projection: ResearchOwnerLearningSource | None, *, skip: tuple[str, ...] = ()) -> None:
    """Register the projection routes on an authenticated router.

    Precedence matches the appendix: target length 414, method 405, body framing 413, then the read. With no
    configured source, Stage-A routes answer a typed 503 PUBLICATION_UNAVAILABLE (never a fixture) and Stage-B
    routes the same typed 404 DATASET_NOT_ENABLED they answer when configured.
    """

    def make(dataset: str):
        async def handle(request: Request) -> Response:
            raw_query = request.scope.get("query_string", b"")
            target = request.scope.get("raw_path") or request.url.path.encode("utf-8")
            if len(target) + (len(raw_query) + 1 if raw_query else 0) > MAX_TARGET_BYTES:
                return _response(local_result("TARGET_TOO_LONG"))
            if request.method != "GET":
                return _response(local_result("METHOD_NOT_ALLOWED"), extra={"Allow": "GET"})
            if "transfer-encoding" in request.headers or request.headers.getlist("content-length") not in ([], ["0"]):
                return _response(local_result("REQUEST_BODY_NOT_ALLOWED"))
            if dataset in STAGE_B_DATASETS:
                return _response(local_result("DATASET_NOT_ENABLED"))
            if projection is None:
                return _response(local_result("PUBLICATION_UNAVAILABLE"))
            try:
                query = raw_query.decode("ascii")
            except UnicodeDecodeError:
                return _response(local_result("INVALID_QUERY"))
            return _response(await projection.read(dataset, query, disconnected=request.is_disconnected))

        handle.__name__ = f"learning_projection_{dataset}"
        return handle

    for dataset in ALL_DATASETS:
        if dataset not in skip:
            router.add_api_route(
                f"/{dataset}", make(dataset), methods=[], include_in_schema=False,
                generate_unique_id_function=lambda route: route.name,
            )
