import asyncio
import json
from hashlib import sha256

import pytest

from condor.v5 import learning_projection as lp


def read(path):
    return (lp.SCHEMA_DIR / path).read_bytes()


INDEX = json.loads(read("golden-index-stage-b.json"))["examples"]
HASHES = json.loads(read("golden-hashes-stage-b.json"))
MANIFEST = json.loads(read("examples/stage-b/manifest.json"))
BASE_TIME = MANIFEST["served_at_ms"]
REVISION = MANIFEST["projection_revision"]
SCOPE = MANIFEST["scope"]
ERRORS = [entry for entry in json.loads(read("golden-index.json"))["examples"] if entry["status"] not in (200, 401)]
ASSESSMENTS = "examples/stage-b/assessments-supported.json"
CHANGED_SEAL = "examples/stage-b/campaigns-seal-integrity-failure.json"


class Reader:
    def __init__(self, *responses):
        self.responses = iter(responses)
        self.calls = []

    async def get(self, dataset, query):
        self.calls.append((dataset, query))
        return next(self.responses)


def source(reader, revision=REVISION):
    config = lp.LearningProjectionConfig("http://owner.invalid", SCOPE["scope_id"], SCOPE["scope_sha256"], revision)
    return lp.ResearchOwnerLearningSource(config, client=reader, clock=lambda: BASE_TIME)


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


def test_status_only_clears_old_page_receipt_without_allowing_replay():
    published = read("examples/stage-b/campaigns-real-scope.json")
    unavailable = read(CHANGED_SEAL)
    reader = Reader(*(lp.OwnerResponse(200, body, None) for body in (published, unavailable, published)))
    binding = source(reader)
    params = "scope_id=v5-okx-spot-dca"
    assert asyncio.run(binding.read("campaigns", params)).body == published
    assert binding.receipt_expiry("campaigns") is not None
    assert asyncio.run(binding.read("campaigns", params)).body == unavailable
    assert binding.receipt_expiry("campaigns") is None
    replay = asyncio.run(binding.read("campaigns", params))
    assert (replay.status, json.loads(replay.body)["code"]) == (503, "VERIFICATION_UNAVAILABLE")
