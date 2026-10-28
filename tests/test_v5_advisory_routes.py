import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from condor.web.auth import get_current_user
from condor.web.models import WebUser
from condor.web.routes import v5_advisory as routes


def client(monkeypatch, tmp_path, *, authenticated=True, handler=None):
    token = tmp_path / "token"
    token.write_text("read-only-token\n")
    monkeypatch.setenv("V5_OBSERVATION_URL", "http://observation:8080")
    monkeypatch.setenv("V5_OBSERVATION_TOKEN_FILE", str(token))
    transport = httpx.MockTransport(
        handler or (lambda request: httpx.Response(200, json={"items": []}))
    )
    monkeypatch.setattr(
        routes, "_client", lambda: httpx.AsyncClient(transport=transport)
    )
    app = FastAPI()
    app.include_router(routes.router, prefix="/api/v1")
    if authenticated:
        app.dependency_overrides[get_current_user] = lambda: WebUser(id=7, role="user")
    return TestClient(app)


def test_authentication_allowlist_and_query_refusal_precede_upstream(
    monkeypatch, tmp_path
):
    calls = []
    api = client(
        monkeypatch,
        tmp_path,
        authenticated=False,
        handler=lambda req: calls.append(req),
    )
    assert api.get("/api/v1/v5-advisory/v1/context").status_code in {401, 403}
    assert calls == []
    api = client(monkeypatch, tmp_path, handler=lambda req: calls.append(req))
    assert api.get("/api/v1/v5-advisory/v1/unknown").status_code == 404
    assert api.get("/api/v1/v5-advisory/v1/context?url=http://evil").status_code == 400
    assert calls == []


def test_proxy_uses_server_token_and_only_fixed_read_route(monkeypatch, tmp_path):
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(
            200, json={"features": {"spot.pressure_15m": {"value": 0.4}}}
        )

    response = client(monkeypatch, tmp_path, handler=handler).get(
        "/api/v1/v5-advisory/v1/context"
    )
    assert response.status_code == 200
    assert response.json()["features"]["spot.pressure_15m"]["value"] == 0.4
    assert str(seen[0].url) == "http://observation:8080/v1/context"
    assert seen[0].headers["authorization"] == "Bearer read-only-token"
    assert "read-only-token" not in response.text
    assert response.headers["x-context-authority"] == "observation-only"


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(302, headers={"Location": "http://evil"}),
        httpx.Response(
            200,
            content=b"x" * (routes.MAX_RESPONSE_BYTES + 1),
            headers={"Content-Type": "application/json"},
        ),
        httpx.Response(
            200,
            content=b"{}",
            headers={
                "Content-Type": "application/json",
                "Content-Length": "9" * 10000,
            },
        ),
        httpx.Response(
            200, content=b"[]", headers={"Content-Type": "application/json"}
        ),
        httpx.Response(200, content=b"{}", headers={"Content-Type": "text/plain"}),
    ],
)
def test_redirects_oversize_non_object_and_wrong_content_type_are_rejected(
    monkeypatch, tmp_path, response
):
    api = client(monkeypatch, tmp_path, handler=lambda req: response)
    assert api.get("/api/v1/v5-advisory/v1/context").status_code in {502, 503}


def test_missing_config_is_explicitly_unavailable(monkeypatch, tmp_path):
    monkeypatch.delenv("V5_OBSERVATION_URL", raising=False)
    monkeypatch.setenv("V5_OBSERVATION_TOKEN_FILE", str(tmp_path / "missing"))
    app = FastAPI()
    app.include_router(routes.router, prefix="/api/v1")
    app.dependency_overrides[get_current_user] = lambda: WebUser(id=7, role="user")
    assert (
        TestClient(app).get("/api/v1/v5-advisory/v1/advice/status").status_code == 503
    )
