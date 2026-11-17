import hashlib
import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from condor.v5.app import create_app
from test_v5_workspace_auth import FakeUpstream, settings


ROOT_ASSETS = {
    'condor.png': 'image/png',
    'favicon.svg': 'image/svg+xml',
    'hyperliquid.png': 'image/png',
    'icons.svg': 'image/svg+xml',
    'condor_old.jpeg': 'image/jpeg',
}


def test_runtime_image_preserves_reviewed_static_manifest():
    dockerfile = (Path(__file__).resolve().parents[1] / 'Dockerfile.v5').read_text()
    runtime_stage = dockerfile.rsplit('\nFROM ', 1)[1]
    assert re.search(
        r'^COPY --from=frontend /build/condor/frontend/v5-reviewed-build\.json ./frontend/v5-reviewed-build\.json$',
        runtime_stage,
        re.MULTILINE,
    )


@pytest.fixture
def static_site(tmp_path):
    dist = tmp_path / 'dist-v5'
    dist.mkdir()
    files = {}
    public = Path(__file__).resolve().parents[1] / 'frontend/public'
    for name in ROOT_ASSETS:
        content = (public / name).read_bytes()
        (dist / name).write_bytes(content)
        files[name] = hashlib.sha256(content).hexdigest()
    html = (Path(__file__).resolve().parents[1] / 'frontend/v5.html').read_text()
    (dist / 'v5.html').write_text(html)
    files['v5.html'] = hashlib.sha256(html.encode()).hexdigest()
    manifest = {'entry': 'v5.html', 'entrySha256': files['v5.html'], 'files': files}
    (tmp_path / 'v5-reviewed-build.json').write_text(json.dumps(manifest))
    app = create_app(settings=settings(tmp_path), upstream=FakeUpstream(), static_dir=dist)
    with TestClient(app) as client:
        yield client, dist


@pytest.mark.parametrize('name, media_type', ROOT_ASSETS.items())
def test_shipped_root_static_is_served(static_site, name, media_type):
    client, dist = static_site
    response = client.get('/' + name)
    assert response.status_code == 200
    assert response.headers['content-type'].split(';')[0] == media_type
    assert response.content == (dist / name).read_bytes()


def test_browser_favicon_request_has_a_real_image(static_site):
    client, dist = static_site
    response = client.get('/favicon.ico')
    assert response.status_code == 200
    assert response.headers['content-type'] == 'image/svg+xml'
    assert response.content == (dist / 'favicon.svg').read_bytes()


def test_html_icon_link_resolves_to_a_shipped_file(static_site):
    client, dist = static_site
    html = client.get('/').text
    icon = re.search(r'<link\b(?=[^>]*\brel="icon")(?=[^>]*\bhref="([^"]+)")[^>]*>', html)
    assert icon is not None
    name = icon.group(1).removeprefix('/')
    assert name in ROOT_ASSETS
    assert (dist / name).is_file()
    assert client.get('/' + name).status_code == 200


@pytest.mark.parametrize('path', [
    '/%2e%2e/v5-reviewed-build.json', '/%2e%2e%2fv5-reviewed-build.json',
    '/assets/%2e%2e/favicon.svg', '/%2e%2e%5cfavicon.svg', '/v5-reviewed-build.json',
    '/unreviewed.png', '/nested/favicon.svg', '/favicon.svg/extra',
])
def test_static_paths_do_not_escape_the_allowlist(static_site, path):
    client, dist = static_site
    (dist / 'unreviewed.png').write_bytes(b'unreviewed')
    assert client.get(path).status_code == 404


@pytest.mark.parametrize('name', ['favicon.svg', 'condor.png'])
def test_reviewed_static_symlink_is_not_served(static_site, name):
    client, dist = static_site
    image = dist / name
    image.rename(dist / ('retained-' + name))
    image.symlink_to(dist / ('retained-' + name))
    assert client.get('/' + name).status_code == 404


def test_changed_reviewed_static_is_not_served(static_site):
    client, dist = static_site
    (dist / 'favicon.svg').write_bytes(b'not the reviewed icon')
    assert client.get('/favicon.svg').status_code == 404


def test_static_response_uses_the_bytes_that_were_verified(static_site, monkeypatch):
    client, dist = static_site
    image = dist / 'condor.png'
    original_read = Path.read_bytes
    reviewed = original_read(image)

    def read_then_replace(path):
        content = original_read(path)
        if path == image:
            path.rename(dist / 'retained-condor.png')
            path.write_bytes(b'unreviewed replacement')
        return content

    monkeypatch.setattr(Path, 'read_bytes', read_then_replace)
    response = client.get('/condor.png')
    assert response.status_code == 200
    assert response.content == reviewed
