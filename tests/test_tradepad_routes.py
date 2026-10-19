"""Tradepad store and routes: published backtest bundles are listed, verified and served read-only."""

import hashlib
import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from condor import tradepad_store as store
from condor.web.auth import get_current_user
from condor.web.models import WebUser
from condor.web.routes import tradepad

BUNDLE = json.dumps({"schema": "tradepad.bundle.v2", "datasets": []}).encode()


def meta(bundle_id, data=BUNDLE, published="2026-10-19T12:00:00Z", **extra):
    value = {
        "schema": "tradepad.bundle.meta.v1",
        "id": bundle_id,
        "title": f"Bundle {bundle_id}",
        "built_utc": "2026-10-19T08:46:41Z",
        "published_utc": published,
        "bundle_sha256": hashlib.sha256(data).hexdigest(),
        "bundle_bytes": len(data),
        "datasets": [
            {
                "id": "marsep-2026",
                "title": "Mar-Sep",
                "strategies": [{"id": "u_pick", "ret": 44.9}],
            }
        ],
    }
    value.update(extra)
    return value


def publish(root: Path, bundle_id, data=BUNDLE, **extra):
    directory = root / "bundles" / bundle_id
    directory.mkdir(parents=True)
    (directory / "bundle.json").write_bytes(data)
    (directory / "bundle.meta.json").write_text(
        json.dumps(meta(bundle_id, data, **extra))
    )
    (directory / "bundle.provenance.json").write_text(json.dumps({"runs": 1}))
    return directory


@pytest.fixture
def root(tmp_path, monkeypatch):
    monkeypatch.setenv("CONDOR_TRADEPAD_DIR", str(tmp_path))
    store._HASHES.clear()
    return tmp_path


def client(authenticated=True):
    app = FastAPI()
    app.include_router(tradepad.router, prefix="/api/v1")
    app.include_router(tradepad.page_router)
    if authenticated:
        app.dependency_overrides[get_current_user] = lambda: WebUser(id=1, role="admin")
    return TestClient(app)


# --------------------------------------------------------------------------------------------- store


def test_catalog_lists_valid_bundles_newest_first_and_reports_every_bad_entry(root):
    publish(root, "older", published="2026-10-01T00:00:00Z")
    publish(root, "newer", published="2026-10-19T00:00:00Z")
    publish(root, "wrong-schema", schema="tradepad.bundle.meta.v0")
    (root / "bundles" / "Bad Name").mkdir()
    (root / "bundles" / "no-meta").mkdir()
    (root / "bundles" / ".replaced").mkdir()  # hidden: replaced bundles are not entries
    nonfinite = publish(root, "nonfinite")
    (nonfinite / "bundle.meta.json").write_text(
        json.dumps(meta("nonfinite")).replace("44.9", "NaN")
    )
    value = store.catalog(root)
    assert [m["id"] for m in value["bundles"]] == ["newer", "older"]
    errors = {e["id"]: e["error"] for e in value["errors"]}
    assert set(errors) == {"Bad Name", "no-meta", "nonfinite", "wrong-schema"}
    assert "missing" in errors["no-meta"] and "schema" in errors["wrong-schema"]
    assert "non-finite" in errors["nonfinite"]


def test_meta_must_name_its_own_directory(root):
    directory = publish(root, "one")
    (directory / "bundle.meta.json").write_text(json.dumps(meta("another")))
    assert "does not match its directory" in store.catalog(root)["errors"][0]["error"]


def test_empty_or_missing_store(root, monkeypatch):
    assert store.catalog(root) == {"bundles": [], "errors": []}
    monkeypatch.delenv("CONDOR_TRADEPAD_DIR")
    with pytest.raises(store.TradepadUnavailable, match="not configured"):
        store.store_root()
    monkeypatch.setenv("CONDOR_TRADEPAD_DIR", str(root / "absent"))
    with pytest.raises(store.TradepadUnavailable, match="missing"):
        store.store_root()


def test_bundle_bytes_are_served_only_while_they_match_the_meta(root):
    directory = publish(root, "one")
    assert store.bundle_file(root, "one").sha256 == hashlib.sha256(BUNDLE).hexdigest()
    tampered = BUNDLE.replace(b"v2", b"v3")
    (directory / "bundle.json").write_bytes(tampered)  # same size, other bytes
    with pytest.raises(store.TradepadIntegrityError, match="sha256"):
        store.bundle_file(root, "one")
    (directory / "bundle.json").write_bytes(BUNDLE + b" ")
    with pytest.raises(store.TradepadIntegrityError, match="size"):
        store.bundle_file(root, "one")


@pytest.mark.parametrize("bundle_id", ["missing", "../etc", "UPPER", "a/b", ""])
def test_unknown_or_invalid_bundle_ids_are_not_found(root, bundle_id):
    with pytest.raises(store.TradepadNotFound):
        store.bundle_file(root, bundle_id)


# -------------------------------------------------------------------------------------------- routes


def test_api_requires_a_session(root):
    publish(root, "one")
    anonymous = client(authenticated=False)
    for path in (
        "/api/v1/tradepad/catalog",
        "/api/v1/tradepad/bundles/one",
        "/api/v1/tradepad/bundles/one/provenance",
    ):
        assert anonymous.get(path).status_code in (401, 403)


def test_unconfigured_store_is_503(monkeypatch):
    monkeypatch.delenv("CONDOR_TRADEPAD_DIR", raising=False)
    response = client().get("/api/v1/tradepad/catalog")
    assert response.status_code == 503
    assert response.json()["detail"] == "Tradepad store is not configured"


def test_catalog_route(root):
    publish(root, "one")
    response = client().get("/api/v1/tradepad/catalog")
    assert response.status_code == 200
    body = response.json()
    assert body["schema"] == "condor.tradepad.catalog.v1"
    assert [m["id"] for m in body["bundles"]] == ["one"] and body["errors"] == []
    assert response.headers["cache-control"] == "no-store"


def test_bundle_route_serves_verified_bytes_with_a_revalidating_etag(root):
    publish(root, "one")
    api = client()
    response = api.get("/api/v1/tradepad/bundles/one")
    digest = hashlib.sha256(BUNDLE).hexdigest()
    assert response.status_code == 200 and response.content == BUNDLE
    assert response.headers["etag"] == f'"{digest}"'
    assert response.headers["content-type"].startswith("application/json")
    assert response.headers["cache-control"] == "private, no-cache"
    for tag in (f'"{digest}"', f'W/"{digest}"', f'"other", "{digest}"'):
        cached = api.get("/api/v1/tradepad/bundles/one", headers={"If-None-Match": tag})
        assert cached.status_code == 304 and cached.content == b""
    assert (
        api.get(
            "/api/v1/tradepad/bundles/one", headers={"If-None-Match": '"other"'}
        ).status_code
        == 200
    )


def test_bundle_route_errors(root):
    directory = publish(root, "one")
    api = client()
    assert api.get("/api/v1/tradepad/bundles/absent").status_code == 404
    (directory / "bundle.json").write_bytes(BUNDLE.replace(b"v2", b"v3"))
    response = api.get("/api/v1/tradepad/bundles/one")
    assert response.status_code == 409 and "sha256" in response.json()["detail"]


def test_provenance_route(root):
    directory = publish(root, "one")
    api = client()
    response = api.get("/api/v1/tradepad/bundles/one/provenance")
    assert response.status_code == 200 and response.json() == {"runs": 1}
    (directory / "bundle.provenance.json").write_text("{not json")
    assert api.get("/api/v1/tradepad/bundles/one/provenance").status_code == 409


def test_viewer_page_is_served_with_its_own_policy(root):
    api = client(authenticated=False)  # the page is code only; data needs a session
    missing = api.get("/tradepad")
    assert missing.status_code == 503 and "not been published" in missing.text
    (root / "viewer").mkdir()
    (root / "viewer" / "viewer.html").write_text(
        "<!doctype html><title>Tradepad</title>"
    )
    for path in ("/tradepad", "/tradepad/"):
        page = api.get(path)
        assert page.status_code == 200 and "<title>Tradepad</title>" in page.text
        policy = page.headers["content-security-policy"]
        assert "connect-src 'self'" in policy and "frame-ancestors 'self'" in policy
        assert "default-src 'none'" in policy


def test_viewer_page_without_store(monkeypatch):
    monkeypatch.delenv("CONDOR_TRADEPAD_DIR", raising=False)
    page = client(authenticated=False).get("/tradepad")
    assert page.status_code == 503 and "not configured" in page.text


def test_app_registers_the_page_before_the_spa_fallback():
    from condor.web.app import create_app

    paths = [getattr(route, "path", "") for route in create_app().routes]
    assert "/api/v1/tradepad/catalog" in paths and "/tradepad" in paths
    if "/{full_path:path}" in paths:
        assert paths.index("/tradepad") < paths.index("/{full_path:path}")
