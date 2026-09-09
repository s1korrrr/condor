"""Entry HTML must revalidate so navigation uses the deployed bundle."""

import pytest
from starlette.testclient import TestClient

from condor.web import app as web_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    dist = tmp_path / "frontend" / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text('<script src="/assets/current.js"></script>')
    (dist / "assets" / "current.js").write_text("export const current = true;")
    monkeypatch.setattr(
        web_app, "__file__", str(tmp_path / "condor" / "web" / "app.py")
    )
    with TestClient(web_app.create_app()) as test_client:
        yield test_client


@pytest.mark.parametrize("path", ["/", "/index.html", "/bots", "/trading-visuals"])
def test_entry_html_requires_revalidation(client, path):
    response = client.get(path)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-cache"
    assert response.headers.get("etag")
    assert "/assets/current.js" in response.text


def test_asset_caching_is_unchanged(client):
    response = client.get("/assets/current.js")
    assert response.status_code == 200
    assert "cache-control" not in response.headers
    assert response.headers.get("etag")
