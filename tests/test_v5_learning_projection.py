import copy
import hashlib
import json

import pytest

from condor.v5.learning import project_learning_manifest

SCOPE = {
    "lane": "spot",
    "venue": "fixture",
    "connector": "fixture",
    "instruments": ["BNB-USDC"],
    "quote_currency": "USDC",
    "timeframe": "1m",
    "horizon_ms": 60000,
    "regime_id": "fixture",
    "mandate_id": "fixture",
}


def record(kind="lesson_revision", data=None):
    value = {
        "schema_name": kind,
        "schema_version": "2" if kind == "lesson_revision" else "1",
        "record_id": "fixture-" + kind,
        "producer_owner": "research_os",
        "producer_revision": "a" * 40,
        "created_at_ms": 100,
        "available_at_ms": 100,
        "correlation_id": "fixture",
        "parent_refs": [],
        "evidence_refs": [],
        "execution_authorized": False,
        "data": data
        or {
            "lesson_id": "lesson-1",
            "revision": "v1",
            "claim": "Do not infer support from uptime",
            "condition": "Paper fixture",
            "scope": SCOPE,
            "support_refs": [],
            "contradictory_refs": [],
            "evidence_validity": "PROVISIONAL",
            "lifecycle_state": "PROPOSED",
            "retraction_refs": [],
        },
    }
    value["payload_sha256"] = hashlib.sha256(
        json.dumps(
            value, sort_keys=True, ensure_ascii=False, separators=(",", ":")
        ).encode()
    ).hexdigest()
    return value


def manifest():
    return {
        "schema_version": "condor-learning-source.v1",
        "scope": SCOPE,
        "generated_at_ms": 100,
        "fresh_until_ms": 200,
        "records": [record()],
        "source_generation": "fixture-g1",
    }


def test_empty_and_stale_are_not_success_or_zero_usage():
    payload = manifest()
    payload["records"] = []
    result = project_learning_manifest(payload, SCOPE, now_ms=201)
    assert result["status"] == "STALE"
    assert result["lessons"] == []
    assert result["effect"] == "NONE"
    assert result["usage"] == "NOT_DISPATCHED"


def test_lesson_evidence_and_unknowns_survive_projection():
    result = project_learning_manifest(manifest(), SCOPE, now_ms=150)
    assert result["lessons"][0]["claim"] == "Do not infer support from uptime"
    assert result["lessons"][0]["contradictory_refs"] == []
    assert result["native_execution"] == "UNKNOWN"


@pytest.mark.parametrize(
    "change",
    ["scope", "digest", "version", "authorization", "huge_clock", "future", "oversize"],
)
def test_hostile_manifest_is_rejected(change):
    value = copy.deepcopy(manifest())
    if change == "scope":
        value["scope"]["venue"] = "wrong"
    elif change == "digest":
        value["records"][0]["data"]["claim"] = "tampered"
    elif change == "version":
        value["records"][0]["schema_version"] = "99"
    elif change == "authorization":
        value["records"][0]["execution_authorized"] = True
    elif change == "huge_clock":
        value["generated_at_ms"] = 10**1000
    elif change == "future":
        value["generated_at_ms"] = 190
    else:
        value["extra"] = "x" * 262145
    with pytest.raises(ValueError):
        project_learning_manifest(value, SCOPE, now_ms=150)


def catalog(count=200):
    value = manifest()
    value["records"] = []
    value["campaigns"] = [
        {"campaign_id": "c1", "state": "INTERRUPTED", "reason": "No outcome inferred"}
    ]
    value["candidates"] = [
        record(
            "candidate_revision",
            {
                "candidate_id": f"candidate-{index}",
                "candidate_revision": "v1",
                "family_id": f"family-{index % 10}",
                "variant_id": f"variant-{index}",
                "scope": SCOPE,
                "implementation_status": "UNQUALIFIED",
                "economic_status": "V5_NOT_SUPPORTED",
                "readiness_status": "DISABLED",
                "permission_status": "NONE",
                "trial_refs": [],
            },
        )
        for index in range(count)
    ]
    return value


def test_200_candidate_projection_covers_every_revision_once():
    from condor.v5.research import project_research

    value = catalog()
    ids = []
    cursor = 0
    while cursor is not None:
        page = project_research(value, SCOPE, now_ms=150, cursor=cursor, limit=25)
        assert page["total_candidates"] == 200
        assert page["total_families"] == 10
        assert len(page["candidates"]) == 25
        ids.extend(row["candidate_id"] for row in page["candidates"])
        cursor = page["next_cursor"]
    assert len(set(ids)) == 200
    for cursor, limit in [(True, 25), (-1, 25), (0, 51), (201, 25)]:
        with pytest.raises(ValueError):
            project_research(value, SCOPE, now_ms=150, cursor=cursor, limit=limit)


def test_release_binding_gaps_are_not_inferred_from_publication():
    value = manifest()
    value["records"] = [
        record(
            "knowledge_release",
            {
                "release_id": "release1",
                "state": "PUBLISHED",
                "scope_of_use": "advisory",
                "lesson_refs": [],
                "review_refs": [],
            },
        )
    ]
    release = project_learning_manifest(value, SCOPE, now_ms=150)["releases"][0]
    assert release["binding_status"] == "BLOCKED_INCOMPLETE"
    assert "candidate_library_ref" in release["missing_bindings"]


def test_research_lineage_keeps_exact_edges_and_workflow_identity():
    from condor.v5.research import project_research
    from tests.test_v5_workflow_projection import job

    value = catalog(0)
    value["records"] = [job()]
    result = project_research(value, SCOPE, now_ms=150)
    assert result["lineage"][0]["record_id"] == "fixture-agent_job"
    assert result["jobs"][0]["usage"]["state"] == "NOT_DISPATCHED"


def test_candidate_available_after_snapshot_is_rejected():
    from condor.v5.research import project_research

    source = catalog(1)
    candidate = source["candidates"][0]
    candidate["available_at_ms"] = source["generated_at_ms"] + 1
    candidate.pop("payload_sha256")
    candidate["payload_sha256"] = hashlib.sha256(
        json.dumps(candidate, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    with pytest.raises(ValueError, match="unavailable"):
        project_research(source, SCOPE, now_ms=150)


def test_malformed_schema_identity_is_a_validation_error():
    from condor.v5.learning import owner_record

    fixture = record()
    fixture["schema_name"] = []
    with pytest.raises(ValueError):
        owner_record(fixture)


@pytest.mark.parametrize("binding", [None, [], {"refs": None}, {"refs": []}])
def test_malformed_nested_lineage_binding_is_a_validation_error(binding):
    from condor.v5.research import project_lineage

    release = record("knowledge_release", {"consumer_manifest": {"models": binding}})
    with pytest.raises(ValueError):
        project_lineage([release])


FROZEN_CONTRACT_HEAD = "798ea9b4da65006e3010597ea55fe527a0b80ffc"
FROZEN_CONTRACT_FIXTURES = {
    "adoption": {
        "available_at_ms": 1200,
        "correlation_id": "stage1-20261029",
        "created_at_ms": 1200,
        "data": {
            "consumer_id": "fixture",
            "disposition": "APPLIED",
            "effective_decision_boundary_ms": 1200,
            "new_release_ref": {
                "available_at_ms": 900,
                "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "owner": "research_os",
                "record_id": "fixture-knowledge_release",
                "record_kind": "knowledge_release",
                "revision": "r1",
            },
            "old_release_ref": None,
            "reason": "fixture",
            "role_revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "runtime_revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        "evidence_refs": [],
        "execution_authorized": False,
        "parent_refs": [],
        "payload_sha256": "5832b8b5a3927ca5f5636bdc075c8b72df633cdbb76d77c566776eecbb896a33",
        "producer_owner": "research_os",
        "producer_revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "record_id": "fixture-adoption",
        "schema_name": "adoption",
        "schema_version": "1",
    },
    "agent_job": {
        "available_at_ms": 1200,
        "correlation_id": "stage1-20261029",
        "created_at_ms": 1200,
        "data": {
            "admission_ref": None,
            "allowed_action": "READ_FIXTURE",
            "attempt_id": "fixture",
            "authority_ceiling": "repository-process-only",
            "campaign_id": "fixture-campaign",
            "campaign_ref": {
                "available_at_ms": 900,
                "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "owner": "research_os",
                "record_id": "fixture-campaign",
                "record_kind": "campaign",
                "revision": "r1",
            },
            "cancellation_generation": 1,
            "capability_manifest_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "context_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "deadline_ms": 1800,
            "decision_at_ms": 1200,
            "decision_cutoff_ms": 1000,
            "expires_at_ms": 2000,
            "idempotency_key": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "input_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "job_id": "fixture",
            "model_id": "FIXTURE_ONLY",
            "model_ref": None,
            "output_schema_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "parent_id": None,
            "parent_ref": None,
            "program_id": "fixture-program",
            "program_ref": {
                "available_at_ms": 900,
                "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "owner": "research_os",
                "record_id": "fixture-program",
                "record_kind": "program",
                "revision": "r1",
            },
            "prompt_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "provider_id": "NONE",
            "release_ref": {
                "available_at_ms": 900,
                "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "owner": "research_os",
                "record_id": "fixture-knowledge_release",
                "record_kind": "knowledge_release",
                "revision": "r1",
            },
            "release_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "reservation": {
                "data_query_limit": None,
                "duration_ms": None,
                "fan_out": 0,
                "input_tokens": None,
                "max_calls": 0,
                "money_limit": None,
                "output_tokens": None,
                "retries": 0,
                "tool_invocations": 0,
            },
            "role_id": "fixture",
            "role_revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "settings_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "state": "PROPOSED",
            "state_history": ["PROPOSED"],
            "usage": {
                "calls": 0,
                "duration_ms": 0,
                "input_tokens": 0,
                "money": {
                    "asset": None,
                    "kind": "money",
                    "quote_currency": "USD",
                    "unit": "quote_asset",
                    "value": "0",
                },
                "output_tokens": 0,
                "state": "NOT_DISPATCHED",
            },
            "workflow_id": "fixture",
        },
        "evidence_refs": [],
        "execution_authorized": False,
        "parent_refs": [],
        "payload_sha256": "062bf349abccb42fccf9c42a53a9588dc2911b03eb694c563b1395ee7a2ddc20",
        "producer_owner": "research_os",
        "producer_revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "record_id": "fixture-agent_job",
        "schema_name": "agent_job",
        "schema_version": "1",
    },
    "agent_message": {
        "available_at_ms": 1200,
        "correlation_id": "stage1-20261029",
        "created_at_ms": 1200,
        "data": {
            "claim": "fixture",
            "consumed_input_refs": [],
            "context_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "decision_at_ms": 1200,
            "decision_cutoff_ms": 1000,
            "disagreements": [],
            "expires_at_ms": 2000,
            "job_ref": {
                "available_at_ms": 900,
                "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "owner": "research_os",
                "record_id": "fixture-agent_job",
                "record_kind": "agent_job",
                "revision": "r1",
            },
            "kind": "OBSERVATION",
            "knowledge_release_id": "fixture-knowledge_release",
            "knowledge_release_ref": {
                "available_at_ms": 900,
                "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "owner": "research_os",
                "record_id": "fixture-knowledge_release",
                "record_kind": "knowledge_release",
                "revision": "r1",
            },
            "missing_inputs": [],
            "output_schema_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "proposed_consequence": "REVIEW_ONLY",
            "recipient_role_id": "fixture",
            "release_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "role_id": "fixture",
            "sender_role_revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "subject_decision_id": "fixture",
            "uncertainty": "fixture",
            "untrusted_external_text": None,
            "untrusted_user_text": None,
            "workflow_id": "fixture",
        },
        "evidence_refs": [],
        "execution_authorized": False,
        "parent_refs": [],
        "payload_sha256": "8759b388e43961c75122100b194042d25c6edc0016a13d1307a89e8cee314015",
        "producer_owner": "hummingbot_api",
        "producer_revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "record_id": "fixture-agent_message",
        "schema_name": "agent_message",
        "schema_version": "1",
    },
    "candidate_revision": {
        "available_at_ms": 1200,
        "correlation_id": "stage1-20261029",
        "created_at_ms": 1200,
        "data": {
            "candidate_id": "fixture",
            "candidate_revision": "fixture",
            "code_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "config_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "cost_model_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "dca_policy_id": "fixture-policy",
            "dependency_lock_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "economic_status": "V5_NOT_SUPPORTED",
            "eligibility_inputs": [],
            "entry_policy_id": "fixture-policy",
            "exit_policy_id": "fixture-policy",
            "exposure_refs": [],
            "family_id": "fixture",
            "feature_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "forbidden_conditions": [],
            "idea_revision_id": "fixture-idea_revision",
            "idea_revision_ref": {
                "available_at_ms": 900,
                "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "owner": "research_os",
                "record_id": "fixture-idea_revision",
                "record_kind": "idea_revision",
                "revision": "r1",
            },
            "implementation_status": "UNQUALIFIED",
            "inventory_migration_policy_id": "fixture-policy",
            "lane": "spot",
            "owner_recipe": "fixture",
            "parent_revision": None,
            "parent_revision_ref": None,
            "permission_status": "NONE",
            "policy_refs": [
                {
                    "available_at_ms": 900,
                    "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "owner": "hummingbot",
                    "record_id": "fixture-policy",
                    "record_kind": "policy",
                    "revision": "r1",
                }
            ],
            "program_id": "fixture-program",
            "program_ref": {
                "available_at_ms": 900,
                "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "owner": "research_os",
                "record_id": "fixture-program",
                "record_kind": "program",
                "revision": "r1",
            },
            "provenance_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "readiness_status": "DISABLED",
            "retirement_policy_id": "fixture-policy",
            "scope": {
                "connector": "fixture",
                "horizon_ms": 1,
                "instruments": ["fixture"],
                "lane": "spot",
                "mandate_id": "fixture",
                "quote_currency": "USDC",
                "regime_id": "fixture",
                "timeframe": "fixture",
                "venue": "fixture",
            },
            "sizing_policy_id": "fixture-policy",
            "target_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "trial_refs": [],
            "variant_id": "fixture",
        },
        "evidence_refs": [],
        "execution_authorized": False,
        "parent_refs": [],
        "payload_sha256": "4aa539b871f3177893e22f693755f59303f285ff3f05528a8192b57c37e93a0b",
        "producer_owner": "research_os",
        "producer_revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "record_id": "fixture-candidate_revision",
        "schema_name": "candidate_revision",
        "schema_version": "1",
    },
    "experience_ref": {
        "available_at_ms": 1200,
        "correlation_id": "stage1-20261029",
        "created_at_ms": 1200,
        "data": {
            "admission": "NOT_REQUESTED",
            "candidate_ref": {
                "available_at_ms": 900,
                "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "owner": "research_os",
                "record_id": "fixture-candidate_revision",
                "record_kind": "candidate_revision",
                "revision": "r1",
            },
            "candidate_revision": "r1",
            "decision_id": "fixture",
            "executor_id": None,
            "fill_ids": [],
            "native_receipt_ref": None,
            "opportunity_refs": [],
            "order_ids": [],
            "outcome_type": "OBSERVED_EXECUTION",
            "owner_run_id": None,
            "owner_run_ref": None,
            "policy_ref": {
                "available_at_ms": 900,
                "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "owner": "hummingbot",
                "record_id": "fixture-policy",
                "record_kind": "policy",
                "revision": "r1",
            },
            "policy_revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "proposal_id": None,
            "proposal_ref": None,
            "receipt_hashes": [],
            "reconciliation": "UNKNOWN",
            "release_id": None,
            "release_ref": None,
        },
        "evidence_refs": [],
        "execution_authorized": False,
        "parent_refs": [],
        "payload_sha256": "a25f2e0dafb3918c61a2d9cfe857b6aec3b846b5497491aef2059932bf88b6ec",
        "producer_owner": "research_os",
        "producer_revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "record_id": "fixture-experience_ref",
        "schema_name": "experience_ref",
        "schema_version": "1",
    },
    "knowledge_release": {
        "available_at_ms": 1200,
        "correlation_id": "stage1-20261029",
        "created_at_ms": 1200,
        "data": {
            "authority_generation": 1,
            "calibrator_refs": [],
            "candidate_refs": [],
            "consumer_manifest": {
                "calibrators": {
                    "absence_reason": "No "
                    "component "
                    "in this "
                    "disabled "
                    "fixture",
                    "refs": [],
                },
                "candidate_library_ref": {
                    "available_at_ms": 900,
                    "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "owner": "research_os",
                    "record_id": "fixture-candidate_library",
                    "record_kind": "candidate_library",
                    "revision": "r1",
                },
                "features": {
                    "absence_reason": "No component " "in this " "disabled " "fixture",
                    "refs": [],
                },
                "models": {
                    "absence_reason": "No component " "in this " "disabled " "fixture",
                    "refs": [],
                },
                "prompts": {
                    "absence_reason": "No component " "in this " "disabled " "fixture",
                    "refs": [],
                },
                "regimes": {
                    "absence_reason": "No component " "in this " "disabled " "fixture",
                    "refs": [],
                },
                "retrieval_index_ref": {
                    "available_at_ms": 900,
                    "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "owner": "research_os",
                    "record_id": "fixture-retrieval_index",
                    "record_kind": "retrieval_index",
                    "revision": "r1",
                },
                "rights_retraction_ref": {
                    "available_at_ms": 900,
                    "content_sha256": "dd3d3c97b03a6b4892daa792978fa3fa3e9bda346b75e42233daff431235a941",
                    "owner": "research_os",
                    "record_id": "fixture-rights_retraction",
                    "record_kind": "rights_retraction",
                    "revision": "r1",
                },
                "skills": {
                    "absence_reason": "No component " "in this " "disabled " "fixture",
                    "refs": [],
                },
                "targets": {
                    "absence_reason": "No component " "in this " "disabled " "fixture",
                    "refs": [],
                },
            },
            "dependency_closure_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "forecast_refs": [],
            "graph_generation_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "lesson_refs": [],
            "manifest_sha256": "a5dfa30c3edb489ddbc84c55ac987f162818016d2240acd59a9b84c3ab39d67d",
            "parent_release_id": None,
            "parent_release_ref": None,
            "policy_revision_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "prompt_revision_hashes": [],
            "release_effective_at_ms": 1300,
            "release_id": "fixture",
            "required_consumer_versions": [],
            "retraction_digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "retrieval_index_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "review_refs": [],
            "rights_version": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "role_revision_hashes": [],
            "schema_digests": [],
            "scope_of_use": "research",
            "skill_revision_hashes": [],
            "state": "DRAFT",
        },
        "evidence_refs": [],
        "execution_authorized": False,
        "parent_refs": [],
        "payload_sha256": "b91ac960a0bd7a55f79b258cde7977aa6d4cbfd2907b4b49f7a051dcfc320378",
        "producer_owner": "research_os",
        "producer_revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "record_id": "fixture-knowledge_release",
        "schema_name": "knowledge_release",
        "schema_version": "1",
    },
    "lesson_revision": {
        "available_at_ms": 1200,
        "correlation_id": "stage1-20261029",
        "created_at_ms": 1200,
        "data": {
            "applicability_predicate_id": "fixture",
            "causal_target": "fixture",
            "claim": "fixture",
            "condition": "fixture",
            "contradictory_refs": [],
            "effect": "fixture",
            "evaluator_revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "evidence_validity": "VALID",
            "invalidation_predicate_id": "fixture",
            "lesson_id": "fixture",
            "lifecycle_state": "PROPOSED",
            "permitted_uses": ["research"],
            "proposed_consequence": "RESEARCH_ONLY",
            "release_eligible": False,
            "retraction_refs": [],
            "reviewer_ids": [],
            "revision": "fixture",
            "scope": {
                "connector": "fixture",
                "horizon_ms": 1,
                "instruments": ["fixture"],
                "lane": "spot",
                "mandate_id": "fixture",
                "quote_currency": "USDC",
                "regime_id": "fixture",
                "timeframe": "fixture",
                "venue": "fixture",
            },
            "search_exposure_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "supersession_refs": [],
            "support_refs": [],
        },
        "evidence_refs": [],
        "execution_authorized": False,
        "parent_refs": [],
        "payload_sha256": "0402cf1d8edff9467820373811b150b1b516650bc1fd4fa4341b0325871c7d1e",
        "producer_owner": "research_os",
        "producer_revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "record_id": "fixture-lesson_revision",
        "schema_name": "lesson_revision",
        "schema_version": "2",
    },
    "opportunity": {
        "available_at_ms": 1200,
        "correlation_id": "stage1-20261029",
        "created_at_ms": 1200,
        "data": {
            "action": "ENTER",
            "candidate_ref": {
                "available_at_ms": 900,
                "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "owner": "research_os",
                "record_id": "fixture-candidate_revision",
                "record_kind": "candidate_revision",
                "revision": "r1",
            },
            "decision_at_ms": 1200,
            "decision_cutoff_ms": 1000,
            "disposition": "SELECTED",
            "expected_cost": {
                "asset": None,
                "kind": "money",
                "quote_currency": "USDC",
                "unit": "quote_asset",
                "value": "0",
            },
            "expires_at_ms": 2000,
            "horizon_ms": 1,
            "input_snapshot_ref": {
                "available_at_ms": 900,
                "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "owner": "hummingbot",
                "record_id": "fixture-input_snapshot",
                "record_kind": "input_snapshot",
                "revision": "r1",
            },
            "inventory_ref": None,
            "missing_data_flags": [],
            "reason": "fixture",
            "required_quote": {
                "asset": None,
                "kind": "money",
                "quote_currency": "USDC",
                "unit": "quote_asset",
                "value": "0",
            },
            "score": {
                "asset": None,
                "kind": "ordinal",
                "quote_currency": None,
                "unit": "ordinal_score",
                "value": "0",
            },
            "side": "BUY",
            "trajectory": "OBSERVED",
            "uncertainty": None,
        },
        "evidence_refs": [],
        "execution_authorized": False,
        "parent_refs": [],
        "payload_sha256": "489aa97a3db3d0dcc28c525a624331332b179739674e70f10d974047947d34a4",
        "producer_owner": "hummingbot",
        "producer_revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "record_id": "fixture-opportunity",
        "schema_name": "opportunity",
        "schema_version": "1",
    },
    "retraction": {
        "available_at_ms": 1200,
        "correlation_id": "stage1-20261029",
        "created_at_ms": 1200,
        "data": {
            "affected_refs": [
                {
                    "available_at_ms": 900,
                    "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "owner": "research_os",
                    "record_id": "fixture-lesson_revision",
                    "record_kind": "lesson_revision",
                    "revision": "r1",
                }
            ],
            "effective_at_ms": 1,
            "effects": ["BLOCK_NEW_USE"],
            "reason": "fixture",
            "replacement_ref": None,
            "reviewer_id": "fixture",
        },
        "evidence_refs": [],
        "execution_authorized": False,
        "parent_refs": [],
        "payload_sha256": "9df4cafcff7b9320938c058a1b32e6259448c4b5cf68941ec4695e8f58b8647a",
        "producer_owner": "research_os",
        "producer_revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "record_id": "fixture-retraction",
        "schema_name": "retraction",
        "schema_version": "1",
    },
    "knowledge_release_published": {
        "available_at_ms": 1200,
        "correlation_id": "stage1-20261029",
        "created_at_ms": 1200,
        "data": {
            "authority_generation": 1,
            "calibrator_refs": [
                {
                    "available_at_ms": 900,
                    "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "owner": "quants_lab",
                    "record_id": "fixture-calibrator",
                    "record_kind": "calibrator",
                    "revision": "r1",
                }
            ],
            "candidate_refs": [
                {
                    "available_at_ms": 900,
                    "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "owner": "research_os",
                    "record_id": "fixture-candidate_revision",
                    "record_kind": "candidate_revision",
                    "revision": "r1",
                }
            ],
            "consumer_manifest": {
                "calibrators": {
                    "absence_reason": None,
                    "refs": [
                        {
                            "available_at_ms": 900,
                            "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                            "owner": "quants_lab",
                            "record_id": "fixture-calibrator",
                            "record_kind": "calibrator",
                            "revision": "r1",
                        }
                    ],
                },
                "candidate_library_ref": {
                    "available_at_ms": 900,
                    "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "owner": "research_os",
                    "record_id": "fixture-candidate_library",
                    "record_kind": "candidate_library",
                    "revision": "r1",
                },
                "features": {
                    "absence_reason": None,
                    "refs": [
                        {
                            "available_at_ms": 900,
                            "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                            "owner": "quants_lab",
                            "record_id": "fixture-feature",
                            "record_kind": "feature",
                            "revision": "r1",
                        }
                    ],
                },
                "models": {
                    "absence_reason": None,
                    "refs": [
                        {
                            "available_at_ms": 900,
                            "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                            "owner": "quants_lab",
                            "record_id": "fixture-model",
                            "record_kind": "model",
                            "revision": "r1",
                        }
                    ],
                },
                "prompts": {
                    "absence_reason": None,
                    "refs": [
                        {
                            "available_at_ms": 900,
                            "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                            "owner": "research_os",
                            "record_id": "fixture-prompt",
                            "record_kind": "prompt",
                            "revision": "r1",
                        }
                    ],
                },
                "regimes": {
                    "absence_reason": None,
                    "refs": [
                        {
                            "available_at_ms": 900,
                            "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                            "owner": "quants_lab",
                            "record_id": "fixture-regime",
                            "record_kind": "regime",
                            "revision": "r1",
                        }
                    ],
                },
                "retrieval_index_ref": {
                    "available_at_ms": 900,
                    "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "owner": "research_os",
                    "record_id": "fixture-retrieval_index",
                    "record_kind": "retrieval_index",
                    "revision": "r1",
                },
                "rights_retraction_ref": {
                    "available_at_ms": 900,
                    "content_sha256": "dd3d3c97b03a6b4892daa792978fa3fa3e9bda346b75e42233daff431235a941",
                    "owner": "research_os",
                    "record_id": "fixture-rights_retraction",
                    "record_kind": "rights_retraction",
                    "revision": "r1",
                },
                "skills": {
                    "absence_reason": None,
                    "refs": [
                        {
                            "available_at_ms": 900,
                            "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                            "owner": "research_os",
                            "record_id": "fixture-skill",
                            "record_kind": "skill",
                            "revision": "r1",
                        }
                    ],
                },
                "targets": {
                    "absence_reason": None,
                    "refs": [
                        {
                            "available_at_ms": 900,
                            "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                            "owner": "quants_lab",
                            "record_id": "fixture-target",
                            "record_kind": "target",
                            "revision": "r1",
                        }
                    ],
                },
            },
            "dependency_closure_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "forecast_refs": [
                {
                    "available_at_ms": 900,
                    "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "owner": "quants_lab",
                    "record_id": "fixture-forecast",
                    "record_kind": "forecast",
                    "revision": "r1",
                }
            ],
            "forecast_target_bindings": [
                {
                    "forecast_ref": {
                        "available_at_ms": 900,
                        "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                        "owner": "quants_lab",
                        "record_id": "fixture-forecast",
                        "record_kind": "forecast",
                        "revision": "r1",
                    },
                    "target_ref": {
                        "available_at_ms": 900,
                        "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                        "owner": "quants_lab",
                        "record_id": "fixture-target",
                        "record_kind": "target",
                        "revision": "r1",
                    },
                }
            ],
            "graph_generation_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "lesson_refs": [
                {
                    "available_at_ms": 900,
                    "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "owner": "research_os",
                    "record_id": "fixture-lesson_revision",
                    "record_kind": "lesson_revision",
                    "revision": "r1",
                }
            ],
            "manifest_sha256": "f8ab7662a82d21dad8840f71e772ad4e778a835cd352f643cbf8952a480e09f5",
            "parent_release_id": None,
            "parent_release_ref": None,
            "policy_revision_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "prompt_revision_hashes": [
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            ],
            "release_effective_at_ms": 1300,
            "release_id": "fixture",
            "required_consumer_versions": ["v1"],
            "retraction_digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "retrieval_index_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "review_refs": [
                {
                    "available_at_ms": 900,
                    "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "owner": "research_os",
                    "record_id": "fixture-assessment",
                    "record_kind": "assessment",
                    "revision": "r1",
                }
            ],
            "rights_version": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "role_revision_hashes": [
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            ],
            "schema_digests": [
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            ],
            "scope_of_use": "research",
            "skill_revision_hashes": [
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            ],
            "state": "PUBLISHED",
        },
        "evidence_refs": [],
        "execution_authorized": False,
        "parent_refs": [],
        "payload_sha256": "c1545bb9897a969c0d7c2278bf0d804636a256ab5ec3db3c86a06da67b9ff809",
        "producer_owner": "research_os",
        "producer_revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "record_id": "fixture-knowledge_release",
        "schema_name": "knowledge_release",
        "schema_version": "1",
    },
}


def test_pinned_owner_fixtures_remain_compatible():
    from condor.v5.research import project_research
    from condor.v5.workflows import project_workflow

    fixtures = copy.deepcopy(FROZEN_CONTRACT_FIXTURES)
    scope = fixtures["lesson_revision"]["data"]["scope"]
    source = {
        "schema_version": "condor-learning-source.v1",
        "scope": scope,
        "generated_at_ms": 2000,
        "fresh_until_ms": 3000,
        "source_generation": "fixture-g1",
        "records": [
            fixtures[kind]
            for kind in (
                "lesson_revision",
                "knowledge_release",
                "adoption",
                "retraction",
            )
        ],
    }
    learning = project_learning_manifest(source, scope, now_ms=2500)
    assert len(learning["lessons"]) == 1
    assert len(learning["releases"]) == 1
    assert learning["releases"][0]["missing_bindings"] == []
    assert len(learning["releases"][0]["bindings"]) == 10
    assert learning["adoptions"][0]["effective_decision_boundary_ms"] == 1200
    source["records"] = [
        fixtures[kind]
        for kind in ("agent_job", "experience_ref", "opportunity", "agent_message")
    ]
    source["candidates"] = [fixtures["candidate_revision"]]
    research = project_research(source, scope, now_ms=2500)
    assert len(research["lineage"]) == 4
    assert research["candidates"][0]["native_execution"] == "UNKNOWN"
    job = project_workflow(fixtures["agent_job"], session_id="fixture-session")
    assert job["replay_allowed"] is False


@pytest.mark.parametrize(
    "mutation", ["digest", "kind", "absence", "retrieval", "rights", "prompts"]
)
def test_complete_release_manifest_cannot_hide_mismatched_bindings(mutation):
    release = copy.deepcopy(FROZEN_CONTRACT_FIXTURES["knowledge_release"]["data"])
    consumer = release["consumer_manifest"]
    if mutation == "digest":
        release["manifest_sha256"] = "b" * 64
    elif mutation == "kind":
        consumer["models"] = {
            "refs": [consumer["candidate_library_ref"]],
            "absence_reason": None,
        }
    elif mutation == "absence":
        consumer["models"]["absence_reason"] = None
    elif mutation == "retrieval":
        release["retrieval_index_sha256"] = "b" * 64
    elif mutation == "rights":
        release["rights_version"] = "b" * 64
    else:
        release["prompt_revision_hashes"] = ["b" * 64]
    if mutation != "digest":
        release["manifest_sha256"] = hashlib.sha256(
            json.dumps(consumer, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
    source = manifest()
    source["records"] = [record("knowledge_release", release)]
    with pytest.raises(ValueError):
        project_learning_manifest(source, SCOPE, now_ms=150)


def test_published_release_cannot_hide_missing_qualification_bindings():
    release = copy.deepcopy(FROZEN_CONTRACT_FIXTURES["knowledge_release"]["data"])
    release["state"] = "PUBLISHED"
    source = manifest()
    source["records"] = [record("knowledge_release", release)]
    row = project_learning_manifest(source, SCOPE, now_ms=150)["releases"][0]
    assert row["binding_status"] == "BLOCKED_INCOMPLETE"
    assert set(row["missing_bindings"]) >= {
        "lesson_refs",
        "review_refs",
        "required_consumer_versions",
    }


@pytest.mark.parametrize(
    "mutation", ["review_kind", "forecast_without_targets", "extra_target"]
)
def test_published_release_rejects_inconsistent_review_and_target_bindings(mutation):
    release = copy.deepcopy(
        FROZEN_CONTRACT_FIXTURES["knowledge_release_published"]["data"]
    )
    binding = dict(release["consumer_manifest"]["candidate_library_ref"])
    if mutation == "review_kind":
        binding.update(record_kind="evidence", record_id="not-a-review")
        release["review_refs"] = [binding]
    elif mutation == "forecast_without_targets":
        binding.update(
            record_kind="forecast", record_id="forecast-1", owner="quants_lab"
        )
        release["forecast_refs"] = [binding]
    else:
        binding.update(record_kind="target", record_id="target-1", owner="quants_lab")
        release["consumer_manifest"]["targets"]["refs"].append(binding)
    release["manifest_sha256"] = hashlib.sha256(
        json.dumps(
            release["consumer_manifest"], sort_keys=True, separators=(",", ":")
        ).encode()
    ).hexdigest()
    source = manifest()
    source["records"] = [record("knowledge_release", release)]
    with pytest.raises(ValueError):
        project_learning_manifest(source, SCOPE, now_ms=150)


def test_final_published_fixture_keeps_all_bindings_without_granting_authority():
    source = manifest()
    source["records"] = [
        record(
            "knowledge_release",
            copy.deepcopy(
                FROZEN_CONTRACT_FIXTURES["knowledge_release_published"]["data"]
            ),
        )
    ]
    row = project_learning_manifest(source, SCOPE, now_ms=150)["releases"][0]
    assert row["state"] == "PUBLISHED"
    assert row["missing_bindings"] == []
    assert row["binding_status"] == "OWNER_VALIDATION_REQUIRED"
    assert len(row["bindings"]) == 10
