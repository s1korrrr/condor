import httpx
import pytest
from fastapi import HTTPException

from condor.research_read import validated_parameters
from tests.test_research_read import client


@pytest.mark.parametrize(
    "key,value",
    [
        ("relation_limit", "0"),
        ("relation_limit", "151"),
        ("relation_limit", "1.0"),
        ("relation_offset", "-1"),
        ("relation_offset", "1000001"),
        ("relation_offset", "１２"),
    ],
)
def test_relationship_bounds(key, value):
    with pytest.raises(HTTPException) as error:
        validated_parameters("node", [("id", "hub"), (key, value)])
    assert error.value.status_code == 400


def test_relationship_request_defaults_and_forwarding(monkeypatch):
    assert validated_parameters("node", [("id", "hub"), ("relation_offset", "25")]) == {
        "id": "hub",
        "relation_limit": "150",
        "relation_offset": "25",
    }

    def handler(request):
        assert request.url.params["relation_limit"] == "25"
        assert request.url.params["relation_offset"] == "150"
        assert request.url.params["projection"] == "summary"
        return httpx.Response(200, json=payload())

    response = client(monkeypatch, handler=handler).get(
        "/api/v1/research/node?server=native-ok-rsi&id=hub&relation_limit=25&relation_offset=150"
    )
    assert response.status_code == 200
    assert response.json()["data"]["relations_page"]["total"] == 173


def payload():
    return {
        "revision": "graph-sha",
        "node": {
            "id": "hub",
            "kind": "artifact_bundle",
            "title": "Hub",
            "status": "INDEXED",
        },
        "edges": [
            {
                "id": f"edge:{i}",
                "source": "hub",
                "target": f"node:{i}",
                "relation": "contains",
                "basis": "recorded",
            }
            for i in range(23)
        ],
        "related": [],
        "relations_page": {"total": 173, "limit": 25, "offset": 150},
    }


@pytest.mark.parametrize(
    "case", ["missing", "offset", "limit", "total", "oversized", "short", "beyond"]
)
def test_relationship_page_rejects_wrong_owner_response(monkeypatch, case):
    data = payload()
    if case == "missing":
        del data["relations_page"]
    elif case == "short":
        data["edges"].pop()
    elif case == "beyond":
        data["relations_page"]["total"] = 150
    elif case == "oversized":
        data["edges"] = [{}] * 26
    else:
        data["relations_page"][case] = -1
    response = client(
        monkeypatch, handler=lambda req: httpx.Response(200, json=data)
    ).get(
        "/api/v1/research/node?server=native-ok-rsi&id=hub&relation_limit=25&relation_offset=150"
    )
    assert response.status_code == 502


@pytest.mark.parametrize(
    "case", ["malformed", "unrelated", "duplicate", "unrelated_neighbor"]
)
def test_relationship_page_rejects_invalid_membership(monkeypatch, case):
    data = payload()
    if case == "malformed":
        data["edges"][0] = {}
    elif case == "unrelated":
        data["edges"][0]["source"] = "another-hub"
    elif case == "duplicate":
        data["edges"][1] = data["edges"][0]
    else:
        data["related"] = [
            {
                "id": "outside",
                "kind": "run",
                "title": "Wrong neighbor",
                "status": "INDEXED",
            }
        ]
    response = client(
        monkeypatch, handler=lambda req: httpx.Response(200, json=data)
    ).get(
        "/api/v1/research/node?server=native-ok-rsi&id=hub&relation_limit=25&relation_offset=150"
    )
    assert response.status_code == 502


@pytest.mark.parametrize("revision", [None, "", 3])
def test_relationship_page_requires_revision(monkeypatch, revision):
    data = payload()
    data["revision"] = revision
    response = client(
        monkeypatch, handler=lambda req: httpx.Response(200, json=data)
    ).get(
        "/api/v1/research/node?server=native-ok-rsi&id=hub&relation_limit=25&relation_offset=150"
    )
    assert response.status_code == 502


def test_relationship_page_requires_present_revision(monkeypatch):
    data = payload()
    del data["revision"]
    response = client(
        monkeypatch, handler=lambda req: httpx.Response(200, json=data)
    ).get(
        "/api/v1/research/node?server=native-ok-rsi&id=hub&relation_limit=25&relation_offset=150"
    )
    assert response.status_code == 502
