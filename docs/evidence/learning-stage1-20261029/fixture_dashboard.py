"""Disposable, constructor-injected fixture dashboard. Never connects to owners."""

import argparse
import copy
import hashlib
import json
from pathlib import Path

import uvicorn

from condor.v5.app import create_app
from condor.v5.config import Settings
from condor.v5.learning import FixtureLearningAPI, project_learning_manifest
from condor.v5.research import project_research
from tests.test_v5_learning_projection import FROZEN_CONTRACT_FIXTURES
from tests.test_v5_workflow_projection import job, lifecycle_job
from tests.test_v5_workspace_auth import FakeUpstream

NOW = 1793275200000
FIXTURE_TOKEN = "fixture-only-no-provider-" + "f" * 48


def seal(value):
    value.pop("payload_sha256", None)
    value["payload_sha256"] = hashlib.sha256(
        json.dumps(
            value, sort_keys=True, ensure_ascii=False, separators=(",", ":")
        ).encode()
    ).hexdigest()
    return value


def fixture_source():
    fixtures = copy.deepcopy(FROZEN_CONTRACT_FIXTURES)
    scope = fixtures["lesson_revision"]["data"]["scope"]
    lesson = fixtures["lesson_revision"]
    lesson["data"].update(
        claim="Paper uptime does not establish strategy support",
        condition="Synthetic BNB-USDC fixture; no economic run",
        contradictory_refs=[
            {
                "owner": "research_os",
                "record_kind": "assessment",
                "record_id": "fixture-contradiction-007",
                "revision": "fixture-v1",
                "content_sha256": "a" * 64,
                "available_at_ms": 1000,
            }
        ],
    )
    seal(lesson)
    manifest = {
        "schema_version": "condor-learning-source.v1",
        "scope": scope,
        "source_generation": "fixture-g1",
        "generated_at_ms": NOW,
        "fresh_until_ms": NOW + 86400000,
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
    candidates = []
    for index in range(200):
        candidate = copy.deepcopy(fixtures["candidate_revision"])
        candidate["record_id"] = f"candidate-record-{index:03}"
        candidate["data"].update(
            candidate_id=f"candidate-{index:03}",
            family_id=f"family-{index % 10:02}",
            variant_id=f"variant-{index:03}",
            trial_refs=[
                {
                    "owner": "research_os",
                    "record_kind": "run",
                    "record_id": f"fixture-trial-{index:03}",
                    "revision": "fixture-v1",
                    "content_sha256": "b" * 64,
                    "available_at_ms": 1000,
                }
            ],
        )
        candidates.append(seal(candidate))
    jobs = [
        job(),
        lifecycle_job("DISPATCH_UNKNOWN", "UNKNOWN"),
        lifecycle_job("OUTPUT_PENDING", "UNKNOWN"),
    ]
    for index, receipt in enumerate(jobs):
        receipt["record_id"] = f"fixture-job-{index}"
        receipt["data"].update(
            job_id=f"fixture-job-{index}", workflow_id="lesson_review"
        )
        seal(receipt)
    research = {
        **manifest,
        "records": [
            fixtures[kind]
            for kind in (
                "opportunity",
                "agent_message",
                "experience_ref",
                "lesson_revision",
                "knowledge_release",
                "adoption",
                "retraction",
            )
        ]
        + jobs,
        "candidates": candidates,
        "campaigns": [
            {
                "campaign_id": "fixture-campaign-001",
                "state": "INTERRUPTED",
                "reason": "Host interrupted. Usage unknown. No paid request replay.",
            }
        ],
    }
    project_learning_manifest(manifest, scope, now_ms=NOW)
    project_research(research, scope, now_ms=NOW)
    return FixtureLearningAPI(manifest=manifest, research=research, scope=scope)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--static", type=Path, required=True)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    args.runtime.mkdir(parents=True, exist_ok=False)
    token_file = args.runtime / "fixture.token"
    token_file.write_text(FIXTURE_TOKEN)
    token_file.chmod(0o600)
    settings = Settings(
        runtime_root=args.runtime / "state",
        dashboard_token_file=token_file,
        dashboard_origin=args.origin,
        observation_base_url="http://fixture.invalid",
        observation_read_token_file=args.runtime / "absent-read-token",
        advisor_control_base_url="http://fixture.invalid",
        advisor_request_token_file=args.runtime / "absent-request-token",
        cookie_secure=True,
    )
    app = create_app(
        settings=settings,
        upstream=FakeUpstream(),
        learning_source=fixture_source(),
        static_dir=args.static,
        clock=lambda: NOW,
    )
    uvicorn.run(app, host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
