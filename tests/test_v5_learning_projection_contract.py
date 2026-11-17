"""The frozen Stage-A projection appendix: every golden validates, every error maps, hashes recompute, freshness holds."""

import copy
import hashlib
import json
from pathlib import Path

import pytest

from condor.v5 import learning_projection as lp

CONTRACT = Path(lp.SCHEMA_DIR)
INDEX = json.loads((CONTRACT / "golden-index.json").read_text())
HASHES = json.loads((CONTRACT / "golden-hashes.json").read_text())
FRESHNESS = json.loads((CONTRACT / "freshness-vectors.json").read_text())
WIRE = json.loads((CONTRACT / "wire-contract.json").read_text())

SCOPE_ID = "fixture-v5-lfl"
SCOPE_SHA = HASHES["scope_sha256"]["sha256"]
REVISION = HASHES["vectors"][0]["sha256"]
EXPECTED = lp.ExpectedBinding(SCOPE_ID, SCOPE_SHA, REVISION)
BASE_NOW = 1794916889000


def load(relative: str):
    return json.loads((CONTRACT / relative).read_text())


def rehash(document: dict) -> dict:
    """Re-seal an envelope after a test edit (rows first, then the envelope)."""
    for row in document["items"]:
        if "row_sha256" in row:
            body = {key: value for key, value in row.items() if key != "row_sha256"}
            row["row_sha256"] = lp.sha256_hex(lp.canonical(body))
    body = {key: value for key, value in document.items() if key != "envelope_sha256"}
    document["envelope_sha256"] = lp.sha256_hex(lp.canonical(body))
    return document


def request_for(path: str) -> lp.RequestShape:
    dataset = Path(path).stem.split("-")[0]
    record_type = {"records-nodes": "node", "records-edges": "edge", "records-age-89s": "node"}.get(Path(path).stem)
    return lp.RequestShape(dataset, record_type)


def validate(document, path="examples/records-nodes.json", now=BASE_NOW):
    return lp.validate_envelope(document, request=request_for(path), expected=EXPECTED, now_ms=now)


# --- vendored appendix is the frozen one -------------------------------------------------------------------


def test_vendored_appendix_matches_its_pinned_checksums():
    lines = (CONTRACT / "SHA256SUMS").read_text().splitlines()
    assert len(lines) == 51
    for line in lines:
        digest, name = line.split("  ", 1)
        assert hashlib.sha256((CONTRACT / name).read_bytes()).hexdigest() == digest, name


def test_wire_contract_limits_are_the_ones_this_client_enforces():
    assert WIRE["limits"]["condor_response_decoded_bytes"] == lp.MAX_PROJECTION_RESPONSE_BYTES == 256_000
    assert WIRE["limits"]["error_decoded_bytes"] == lp.MAX_ERROR_BYTES
    assert WIRE["limits"]["row_encoded_bytes"] == lp.MAX_ROW_BYTES
    assert WIRE["limits"]["target_bytes"] == lp.MAX_TARGET_BYTES
    assert FRESHNESS["max_age_ms"] == lp.MAX_VERIFICATION_AGE_MS
    assert WIRE["projection_transport"]["condor_total_deadline_ms"] == int(lp.TOTAL_TIMEOUT_SECONDS * 1000)
    assert {code: status for status, codes in lp.ERROR_STATUS_CODES.items() for code in codes} == {
        code: entry["status"] for entry in WIRE["errors"] for code in entry["codes"]
    }


# --- goldens -----------------------------------------------------------------------------------------------

SUCCESS_GOLDENS = [entry for entry in INDEX["examples"] if entry["status"] == 200]
ERROR_GOLDENS = [entry for entry in INDEX["examples"] if entry["status"] != 200]


@pytest.mark.parametrize("entry", SUCCESS_GOLDENS, ids=lambda entry: entry["path"])
def test_every_success_golden_passes_strict_parse_schema_hashes_and_invariants(entry):
    raw = (CONTRACT / entry["path"]).read_bytes()
    document = lp.parse_strict(raw)
    assert lp.schema_errors(entry["schema"].removesuffix(".schema.json"), document) is None
    served = document["served_at_ms"]
    validate(document, entry["path"], now=served)


@pytest.mark.parametrize("entry", ERROR_GOLDENS, ids=lambda entry: entry["path"])
def test_every_error_golden_maps_to_its_status(entry):
    document = lp.parse_strict((CONTRACT / entry["path"]).read_bytes())
    if entry["status"] == 401:
        assert lp.schema_errors("auth-error", document) is None
        return
    assert lp.validate_error(entry["status"], document) == document
    other = next(status for status in lp.ERROR_STATUS_CODES if status != entry["status"])
    with pytest.raises(lp.ContractViolation):
        lp.validate_error(other, document)  # a code under the wrong status is rejected


@pytest.mark.parametrize("entry", INDEX["disabled_datasets"], ids=lambda entry: entry["path"])
def test_stage_b_disabled_goldens_are_typed_404_dataset_not_enabled(entry):
    wrapper = load(entry["path"])
    assert wrapper["http_status"] == 404
    assert lp.validate_error(404, wrapper["body"])["code"] == "DATASET_NOT_ENABLED"


def test_every_registry_code_has_a_golden_and_a_local_body():
    golden_codes = {Path(entry["path"]).stem for entry in ERROR_GOLDENS if entry["status"] != 401}
    assert golden_codes == set(lp.CODE_STATUS)
    for code in lp.CODE_STATUS:
        body = lp.parse_strict(lp.error_body(code))
        assert lp.validate_error(lp.CODE_STATUS[code], body) == body
        assert body["retryable"] is (lp.CODE_STATUS[code] == 503)


def test_auth_error_is_not_a_projection_error():
    auth = {"detail": {"code": "authentication_required"}}
    with pytest.raises(lp.ContractViolation):
        lp.validate_error(401, auth)


# --- hashes ------------------------------------------------------------------------------------------------


def test_hash_vectors_recompute_from_canonical_preimages():
    for vector in HASHES["vectors"]:
        encoded = lp.canonical(vector["preimage"])
        assert encoded.decode("utf-8") == vector["canonical_utf8"]
        assert encoded.hex() == vector["canonical_utf8_hex"]
        assert len(encoded) == vector["byte_length"]
        assert lp.sha256_hex(encoded) == vector["sha256"]
    scope = HASHES["scope_sha256"]
    assert lp.sha256_hex(lp.canonical(scope["preimage"])) == scope["sha256"]
    assert lp.sha256_hex(lp.canonical(HASHES["cursor"]["filter_preimage"])) == HASHES["cursor"]["filter_sha256"]
    assert lp.sha256_hex(lp.canonical(WIRE["projection_revision_preimage"])) == WIRE["projection_revision"]


def test_byte_ordering_is_unsigned_utf8_not_locale():
    # Ascending unsigned UTF-8 bytes; no locale, case fold or normalization.
    assert sorted(["z", "é", "a", "A", "á"], key=lambda value: value.encode("utf-8")) == [
        "A", "a", "á", "z", "é"
    ]


def test_opaque_cursor_round_trips_unchanged_through_validation():
    token = HASHES["cursor"]["token"]
    document = load("examples/records-nodes.json")
    document["page"] = {"limit": 25, "next_cursor": token, "has_more": True}
    validate(rehash(document))
    assert document["page"]["next_cursor"] == token
    # Syntax only: Condor never decodes it; a token outside the alphabet is rejected.
    document["page"]["next_cursor"] = token + "="
    with pytest.raises(lp.ContractViolation):
        validate(rehash(document))


# --- freshness ---------------------------------------------------------------------------------------------


def aged(seconds: int):
    document = load("examples/records-nodes.json")
    document["served_at_ms"] = document["verified_at_ms"] + seconds * 1000
    return rehash(document), document["served_at_ms"]


@pytest.mark.parametrize("name,seconds,ok", [("89s", 89, True), ("90s-boundary", 90, True), ("91s", 91, False)])
def test_freshness_vectors_accept_89_and_90_and_reject_91_seconds(name, seconds, ok):
    vector = next(item for item in FRESHNESS["vectors"] if item["name"] == name)
    assert vector["served_at_ms"] - vector["verified_at_ms"] == seconds * 1000
    document, served = aged(seconds)
    if ok:
        assert vector["expected_http"] == 200
        validate(document, now=served)
    else:
        assert vector["expected_http"] == 503
        with pytest.raises(lp.ContractViolation, match="90 s"):
            validate(document, now=served)


def test_future_timestamps_beyond_five_seconds_are_rejected():
    document = load("examples/records-nodes.json")
    served = document["served_at_ms"]
    validate(copy.deepcopy(document), now=served - 5000)
    with pytest.raises(lp.ContractViolation, match="future"):
        validate(copy.deepcopy(document), now=served - 5001)


def test_verified_after_served_is_rejected():
    document = load("examples/records-nodes.json")
    document["verified_at_ms"] = document["served_at_ms"] + 1
    with pytest.raises(lp.ContractViolation):
        validate(rehash(document), now=BASE_NOW)


def test_stale_is_not_a_v1_state():
    document = load("examples/records-nodes.json")
    document["status"] = "STALE"
    with pytest.raises(lp.ContractViolation):
        validate(rehash(document))


# --- strict parsing ----------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw",
    [
        b'{"a":1,"a":2}',  # duplicate key
        b'{"a":1.0}',  # float token
        b'{"a":1e0}',  # exponent token
        b'{"a":-0}',  # negative zero
        b'{"a":9007199254740992}',  # beyond the safe integer range
        b'{"a":NaN}',
        b'{"a":Infinity}',
        b'\xef\xbb\xbf{"a":1}',  # BOM
        b'{"a":"\xff"}',  # invalid UTF-8
        b'{"a":"\\ud800"}',  # unpaired surrogate
        b"{" * 5000,  # excess nesting
    ],
)
def test_strict_parser_rejects(raw):
    with pytest.raises(lp.ContractViolation):
        lp.parse_strict(raw)


def test_strict_parser_accepts_the_canonical_form_exactly():
    value = {"b": [1, 2, {"c": None}], "a": "é"}
    assert lp.parse_strict(lp.canonical(value)) == value
    assert lp.canonical(value) == b'{"a":"\xc3\xa9","b":[1,2,{"c":null}]}'


# --- whole-envelope rejection ------------------------------------------------------------------------------


def mutate(path, change):
    document = load(path)
    change(document)
    return document


@pytest.mark.parametrize(
    "label,change",
    [
        ("unknown key", lambda d: d.__setitem__("extra", 1)),
        ("wrong dataset", lambda d: d.__setitem__("dataset", "jobs")),
        ("scope id", lambda d: d["scope"].__setitem__("scope_id", "other")),
        ("scope hash", lambda d: d["scope"].__setitem__("scope_sha256", "0" * 64)),
        ("revision", lambda d: d.__setitem__("projection_revision", "1" * 64)),
        ("snapshot id", lambda d: d.__setitem__("snapshot_id", "2" * 64)),
        ("returned_items", lambda d: d["coverage"].__setitem__("returned_items", 2)),
        ("total below returned", lambda d: d["coverage"].__setitem__("total_items", 0)),
        ("has_more", lambda d: d["page"].__setitem__("has_more", True)),
        ("pending events", lambda d: d["coverage"].__setitem__("pending_events", 1)),
        ("unresolved membership hidden in BOUND", lambda d: d["coverage"].__setitem__("unresolved_membership_items", 3)),
        ("row field", lambda d: d["items"][0].__setitem__("kind", "bogus")),
        ("row has no hash", lambda d: d["items"][0].__delitem__("row_sha256")),
    ],
)
def test_one_bad_field_rejects_the_whole_envelope(label, change):
    document = mutate("examples/records-nodes.json", change)
    with pytest.raises(lp.ContractViolation):
        validate(rehash(document) if label not in {"row has no hash", "snapshot id"} else document)


def test_hash_mismatches_are_rejected_without_resealing():
    document = load("examples/records-nodes.json")
    document["items"][0]["title"] = "Edited after sealing"
    with pytest.raises(lp.ContractViolation, match="hash"):
        validate(document)
    document = load("examples/records-nodes.json")
    document["envelope_sha256"] = "3" * 64
    with pytest.raises(lp.ContractViolation, match="envelope hash"):
        validate(document)


def test_row_hash_is_checked_even_when_only_the_envelope_is_resealed():
    document = load("examples/records-nodes.json")
    document["items"][0]["title"] = "Edited and the envelope re-sealed, the row hash left stale"
    body = {key: value for key, value in document.items() if key != "envelope_sha256"}
    document["envelope_sha256"] = lp.sha256_hex(lp.canonical(body))
    with pytest.raises(lp.ContractViolation, match="row hash"):
        validate(document)


def test_items_must_be_strictly_ascending_by_record_id_bytes():
    document = load("examples/records-nodes.json")
    second = copy.deepcopy(document["items"][0])
    second["record_id"] = "experiment:fixture-0"  # sorts before the first row
    document["items"].append(second)
    document["coverage"]["returned_items"] = 2
    document["coverage"]["total_items"] = 2
    with pytest.raises(lp.ContractViolation, match="ascending"):
        validate(rehash(document))
    document["items"][1]["record_id"] = document["items"][0]["record_id"]  # a tie is a publication error
    with pytest.raises(lp.ContractViolation, match="ascending"):
        validate(rehash(document))


def test_partial_must_name_a_real_gap_and_bound_cannot_hide_one():
    document = load("examples/records-nodes.json")
    document["status"] = "PARTIAL"
    with pytest.raises(lp.ContractViolation, match="no gap"):
        validate(rehash(document))
    lessons = load("examples/lessons.json")
    lessons["status"] = "BOUND"
    lessons["reason_codes"] = []
    lessons["coverage"]["state"] = "COMPLETE"
    with pytest.raises(lp.ContractViolation, match="hides a gap"):
        lp.validate_envelope(rehash(lessons), request=lp.RequestShape("lessons"), expected=EXPECTED, now_ms=BASE_NOW)


def test_records_pages_never_mix_nodes_and_edges():
    edges = load("examples/records-edges.json")
    with pytest.raises(lp.ContractViolation, match="edge in a node page"):
        lp.validate_envelope(edges, request=lp.RequestShape("records", "node"), expected=EXPECTED, now_ms=BASE_NOW)
    nodes = load("examples/records-nodes.json")
    with pytest.raises(lp.ContractViolation, match="node in an edge page"):
        lp.validate_envelope(nodes, request=lp.RequestShape("records", "edge"), expected=EXPECTED, now_ms=BASE_NOW)


def test_running_job_is_not_completion_and_recorded_finish_needs_a_time():
    document = load("examples/jobs-running.json")
    row = document["items"][0]
    assert (row["native_state"], row["completion"], row["finished_at_ms"]) == ("RUNNING", "NOT_RECORDED", None)
    lp.validate_envelope(document, request=lp.RequestShape("jobs"), expected=EXPECTED, now_ms=BASE_NOW)
    finished = load("examples/jobs.json")
    finished["items"][0]["finished_at_ms"] = None  # recorded completion without a time must stay PARTIAL
    with pytest.raises(lp.ContractViolation, match="PARTIAL"):
        lp.validate_envelope(rehash(finished), request=lp.RequestShape("jobs"), expected=EXPECTED, now_ms=BASE_NOW)


def test_out_of_scope_references_expose_only_an_opaque_id():
    document = load("examples/records-edges.json")
    ref = document["items"][0]["to_ref"]
    ref.update({"resolution": "OUT_OF_SCOPE", "kind": "experiment", "revision": None, "source_index": None})
    with pytest.raises(lp.ContractViolation, match="opaque"):
        lp.validate_envelope(rehash(document), request=lp.RequestShape("records", "edge"), expected=EXPECTED, now_ms=BASE_NOW)
    ref["kind"] = "OPAQUE"
    lp.validate_envelope(rehash(document), request=lp.RequestShape("records", "edge"), expected=EXPECTED, now_ms=BASE_NOW)


def test_source_paths_and_pointers_must_be_safe():
    for bad in ("../x.json", "/abs.json", "a//b.json", "a\\b.json", "./a.json"):
        document = load("examples/records-nodes.json")
        document["items"][0]["sources"][0]["relative_path"] = bad
        with pytest.raises(lp.ContractViolation):
            validate(rehash(document))
    document = load("examples/records-nodes.json")
    document["items"][0]["sources"][0]["pointer"] = "/a~2b"
    with pytest.raises(lp.ContractViolation, match="pointer"):
        validate(rehash(document))


def test_trailing_newline_does_not_satisfy_anchored_patterns():
    document = load("examples/records-nodes.json")
    document["projection_revision"] = REVISION + "\n"  # Python's $ would accept this; ECMA 262 does not
    assert lp.schema_errors("records", document) is not None


def test_manifest_always_lists_six_descriptors_in_order_and_unavailable_manifest_claims_nothing():
    manifest = load("examples/manifest.json")
    assert [item["dataset"] for item in manifest["items"]] == list(lp.MANIFEST_ORDER)
    lp.validate_envelope(manifest, request=lp.RequestShape("manifest"), expected=EXPECTED, now_ms=BASE_NOW)
    manifest["status"] = "UNAVAILABLE"
    manifest["coverage"]["state"] = "UNAVAILABLE"
    with pytest.raises(lp.ContractViolation, match="unavailable manifest"):
        lp.validate_envelope(rehash(manifest), request=lp.RequestShape("manifest"), expected=EXPECTED, now_ms=BASE_NOW)


def test_row_size_nesting_and_reference_budgets():
    document = load("examples/lessons.json")
    row = document["items"][0]
    ref = {"owner": "research_os", "kind": "outcome", "record_id": "x" * 160, "revision": None, "source_index": 0, "resolution": "RESOLVED"}
    row["outcome_refs"] = [dict(ref, record_id=f"{index}" + "x" * 150) for index in range(4)]
    row["contradictory_refs"] = [dict(ref, record_id="y" * 150)]
    with pytest.raises(lp.ContractViolation, match="four references"):
        lp.validate_envelope(rehash(document), request=lp.RequestShape("lessons"), expected=EXPECTED, now_ms=BASE_NOW)


def test_query_parser_is_strict_and_forwards_raw_bytes():
    assert lp.parse_query("") == {}
    assert lp.parse_query("a=b%20c&d=%C3%A9&e=x+y") == {"a": "b c", "d": "é", "e": "x y"}
    for bad in ("a", "a=", "=b", "a=1&a=2", "a=%zz", "a=%ff", "a=1&&b=2"):
        with pytest.raises(lp.QueryViolation):
            lp.parse_query(bad)
    assert lp.prepare_query("lessons", "limit=10", SCOPE_ID) == "limit=10&scope_id=fixture-v5-lfl"
    assert lp.prepare_query("lessons", "", SCOPE_ID) == "scope_id=fixture-v5-lfl"
    assert lp.prepare_query("lessons", f"scope_id={SCOPE_ID}&limit=10", SCOPE_ID) == f"scope_id={SCOPE_ID}&limit=10"
    for dataset, query in (
        ("lessons", "scope_id=other"),
        ("lessons", "limit=51"),
        ("lessons", "limit=05"),
        ("lessons", "limit=0"),
        ("lessons", "record_type=node"),  # unknown for lessons
        ("records", ""),  # record_type is required
        ("records", "record_type=graph"),
        ("manifest", "limit=5"),
        ("lessons", "cursor=bad+cursor"),
        ("lessons", "cursor=" + "A" * 513),
    ):
        with pytest.raises(lp.QueryViolation):
            lp.prepare_query(dataset, query, SCOPE_ID)
    assert lp.prepare_query("records", "record_type=edge&root_id=a%2Fb", SCOPE_ID).startswith("record_type=edge&root_id=a%2Fb")


def test_retry_after_is_one_to_thirty_or_one():
    assert [lp.normalize_retry_after(value) for value in ("1", "30", "7", None, "0", "31", "-1", "1.5", " 5", "007x", "100", "٣")] == [
        1, 30, 7, 1, 1, 1, 1, 1, 1, 1, 1, 1
    ]
