"""Seeded mutation fuzz of the real paper qualification status (PR #77 reviews).

Each case mutates one location of tests/fixtures/v5_paper_qualification.status.json (delete a key, change a value's
type, or inject a hostile scalar) and reads every paper route. No case may return HTTP 500; a status the reader
classifies FRESH must also project through every route with a 200.
"""

import copy
import json
import random
from pathlib import Path

import pytest
from test_v5_paper_binding import BOT, SERVER, ReviewUpstream, client_for

from condor.v5 import paper

FIXTURE = Path(__file__).parent / "fixtures" / "v5_paper_qualification.status.json"
HOSTILE = [
    None,
    True,
    0,
    -1,
    1.5,
    10**18,
    "",
    "x" * 400,
    "1__0",
    "nan",
    "-",
    [],
    {},
    [[]],
    {"a": None},
    "‮",
]
ROUTES = [
    ("/api/v5/dashboard/profile", None),
    ("/api/v5/dashboard/read", f"/api/v1/servers/{SERVER}/status"),
    ("/api/v5/dashboard/read", f"/api/v1/servers/{SERVER}/bots"),
    ("/api/v5/dashboard/read", "/api/v1/trading-visuals/sources"),
    ("/api/v5/dashboard/read", f"/api/v1/trading-visuals/bootstrap?bot={BOT}"),
    ("/api/v5/workspace", None),
]


def _locations(value, path=()):
    yield path
    if isinstance(value, dict):
        for key, item in value.items():
            yield from _locations(item, (*path, key))
    elif isinstance(value, list):
        for index, item in enumerate(value[:3]):
            yield from _locations(item, (*path, index))


def _mutations(seed_count=240):
    base = json.loads(FIXTURE.read_text())
    locations = [p for p in _locations(base) if p]
    rng = random.Random(20261029)
    for index in range(seed_count):
        location = rng.choice(locations)
        operation = rng.choice(["delete", "replace", "replace"])
        yield pytest.param(
            location, operation, rng.choice(HOSTILE), id=f"{index}-{operation}"
        )


def _apply(payload, location, operation, value):
    parent = payload
    for key in location[:-1]:
        parent = parent[key]
    if operation == "delete":
        if isinstance(parent, dict):
            del parent[location[-1]]
        else:
            parent.pop(location[-1])
    else:
        parent[location[-1]] = copy.deepcopy(value)
    return payload


@pytest.mark.parametrize("location,operation,value", list(_mutations()))
def test_a_mutated_real_status_never_causes_http_500(
    tmp_path, location, operation, value
):
    base = json.loads(FIXTURE.read_text())
    now = base["generated_at"] + 1
    payload = _apply(base, location, operation, value)
    with client_for(
        tmp_path, ReviewUpstream(False), payload=payload, clock_s=now
    ) as client:
        path = tmp_path / "runtime_status" / f"{BOT}.status.json"
        fresh = paper.read_paper_status(path, now=now).state == "FRESH"
        client._transport.raise_server_exceptions = False
        for route, compatibility_path in ROUTES:
            params = {} if compatibility_path is None else {"path": compatibility_path}
            response = client.get(route, params=params)
            assert response.status_code != 500, (
                location,
                operation,
                value,
                route,
                compatibility_path,
            )
            if fresh:
                assert response.status_code == 200, (
                    location,
                    operation,
                    value,
                    route,
                    response.text[:200],
                )
                if compatibility_path == f"/api/v1/servers/{SERVER}/bots":
                    # Completeness: a FRESH status projects every owned controller,
                    # reported or unavailable; none can be hidden from the totals.
                    written = json.loads(path.read_text())
                    owned = set(written["native_reports"]) | set(
                        written["unavailable_controller_ids"]
                    )
                    projected = {
                        row["controller_id"] for row in response.json()["controllers"]
                    }
                    assert projected == owned, (location, operation, value)
