"""Condor must consume a complete, single-revision API catalogue."""

import asyncio
from urllib.parse import parse_qs, urlsplit

from condor.fetchers.fleet import read_full_catalogue


def _read_pages(pages):
    requests = []

    async def read_path(_client, path):
        query = parse_qs(urlsplit(path).query)
        requests.append(query)
        return pages[len(requests) - 1]

    return requests, read_path


def test_catalogue_reads_every_visible_page():
    requests, read_path = _read_pages([
        {"catalogue_revision": "rev-1", "items": [{"bot_key": "a"}], "cursor": "rev-1|1", "count": 2},
        {"catalogue_revision": "rev-1", "items": [{"bot_key": "b"}], "cursor": None, "count": 2},
    ])
    result = asyncio.run(read_full_catalogue(object(), read_path))
    assert [item["bot_key"] for item in result["items"]] == ["a", "b"]
    assert requests == [{"limit": ["100"]}, {"limit": ["100"], "cursor": ["rev-1|1"]}]


def test_catalogue_discards_partial_result_after_revision_change():
    _requests, read_path = _read_pages([
        {"catalogue_revision": "rev-1", "items": [{"bot_key": "a"}], "cursor": "rev-1|1", "count": 2},
        {"catalogue_revision": "rev-2", "items": [{"bot_key": "b"}], "cursor": None, "count": 2},
    ])
    result = asyncio.run(read_full_catalogue(object(), read_path))
    assert result == {"items": [], "reason_code": "source_unavailable"}


def test_catalogue_discards_partial_result_after_source_failure():
    _requests, read_path = _read_pages([
        {"catalogue_revision": "rev-1", "items": [{"bot_key": "a"}], "cursor": "rev-1|1", "count": 2},
        {"items": [], "reason_code": "source_unavailable"},
    ])
    result = asyncio.run(read_full_catalogue(object(), read_path))
    assert result == {"items": [], "reason_code": "source_unavailable"}


def test_catalogue_discards_repeated_cursor():
    _requests, read_path = _read_pages([
        {"catalogue_revision": "rev-1", "items": [{"bot_key": "a"}], "cursor": "rev-1|1", "count": 3},
        {"catalogue_revision": "rev-1", "items": [{"bot_key": "b"}], "cursor": "rev-1|1", "count": 3},
    ])
    result = asyncio.run(read_full_catalogue(object(), read_path))
    assert result == {"items": [], "reason_code": "source_unavailable"}


def test_catalogue_discards_incomplete_final_count():
    _requests, read_path = _read_pages([
        {"catalogue_revision": "rev-1", "items": [{"bot_key": "a"}], "cursor": None, "count": 2},
    ])
    result = asyncio.run(read_full_catalogue(object(), read_path))
    assert result == {"items": [], "reason_code": "source_unavailable"}
