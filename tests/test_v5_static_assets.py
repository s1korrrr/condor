import hashlib
import json
import os
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
    original_open = os.open
    reviewed = image.read_bytes()

    def open_then_replace(path, flags, *args, **kwargs):
        descriptor = original_open(path, flags, *args, **kwargs)
        if Path(path) == image:
            image.rename(dist / 'retained-condor.png')
            image.write_bytes(b'unreviewed replacement')
        return descriptor

    monkeypatch.setattr(os, 'open', open_then_replace)
    response = client.get('/condor.png')
    assert response.status_code == 200
    assert response.content == reviewed


@pytest.mark.parametrize('kind', ['directory', 'fifo', 'oversized'])
def test_root_static_requires_a_bounded_regular_descriptor(static_site, kind):
    client, dist = static_site
    image = dist / 'condor.png'
    image.rename(dist / 'retained-condor.png')
    if kind == 'directory':
        image.mkdir()
    elif kind == 'fifo':
        os.mkfifo(image)
    else:
        with image.open('wb') as source:
            source.truncate(8 * 1024 * 1024 + 1)
    assert client.get('/condor.png').status_code == 404
    assert client.head('/condor.png').status_code == 404


def test_root_static_size_limit_uses_the_open_descriptor(static_site, monkeypatch):
    client, _ = static_site
    original_fstat = os.fstat
    checked = []

    def oversized_descriptor(descriptor):
        metadata = original_fstat(descriptor)
        checked.append(descriptor)
        values = list(metadata)
        values[6] = 8 * 1024 * 1024 + 1
        return os.stat_result(values)

    monkeypatch.setattr(os, 'fstat', oversized_descriptor)
    assert client.get('/condor.png').status_code == 404
    assert checked


def test_legacy_logo_also_requires_its_reviewed_hash(static_site):
    client, dist = static_site
    (dist / 'condor_old.jpeg').write_bytes(b'not reviewed')
    assert client.get('/condor_old.jpeg').status_code == 404
    assert client.head('/condor_old.jpeg').status_code == 404


@pytest.mark.parametrize('name', [*ROOT_ASSETS, 'favicon.ico'])
def test_root_static_head_matches_get_headers_without_body(static_site, name):
    client, _ = static_site
    response = client.get('/' + name)
    head = client.head('/' + name)
    assert head.status_code == response.status_code == 200
    assert head.headers == response.headers
    assert head.content == b''


def test_root_static_symlink_swap_at_open_is_rejected(static_site, monkeypatch):
    client, dist = static_site
    image = dist / 'condor.png'
    retained = dist / 'retained-condor.png'
    original_open = os.open
    original_read = Path.read_bytes
    swapped = False

    def swap():
        nonlocal swapped
        if not swapped:
            image.rename(retained)
            image.symlink_to(retained)
            swapped = True

    def swap_before_open(path, flags, *args, **kwargs):
        if Path(path) == image:
            swap()
        return original_open(path, flags, *args, **kwargs)

    def swap_before_read(path):
        if path == image:
            swap()
        return original_read(path)

    monkeypatch.setattr(os, 'open', swap_before_open)
    monkeypatch.setattr(Path, 'read_bytes', swap_before_read)
    assert client.get('/condor.png').status_code == 404
    assert swapped


def test_missing_static_manifest_logs_warning(tmp_path, caplog):
    dist = tmp_path / 'dist-v5'
    dist.mkdir()
    create_app(settings=settings(tmp_path), upstream=FakeUpstream(), static_dir=dist)
    assert 'V5 root statics withheld: missing reviewed manifest' in caplog.text
