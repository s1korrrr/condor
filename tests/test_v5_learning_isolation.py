from fastapi.testclient import TestClient

from condor.v5.app import create_app
from condor.v5.learning import FixtureLearningAPI
from tests.test_v5_learning_projection import SCOPE, catalog, manifest
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
