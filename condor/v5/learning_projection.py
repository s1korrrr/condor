"""Condor binding for the frozen V5 Learning / Factory / Lineage Stage-A projection.

Read-only, authority NONE. Contract: rsibot ``1d8c0ab6`` (design §5 and the appendix vendored verbatim in
``schemas/learning_projection``). Four parts:

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
from typing import Any, Callable
from urllib.parse import quote, unquote_to_bytes

import aiohttp
from fastapi import APIRouter, Request, Response
from jsonschema import Draft202012Validator, ValidationError
from jsonschema import validators as _jsonschema_validators
from referencing import Registry, Resource

logger = logging.getLogger(__name__)

SCHEMA_DIR = Path(__file__).resolve().parent / "schemas" / "learning_projection"
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

STAGE_A_DATASETS = ("manifest", "lessons", "records", "jobs")
STAGE_B_DATASETS = ("candidates", "campaigns", "assessments")
ALL_DATASETS = STAGE_A_DATASETS + STAGE_B_DATASETS
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
class ExpectedBinding:
    """What Condor was configured to accept; an envelope for anything else is rejected."""

    scope_id: str
    scope_sha256: str
    projection_revision: str


@dataclass(frozen=True)
class RequestShape:
    dataset: str
    record_type: str | None = None


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
    for field_name in ("supersedes", "experiment_ref", "from_ref", "to_ref"):
        if isinstance(row.get(field_name), dict):
            refs.append(row[field_name])
    for field_name in ("outcome_refs", "contradictory_refs", "artifact_refs"):
        refs.extend(row.get(field_name) or [])
    return refs


def _safe_relative_path(path: str) -> bool:
    if path.startswith("/") or "\\" in path or "\x00" in path:
        return False
    return not any(part in _RELATIVE_SEGMENT_BAD for part in path.split("/"))


def _check_row(row: dict[str, Any], *, context: str) -> None:
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
    if len(encoded) + 76 > MAX_ROW_BYTES:  # 76 = ,"row_sha256":"<64>"
        raise ContractViolation(f"{context}: row exceeds {MAX_ROW_BYTES} bytes")
    if sha256_hex(encoded) != row["row_sha256"]:
        raise ContractViolation(f"{context}: row hash mismatch")
    if len(canonical(row["row_scope"])) > 768:
        raise ContractViolation(f"{context}: row_scope too large")
    if sum(len(canonical(source)) for source in sources) > 1_024:
        raise ContractViolation(f"{context}: source region too large")
    if sum(len(canonical(ref)) for ref in refs) > 2_048:
        raise ContractViolation(f"{context}: reference region too large")
    if sum(len(canonical(issue)) for issue in row["issues"]) > 512:
        raise ContractViolation(f"{context}: issue region too large")
    if _objects_below(row) > MAX_ROW_NESTED_OBJECTS or _depth(row) - 1 > MAX_ROW_DEPTH:
        raise ContractViolation(f"{context}: row nesting exceeds the contract")
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


def validate_envelope(
    document: Any,
    *,
    request: RequestShape,
    expected: ExpectedBinding,
    now_ms: int,
) -> dict[str, Any]:
    """Validate one 200 body. Returns the document; raises ``ContractViolation`` on any violation."""
    dataset = request.dataset
    if dataset not in STAGE_A_DATASETS:
        raise ContractViolation("dataset has no Stage-A success schema")
    problem = schema_errors(dataset, document)
    if problem:
        raise ContractViolation(problem)
    if document["dataset"] != dataset:
        raise ContractViolation("envelope answers a different dataset")
    if document["projection_revision"] != expected.projection_revision:
        raise ContractViolation("projection revision mismatch")
    scope = document["scope"]
    if scope is not None and (scope["scope_id"] != expected.scope_id or scope["scope_sha256"] != expected.scope_sha256):
        raise ContractViolation("scope mismatch")

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
        _check_row(item, context=context)
        _check_dataset_row(item, dataset, request, context=context)
        ids.append(item["record_id"].encode("utf-8"))
    if any(left >= right for left, right in zip(ids, ids[1:])):
        raise ContractViolation("items are not strictly ascending by record_id")

    # Status semantics.
    if status == "UNAVAILABLE" and (items and dataset != "manifest"):
        raise ContractViolation("unavailable envelope carries rows")
    if status == "BOUND":
        if coverage["unresolved_membership_items"] != 0 or coverage["omitted_items"] != 0 or _has_gap(document):
            raise ContractViolation("BOUND envelope hides a gap")
    if status == "PARTIAL" and not _has_gap(document):
        raise ContractViolation("PARTIAL envelope names no gap")
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


def prepare_query(dataset: str, raw: str, scope_id: str) -> str:
    """Validate a browser query and return the raw query to forward.

    The browser does not know the scope ID before it reads the manifest, so Condor appends its configured
    ``scope_id`` when absent. A supplied ``scope_id`` must equal the configured one. Everything else is forwarded
    byte-for-byte; the owner remains authoritative.
    """
    parsed = parse_query(raw)
    forwarded = raw
    if "scope_id" not in parsed:
        forwarded = f"{raw}&" if raw else ""
        forwarded += "scope_id=" + quote(scope_id, safe="")
        parsed["scope_id"] = scope_id
    elif parsed["scope_id"] != scope_id:
        raise QueryViolation("scope_id is not the configured scope")
    problem = schema_errors(f"query-{dataset}", parsed)
    if problem:
        raise QueryViolation(problem)
    return forwarded


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
                    async with session.get(self.base_url + target, headers=headers, allow_redirects=False) as response:
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
        encoding = response.headers.get("Content-Encoding", "identity").strip().lower()
        if encoding not in {"", "identity"}:
            raise ProjectionTransportError("invalid", "compressed response")
        media = response.headers.get("Content-Type", "").split(";")[0].strip().lower()
        if media != "application/json":
            raise ProjectionTransportError("invalid", "not JSON")
        declared = response.headers.get("Content-Length")
        if declared is not None and (not declared.isdigit() or int(declared) > self.max_bytes):
            raise ProjectionTransportError("invalid", "declared length beyond the cap")
        body = bytearray()
        while True:  # count the actual dechunked bytes; never trust Content-Length
            chunk = await response.content.read(self.max_bytes + 1 - len(body))
            if not chunk:
                break
            body.extend(chunk)
            if len(body) > self.max_bytes:
                raise ProjectionTransportError("invalid", "response beyond the cap")
        if declared is not None and int(declared) != len(body):
            raise ProjectionTransportError("invalid", "length mismatch")
        return OwnerResponse(response.status, bytes(body), response.headers.get("Retry-After"))


# ---------------------------------------------------------------------------
# Production source
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class LearningProjectionConfig:
    owner_url: str
    scope_id: str
    scope_sha256: str
    projection_revision: str

    @property
    def expected(self) -> ExpectedBinding:
        return ExpectedBinding(self.scope_id, self.scope_sha256, self.projection_revision)


@dataclass(frozen=True)
class ProjectionResult:
    """What the browser route sends back: exact owner bytes on success and passthrough errors."""

    status: int
    body: bytes
    retry_after: int | None = None


@dataclass
class Receipt:
    snapshot_id: str
    verified_at_ms: int
    status: str
    expires_at: float  # monotonic seconds


def normalize_retry_after(value: str | None) -> int:
    """Exactly one ASCII decimal integer in 1..30, otherwise 1."""
    if value is not None and _RETRY_AFTER.fullmatch(value) and 1 <= int(value) <= 30:
        return int(value)
    return 1


def local_result(code: str, snapshot_id: str | None = None) -> ProjectionResult:
    """A Condor-originated typed error: the five-key owner shape, Retry-After: 1 on 503."""
    status = CODE_STATUS[code]
    return ProjectionResult(status, error_body(code, snapshot_id), 1 if status == 503 else None)


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
        return {dataset: result.get(dataset, "UNAVAILABLE") for dataset in STAGE_A_DATASETS}

    def receipt_expiry(self, dataset: str) -> float | None:
        """Monotonic instant at which this dataset's receipt expires, or None when there is none."""
        receipt = self._receipts.get(dataset)
        return receipt.expires_at if receipt else None

    def _accept(self, dataset: str, envelope: dict[str, Any]) -> None:
        status = envelope["status"]
        if status == "UNAVAILABLE":
            self.invalidate(dataset)
            return
        snapshot = envelope["snapshot_id"]
        verified = envelope["verified_at_ms"]
        previous = self._receipts.get(dataset)
        if previous and previous.snapshot_id == snapshot and verified < previous.verified_at_ms:
            raise ContractViolation("verification time went backwards for one snapshot")
        remaining_ms = MAX_VERIFICATION_AGE_MS - (envelope["served_at_ms"] - verified)
        expires_at = self.monotonic() + remaining_ms / 1000
        if previous and previous.snapshot_id == snapshot and previous.verified_at_ms == verified:
            expires_at = min(expires_at, previous.expires_at)  # same verification: a poll cannot extend it
        for other, receipt in list(self._receipts.items()):
            if other != dataset and receipt.snapshot_id != snapshot:
                del self._receipts[other]  # the generation changed: drop what belonged to the old one
        self._receipts[dataset] = Receipt(snapshot, verified, status, expires_at)

    # --- reads ---------------------------------------------------------------------------------------------

    async def read(self, dataset: str, raw_query: str) -> ProjectionResult:
        """One browser request -> at most one owner request. No retry, no cache hit, no fallback."""
        if dataset in STAGE_B_DATASETS:
            return local_result("DATASET_NOT_ENABLED")  # checked before query validation, like the owner
        if dataset not in STAGE_A_DATASETS:
            return local_result("ROUTE_NOT_FOUND")
        try:
            forwarded = prepare_query(dataset, raw_query, self.config.scope_id)
            parsed = parse_query(forwarded)
        except QueryViolation:
            return local_result("INVALID_QUERY")
        try:
            response = await self.client.get(dataset, forwarded)
        except ProjectionTransportError as error:
            logger.warning("learning projection %s transport failure: %s", dataset, error)
            self.invalidate()
            return local_result("UPSTREAM_UNAVAILABLE" if error.kind == "unavailable" else "INVALID_OWNER_PROJECTION")
        try:
            return self._interpret(dataset, parsed, response)
        except ContractViolation as violation:
            logger.warning("learning projection %s rejected: %s", dataset, violation)
            self.invalidate()
            return local_result("INVALID_OWNER_PROJECTION")

    def _interpret(self, dataset: str, parsed: dict[str, str], response: OwnerResponse) -> ProjectionResult:
        if response.status == 200:
            document = parse_strict(response.body)
            request = RequestShape(dataset, parsed.get("record_type"))
            envelope = validate_envelope(document, request=request, expected=self.config.expected, now_ms=self.clock())
            self._accept(dataset, envelope)
            return ProjectionResult(200, response.body)
        if response.status not in ERROR_STATUS_CODES:
            raise ContractViolation("unknown upstream status")
        if len(response.body) > MAX_ERROR_BYTES:
            raise ContractViolation("error body too large")
        document = validate_error(response.status, parse_strict(response.body))
        self.invalidate(dataset)
        retry = normalize_retry_after(response.retry_after) if response.status == 503 else None
        return ProjectionResult(response.status, response.body, retry)


# ---------------------------------------------------------------------------
# Browser routes: /api/v5/learning/{manifest,lessons,records,jobs,candidates,campaigns,assessments}
# ---------------------------------------------------------------------------

ROUTE_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]


def _response(result: ProjectionResult, *, extra: dict[str, str] | None = None) -> Response:
    headers = {"Cache-Control": "no-store"}
    if result.retry_after is not None:
        headers["Retry-After"] = str(result.retry_after)
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
            if "transfer-encoding" in request.headers or request.headers.get("content-length", "0") != "0":
                return _response(local_result("REQUEST_BODY_NOT_ALLOWED"))
            try:
                query = raw_query.decode("ascii")
            except UnicodeDecodeError:
                return _response(local_result("INVALID_QUERY"))
            if projection is None:
                code = "DATASET_NOT_ENABLED" if dataset in STAGE_B_DATASETS else "PUBLICATION_UNAVAILABLE"
                return _response(local_result(code))
            return _response(await projection.read(dataset, query))

        handle.__name__ = f"learning_projection_{dataset}"
        return handle

    for dataset in ALL_DATASETS:
        if dataset not in skip:
            router.add_api_route(f"/{dataset}", make(dataset), methods=ROUTE_METHODS, include_in_schema=False)
