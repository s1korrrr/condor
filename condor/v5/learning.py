"""Bounded fixture-only read projections, not a knowledge store or dispatcher.

Owner envelopes follow rsibot 798ea9b4da65006e3010597ea55fe527a0b80ffc. The consumer checks integrity, identity,
scope and displayed fields; canonical semantic validation stays with the owner.
"""

import hashlib
import json
import re

from fastapi import APIRouter, Depends, HTTPException, Request

from .roles import ROLE_SPECS, resolve_role

MAX_BYTES = 262144
MAX_RECORDS = 64
ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
HASH = re.compile(r"^[a-f0-9]{64}$")
OWNERS = {
    "lesson_revision": "research_os",
    "knowledge_release": "research_os",
    "adoption": "research_os",
    "retraction": "research_os",
    "agent_job": "research_os",
    "candidate_revision": "research_os",
    "experience_ref": "research_os",
    "opportunity": "hummingbot",
    "agent_message": "hummingbot_api",
    "forecast": "quants_lab",
    "forecast_evaluation": "quants_lab",
    "event": "quants_lab",
}
REFERENCE_OWNERS = {
    **OWNERS,
    "evidence": "research_os",
    "input_snapshot": "hummingbot",
    "inventory": "hummingbot",
    "critic_receipt": "hummingbot_api",
    "model": "quants_lab",
    "calibrator": "quants_lab",
    "candidate_library": "research_os",
    "program": "research_os",
    "idea_revision": "research_os",
    "native_receipt": "hummingbot",
    "outcome": "research_os",
    "policy": "hummingbot",
    "campaign": "research_os",
    "job_admission": "research_os",
    "strategy_selection_proposal": "hummingbot_api",
    **{kind: "quants_lab" for kind in ("feature", "regime", "target")},
    **{
        kind: "research_os"
        for kind in (
            "prompt",
            "skill",
            "retrieval_index",
            "rights_retraction",
            "source",
        )
    },
    **{
        kind: "research_os"
        for kind in (
            "experiment",
            "run",
            "assessment",
            "metrics",
            "report",
            "artifact_bundle",
        )
    },
}
RELEASE_BINDINGS = (
    "candidate_library_ref",
    "models",
    "features",
    "regimes",
    "targets",
    "prompts",
    "skills",
    "calibrators",
    "retrieval_index_ref",
    "rights_retraction_ref",
)


def release_bindings(data):
    manifest = data.get("consumer_manifest")
    if not isinstance(manifest, dict):
        return list(RELEASE_BINDINGS), []
    missing = [key for key in RELEASE_BINDINGS if key not in manifest]
    if missing:
        return missing, []
    if set(manifest) != set(RELEASE_BINDINGS) or hashlib.sha256(
        bounded(manifest)
    ).hexdigest() != data.get("manifest_sha256"):
        raise ValueError("consumer manifest digest or fields mismatch")
    rows = []
    for key in RELEASE_BINDINGS:
        component = manifest[key]
        if key.endswith("_ref"):
            refs = references([component])
            expected = key.removesuffix("_ref")
            absence = None
        else:
            if not isinstance(component, dict) or set(component) != {
                "refs",
                "absence_reason",
            }:
                raise ValueError("invalid release component binding")
            refs = references(component["refs"])
            expected = {"features": "feature", "calibrators": "calibrator"}.get(
                key, key[:-1]
            )
            absence = component["absence_reason"]
            if (not refs and not absence) or (refs and absence is not None):
                raise ValueError("release requires refs or explicit absence")
            if absence is not None:
                text(absence)
        if any(ref["record_kind"] != expected for ref in refs):
            raise ValueError("release component kind mismatch")
        rows.append({"component": key, "refs": refs, "absence_reason": absence})
    if manifest["retrieval_index_ref"]["content_sha256"] != data.get(
        "retrieval_index_sha256"
    ):
        raise ValueError("retrieval digest mismatch")
    rights = {key: data.get(key) for key in ("rights_version", "retraction_digest")}
    if (
        manifest["rights_retraction_ref"]["content_sha256"]
        != hashlib.sha256(bounded(rights)).hexdigest()
    ):
        raise ValueError("rights/retraction digest mismatch")
    if manifest["calibrators"]["refs"] != data.get("calibrator_refs"):
        raise ValueError("calibrator binding mismatch")
    for key, digest_key in (
        ("prompts", "prompt_revision_hashes"),
        ("skills", "skill_revision_hashes"),
    ):
        if [ref["content_sha256"] for ref in manifest[key]["refs"]] != data.get(
            digest_key
        ):
            raise ValueError("prompt/skill binding mismatch")
    missing = []
    for key, expected in (
        ("lesson_refs", "lesson_revision"),
        ("candidate_refs", "candidate_revision"),
        ("forecast_refs", "forecast"),
        ("calibrator_refs", "calibrator"),
        ("review_refs", "assessment"),
    ):
        if any(ref["record_kind"] != expected for ref in references(data.get(key, []))):
            raise ValueError("release reference kind mismatch")
    forecasts = references(data.get("forecast_refs", []))
    bindings = data.get("forecast_target_bindings", [])
    if not isinstance(bindings, list) or len(bindings) > 256:
        raise ValueError("invalid forecast target binding collection")
    bound_forecasts, bound_targets = [], set()
    for binding in bindings:
        if not isinstance(binding, dict) or set(binding) != {
            "forecast_ref",
            "target_ref",
        }:
            raise ValueError("invalid forecast target binding")
        forecast, target = references([binding["forecast_ref"], binding["target_ref"]])
        if forecast["record_kind"] != "forecast" or target["record_kind"] != "target":
            raise ValueError("forecast target binding kind mismatch")
        bound_forecasts.append(bounded(forecast))
        bound_targets.add(bounded(target))
    if sorted(map(bounded, forecasts)) != sorted(bound_forecasts) or len(
        set(bound_forecasts)
    ) != len(bound_forecasts):
        raise ValueError("release requires exact forecast target coverage")
    if forecasts and (
        not manifest["targets"]["refs"]
        or set(map(bounded, manifest["targets"]["refs"])) != bound_targets
        or not manifest["models"]["refs"]
        or not manifest["features"]["refs"]
    ):
        raise ValueError("forecast targets, models or features incomplete")
    if data.get("state") in {"VALIDATED", "PUBLISHED"}:
        for key in ("lesson_refs", "review_refs", "required_consumer_versions"):
            if not data.get(key):
                missing.append(key)
    if data.get("state") == "PUBLISHED":
        for key in ("role_revision_hashes", "schema_digests"):
            if not data.get(key):
                missing.append(key)
        missing.extend(
            key
            for key in RELEASE_BINDINGS
            if not key.endswith("_ref") and not manifest[key]["refs"]
        )
    return missing, rows


def clock(value):
    if type(value) is not int or not 0 <= value <= 9007199254740991:
        raise ValueError("invalid projection clock or counter")
    return value


def text(value, *, identifier=False):
    if not isinstance(value, str) or not 0 < len(value) <= 4096:
        raise ValueError("invalid projection text")
    if identifier and not ID.fullmatch(value):
        raise ValueError("invalid identifier")
    return value


def bounded(value, *, max_bytes=MAX_BYTES):
    def check(item, depth=0):
        if depth > 24:
            raise ValueError("projection nesting limit")
        if item is None or type(item) in (str, bool):
            return
        if type(item) is int:
            clock(item)
            return
        if type(item) is list:
            if len(item) > 256:
                raise ValueError("projection collection limit")
            for child in item:
                check(child, depth + 1)
            return
        if type(item) is dict and all(type(key) is str for key in item):
            for child in item.values():
                check(child, depth + 1)
            return
        raise ValueError("projection requires JSON without floats")

    try:
        check(value)
        encoded = json.dumps(
            value,
            sort_keys=True,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        ).encode()
    except (TypeError, UnicodeError, OverflowError, RecursionError) as error:
        raise ValueError("invalid projection JSON") from error
    if len(encoded) > max_bytes:
        raise ValueError("projection byte limit")
    return encoded


def references(value):
    if not isinstance(value, list) or len(value) > 64:
        raise ValueError("invalid reference collection")
    result = []
    for reference in value:
        if not isinstance(reference, dict) or set(reference) != {
            "owner",
            "record_kind",
            "record_id",
            "revision",
            "content_sha256",
            "available_at_ms",
        }:
            raise ValueError("invalid reference")
        kind = text(reference["record_kind"], identifier=True)
        expected = REFERENCE_OWNERS.get(kind)
        if expected is None or reference["owner"] != expected:
            raise ValueError("reference owner mismatch")
        if reference["owner"] not in {
            "research_os",
            "hummingbot",
            "hummingbot_api",
            "quants_lab",
        }:
            raise ValueError("invalid reference owner")
        text(reference["record_id"], identifier=True)
        text(reference["revision"], identifier=True)
        if not isinstance(reference["content_sha256"], str) or not HASH.fullmatch(
            reference["content_sha256"]
        ):
            raise ValueError("invalid reference digest")
        clock(reference["available_at_ms"])
        result.append(dict(reference))
    return result


def owner_record(value, kind=None):
    bounded(value)
    if not isinstance(value, dict):
        raise ValueError("invalid owner envelope")
    name = value.get("schema_name")
    if (
        not isinstance(name, str)
        or name not in OWNERS
        or (kind is not None and name != kind)
    ):
        raise ValueError("unsupported owner schema")
    if (
        value.get("schema_version") != ("2" if name == "lesson_revision" else "1")
        or value.get("producer_owner") != OWNERS[name]
    ):
        raise ValueError("owner schema identity mismatch")
    if value.get("execution_authorized") is not False:
        raise ValueError("authorizing envelope rejected")
    text(value.get("record_id"), identifier=True)
    text(value.get("correlation_id"), identifier=True)
    revision = value.get("producer_revision")
    if not isinstance(revision, str) or not re.fullmatch(
        r"(?:[a-f0-9]{40}|[a-f0-9]{64})", revision
    ):
        raise ValueError("invalid producer revision")
    if clock(value.get("created_at_ms")) > clock(value.get("available_at_ms")):
        raise ValueError("invalid owner clock order")
    references(value.get("parent_refs"))
    references(value.get("evidence_refs"))
    digest = hashlib.sha256(
        bounded({key: child for key, child in value.items() if key != "payload_sha256"})
    ).hexdigest()
    if value.get("payload_sha256") != digest or not isinstance(value.get("data"), dict):
        raise ValueError("owner payload integrity mismatch")
    return value["data"]


def source_page(payload, expected_scope, now_ms):
    bounded(payload)
    if (
        not isinstance(payload, dict)
        or payload.get("schema_version") != "condor-learning-source.v1"
    ):
        raise ValueError("unsupported source projection")
    if not expected_scope or payload.get("scope") != expected_scope:
        raise ValueError("projection scope mismatch")
    generated = clock(payload.get("generated_at_ms"))
    expiry = clock(payload.get("fresh_until_ms"))
    if generated > clock(now_ms) or expiry < generated:
        raise ValueError("invalid source clock")
    text(payload.get("source_generation"), identifier=True)
    records = payload.get("records")
    if not isinstance(records, list) or len(records) > MAX_RECORDS:
        raise ValueError("owner page limit")
    identities = set()
    for value in records:
        owner_record(value)
        if value["available_at_ms"] > generated:
            raise ValueError("record unavailable at source generation")
        if value["record_id"] in identities:
            raise ValueError("duplicate owner record")
        identities.add(value["record_id"])
        if "scope" in value["data"] and value["data"]["scope"] != expected_scope:
            raise ValueError("record scope mismatch")
    return records, "STALE" if now_ms > expiry else "FIXTURE_ONLY"


def project_learning_manifest(owner_payload, expected_scope, *, now_ms):
    records, status = source_page(owner_payload, expected_scope, now_ms)
    result = {
        "schema_version": "condor-learning-projection.v1",
        "status": status,
        "source_generation": owner_payload["source_generation"],
        "generated_at_ms": owner_payload["generated_at_ms"],
        "fresh_until_ms": owner_payload["fresh_until_ms"],
        "scope": expected_scope,
        "effect": "NONE",
        "usage": "NOT_DISPATCHED",
        "native_execution": "UNKNOWN",
        "lessons": [],
        "releases": [],
        "adoptions": [],
        "retractions": [],
    }
    fields = {
        "lesson_revision": (
            "lessons",
            (
                "lesson_id",
                "revision",
                "claim",
                "condition",
                "evidence_validity",
                "lifecycle_state",
            ),
            ("support_refs", "contradictory_refs", "retraction_refs"),
        ),
        "knowledge_release": (
            "releases",
            ("release_id", "state", "scope_of_use"),
            ("lesson_refs", "review_refs"),
        ),
        "adoption": ("adoptions", ("consumer_id", "disposition", "reason"), ()),
        "retraction": ("retractions", ("reason", "reviewer_id"), ("affected_refs",)),
    }
    for value in records:
        kind = value["schema_name"]
        if kind not in fields:
            raise ValueError("unexpected learning record")
        collection, strings, refs = fields[kind]
        data = value["data"]
        row = {
            "record_id": value["record_id"],
            "payload_sha256": value["payload_sha256"],
            "available_at_ms": value["available_at_ms"],
            "evidence_refs": references(value["evidence_refs"]),
        }
        row.update({field: text(data.get(field)) for field in strings})
        row.update({field: references(data.get(field)) for field in refs})
        if kind == "adoption":
            row["new_release_ref"] = references([data.get("new_release_ref")])[0]
            row["effective_decision_boundary_ms"] = clock(
                data.get("effective_decision_boundary_ms")
            )
            if (
                row["effective_decision_boundary_ms"]
                < row["new_release_ref"]["available_at_ms"]
            ):
                raise ValueError("adoption precedes release availability")
        if kind == "knowledge_release":
            row["missing_bindings"], row["bindings"] = release_bindings(data)
            row["binding_status"] = (
                "BLOCKED_INCOMPLETE"
                if row["missing_bindings"]
                else "OWNER_VALIDATION_REQUIRED"
            )
        if kind == "retraction":
            row["effective_at_ms"] = clock(data.get("effective_at_ms"))
        result[collection].append(row)
    bounded(result)
    return result


class FixtureLearningAPI:
    def __init__(self, *, manifest=None, research=None, scope=None, workflows=None):
        from .workflows import FixtureWorkflowRequests

        self.manifest = manifest
        self.research = research
        self.scope = scope
        self.workflows = FixtureWorkflowRequests(workflows)


def learning_router(*, source, require_auth, check_origin, now):
    from .research import project_research

    router = APIRouter(prefix="/api/v5/learning", dependencies=[Depends(require_auth)])

    @router.get("/roles")
    async def roles():
        return {
            "roles": [resolve_role(role, {}) for role in ROLE_SPECS],
            "effect": "NONE",
            "enabled": False,
        }

    @router.get("/manifest")
    async def manifest():
        if source.manifest is None:
            return {
                "status": "UNAVAILABLE",
                "reason": "Learning owner is not bound; Stage 1 disabled",
                "effect": "NONE",
            }
        try:
            return project_learning_manifest(
                source.manifest, source.scope, now_ms=now()
            )
        except ValueError as error:
            raise HTTPException(
                502, detail={"code": "INVALID_LEARNING_PROJECTION"}
            ) from error

    @router.get("/research")
    async def research(cursor: int = 0, limit: int = 25):
        if source.research is None:
            return {
                "status": "UNAVAILABLE",
                "reason": "Research owner is not bound; Stage 1 disabled",
                "effect": "NONE",
            }
        try:
            return project_research(
                source.research, source.scope, now_ms=now(), cursor=cursor, limit=limit
            )
        except ValueError as error:
            raise HTTPException(
                502, detail={"code": "INVALID_RESEARCH_PROJECTION"}
            ) from error

    @router.post("/workflows")
    async def workflow(request: Request):
        check_origin(request)
        if not source.workflows.available:
            raise HTTPException(503, detail={"code": "STAGE1_DISPATCH_DISABLED"})
        try:
            return source.workflows.request(await request.json())
        except (ValueError, TypeError) as error:
            raise HTTPException(
                422, detail={"code": "INVALID_FIXED_WORKFLOW"}
            ) from error

    return router
