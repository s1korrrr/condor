import httpx
import pytest
from test_research_read import client


def network():
    return {
        "revision": "rev",
        "node_fields": ["id", "kind", "title", "family", "lane"],
        "nodes": [["a", "idea", "A", "rsi", "SPOT"], ["b", "run", "B", "rsi", "SPOT"]],
        "edge_fields": ["source", "target", "relation", "basis"],
        "edges": [[0, 1, "tested", "EXPLICIT"]],
        "total_nodes": 2,
        "total_edges": 2,
        "unresolved_edges": 1,
        "stats": {
            key: [{"key": "fixture", "count": 2}]
            for key in ("kinds", "relations", "families", "lanes")
        },
    }


def test_full_network_preserves_native_indices_and_counts(monkeypatch):
    data = network()
    response = client(
        monkeypatch, handler=lambda req: httpx.Response(200, json=data)
    ).get("/api/v1/research/network?server=native-ok-rsi")
    assert response.status_code == 200
    assert response.json()["data"] == data


@pytest.mark.parametrize(
    "mutation", ["index", "duplicate", "count", "unresolved", "revision"]
)
def test_full_network_rejects_inconsistent_identity(monkeypatch, mutation):
    data = network()
    if mutation == "index":
        data["edges"][0][1] = 2
    elif mutation == "duplicate":
        data["nodes"][1][0] = "a"
    elif mutation == "count":
        data["total_nodes"] = 1
    elif mutation == "unresolved":
        data["total_edges"] = 1
    else:
        data["revision"] = None
    response = client(
        monkeypatch, handler=lambda req: httpx.Response(200, json=data)
    ).get("/api/v1/research/network?server=native-ok-rsi")
    assert response.status_code == 502


@pytest.mark.parametrize(
    "endpoint,item",
    [
        ("queue", {"id": "q", "node_id": "a", "title": "Next", "reason": "Missing"}),
        (
            "learning",
            {"id": "a", "kind": "decision", "title": "Outcome", "status": "HOLD"},
        ),
        ("unresolved", {"id": "gap", "kind": "recorded_gap", "reason": "Missing"}),
        (
            "archive",
            {"id": "old", "kind": "experiment", "title": "Old", "status": "FAILED"},
        ),
    ],
)
def test_new_paginated_native_reads(monkeypatch, endpoint, item):
    data = {"items": [item], "total": 1, "limit": 30, "offset": 0, "revision": "rev"}
    response = client(
        monkeypatch, handler=lambda req: httpx.Response(200, json=data)
    ).get(f"/api/v1/research/{endpoint}?server=native-ok-rsi")
    assert response.status_code == 200
    assert response.json()["data"]["items"] == [item]


def test_archive_full_record_and_receipts_keep_fields_without_locators(monkeypatch):
    data = {
        "record": {"id": "old", "fields": {"metric": 42, "path": "/private/source"}},
        "revision": "rev",
        "documents": [],
    }
    response = client(
        monkeypatch, handler=lambda req: httpx.Response(200, json=data)
    ).get("/api/v1/research/archive-record?server=native-ok-rsi&id=old")
    assert response.status_code == 200
    assert response.json()["data"]["record"]["fields"] == {"metric": 42}


def test_document_stream_has_auth_boundary_and_no_token_forwarding(monkeypatch):
    def handler(req):
        assert str(req.url).startswith("http://127.0.0.1:8873/api/knowledge/document?")
        assert "authorization" not in req.headers
        assert "cookie" not in req.headers
        return httpx.Response(
            200,
            content=b"<html>source</html>",
            headers={"Content-Type": "text/html", "Content-Length": "19"},
        )

    response = client(monkeypatch, handler=handler).get(
        "/api/v1/research/document?server=native-ok-rsi&scope=node&id=a&ref=" + "a" * 64
    )
    assert response.status_code == 200
    assert response.content == b"<html>source</html>"
    assert response.headers["content-security-policy"].startswith("sandbox")
    assert response.headers["content-disposition"] == "attachment"


@pytest.mark.parametrize(
    "query",
    [
        "scope=file&id=a&ref=" + "a" * 64,
        "scope=node&id=a&ref=/etc/passwd",
        "scope=node&id=a&ref=" + "a" * 64 + "&url=http://evil",
    ],
)
def test_document_rejects_unbound_or_arbitrary_source_requests(monkeypatch, query):
    response = client(monkeypatch).get(
        "/api/v1/research/document?server=native-ok-rsi&" + query
    )
    assert response.status_code == 400


@pytest.mark.parametrize("status", [403, 404, 409, 413])
def test_owner_document_failure_remains_explicit(monkeypatch, status):
    response = client(
        monkeypatch,
        handler=lambda req: httpx.Response(status, json={"error": "private path"}),
    ).get(
        "/api/v1/research/document?server=native-ok-rsi&scope=node&id=a&ref=" + "a" * 64
    )
    assert response.status_code == status
    assert "private path" not in response.text


@pytest.mark.parametrize(
    "headers",
    [
        {"Content-Length": "-1"},
        {"Content-Length": "unknown"},
        {"Content-Length": "1", "Content-Encoding": "gzip"},
        {"Content-Length": "1", "Content-Type": "text/html; invalid=parameter"},
    ],
)
def test_document_rejects_invalid_length_encoding_or_media(monkeypatch, headers):
    response = client(
        monkeypatch,
        handler=lambda req: httpx.Response(200, content=b"x", headers=headers),
    ).get(
        "/api/v1/research/document?server=native-ok-rsi&scope=node&id=a&ref=" + "a" * 64
    )
    assert response.status_code == 502


def test_complete_network_limit_is_explicit_not_sampling(monkeypatch):
    from condor import research_read

    monkeypatch.setattr(research_read, "NETWORK_MAX_BYTES", 100)
    response = client(
        monkeypatch, handler=lambda req: httpx.Response(200, json=network())
    ).get("/api/v1/research/network?server=native-ok-rsi")
    assert response.status_code == 413
    assert "silently sampled" in response.json()["detail"]
