import asyncio
import hashlib
import json
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from condor.web.auth import get_current_user
from condor.web.models import WebUser
from condor.web.routes import screener as routes


class Content:
    def __init__(self, body):
        self.body = body

    async def iter_chunked(self, size):
        for offset in range(0, len(self.body), size):
            await asyncio.sleep(0)
            yield self.body[offset : offset + size]


class Upstream:
    def __init__(
        self, status=200, body=b'{"ok":true}', content_type="application/json"
    ):
        self.status = status
        self.headers = {"Content-Type": content_type}
        self.content = Content(body)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class Session:
    def __init__(self, response=None):
        self.response = response or Upstream()
        self.calls = []

    def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self.response


def make_client(monkeypatch, *, authenticated=True, access=True, response=None):
    session = Session(response)

    class Config:
        def has_server_access(self, user_id, server):
            return access and server == "v2"

        async def get_client(self, server):
            return SimpleNamespace(
                bot_orchestration=SimpleNamespace(
                    base_url="http://native/api/v1", session=session
                )
            )

    monkeypatch.setattr(routes, "get_config_manager", lambda: Config())
    app = FastAPI()
    app.include_router(routes.router, prefix="/api/v1")
    if authenticated:
        app.dependency_overrides[get_current_user] = lambda: WebUser(id=7, role="user")
    return TestClient(app), session


def test_screener_gateway_requires_authentication_and_server_access(monkeypatch):
    anonymous, _ = make_client(monkeypatch, authenticated=False)
    assert anonymous.get(
        "/api/v1/servers/v2/screener/capabilities?bot=alpha"
    ).status_code in {401, 403}
    denied, _ = make_client(monkeypatch, access=False)
    assert (
        denied.get("/api/v1/servers/v2/screener/capabilities?bot=alpha").status_code
        == 404
    )


def test_screener_gateway_maps_only_fixed_native_gets(monkeypatch):
    client, session = make_client(monkeypatch)
    response = client.get(
        "/api/v1/servers/v2/screener/snapshot?bot=alpha&screen=rsi_low&interval=1m&limit=100&search=BTC"
    )
    assert response.status_code == 200
    url, options = session.calls[0]
    assert url == "http://native/api/v1/market-screener/snapshot"
    assert options["params"] == [
        ("screen", "rsi_low"),
        ("interval", "1m"),
        ("limit", "100"),
        ("search", "BTC"),
        ("bot", "alpha"),
    ]
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"


def test_screener_source_index_is_server_scoped_and_does_not_need_a_client_bot_choice(
    monkeypatch,
):
    client, session = make_client(monkeypatch)
    response = client.get("/api/v1/servers/v2/screener/capabilities")
    assert response.status_code == 200
    assert session.calls[0][0] == "http://native/api/v1/market-screener/capabilities"
    assert session.calls[0][1]["params"] == []


@pytest.mark.parametrize(
    "suffix,query,status",
    [
        ("not-listed", "bot=alpha", 404),
        ("instruments", "bot=alpha", 404),
        ("instruments/../../health", "bot=alpha", 404),
        ("capabilities", "bot=alpha&bot=beta", 400),
        ("snapshot", "bot=alpha&screen=all&screen=rsi_low", 400),
        ("snapshot", "bot=alpha&arbitrary_url=http://example.com", 400),
        ("candles", "bot=alpha&instrument_id=BTC-USDC", 400),
        ("snapshot", "bot=alpha&screen=watchlist&watchlist_ids=not-qualified", 400),
    ],
)
def test_screener_gateway_rejects_unknown_or_ambiguous_inputs(
    monkeypatch, suffix, query, status
):
    client, session = make_client(monkeypatch)
    response = client.get(f"/api/v1/servers/v2/screener/{suffix}?{query}")
    assert response.status_code == status
    assert not session.calls


def test_screener_gateway_rejects_redirect_and_non_json(monkeypatch):
    client, _ = make_client(monkeypatch, response=Upstream(302, b"", "text/plain"))
    response = client.get("/api/v1/servers/v2/screener/health?bot=alpha")
    assert response.status_code == 502
    html, _ = make_client(
        monkeypatch, response=Upstream(200, b"<html>login</html>", "text/html")
    )
    assert html.get("/api/v1/servers/v2/screener/health?bot=alpha").status_code == 502


def test_screener_gateway_bounds_response_bytes(monkeypatch):
    monkeypatch.setattr(routes, "JSON_MAX_BYTES", 16)
    client, _ = make_client(monkeypatch, response=Upstream(200, b"x" * 17))
    response = client.get("/api/v1/servers/v2/screener/health?bot=alpha")
    assert response.status_code == 502


@pytest.mark.parametrize(
    "instrument", ["okx:spot:A-USDC", "okx:spot:" + "A" * 30 + "-USDC"]
)
def test_gateway_accepts_reader_instrument_lengths(monkeypatch, instrument):
    client, session = make_client(monkeypatch)
    assert (
        client.get(
            "/api/v1/servers/v2/screener/candles",
            params={"bot": "alpha", "instrument_id": instrument},
        ).status_code
        == 200
    )
    assert session.calls


def test_gateway_rejects_foreign_quote_watchlist(monkeypatch):
    client, session = make_client(monkeypatch)
    assert (
        client.get(
            "/api/v1/servers/v2/screener/snapshot",
            params={"bot": "alpha", "watchlist_ids": "okx:spot:BTC-USDT"},
        ).status_code
        == 400
    )
    assert not session.calls


def canonical_context(*, schema_version="1.0", numeric_unavailable=False):
    payload = {
        "schema_version": schema_version,
        "stream_id": "okx-spot-usdc-five",
        "epoch": "epoch-1",
        "sequence": 1,
        "source_kind": "observed",
        "snapshot_id": "",
        "venue": "okx",
        "numeraire": "USDC",
        "cutoff_ms": 1_800_000_000_000,
        "available_at_ms": 1_800_000_000_000,
        "expires_at_ms": 1_800_000_060_000,
        "supersedes": None,
        "max_input_available_at_ms": 1_800_000_000_000,
        "status": "DEGRADED",
        "reasons": ["WARMUP_INCOMPLETE"],
        "provenance": {
            "code_digest": "a" * 64,
            "config_digest": "b" * 64,
            "universe_hash": "c" * 64,
            "input_manifest_digest": "d" * 64,
            "model_digest": "e" * 64,
            "serializer_version": "mc-json-1",
            "artifact_refs": [],
        },
        "coverage": {
            "expected_count": 5,
            "valid_count": 5,
            "valid_weight_fraction": 1.0,
            "missing": [],
        },
        "market": [
            {
                "name": "breadth_positive_eq_h5",
                "value": 0.0,
                "unit": "share",
                "horizon_minutes": 5,
                "status": "VALID",
                "reasons": [],
                "valid_count": 5,
                "expected_count": 5,
                "valid_weight_fraction": 1.0,
                "model_id": None,
                "input_available_at_ms": 1_800_000_000_000,
            },
            {
                "name": "market_return_eq_h60",
                "value": 0.0 if numeric_unavailable else None,
                "unit": "return_fraction",
                "horizon_minutes": 60,
                "status": "WARMUP_INCOMPLETE",
                "reasons": ["WARMUP_INCOMPLETE"],
                "valid_count": 0,
                "expected_count": 5,
                "valid_weight_fraction": 0.0,
                "model_id": None,
                "input_available_at_ms": 1_800_000_000_000,
            },
        ],
        "assets": [
            {
                "asset_id": "BTC",
                "instrument_id": "BTC-USDC",
                "reasons": [],
                "features": [],
                "fits": [],
            }
        ],
    }
    canonical = json.dumps(
        {key: value for key, value in payload.items() if key != "snapshot_id"},
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode()
    payload["snapshot_id"] = hashlib.sha256(canonical).hexdigest()
    return json.dumps(payload, separators=(",", ":")).encode()


def canonical_context_with_mutation(mutation):
    payload = json.loads(canonical_context())
    mutation(payload)
    canonical = json.dumps(
        {key: value for key, value in payload.items() if key != "snapshot_id"},
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode()
    payload["snapshot_id"] = hashlib.sha256(canonical).hexdigest()
    return json.dumps(payload, separators=(",", ":")).encode()


def test_canonical_context_gateway_uses_fixed_authenticated_read_and_accepts_zero(
    monkeypatch,
):
    client, session = make_client(
        monkeypatch, response=Upstream(body=canonical_context())
    )

    response = client.get("/api/v1/servers/v2/screener/context")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["availability"] == "available"
    assert response.json()["payload"]["market"][0]["value"] == 0.0
    assert session.calls == [
        (
            "http://native/api/v1/screener/market-context/v1/latest",
            {"params": [], "allow_redirects": False, "timeout": 5.0},
        )
    ]


@pytest.mark.parametrize(
    "status,body,reason",
    [
        (404, b'{"detail":{"reasons":["CONTEXT_UNAVAILABLE"]}}', "CONTEXT_UNAVAILABLE"),
        (503, b'{"detail":{"reasons":["CAPACITY_EXCEEDED"]}}', "CAPACITY_EXCEEDED"),
        (503, b"not-json", "STORE_UNAVAILABLE"),
    ],
)
def test_canonical_context_unavailable_is_a_typed_success_wrapper(
    monkeypatch, status, body, reason
):
    client, _ = make_client(monkeypatch, response=Upstream(status, body))

    response = client.get("/api/v1/servers/v2/screener/context")

    assert response.status_code == 200
    assert response.json() == {
        "availability": "unavailable",
        "reason": reason,
        "source_status": status,
    }


def test_canonical_context_gateway_distinguishes_auth_and_rejects_query_or_unavailable_values(
    monkeypatch,
):
    unauthorized, _ = make_client(
        monkeypatch, response=Upstream(403, b'{"detail":"no"}')
    )
    assert unauthorized.get("/api/v1/servers/v2/screener/context").status_code == 502

    client, session = make_client(monkeypatch)
    assert (
        client.get("/api/v1/servers/v2/screener/context?bot=alpha").status_code == 400
    )
    assert not session.calls

    malformed, _ = make_client(
        monkeypatch, response=Upstream(body=canonical_context(numeric_unavailable=True))
    )
    assert malformed.get("/api/v1/servers/v2/screener/context").status_code == 502


def test_canonical_context_gateway_rejects_unknown_schema_and_bad_digest(monkeypatch):
    unknown, _ = make_client(
        monkeypatch, response=Upstream(body=canonical_context(schema_version="2.0"))
    )
    assert unknown.get("/api/v1/servers/v2/screener/context").status_code == 502

    body = json.loads(canonical_context())
    body["market"][0]["value"] = 1.0
    mismatch, _ = make_client(
        monkeypatch, response=Upstream(body=json.dumps(body).encode())
    )
    assert mismatch.get("/api/v1/servers/v2/screener/context").status_code == 502

    duplicate, _ = make_client(
        monkeypatch,
        response=Upstream(body=b'{"schema_version":"1.0","schema_version":"1.0"}'),
    )
    assert duplicate.get("/api/v1/servers/v2/screener/context").status_code == 502


@pytest.mark.parametrize(
    "mutation",
    [
        lambda body: body["market"][0].pop("model_id"),
        lambda body: body["market"][0].update(horizon_minutes=1441),
        lambda body: body["market"][0].update(status=[]),
        lambda body: body["market"][0].update(unit=[]),
        lambda body: body.update(stream_id="Uppercase"),
        lambda body: body.update(epoch="bad epoch"),
        lambda body: body.update(venue="OKX"),
        lambda body: body.update(numeraire="USDC!"),
        lambda body: body.update(supersedes="bad"),
        lambda body: body.update(unexpected="extra"),
        lambda body: body["assets"][0].update(
            fits=[
                {
                    "horizon_minutes": 60,
                    "status": "VALID",
                    "reasons": [],
                    "training_samples": 1,
                    "history_cutoff_ms": None,
                    "factor_id": "f" * 64,
                }
            ]
        ),
        lambda body: body["assets"][0].update(
            fits=[
                {
                    "horizon_minutes": 60,
                    "status": "INPUT_MISSING",
                    "reasons": ["NOT_A_REASON"],
                    "training_samples": 1,
                    "history_cutoff_ms": None,
                    "factor_id": None,
                }
            ]
        ),
    ],
    ids=[
        "required-nullable-feature-field",
        "horizon-bound",
        "unhashable-feature-status",
        "unhashable-feature-unit",
        "stream-pattern",
        "epoch-pattern",
        "venue-pattern",
        "numeraire-pattern",
        "supersedes-digest",
        "unknown-top-level-field",
        "fit-validity-requires-cutoff",
        "fit-reason-code",
    ],
)
def test_canonical_context_gateway_rejects_malformed_contract_shapes(
    monkeypatch, mutation
):
    body = canonical_context_with_mutation(mutation)
    client, _ = make_client(monkeypatch, response=Upstream(body=body))
    assert client.get("/api/v1/servers/v2/screener/context").status_code == 502


def test_canonical_context_gateway_enforces_authentication_and_server_access(
    monkeypatch,
):
    anonymous, _ = make_client(monkeypatch, authenticated=False)
    assert anonymous.get("/api/v1/servers/v2/screener/context").status_code in {
        401,
        403,
    }

    denied, session = make_client(monkeypatch, access=False)
    assert denied.get("/api/v1/servers/v2/screener/context").status_code == 404
    assert not session.calls


def test_canonical_context_gateway_rejects_redirect_and_oversized_snapshot(monkeypatch):
    redirected, _ = make_client(monkeypatch, response=Upstream(302, b"", "text/plain"))
    assert redirected.get("/api/v1/servers/v2/screener/context").status_code == 502

    monkeypatch.setattr(routes, "CONTEXT_MAX_BYTES", 16)
    oversized, _ = make_client(monkeypatch, response=Upstream(body=b"x" * 17))
    assert oversized.get("/api/v1/servers/v2/screener/context").status_code == 502
