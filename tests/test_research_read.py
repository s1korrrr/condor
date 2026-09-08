import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from condor.web.auth import get_current_user
from condor.web.models import WebUser


def client(monkeypatch, *, access=True, authenticated=True, handler=None):
    from condor import research_read
    from condor.web.routes import research

    monkeypatch.setenv("CONDOR_RESEARCH_SERVER", "native-ok-rsi")

    class Config:
        def has_server_access(self, user_id, server):
            return access and user_id == 1 and server == "native-ok-rsi"

    monkeypatch.setattr(research, "get_config_manager", lambda: Config())
    transport = httpx.MockTransport(
        handler
        or (
            lambda req: httpx.Response(
                200, json={"items": [], "total": 0, "limit": 30, "offset": 0}
            )
        )
    )
    monkeypatch.setattr(
        research_read, "_client", lambda: httpx.AsyncClient(transport=transport)
    )
    app = FastAPI()
    app.include_router(research.router, prefix="/api/v1")
    if authenticated:
        app.dependency_overrides[get_current_user] = lambda: WebUser(id=1, role="admin")
    return TestClient(app)


def test_research_auth_and_exact_configured_server(monkeypatch):
    assert client(monkeypatch, authenticated=False).get(
        "/api/v1/research/nodes?server=native-ok-rsi"
    ).status_code in (401, 403)
    assert (
        client(monkeypatch, access=False)
        .get("/api/v1/research/nodes?server=native-ok-rsi")
        .status_code
        == 404
    )
    assert (
        client(monkeypatch).get("/api/v1/research/nodes?server=other").status_code
        == 404
    )


def test_research_nodes_fixed_origin_bounded_envelope_and_no_forwarded_auth(
    monkeypatch,
):
    def handler(req):
        assert str(req.url).startswith("http://127.0.0.1:8873/api/knowledge/nodes?")
        assert "server" not in req.url.params
        assert "authorization" not in req.headers and "cookie" not in req.headers
        return httpx.Response(
            200, json={"items": [], "total": 0, "limit": 30, "offset": 0}
        )

    response = client(monkeypatch, handler=handler).get(
        "/api/v1/research/nodes?server=native-ok-rsi",
        headers={"Authorization": "private", "Cookie": "private"},
    )
    assert response.status_code == 200
    assert response.json()["source"]["owner"] == "research_os"
    assert response.json()["data"]["total"] == 0
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize(
    "query",
    [
        "limit=51",
        "limit=-1",
        "offset=10001",
        "q=a&q=b",
        "url=http://example.com",
        "path=/etc/passwd",
    ],
)
def test_research_rejects_bad_queries(monkeypatch, query):
    assert (
        client(monkeypatch)
        .get("/api/v1/research/nodes?server=native-ok-rsi&" + query)
        .status_code
        == 400
    )


@pytest.mark.parametrize(
    "path", ["sync", "run", "source", "../source", "network", "node/anything"]
)
def test_research_rejects_unlisted_paths(monkeypatch, path):
    assert (
        client(monkeypatch)
        .get("/api/v1/research/" + path + "?server=native-ok-rsi")
        .status_code
        == 404
    )


@pytest.mark.parametrize("method", ["post", "put", "delete", "patch"])
def test_research_mutations_absent(monkeypatch, method):
    assert (
        getattr(client(monkeypatch), method)(
            "/api/v1/research/nodes?server=native-ok-rsi"
        ).status_code
        == 405
    )


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(302, headers={"location": "http://example.com/private"}),
        httpx.Response(503, text="private upstream path"),
        httpx.Response(200, text="<html>source file</html>"),
        httpx.Response(
            200, json={"items": [], "total": "unknown", "limit": 30, "offset": 0}
        ),
        httpx.Response(
            200,
            content=b'{"items":[], "total":NaN}',
            headers={"content-type": "application/json"},
        ),
        httpx.Response(
            200,
            content=b"x" * (1024 * 1024 + 1),
            headers={"content-type": "application/json"},
        ),
    ],
)
def test_research_malformed_or_oversized_never_becomes_success(monkeypatch, response):
    result = client(monkeypatch, handler=lambda req: response).get(
        "/api/v1/research/nodes?server=native-ok-rsi"
    )
    assert result.status_code == 502
    assert "private" not in result.text and "source file" not in result.text


def test_research_offline_error_is_sanitized(monkeypatch):
    def unavailable(req):
        raise httpx.ConnectError("/private/path credential", request=req)

    response = client(monkeypatch, handler=unavailable).get(
        "/api/v1/research/nodes?server=native-ok-rsi"
    )
    assert response.status_code == 502 and "credential" not in response.text


def test_research_preserves_source_freshness_and_omits_filesystem_locators(monkeypatch):
    payload = {
        "counts": {"ideas": 3},
        "facets": {},
        "limitations": ["Counts are not economic support"],
        "generated_at": "2026-01-01T00:00:00Z",
        "source_revision": "source-sha",
        "revision": "graph-sha",
        "source_root": "/private/workspace",
        "store": "/private/store",
        "freshness": {
            "state": "PENDING",
            "last_sync": "2026-01-01T00:00:00Z",
            "pending_events": 2,
        },
    }
    response = client(
        monkeypatch, handler=lambda req: httpx.Response(200, json=payload)
    ).get("/api/v1/research/overview?server=native-ok-rsi")
    data = response.json()["data"]
    assert data["freshness"] == payload["freshness"]
    assert data["generated_at"] == payload["generated_at"]
    assert data["revision"] == "graph-sha" and data["source_revision"] == "source-sha"
    assert "source_root" not in data and "store" not in data


def test_research_detail_identity_and_record_projection(monkeypatch):
    node = {
        "id": "idea:one",
        "kind": "idea",
        "title": "<script>plain text</script>",
        "status": "PROPOSED",
        "source": {
            "path": "/private/data.json",
            "sha256": "exact-hash",
            "origin": "registered_idea",
        },
        "data": {
            "hypothesis": "Unproven mechanism",
            "api_key": "not-visible",
            "command": ["execute"],
            "verdict": "UNAVAILABLE",
        },
    }
    payload = {
        "node": node,
        "edges": [],
        "related": [],
        "usage": {"valid_evaluations": 0},
    }
    c = client(monkeypatch, handler=lambda req: httpx.Response(200, json=payload))
    response = c.get("/api/v1/research/node?server=native-ok-rsi&id=idea:one")
    projected = response.json()["data"]["node"]
    assert projected["source"] == {"sha256": "exact-hash", "origin": "registered_idea"}
    assert projected["data"] == {
        "hypothesis": "Unproven mechanism",
        "verdict": "UNAVAILABLE",
    }
    assert projected["title"] == node["title"]
    assert (
        c.get("/api/v1/research/node?server=native-ok-rsi&id=idea:other").status_code
        == 502
    )


def test_research_graph_preserves_relation_basis_and_truncation(monkeypatch):
    node = {"id": "idea:one", "kind": "idea", "title": "Idea", "status": "PROPOSED"}
    payload = {
        "nodes": [node],
        "edges": [
            {
                "source": "idea:one",
                "target": "idea:one",
                "relation": "revision_of",
                "basis": "EXPLICIT",
                "resolved": True,
            }
        ],
        "truncated": True,
    }
    response = client(
        monkeypatch, handler=lambda req: httpx.Response(200, json=payload)
    ).get("/api/v1/research/graph?server=native-ok-rsi&id=idea:one")
    assert response.json()["data"] == payload


def test_research_graph_accepts_bounded_large_native_records_without_shipping_details(
    monkeypatch,
):
    node = {
        "id": "idea:one",
        "kind": "idea",
        "title": "Idea",
        "status": "PROPOSED",
        "source": {"sha256": "source-hash"},
        "data": {"native_evidence": "x" * 1_300_000},
    }
    payload = {"nodes": [node], "edges": [], "truncated": False}
    response = client(
        monkeypatch, handler=lambda req: httpx.Response(200, json=payload)
    ).get("/api/v1/research/graph?server=native-ok-rsi&id=idea:one")
    assert response.status_code == 200
    projected = response.json()["data"]["nodes"][0]
    assert projected == {key: value for key, value in node.items() if key != "data"}
    assert len(response.content) < 2000


def test_research_graph_still_rejects_source_over_four_megabytes(monkeypatch):
    payload = {
        "nodes": [
            {
                "id": "idea:one",
                "kind": "idea",
                "title": "Idea",
                "status": "PROPOSED",
                "data": {"native_evidence": "x" * (4 * 1024 * 1024)},
            }
        ],
        "edges": [],
        "truncated": False,
    }
    response = client(
        monkeypatch, handler=lambda req: httpx.Response(200, json=payload)
    ).get("/api/v1/research/graph?server=native-ok-rsi&id=idea:one")
    assert response.status_code == 502


def test_research_large_node_retains_native_evidence_for_detail(monkeypatch):
    node = {
        "id": "idea:one",
        "kind": "idea",
        "title": "Idea",
        "status": "PROPOSED",
        "data": {"native_evidence": "x" * 1_300_000, "net_pnl_quote": -12.5},
    }
    payload = {"node": node, "edges": [], "related": []}
    response = client(
        monkeypatch, handler=lambda req: httpx.Response(200, json=payload)
    ).get("/api/v1/research/node?server=native-ok-rsi&id=idea:one")
    assert response.status_code == 200
    assert response.json()["data"]["node"]["data"] == node["data"]


def test_research_missing_configuration_is_explicit(monkeypatch):
    c = client(monkeypatch)
    monkeypatch.delenv("CONDOR_RESEARCH_SERVER")
    assert c.get("/api/v1/research/overview?server=native-ok-rsi").status_code == 503


def test_research_comparisons_preserve_contract_groups_and_missing_curves(monkeypatch):
    conditions = {
        "capital_model": "SPOT_1X",
        "costs_identity": "cost-hash",
        "execution_identity": "owner-hash",
        "window": {"start": "2026-05-01", "end": "2026-09-01"},
    }
    item = {
        "id": "assessment:1",
        "label": "evaluation:1",
        "value": -3.2,
        "unit": "USDC",
        "metric": "net_pnl",
        "baseline": "owner:baseline",
        "comparable_group": "group:spot",
        "verdict": "CONTRADICTED",
        "conditions": conditions,
        "source_refs": [{"path": "/private/evidence", "sha256": "evidence-hash"}],
        "validity": "VALID",
        "attribution": "ISOLATED",
    }
    payload = {
        "items": [item],
        "limitations": [
            "Separate groups must not be pooled. Missing curves are unavailable."
        ],
    }

    def handler(req):
        assert req.url.path == "/api/knowledge/comparisons"
        assert req.url.params["idea_id"] == "idea:one"
        return httpx.Response(200, json=payload)

    c = client(monkeypatch, handler=handler)
    response = c.get(
        "/api/v1/research/comparisons?server=native-ok-rsi&idea_id=idea:one"
    )
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["items"][0]["conditions"] == conditions
    assert (
        data["items"][0]["value"] == -3.2
        and data["items"][0]["comparable_group"] == "group:spot"
    )
    assert data["items"][0]["source_refs"] == [{"sha256": "evidence-hash"}]
    assert data["limitations"] == payload["limitations"]
    assert c.get("/api/v1/research/comparisons?server=native-ok-rsi").status_code == 400
    assert (
        c.get(
            "/api/v1/research/comparisons?server=native-ok-rsi&idea_id=a&idea_id=b"
        ).status_code
        == 400
    )


def test_research_clusters_preserve_source_counts_and_basis(monkeypatch):
    payload = {
        "items": [
            {
                "family": "ok_rsi",
                "lane": "SPOT",
                "node_count": 4,
                "idea_count": 1,
                "experiment_count": 1,
            }
        ],
        "total": 1,
        "basis": "Recorded family and accounting lane; not inferred performance similarity",
    }
    c = client(monkeypatch, handler=lambda req: httpx.Response(200, json=payload))
    response = c.get("/api/v1/research/clusters?server=native-ok-rsi")
    assert response.status_code == 200 and response.json()["data"] == payload
    assert (
        c.get("/api/v1/research/clusters?server=native-ok-rsi&limit=10").status_code
        == 400
    )


@pytest.mark.parametrize(
    "endpoint,payload",
    [
        ("comparisons", {"items": [{"value": 1}], "limitations": []}),
        ("clusters", {"items": [], "total": 8, "basis": "Recorded"}),
    ],
)
def test_research_new_read_shapes_fail_closed(monkeypatch, endpoint, payload):
    c = client(monkeypatch, handler=lambda req: httpx.Response(200, json=payload))
    assert (
        c.get(
            f"/api/v1/research/{endpoint}?server=native-ok-rsi"
            + ("&idea_id=idea:one" if endpoint == "comparisons" else "")
        ).status_code
        == 502
    )


def test_projection_redacts_nested_local_locators_and_credentials():
    from condor.research_read import _project

    data = {
        "execution": {
            "python": "/Users/operator/env/bin/python",
            "entrypoints": ["/tmp/run.py"],
            "snapshot_dir": "/private/tmp/evidence",
            "workspace": "/Users/operator/work",
        },
        "sources": [{"git": {"repository": "/Users/operator/repo", "sha": "abc"}}],
        "input_files": ["/Users/operator/input.csv"],
        "access_token": "private-token",
        "nested": {"secret": "private", "authorization": "Bearer private"},
        "hypothesis": "Drawdown / exposure ratio",
        "source_refs": ["evidence:abc"],
    }
    projected = _project(data)
    import json

    encoded = json.dumps(projected)
    assert (
        "/Users/" not in encoded
        and "/private/" not in encoded
        and "/tmp/" not in encoded
    )
    assert "private-token" not in encoded and "Bearer private" not in encoded
    assert projected["hypothesis"] == data["hypothesis"]
    assert projected["source_refs"] == ["evidence:abc"]


def test_catalog_and_graph_request_owner_summary_projection(monkeypatch):
    def handler(req):
        assert req.url.params["projection"] == "summary"
        return httpx.Response(
            200, json={"items": [], "total": 0, "limit": 30, "offset": 0}
        )

    assert (
        client(monkeypatch, handler=handler)
        .get("/api/v1/research/nodes?server=native-ok-rsi")
        .status_code
        == 200
    )


def test_projection_redacts_locators_embedded_in_rationale_without_hiding_evidence():
    from condor.research_read import _project

    data = {
        "rationale": 'Qualification HELD. Proofs [{"path":"/Users/operator/evidence/check.json","sha256":"abc"}]',
        "link": "https://example.org/papers/one",
        "ratio": "gross / net",
    }
    result = _project(data)
    assert "/Users/operator" not in result["rationale"]
    assert (
        "Qualification HELD" in result["rationale"]
        and '"sha256":"abc"' in result["rationale"]
    )
    assert result["link"] == data["link"] and result["ratio"] == data["ratio"]


def test_projection_anonymizes_local_locator_dictionary_keys_without_losing_hashes():
    from condor.research_read import _project

    data = {
        "code_sha256": {
            "/Users/operator/one.py": "hash-one",
            "/Users/operator/two.py": "hash-two",
        }
    }
    projected = _project(data)
    assert all("/Users/" not in key for key in projected["code_sha256"])
    assert sorted(projected["code_sha256"].values()) == ["hash-one", "hash-two"]
    assert _project(data) == projected


@pytest.mark.parametrize("reverse", [False, True])
def test_projection_rejects_anonymized_key_collision_without_losing_evidence(reverse):
    import hashlib

    from condor.research_read import _project

    key = "/Users/operator/one.py"
    values = [
        (key, "source-hash"),
        (
            "local-locator:" + hashlib.sha256(key.encode()).hexdigest(),
            "literal-key-hash",
        ),
    ]
    with pytest.raises(ValueError, match="key collision"):
        _project(dict(reversed(values) if reverse else values))
