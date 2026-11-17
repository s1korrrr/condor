import asyncio
import json
import time
from hashlib import sha256

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from condor.v5 import learning_projection as lp
from condor.v5.config import ConfigurationError, _learning_projection_config
from condor.v5.learning import FixtureLearningAPI, learning_router


def read(path):
    return (lp.SCHEMA_DIR / path).read_bytes()


INDEX = json.loads(read("golden-index-stage-b.json"))["examples"]
HASHES = json.loads(read("golden-hashes-stage-b.json"))
MANIFEST = json.loads(read("examples/stage-b/manifest.json"))
BASE_TIME = MANIFEST["served_at_ms"]
REVISION = MANIFEST["projection_revision"]
SCOPE = MANIFEST["scope"]
MEMBERSHIP = lp.ScopeMembership(
    SCOPE["program_id"], tuple((pair["family_id"], pair["lane"]) for pair in SCOPE["family_lane_pairs"])
)
ERRORS = [entry for entry in json.loads(read("golden-index.json"))["examples"] if entry["status"] not in (200, 401)]
ASSESSMENTS = "examples/stage-b/assessments-supported.json"
CHANGED_SEAL = "examples/stage-b/campaigns-seal-integrity-failure.json"
STAGE_A_REVISION = json.loads(read("wire-contract.json"))["projection_revision"]
STAGE_A_SCOPE_SHA = "a3a34ee765c75616da6f606a66156cdbf0e8736c91052966607fa6b59936bd18"
STAGE_B_SCOPE_SHA = "1f65d67fc990262e049e808961b1a23068f26692b9171112eb441be0157e7c16"
STAGE_B_SOURCE = "bf9f3c14de413c56b7c3ddacf16b10e2d4c4027c"


class Reader:
    def __init__(self, *responses):
        self.responses = iter(responses)
        self.calls = []

    async def get(self, dataset, query):
        self.calls.append((dataset, query))
        return next(self.responses)


def source(reader, revision=REVISION, *, monotonic=time.monotonic):
    config = lp.LearningProjectionConfig("http://owner.invalid", SCOPE["scope_id"], SCOPE["scope_sha256"], revision, MEMBERSHIP)
    return lp.ResearchOwnerLearningSource(config, client=reader, clock=lambda: BASE_TIME, monotonic=monotonic)


def query(entry):
    return "&".join(f"{name}={value}" for name, value in entry["query"].items())


def seal(document):
    document.pop("envelope_sha256")
    document["envelope_sha256"] = sha256(lp.canonical(document)).hexdigest()
    return lp.canonical(document)


def test_pinned_stage_b_bytes_and_all_canonical_vectors():
    for line in read("SHA256SUMS.stage-b").decode().splitlines():
        digest, path = line.split("  ", 1)
        assert sha256(read(path)).hexdigest() == digest, path
    for vector in HASHES["vectors"]:
        canonical = lp.canonical(vector["preimage"])
        assert canonical.hex() == vector["canonical_hex"]
        assert sha256(canonical).hexdigest() == vector["sha256"]


def test_pin_documents_the_stage_b_source_and_checksum_manifest():
    _heading, section = read("PIN.md").decode().split("## Stage B", 1)
    assert STAGE_B_SOURCE in section
    assert "SHA256SUMS.stage-b" in section


@pytest.mark.parametrize("entry", INDEX, ids=lambda entry: entry["path"])
def test_every_stage_b_golden_passes_through_unchanged(entry):
    raw = read(entry["path"])
    document = json.loads(raw)
    reader = Reader(lp.OwnerResponse(200, raw, None))
    assert lp.schema_errors("browser-response-stage-b", document) is None
    result = asyncio.run(source(reader).read(document["dataset"], query(entry)))
    assert (result.status, result.body) == (200, raw)
    assert reader.calls == [(document["dataset"], query(entry))]


def test_stage_a_keeps_the_factory_disabled_without_an_owner_call():
    reader = Reader()
    binding = source(reader, json.loads(read("examples/manifest.json"))["projection_revision"])
    for dataset in lp.STAGE_B_DATASETS:
        result = asyncio.run(binding.read(dataset, ""))
        assert (result.status, json.loads(result.body)["code"]) == (404, "DATASET_NOT_ENABLED")
    assert reader.calls == []


@pytest.mark.parametrize("stage", ["A", "B", None])
def test_campaigns_route_only_forwards_when_configured_b(stage):
    raw = read("examples/stage-b/campaigns-real-scope.json")
    reader = Reader(lp.OwnerResponse(200, raw, None))
    projection = None if stage is None else source(reader, REVISION if stage == "B" else STAGE_A_REVISION)
    app = FastAPI()
    app.include_router(learning_router(
        source=FixtureLearningAPI(), require_auth=lambda: None, check_origin=lambda: None,
        now=lambda: BASE_TIME, projection=projection,
    ))
    target = "limit=%32%35&scope_id=v5-okx-spot-dca"
    with TestClient(app) as client:
        response = client.get(f"/api/v5/learning/campaigns?{target}")
    if stage == "B":
        assert (response.status_code, response.content) == (200, raw)
        assert reader.calls == [("campaigns", target)]
    else:
        assert (response.status_code, response.json()["code"]) == (404, "DATASET_NOT_ENABLED")
        assert reader.calls == []


def test_stage_b_config_requires_the_vendored_stage_b_membership_pin():
    env = {
        "V5_LEARNING_SOURCE": "research_os_v1",
        "V5_LEARNING_OWNER_URL": "http://owner.invalid",
        "V5_LEARNING_SCOPE_ID": "v5-lfl-okx-spot-dca",
        "V5_LEARNING_SCOPE_SHA256": STAGE_B_SCOPE_SHA,
        "V5_LEARNING_PROJECTION_REVISION": REVISION,
    }
    config = _learning_projection_config(env)
    assert config.stage_b and config.expected.scope_sha256 == STAGE_B_SCOPE_SHA
    pinned = json.loads((lp.SCOPE_DIR / "scope-okx-spot-dca-stage-b.json").read_bytes())
    assert config.expected.membership.summary() == {key: pinned[key] for key in ("program_id", "family_lane_pairs")}


@pytest.mark.parametrize("revision,digest", [
    (REVISION, STAGE_A_SCOPE_SHA), (STAGE_A_REVISION, STAGE_B_SCOPE_SHA), ("f" * 64, STAGE_A_SCOPE_SHA),
], ids=["b-revision-a-scope", "a-revision-b-scope", "unknown-revision"])
def test_startup_rejects_scope_and_revision_mismatches(revision, digest):
    with pytest.raises(ConfigurationError):
        _learning_projection_config({
            "V5_LEARNING_SOURCE": "research_os_v1", "V5_LEARNING_OWNER_URL": "http://owner.invalid",
            "V5_LEARNING_SCOPE_ID": "v5-lfl-okx-spot-dca", "V5_LEARNING_SCOPE_SHA256": digest,
            "V5_LEARNING_PROJECTION_REVISION": revision,
        })


@pytest.mark.parametrize("entry", ERRORS, ids=lambda entry: entry["path"])
def test_stage_b_passes_each_typed_reader_error(entry):
    raw = read(entry["path"])
    reader = Reader(lp.OwnerResponse(entry["status"], raw, "17"))
    params = "limit=%32%35&scope_id=v5-okx-spot-dca"
    result = asyncio.run(source(reader).read("campaigns", params))
    assert (result.status, result.body) == (entry["status"], raw)
    assert reader.calls == [("campaigns", params)]


def test_unavailable_manifest_does_not_gate_stage_b():
    unavailable = read("examples/stage-b/manifest-unavailable.json")
    error = read("examples/errors/PUBLICATION_UNAVAILABLE.json")
    reader = Reader(lp.OwnerResponse(200, unavailable, None), lp.OwnerResponse(503, error, "17"))
    binding = source(reader)
    params = "scope_id=v5-okx-spot-dca"
    assert asyncio.run(binding.read("manifest", params)).body == unavailable
    result = asyncio.run(binding.read("campaigns", params))
    assert (result.status, result.body, result.retry_after) == (503, error, 17)
    assert reader.calls == [("manifest", params), ("campaigns", params)]
    assert binding.receipt_expiry("manifest") is None


@pytest.mark.parametrize("path, field, value", [
    (ASSESSMENTS, "projection_revision", "1" * 64),
    (ASSESSMENTS, "scope", None),
    (ASSESSMENTS, "scope", {**SCOPE, "scope_id": "wrong-scope"}),
    (ASSESSMENTS, "scope", {**SCOPE, "program_id": "wrong-program"}),
    (ASSESSMENTS, "snapshot_id", None),
    (ASSESSMENTS, "verified_at_ms", None),
    (CHANGED_SEAL, "projection_revision", "1" * 64),
    (CHANGED_SEAL, "items", json.loads(read("examples/stage-b/campaigns-real-scope.json"))["items"][:1]),
    (CHANGED_SEAL, "page", {"has_more": True, "limit": 25, "next_cursor": "A" * 112}),
    ("examples/stage-b/manifest.json", "reason_codes", ["PREREGISTRATION_SEAL_MISSING", "OMITTED_CONTENT", "INDEX_INCOMPLETE"]),
])
def test_invalid_stage_b_success_fails_closed(path, field, value):
    document = json.loads(read(path))
    document[field] = value
    reader = Reader(lp.OwnerResponse(200, seal(document), None))
    entry = next(entry for entry in INDEX if entry["path"] == path)
    binding = source(reader)
    result = asyncio.run(binding.read(document["dataset"], query(entry)))
    assert (result.status, json.loads(result.body)["code"]) == (502, "INVALID_OWNER_PROJECTION")
    assert binding.receipt_expiry(document["dataset"]) is None


def test_overflow_cannot_evict_a_higher_ranked_visible_descriptor_reason():
    path = "examples/stage-b/manifest-reason-overflow.json"
    document = json.loads(read(path))
    document["reason_codes"] = ["INDEX_INCOMPLETE", "OMITTED_CONTENT", "PREREGISTRATION_SEAL_MISSING", "UNRESOLVED_REFERENCE"]
    raw = seal(document)
    assert lp.schema_errors("manifest-stage-b", document) is None
    reader = Reader(lp.OwnerResponse(200, raw, None))
    result = asyncio.run(source(reader).read("manifest", "scope_id=v5-okx-spot-dca"))
    assert (result.status, json.loads(result.body)["code"]) == (502, "INVALID_OWNER_PROJECTION")


@pytest.mark.parametrize("start,end", [
    ("2026-10-01T00:00:00Z", "2026-03-01T00:00:00Z"),
    ("2026-03-01T00:00:00-03:00", "2026-03-01T02:00:00Z"),
    ("2026-03-01T00:00:00", "2026-10-01T00:00:00Z"),
    ("2026-03-01T00:00:00-03:00", "2026-03-01T03:00:00Z"),
    ("2026-02-29T00:00:00Z", "2026-03-02T00:00:00Z"),
], ids=["reversed", "offset-reversed", "mixed-awareness", "equal-instant", "impossible-date"])
def test_assessment_comparison_rejects_disordered_native_iso_windows(start, end):
    document = json.loads(read(ASSESSMENTS))
    row = document["items"][0]
    row["comparison"]["conditions"]["window"] = {"start": start, "end_exclusive": end}
    row.pop("row_sha256")
    row["row_sha256"] = sha256(lp.canonical(row)).hexdigest()
    raw = seal(document)
    assert lp.schema_errors("assessments", document) is None
    reader = Reader(lp.OwnerResponse(200, raw, None))
    entry = next(entry for entry in INDEX if entry["path"] == ASSESSMENTS)
    result = asyncio.run(source(reader).read("assessments", query(entry)))
    assert (result.status, json.loads(result.body)["code"]) == (502, "INVALID_OWNER_PROJECTION")


def test_status_only_clears_old_page_receipt_without_extending_its_original_deadline():
    published = read("examples/stage-b/campaigns-real-scope.json")
    unavailable = read(CHANGED_SEAL)
    reader = Reader(*(lp.OwnerResponse(200, body, None) for body in (published, unavailable, published, published)))
    clock = [0]
    binding = source(reader, monotonic=lambda: clock[0])
    params = "scope_id=v5-okx-spot-dca"
    assert asyncio.run(binding.read("campaigns", params)).body == published
    deadline = binding.receipt_expiry("campaigns")
    assert deadline == 89
    assert asyncio.run(binding.read("campaigns", params)).body == unavailable
    assert binding.receipt_expiry("campaigns") is None
    clock[0] = deadline - 1
    assert asyncio.run(binding.read("campaigns", params)).body == published
    assert binding.receipt_expiry("campaigns") == deadline
    clock[0] = deadline
    replay = asyncio.run(binding.read("campaigns", params))
    assert (replay.status, json.loads(replay.body)["code"]) == (503, "VERIFICATION_UNAVAILABLE")
    assert replay.freshness == "expired"
