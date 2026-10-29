import copy
import hashlib
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from condor.v5.app import create_app
from condor.v5.learning import FixtureLearningAPI
from condor.v5.projection_validation import OWNER_SCHEMAS, ProjectionValidationError
from tests.test_v5_learning_projection import (
    FROZEN_CONTRACT_FIXTURES,
    SCOPE,
    catalog,
    manifest,
)
from tests.test_v5_workspace_auth import ORIGIN, FakeUpstream, login, settings


def test_learning_deep_links_serve_the_shell_not_an_api_404(tmp_path):
    static = tmp_path / "fixture-frontend"
    static.mkdir()
    (static / "v5.html").write_text("<html><title>Fixture shell</title></html>")
    with TestClient(
        create_app(
            settings=settings(tmp_path), upstream=FakeUpstream(), static_dir=static
        )
    ) as client:
        for path in ("learning", "research-factory", "decision-lineage"):
            response = client.get("/" + path)
            assert response.status_code == 200
            assert "Fixture shell" in response.text
        assert client.get("/api/v5/learning/manifest").status_code == 401


def test_learning_routes_inherit_auth_origin_and_disabled_default(tmp_path):
    upstream = FakeUpstream()
    with TestClient(
        create_app(settings=settings(tmp_path), upstream=upstream)
    ) as client:
        for path in ("roles", "manifest", "research"):
            assert client.get("/api/v5/learning/" + path).status_code == 401
        login(client)
        response = client.get("/api/v5/learning/roles")
        assert response.status_code == 200
        assert len(response.json()["roles"]) == 12
        assert client.get("/api/v5/learning/manifest").json()["status"] == "UNAVAILABLE"
        assert client.post("/api/v5/learning/workflows", json={}).status_code == 403
        response = client.post(
            "/api/v5/learning/workflows", json={}, headers={"Origin": ORIGIN}
        )
        assert response.status_code == 503
        assert upstream.report_calls == []
    assert not (tmp_path / "v5-state" / "learning").exists()


def test_authenticated_fixture_reads_and_bad_owner_fail_closed(tmp_path):
    source = FixtureLearningAPI(manifest=manifest(), research=catalog(), scope=SCOPE)
    with TestClient(
        create_app(
            settings=settings(tmp_path),
            upstream=FakeUpstream(),
            learning_source=source,
            clock=lambda: 150,
        )
    ) as client:
        login(client)
        assert (
            client.get("/api/v5/learning/manifest").json()["status"] == "FIXTURE_ONLY"
        )
        page = client.get("/api/v5/learning/research?cursor=175&limit=25")
        assert page.status_code == 200
        assert page.json()["next_cursor"] is None
        assert len(page.json()["candidates"]) == 25
        source.manifest["scope"] = {"lane": "futures"}
        assert client.get("/api/v5/learning/manifest").status_code == 502


def seal_owner(value):
    value.pop("payload_sha256", None)
    value["payload_sha256"] = hashlib.sha256(
        json.dumps(
            value, sort_keys=True, ensure_ascii=False, separators=(",", ":")
        ).encode()
    ).hexdigest()
    return value


@pytest.mark.parametrize("mutation", ["candidate-list-state", "job-missing-usage"])
def test_reviewer_malformed_records_return_typed_502(tmp_path, mutation):
    from condor.v5.research import project_research
    from tests.test_v5_workflow_projection import job

    payload = catalog(1 if mutation == "candidate-list-state" else 0)
    if mutation == "candidate-list-state":
        value = payload["candidates"][0]
        value["data"]["implementation_status"] = []
    else:
        value = job()
        value["data"].pop("usage")
        payload["records"] = [value]
    seal_owner(value)
    with pytest.raises(ProjectionValidationError):
        project_research(payload, SCOPE, now_ms=150)
    source = FixtureLearningAPI(research=payload, scope=SCOPE)
    with TestClient(
        create_app(
            settings=settings(tmp_path),
            upstream=FakeUpstream(),
            learning_source=source,
            clock=lambda: 150,
        ),
        raise_server_exceptions=False,
    ) as client:
        login(client)
        response = client.get("/api/v5/learning/research")
        assert response.status_code == 502, response.text
        assert response.json() == {"detail": {"code": "INVALID_RESEARCH_PROJECTION"}}


def schema_mutations(schema, value, definitions, path=()):
    if "$ref" in schema:
        schema = definitions[schema["$ref"].split("/")[-1]]
    if "anyOf" in schema:
        for option in schema["anyOf"]:
            if option.get("type") != "null" and value is not None:
                yield from schema_mutations(option, value, definitions, path)
        return
    if isinstance(value, dict):
        for key, child in schema.get("properties", {}).items():
            if key not in value:
                continue
            child_path = path + (key,)
            yield child_path, "type", [] if isinstance(value[key], dict) else {}
            if key in schema.get("required", []):
                yield child_path, "missing", None
            if "enum" in child or "const" in child:
                yield child_path, "enum", "NOT_AN_OWNER_ENUM"
            yield from schema_mutations(child, value[key], definitions, child_path)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from schema_mutations(
                schema.get("items", {}), child, definitions, path + (index,)
            )


@pytest.mark.parametrize(
    "kind,route",
    [(kind, "research") for kind in OWNER_SCHEMAS]
    + [
        (kind, "manifest")
        for kind in ("lesson_revision", "knowledge_release", "adoption", "retraction")
    ]
    + [("agent_job", "workflows")],
)
def test_every_owner_field_is_validated_before_projection(tmp_path, kind, route):
    from condor.v5.learning import owner_record
    from condor.v5.research import project_lineage

    original = FROZEN_CONTRACT_FIXTURES.get(kind)
    if original is None:
        original = json.loads(
            (
                Path(__file__).parent / "fixtures" / "v5-learning" / f"{kind}.json"
            ).read_text()
        )
    if route == "workflows":
        from tests.test_v5_workflow_projection import job

        original = job()
    scope = FROZEN_CONTRACT_FIXTURES["lesson_revision"]["data"]["scope"]
    payload = {
        "schema_version": "condor-learning-source.v1",
        "scope": scope,
        "generated_at_ms": 10000,
        "fresh_until_ms": 20000,
        "source_generation": "fixture-g1",
        "records": [],
        "candidates": [],
    }
    source = FixtureLearningAPI(
        scope=scope,
        **{route: {"lesson_review": original} if route == "workflows" else payload},
    )
    request = {
        "workflow_id": "lesson_review",
        "campaign_id": "c1",
        "program_id": "p1",
        "request_id": "fixture-request",
        "session_id": "fixture-session",
        "expected_generation": "fixture-g1",
        "input_artifact_ids": ["fixture-input"],
    }
    with TestClient(
        create_app(
            settings=settings(tmp_path),
            upstream=FakeUpstream(),
            learning_source=source,
            clock=lambda: 12000,
        ),
        raise_server_exceptions=False,
    ) as client:
        login(client)
        if route == "workflows":
            control = client.post(
                "/api/v5/learning/workflows", json=request, headers={"Origin": ORIGIN}
            )
            source.workflows._requests.clear()
        else:
            payload["records"] = [] if kind == "candidate_revision" else [original]
            payload["candidates"] = [original] if kind == "candidate_revision" else []
            control = client.get(f"/api/v5/learning/{route}")
        assert control.status_code == 200, (kind, route, control.text)
        schema = OWNER_SCHEMAS[kind]
        for path, mutation, replacement in schema_mutations(
            schema, original, schema.get("$defs", {})
        ):
            value = copy.deepcopy(original)
            parent = value
            for part in path[:-1]:
                parent = parent[part]
            if mutation == "missing":
                del parent[path[-1]]
            else:
                parent[path[-1]] = replacement
            if path != ("payload_sha256",):
                seal_owner(value)
            with pytest.raises(ProjectionValidationError):
                owner_record(value)
            with pytest.raises(ProjectionValidationError):
                project_lineage([value])
            payload["records"] = [] if kind == "candidate_revision" else [value]
            payload["candidates"] = [value] if kind == "candidate_revision" else []
            if route == "workflows":
                source.workflows._receipts["lesson_review"] = value
                response = client.post(
                    "/api/v5/learning/workflows",
                    json=request,
                    headers={"Origin": ORIGIN},
                )
            else:
                response = client.get(f"/api/v5/learning/{route}")
            assert response.status_code == 502, (kind, path, mutation, response.text)
            code = (
                "INVALID_LEARNING_PROJECTION"
                if route == "manifest"
                else "INVALID_RESEARCH_PROJECTION"
            )
            assert response.json() == {"detail": {"code": code}}, (kind, path, mutation)


@pytest.mark.parametrize("error_type", [TypeError, KeyError])
def test_unexpected_projection_bugs_are_not_masked_as_owner_errors(
    tmp_path, monkeypatch, error_type
):
    def broken_projection(*args, **kwargs):
        raise error_type("injected implementation bug")

    monkeypatch.setattr("condor.v5.research.project_research", broken_projection)
    with TestClient(
        create_app(
            settings=settings(tmp_path),
            upstream=FakeUpstream(),
            learning_source=FixtureLearningAPI(research=catalog(0), scope=SCOPE),
        ),
        raise_server_exceptions=False,
    ) as client:
        login(client)
        assert client.get("/api/v5/learning/research").status_code == 500
