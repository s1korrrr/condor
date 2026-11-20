"""Configuration, the bounded client, receipt expiry and the browser routes, against a raw-socket fake owner."""

import asyncio
import dataclasses
import gzip
import json
import threading
from pathlib import Path

import aiohttp
import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

from condor.v5 import learning_projection as lp
from condor.v5.app import MAX_JSON_BODY_BYTES, create_app
from condor.v5.config import ConfigurationError, Settings
from condor.v5.learning import FixtureLearningAPI
from tests.test_v5_learning_projection_contract import (
    CONTRACT,
    EXPECTED,
    FIXTURE_MEMBERSHIP,
    HASHES,
    SCOPE_ID,
    SCOPE_SHA,
    REVISION,
    aged,
    load,
    rehash,
)
from tests.test_v5_workspace_auth import FakeUpstream, login, settings

NOW = 1794916801000
CONFIG = lp.LearningProjectionConfig("http://127.0.0.1:1", SCOPE_ID, SCOPE_SHA, REVISION, FIXTURE_MEMBERSHIP)
PINNED_SCOPE_ID = "v5-lfl-okx-spot-dca"
PINNED_SCOPE_SHA = "a3a34ee765c75616da6f606a66156cdbf0e8736c91052966607fa6b59936bd18"
ENV = {
    "V5_LEARNING_SOURCE": "research_os_v1",
    "V5_LEARNING_OWNER_URL": "http://172.18.0.1:8875/",
    "V5_LEARNING_SCOPE_ID": PINNED_SCOPE_ID,
    "V5_LEARNING_SCOPE_SHA256": PINNED_SCOPE_SHA,
    "V5_LEARNING_PROJECTION_REVISION": REVISION,
}
GOLDEN_BYTES = {name: (CONTRACT / f"examples/{name}.json").read_bytes() for name in (
    "manifest", "lessons", "records-nodes", "records-edges", "jobs", "jobs-running")}


# --- a fake owner on a real socket -------------------------------------------------------------------------


def http(status=200, body=b"", *, headers=None, chunked=False, length="auto", ctype="application/json"):
    reason = {200: "OK", 302: "Found"}.get(status, "X")
    head = [f"HTTP/1.1 {status} {reason}"]
    if ctype:
        head.append(f"Content-Type: {ctype}")
    if chunked:
        head.append("Transfer-Encoding: chunked")
        payload = b"".join(b"%x\r\n%s\r\n" % (len(part), part) for part in (body[:7], body[7:]) if part) + b"0\r\n\r\n"
    else:
        payload = body
        if length == "auto":
            head.append(f"Content-Length: {len(body)}")
        elif length is not None:
            head.append(f"Content-Length: {length}")
    head.extend(f"{key}: {value}" for key, value in (headers or {}).items())
    head.append("Connection: close")
    return ("\r\n".join(head) + "\r\n\r\n").encode() + payload


HANG = object()


class RawOwner:
    """Answers each request with whatever ``handler(request)`` returns (raw HTTP bytes), recording what it saw."""

    def __init__(self, handler):
        self.handler = handler
        self.requests: list[dict] = []
        self.loop = asyncio.new_event_loop()
        self.server = None
        self.thread = threading.Thread(target=self.loop.run_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        self.server = asyncio.run_coroutine_threadsafe(
            asyncio.start_server(self._serve, "127.0.0.1", 0), self.loop
        ).result(5)
        self.port = self.server.sockets[0].getsockname()[1]
        self.url = f"http://127.0.0.1:{self.port}"
        return self

    def __exit__(self, *exc):
        self.server.close()
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(5)
        self.loop.close()

    async def _serve(self, reader, writer):
        try:
            head = await reader.readuntil(b"\r\n\r\n")
        except Exception:
            writer.close()
            return
        lines = head.decode("latin-1").split("\r\n")
        method, target, _ = lines[0].split(" ", 2)
        headers = {line.split(":", 1)[0].lower(): line.split(":", 1)[1].strip() for line in lines[1:] if ":" in line}
        request = {"method": method, "target": target, "headers": headers}
        self.requests.append(request)
        answer = self.handler(request)
        if answer is HANG:
            await asyncio.sleep(30)
        elif answer is not None:
            writer.write(answer)
            await writer.drain()
        writer.close()


def serving(documents):
    """Handler that answers by dataset path with prebuilt (status, body, headers) or a callable."""

    def handler(request):
        path = request["target"].split("?", 1)[0].rsplit("/", 1)[-1]
        entry = documents[path]
        if callable(entry):
            return entry(request)
        status, body, *rest = entry if isinstance(entry, tuple) else (200, entry)
        return http(status, body, headers=rest[0] if rest else None)

    return handler


def configured(tmp_path, owner, *, clock=lambda: NOW, **overrides):
    config = dataclasses.replace(settings(tmp_path), learning_projection=dataclasses.replace(CONFIG, owner_url=owner.url, **overrides))
    return create_app(settings=config, upstream=FakeUpstream(), clock=clock)


def client_for(tmp_path, owner, **kwargs):
    client = TestClient(configured(tmp_path, owner, **kwargs))
    client.__enter__()
    login(client)
    return client


# --- configuration ------------------------------------------------------------------------------------------


def test_unset_configuration_is_disabled_and_full_configuration_is_exact():
    assert Settings.from_env.__func__  # sanity: the classmethod exists
    from condor.v5.config import _learning_projection_config as parse

    assert parse({}) is None
    config = parse(ENV)
    assert (config.owner_url, config.scope_id, config.scope_sha256, config.projection_revision) == (
        "http://172.18.0.1:8875", PINNED_SCOPE_ID, PINNED_SCOPE_SHA, REVISION,
    )
    assert config.membership.program_id == "okx_spot_dca"
    assert config.membership.family_lane_pairs == (
        ("ok_rsi_challenger_20260903", "SPOT"), ("ok_rsi_owner_replay_baseline", "SPOT"),
        ("ok_rsi_trend_aware_dca", "SPOT"), ("okx_spot_dca", "SPOT"),
    )


@pytest.mark.parametrize("revision,digest", [
    (REVISION, PINNED_SCOPE_SHA),
    (lp.STAGE_B_REVISION, lp.STAGE_B_SCOPE_SHA256),
])
def test_startup_accepts_only_the_canonical_pins_with_matching_scope_id(revision, digest):
    from condor.v5.config import _learning_projection_config as parse

    env = {**ENV, "V5_LEARNING_SCOPE_SHA256": digest, "V5_LEARNING_PROJECTION_REVISION": revision}
    assert parse(env).scope_sha256 == digest
    with pytest.raises(ConfigurationError):
        parse({**env, "V5_LEARNING_SCOPE_SHA256": "0" * 64})
    with pytest.raises(ConfigurationError):
        parse({**env, "V5_LEARNING_SCOPE_ID": "wrong-scope"})


@pytest.mark.parametrize("missing", sorted(ENV))
def test_partial_configuration_fails_startup(missing):
    from condor.v5.config import _learning_projection_config as parse

    values = {key: value for key, value in ENV.items() if key != missing}
    with pytest.raises(ConfigurationError, match=missing):
        parse(values)


@pytest.mark.parametrize(
    "name,value",
    [
        ("V5_LEARNING_SOURCE", "fixture"),
        ("V5_LEARNING_SOURCE", "Research_OS_V1"),
        ("V5_LEARNING_OWNER_URL", "ftp://172.18.0.1:8875"),
        ("V5_LEARNING_OWNER_URL", "http://user:pw@172.18.0.1:8875"),
        ("V5_LEARNING_OWNER_URL", "http://172.18.0.1:8875?x=1"),
        ("V5_LEARNING_SCOPE_ID", "bad\nid"),
        ("V5_LEARNING_SCOPE_ID", "x" * 161),
        ("V5_LEARNING_SCOPE_SHA256", "A" * 64),
        ("V5_LEARNING_SCOPE_SHA256", "a" * 63),
        ("V5_LEARNING_PROJECTION_REVISION", "g" * 64),
    ],
)
def test_invalid_configuration_fails_startup(name, value):
    from condor.v5.config import _learning_projection_config as parse

    with pytest.raises(ConfigurationError):
        parse({**ENV, name: value})


def test_settings_from_env_carries_the_projection_block(tmp_path, monkeypatch):
    base = settings(tmp_path)
    env = {
        "V5_RUNTIME_ROOT": str(base.runtime_root),
        "V5_DASHBOARD_TOKEN_FILE": str(base.dashboard_token_file),
        "V5_DASHBOARD_ORIGIN": base.dashboard_origin,
        "V5_OBSERVATION_BASE_URL": base.observation_base_url,
        "V5_OBSERVATION_TOKEN_FILE": str(base.observation_read_token_file),
        "V5_ADVISOR_CONTROL_BASE_URL": base.advisor_control_base_url,
        "V5_ADVISORY_REQUEST_TOKEN_FILE": str(base.advisor_request_token_file),
    }
    assert Settings.from_env(env).learning_projection is None
    assert Settings.from_env({**env, **ENV}).learning_projection.scope_id == PINNED_SCOPE_ID
    with pytest.raises(ConfigurationError):
        Settings.from_env({**env, "V5_LEARNING_SCOPE_ID": SCOPE_ID})


# --- routes: success is exact bytes ----------------------------------------------------------------------


def test_routes_require_the_existing_session_cookie(tmp_path):
    with RawOwner(lambda request: http(200, b"{}")) as owner:
        with TestClient(configured(tmp_path, owner)) as client:
            for dataset in lp.ALL_DATASETS:
                response = client.get(f"/api/v5/learning/{dataset}")
                assert response.status_code == 401
                assert response.json() == {"detail": {"code": "authentication_required"}}
        assert owner.requests == []


def test_each_stage_a_route_returns_the_owner_bytes_unchanged_and_forwards_nothing_private(tmp_path):
    documents = {
        "manifest": GOLDEN_BYTES["manifest"],
        "lessons": GOLDEN_BYTES["lessons"],
        "records": GOLDEN_BYTES["records-nodes"],
        "jobs": GOLDEN_BYTES["jobs"],
    }
    with RawOwner(serving(documents)) as owner:
        client = client_for(tmp_path, owner)
        client.cookies.set("other", "secret")
        for dataset, query in (("manifest", ""), ("lessons", "limit=10&"), ("records", "record_type=node&"), ("jobs", "")):
            response = client.get(f"/api/v5/learning/{dataset}?{query}scope_id={SCOPE_ID}", headers={"Authorization": "Bearer abc", "Origin": "https://x"})
            assert response.status_code == 200, (dataset, response.text)
            assert response.content == documents[dataset]  # byte-for-byte, no re-serialisation
            assert response.headers["cache-control"] == "no-store"
            assert response.headers["content-type"] == "application/json"
        client.__exit__(None, None, None)
    targets = [request["target"] for request in owner.requests]
    assert targets == [
        "/api/knowledge/v5-projection/v1/manifest?scope_id=fixture-v5-lfl",
        "/api/knowledge/v5-projection/v1/lessons?limit=10&scope_id=fixture-v5-lfl",
        "/api/knowledge/v5-projection/v1/records?record_type=node&scope_id=fixture-v5-lfl",
        "/api/knowledge/v5-projection/v1/jobs?scope_id=fixture-v5-lfl",
    ]
    for request in owner.requests:
        assert request["method"] == "GET"
        assert request["headers"]["accept-encoding"] == "identity"
        assert not {"cookie", "authorization", "origin", "x-forwarded-for"} & set(request["headers"])


def test_cursor_is_forwarded_and_returned_unchanged(tmp_path):
    token = HASHES["cursor"]["token"]
    document = load("examples/records-nodes.json")
    document["page"] = {"limit": 25, "next_cursor": token, "has_more": True}
    body = json.dumps(rehash(document)).encode()
    with RawOwner(serving({"records": body})) as owner:
        client = client_for(tmp_path, owner)
        response = client.get(f"/api/v5/learning/records?record_type=node&cursor={token}&scope_id={SCOPE_ID}")
        client.__exit__(None, None, None)
    assert response.status_code == 200 and response.json()["page"]["next_cursor"] == token
    assert owner.requests[0]["target"].endswith(f"record_type=node&cursor={token}&scope_id=fixture-v5-lfl")


def test_supplied_scope_id_is_forwarded_untouched_when_it_is_the_configured_one(tmp_path):
    with RawOwner(serving({"lessons": GOLDEN_BYTES["lessons"]})) as owner:
        client = client_for(tmp_path, owner)
        assert client.get(f"/api/v5/learning/lessons?scope_id={SCOPE_ID}&limit=5").status_code == 200
        other = client.get("/api/v5/learning/lessons?scope_id=other")
        client.__exit__(None, None, None)
    assert owner.requests[0]["target"].endswith(f"?scope_id={SCOPE_ID}&limit=5")
    assert other.status_code == 400 and other.json()["code"] == "INVALID_QUERY"
    assert len(owner.requests) == 1


# --- routes: errors -------------------------------------------------------------------------------------


def typed(code):
    return load(f"examples/errors/{code}.json")


@pytest.mark.parametrize(
    "code",
    ["INVALID_QUERY", "INVALID_CURSOR", "ROOT_NOT_IN_SCOPE", "DATASET_NOT_ENABLED", "ROUTE_NOT_FOUND", "METHOD_NOT_ALLOWED",
     "REQUEST_BODY_NOT_ALLOWED", "TARGET_TOO_LONG", "SNAPSHOT_CHANGED", "PROJECTION_BUSY", "PROJECTION_DEADLINE", "WARMING",
     "VERIFICATION_UNAVAILABLE", "PUBLICATION_UNAVAILABLE", "UPSTREAM_UNAVAILABLE", "UPSTREAM_INVALID"],
)
def test_every_owner_error_golden_passes_through_with_its_status_and_exact_bytes(tmp_path, code):
    body = json.dumps(typed(code)).encode()
    status = lp.CODE_STATUS[code]
    with RawOwner(lambda request: http(status, body, headers={"Retry-After": "7"} if status == 503 else None)) as owner:
        client = client_for(tmp_path, owner)
        response = client.get(f"/api/v5/learning/lessons?scope_id={SCOPE_ID}")
        client.__exit__(None, None, None)
    assert response.status_code == status
    assert response.content == body
    assert response.headers.get("retry-after") == ("7" if status == 503 else None)
    assert "detail" not in response.json()


@pytest.mark.parametrize("given,expected", [("7", "7"), ("30", "30"), ("0", "1"), ("31", "1"), ("abc", "1"), ("1.5", "1"), (None, "1")])
def test_retry_after_is_normalised_on_503(tmp_path, given, expected):
    body = json.dumps(typed("WARMING")).encode()
    with RawOwner(lambda request: http(503, body, headers={"Retry-After": given} if given else None)) as owner:
        client = client_for(tmp_path, owner)
        response = client.get(f"/api/v5/learning/lessons?scope_id={SCOPE_ID}")
        client.__exit__(None, None, None)
    assert response.status_code == 503 and response.headers["retry-after"] == expected


def test_stage_b_routes_are_typed_404_before_any_query_validation_or_owner_call(tmp_path):
    with RawOwner(lambda request: http(200, b"{}")) as owner:
        client = client_for(tmp_path, owner)
        for dataset in lp.STAGE_B_DATASETS:
            for query in ("", "?garbage", "?scope_id=other&limit=999"):
                response = client.get(f"/api/v5/learning/{dataset}{query}")
                assert response.status_code == 404
                assert response.json() == typed("DATASET_NOT_ENABLED")
        client.__exit__(None, None, None)
    assert owner.requests == []


@pytest.mark.parametrize(
    "query,code",
    [(query, "INVALID_QUERY") for query in ("limit=0", "limit=51", "limit=05", "limit=a", "limit=1&limit=2", "cursor=", "x=1", "limit=%ff", "limit=%zz")]
    + [("cursor=a%20b", "INVALID_CURSOR")],
)
def test_invalid_query_is_a_typed_400_and_never_reaches_the_owner(tmp_path, query, code):
    with RawOwner(lambda request: http(200, b"{}")) as owner:
        client = client_for(tmp_path, owner)
        response = client.get(f"/api/v5/learning/lessons?scope_id={SCOPE_ID}&{query}")
        client.__exit__(None, None, None)
    assert response.status_code == 400 and response.json() == typed(code)
    assert owner.requests == []


def test_records_needs_a_record_type_and_manifest_takes_no_page_params(tmp_path):
    with RawOwner(lambda request: http(200, b"{}")) as owner:
        client = client_for(tmp_path, owner)
        assert client.get(f"/api/v5/learning/records?scope_id={SCOPE_ID}").status_code == 400
        assert client.get(f"/api/v5/learning/records?scope_id={SCOPE_ID}&record_type=graph").status_code == 400
        assert client.get(f"/api/v5/learning/manifest?scope_id={SCOPE_ID}&limit=5").status_code == 400
        client.__exit__(None, None, None)
    assert owner.requests == []


def test_method_body_and_target_errors_are_typed_and_ordered(tmp_path):
    with RawOwner(lambda request: http(200, b"{}")) as owner:
        client = client_for(tmp_path, owner)
        post = client.post("/api/v5/learning/lessons")
        assert post.status_code == 405 and post.headers["allow"] == "GET" and post.json() == typed("METHOD_NOT_ALLOWED")
        assert client.put("/api/v5/learning/jobs").status_code == 405
        body = client.request("GET", "/api/v5/learning/lessons", content=b"x")
        assert body.status_code == 413 and body.json() == typed("REQUEST_BODY_NOT_ALLOWED")
        chunked = client.request("GET", "/api/v5/learning/lessons", headers={"Transfer-Encoding": "chunked"}, content=b"")
        assert chunked.status_code == 413
        long = client.get("/api/v5/learning/lessons?cursor=" + "A" * 5000)
        assert long.status_code == 414 and long.json() == typed("TARGET_TOO_LONG")
        both = client.post("/api/v5/learning/lessons?cursor=" + "A" * 5000)  # length outranks method
        assert both.status_code == 414
        client.__exit__(None, None, None)
    assert owner.requests == []


def test_legacy_non_projection_routes_are_untouched(tmp_path):
    with RawOwner(lambda request: http(200, b"{}")) as owner:
        client = client_for(tmp_path, owner)
        assert len(client.get("/api/v5/learning/roles").json()["roles"]) == 12
        research = client.get("/api/v5/learning/research")
        assert research.json()["status"] == "UNAVAILABLE" and research.json()["effect"] == "NONE"
        assert client.post("/api/v5/learning/workflows", json={}, headers={"Origin": "https://v5.example.test"}).status_code == 503
        client.__exit__(None, None, None)
    assert owner.requests == []


# --- routes: a bad owner never becomes a success -------------------------------------------------------


def bad_owner_cases():
    good = GOLDEN_BYTES["lessons"]
    document = json.loads(good)
    wrong_scope = rehash(json.loads(good)); wrong_scope["scope"]["scope_id"] = "other"; rehash(wrong_scope)
    aged91, _ = aged(91)
    return {
        "oversize": http(200, b" " * (lp.MAX_PROJECTION_RESPONSE_BYTES + 1)),
        "gzip": http(200, gzip.compress(good), headers={"Content-Encoding": "gzip"}),
        "claims gzip, plain body": http(200, good, headers={"Content-Encoding": "gzip"}),
        "not json type": http(200, good, ctype="text/html"),
        "redirect": http(302, b"", headers={"Location": "http://example.test/"}),
        "declared length beyond cap": http(200, good, length=str(lp.MAX_PROJECTION_RESPONSE_BYTES + 1)),
        "truncated": http(200, good[:-20], length=len(good)),
        "short length": http(200, good, length=len(good) - 5),
        "invalid json": http(200, b"{not json"),
        "duplicate keys": http(200, good.replace(b'"owner"', b'"owner":"research_os","owner"', 1)),
        "float token": http(200, good.replace(b'"limit": 25', b'"limit": 25.0')),
        "utf8 bom": http(200, b"\xef\xbb\xbf" + good),
        "unknown status": http(418, json.dumps(typed("INVALID_QUERY")).encode()),
        "code under wrong status": http(409, json.dumps(typed("INVALID_QUERY")).encode()),
        "error with extra key": http(400, json.dumps({**typed("INVALID_QUERY"), "detail": "x"}).encode()),
        "oversize error": http(400, json.dumps({**typed("INVALID_QUERY"), "pad": "x" * 3000}).encode()),
        "stale state": http(200, json.dumps(rehash({**document, "status": "STALE"})).encode()),
        "wrong scope": http(200, json.dumps(wrong_scope).encode()),
        "91s old": http(200, json.dumps({**aged91, "dataset": "lessons"}).encode()),
        "wrong dataset": http(200, GOLDEN_BYTES["jobs"]),
        "plain text 502": http(502, b"Bad Gateway", ctype="text/plain"),
    }


@pytest.mark.parametrize("label", sorted(bad_owner_cases()))
def test_malformed_or_violating_owner_responses_become_one_typed_502(tmp_path, label):
    answer = bad_owner_cases()[label]
    with RawOwner(lambda request: answer) as owner:
        client = client_for(tmp_path, owner)
        response = client.get(f"/api/v5/learning/lessons?scope_id={SCOPE_ID}")
        client.__exit__(None, None, None)
    assert response.status_code == 502, label
    assert response.json() == typed("INVALID_OWNER_PROJECTION")
    assert "detail" not in response.json()


def test_chunked_owner_responses_are_counted_and_accepted(tmp_path):
    with RawOwner(lambda request: http(200, GOLDEN_BYTES["lessons"], chunked=True)) as owner:
        client = client_for(tmp_path, owner)
        response = client.get(f"/api/v5/learning/lessons?scope_id={SCOPE_ID}")
        client.__exit__(None, None, None)
    assert response.status_code == 200 and response.content == GOLDEN_BYTES["lessons"]


def test_unreachable_owner_is_a_typed_503_with_retry_after(tmp_path):
    with RawOwner(lambda request: None) as owner:
        url = owner.url
    config = dataclasses.replace(settings(tmp_path), learning_projection=dataclasses.replace(CONFIG, owner_url=url))
    with TestClient(create_app(settings=config, upstream=FakeUpstream(), clock=lambda: NOW)) as client:
        login(client)
        response = client.get(f"/api/v5/learning/lessons?scope_id={SCOPE_ID}")
    assert response.status_code == 503 and response.json() == typed("UPSTREAM_UNAVAILABLE")
    assert response.headers["retry-after"] == "1"


def test_slow_owner_is_cut_off_at_the_client_deadline_without_retry(tmp_path):
    with RawOwner(lambda request: HANG) as owner:
        source = lp.ResearchOwnerLearningSource(
            dataclasses.replace(CONFIG, owner_url=owner.url),
            client=lp.OwnerProjectionClient(owner.url, timeout_seconds=0.3),
            clock=lambda: NOW,
        )
        config = dataclasses.replace(settings(tmp_path), learning_projection=dataclasses.replace(CONFIG, owner_url=owner.url))
        with TestClient(create_app(settings=config, upstream=FakeUpstream(), clock=lambda: NOW, projection_source=source)) as client:
            login(client)
            response = client.get(f"/api/v5/learning/lessons?scope_id={SCOPE_ID}")
    assert response.status_code == 503 and response.json()["code"] == "UPSTREAM_UNAVAILABLE"
    assert len(owner.requests) == 1  # no retry


# --- no fixture fallback, anywhere ---------------------------------------------------------------------


def test_unconfigured_routes_are_typed_unavailable_never_fixture_data(tmp_path):
    with TestClient(create_app(settings=settings(tmp_path), upstream=FakeUpstream())) as client:
        login(client)
        for dataset in lp.STAGE_A_DATASETS:
            response = client.get(f"/api/v5/learning/{dataset}")
            assert response.status_code == 503 and response.json() == typed("PUBLICATION_UNAVAILABLE")
            assert response.headers["retry-after"] == "1"
        for dataset in lp.STAGE_B_DATASETS:
            assert client.get(f"/api/v5/learning/{dataset}").json() == typed("DATASET_NOT_ENABLED")


def test_an_injected_fixture_never_answers_for_a_configured_projection(tmp_path):
    fixture = FixtureLearningAPI(manifest={"status": "FIXTURE_ONLY"}, scope={})
    with RawOwner(lambda request: None) as owner:
        config = dataclasses.replace(settings(tmp_path), learning_projection=dataclasses.replace(CONFIG, owner_url=owner.url))
        with TestClient(create_app(settings=config, upstream=FakeUpstream(), clock=lambda: NOW, learning_source=fixture)) as client:
            login(client)
            response = client.get(f"/api/v5/learning/manifest?scope_id={SCOPE_ID}")
    assert response.status_code == 503 and response.json() == typed("UPSTREAM_UNAVAILABLE")
    assert "FIXTURE" not in response.text


def test_the_projection_module_imports_no_fixture_or_shared_reader():
    import ast

    tree = ast.parse(Path(lp.__file__).read_text())
    imported = {
        (node.module or "") if isinstance(node, ast.ImportFrom) else alias.name
        for node in ast.walk(tree)
        for alias in (getattr(node, "names", None) or [None])
        if isinstance(node, (ast.Import, ast.ImportFrom))
    }
    names = {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)}
    assert not {"learning", "upstream", "read_bridge", "workflows", "research"} & {name.lstrip(".") for name in imported}
    assert not {"FixtureLearningAPI", "V5Upstream", "_bounded_read"} & names


# --- receipt state: expiry, invalidation, no renewal by polling --------------------------------------------


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


def make_source(owner, clock, *, ms=lambda: NOW):
    return lp.ResearchOwnerLearningSource(
        dataclasses.replace(CONFIG, owner_url=owner.url),
        client=lp.OwnerProjectionClient(owner.url, timeout_seconds=2),
        clock=ms,
        monotonic=clock,
    )


def read(source, dataset="records", query="record_type=node"):
    return asyncio.run(source.read(dataset, f"{query + '&' if query else ''}scope_id={SCOPE_ID}"))


def generation(document, publication, offset=0):
    document["publication_sha256"] = publication * 64
    document["verified_at_ms"] += offset
    document["served_at_ms"] += offset
    document["snapshot_id"] = lp.sha256_hex(lp.canonical({
        key: document["scope"][key] if key == "scope_sha256" else document[key]
        for key in ("schema", "projection_revision", "scope_sha256", "publication_sha256",
                    "database_sha256", "source_revision", "source_snapshot", "event_signature")
    }))
    return rehash(document)


def scripted_source(clock, *answers):
    pending = iter(answers)

    class Owner:
        async def get(self, dataset, query):
            answer = next(pending)
            if isinstance(answer, lp.OwnerResponse):
                return answer
            return lp.OwnerResponse(200, json.dumps(answer).encode(), None)

    wall_time = max(answer["served_at_ms"] for answer in answers if isinstance(answer, dict))
    return lp.ResearchOwnerLearningSource(CONFIG, client=Owner(), clock=lambda: wall_time, monotonic=clock)


def test_retired_generation_cannot_rebind_through_an_unseen_dataset():
    first = generation(load("examples/records-nodes.json"), "1")
    next_generation = generation(load("examples/records-nodes.json"), "2", 39_000)
    retired = generation(load("examples/jobs.json"), "1", 40_000)
    source = scripted_source(Clock(), first, next_generation, retired)
    assert read(source).status == read(source).status == 200
    replay = read(source, "jobs", "")
    assert replay.status == 409 and json.loads(replay.body)["code"] == "SNAPSHOT_CHANGED"
    assert source.state()["records"] == "BOUND" and source.state()["jobs"] == "UNAVAILABLE"


def test_newer_identity_bearing_unavailable_retires_the_previous_snapshot():
    first = generation(load("examples/lessons.json"), "1")
    unavailable = generation(load("examples/jobs.json"), "2", 10_000)
    unavailable.update(status="UNAVAILABLE", items=[], reason_codes=["VERIFICATION_EXPIRED"])
    unavailable["coverage"].update(state="UNAVAILABLE", returned_items=0)
    rehash(unavailable)
    late = generation(load("examples/lessons.json"), "1", 20_000)
    source = scripted_source(Clock(), first, unavailable, late)
    assert read(source, "lessons", "").status == 200
    result = read(source, "jobs", "")
    assert result.status == 200 and json.loads(result.body) == unavailable
    state = source.state()
    replay = read(source, "lessons", "")
    assert replay.status == 409 and json.loads(replay.body)["code"] == "SNAPSHOT_CHANGED"
    assert source.state() == state == dict.fromkeys(lp.STAGE_A_DATASETS, "UNAVAILABLE")
    assert source.receipt_expiry("lessons") is None and source.receipt_expiry("jobs") is None


def test_projection_route_headers_stay_within_the_frozen_wire_allowlist():
    headers = load("wire-contract.json")["permitted_headers"]

    def field(entry):
        return entry.partition(":")[0].lower()

    base = {field(entry) for entry in headers["regenerated"]}
    per_status = {}
    for entry in [*headers["forwarded"], headers["method_error"]]:
        name, suffix = entry.split(" only on ", 1)
        status = int(suffix[:3])
        per_status.setdefault(status, set()).add(field(name))

    first = generation(load("examples/lessons.json"), "1")
    current = generation(load("examples/jobs.json"), "2", 10_000)
    owner_error = lp.OwnerResponse(502, json.dumps(typed("UPSTREAM_INVALID")).encode(), None)
    clock = Clock()
    source = scripted_source(clock, first, current, first, current, owner_error)
    app = FastAPI()
    router = APIRouter(prefix="/api/v5/learning")
    lp.add_projection_routes(router, source)
    app.include_router(router)
    query = f"?scope_id={SCOPE_ID}"
    lessons = "/api/v5/learning/lessons"
    jobs = "/api/v5/learning/jobs"
    with TestClient(app) as client:
        responses = [
            (client.get(lessons + query), 200),
            (client.get(jobs + query), 200),
            (client.get(lessons + query), 409),
            (client.post(lessons + query), 405),
            (client.get(lessons + query, headers={"Content-Length": "1"}), 413),
            (client.get(lessons + "?" + "x" * 4096), 414),
            (client.get(lessons), 400),
            (client.get("/api/v5/learning/candidates" + query), 404),
        ]
        clock.now = 91
        responses.extend([(client.get(jobs + query), 503), (client.get(jobs + query), 502)])
        assert responses[-2][0].json()["code"] == "VERIFICATION_UNAVAILABLE"
        assert responses[-2][0].headers["Retry-After"] == "1"
        for response, status in responses:
            assert response.status_code == status
            assert not (set(response.headers) - (base | per_status.get(status, set()))), (status, response.headers)


def test_older_generation_cannot_replace_newer_or_clear_other_datasets():
    first = generation(load("examples/records-nodes.json"), "1", 1_000)
    lessons = generation(load("examples/lessons.json"), "1", 1_000)
    current = generation(load("examples/records-nodes.json"), "2", 40_000)
    current_lessons = generation(load("examples/lessons.json"), "2", 40_000)
    late = generation(load("examples/records-nodes.json"), "1", 20_000)
    source = scripted_source(Clock(), first, lessons, current, current_lessons, late)
    for dataset, query in (("records", "record_type=node"), ("lessons", "")) * 2:
        assert read(source, dataset, query).status == 200
    expiry = {dataset: source.receipt_expiry(dataset) for dataset in ("records", "lessons")}
    live = source.state()
    assert live["records"] == current["status"] and live["lessons"] == current_lessons["status"]
    assert read(source).status == 409
    assert {dataset: source.receipt_expiry(dataset) for dataset in expiry} == expiry
    assert source.state() == live


@pytest.mark.parametrize("status", [401, 409])
def test_cache_clear_preserves_original_replay_deadline(status):
    first, _ = aged(89)
    denied = lp.OwnerResponse(status, json.dumps(typed("SNAPSHOT_CHANGED")).encode(), None)
    clock = Clock()
    source = scripted_source(clock, first, *([denied] if status == 409 else []), first, first)
    assert read(source).status == 200
    if status == 401:
        source.invalidate()  # Auth boundary clears display receipts, not the ledger.
    else:
        assert read(source).status == 409
    clock.now = 0.5
    assert read(source).status == 200
    assert source.receipt_expiry("records") == 1.0
    clock.now = 1.001
    if status == 401:
        source.invalidate()
    else:
        assert source.state()["records"] == "UNAVAILABLE"
    assert read(source).status == 503


def test_route_relogin_cannot_extend_a_verification_deadline(tmp_path):
    first, _ = aged(89)
    clock = Clock()
    source = scripted_source(clock, first, first, first)
    app = create_app(settings=settings(tmp_path), upstream=FakeUpstream(), projection_source=source)
    url = f"/api/v5/learning/records?scope_id={SCOPE_ID}&record_type=node"
    with TestClient(app) as client:
        login(client)
        assert client.get(url).status_code == 200
        client.cookies.clear()
        assert client.get(url).status_code == 401
        assert source.state()["records"] == "UNAVAILABLE"
        clock.now = 0.5
        login(client)
        assert client.get(url).status_code == 200
        assert source.receipt_expiry("records") == 1
        client.cookies.clear()
        assert client.get(url).status_code == 401
        clock.now = 1.001
        login(client)
        result = client.get(url)
        assert result.status_code == 503
        assert result.json()["code"] == "VERIFICATION_UNAVAILABLE"
        assert result.headers["Retry-After"] == "1"


def test_resealed_foreign_program_cannot_define_its_own_membership():
    foreign = load("examples/lessons.json")
    foreign["scope"]["program_id"] = "foreign-program"
    for row in foreign["items"]:
        row["program_id"] = row["row_scope"]["program_id"] = "foreign-program"
    rehash(foreign)
    assert lp.schema_errors("lessons", foreign) is None
    result = read(scripted_source(Clock(), foreign), "lessons", "")
    assert result.status == 502 and json.loads(result.body)["code"] == "INVALID_OWNER_PROJECTION"


def test_retired_unavailable_response_cannot_remove_a_live_receipt():
    first = generation(load("examples/records-nodes.json"), "1")
    current = generation(load("examples/records-nodes.json"), "2", 1)
    late = {**first, "status": "UNAVAILABLE", "items": [], "reason_codes": ["VERIFICATION_EXPIRED"]}
    late["coverage"] = {**first["coverage"], "state": "UNAVAILABLE", "returned_items": 0}
    rehash(late)
    assert lp.schema_errors("records", late) is None
    source = scripted_source(Clock(), first, current, late)
    assert read(source).status == read(source).status == 200
    assert read(source).status == 409
    assert source.state()["records"] == "BOUND"


def test_duplicate_content_length_is_typed_413_without_owner_call(tmp_path):
    with RawOwner(lambda request: http(200, GOLDEN_BYTES["manifest"])) as owner:
        client = client_for(tmp_path, owner)
        try:
            result = client.get(f"/api/v5/learning/manifest?scope_id={SCOPE_ID}",
                                headers=[("Content-Length", "0"), ("Content-Length", "0")])
            assert result.status_code == 413 and result.json() == typed("REQUEST_BODY_NOT_ALLOWED")
            assert owner.requests == []
        finally:
            client.__exit__(None, None, None)


def test_receipt_expires_90_seconds_after_the_owner_verification_not_after_the_poll():
    document, served = aged(89)  # verified 89 s before it was served
    body = json.dumps(document).encode()
    clock = Clock()
    with RawOwner(lambda request: http(200, body)) as owner:
        source = make_source(owner, clock, ms=lambda: served)
        clock.now = 100.0
        assert read(source).status == 200
        assert source.state()["records"] == "BOUND"
        clock.now = 100.9
        assert source.state()["records"] == "BOUND"
        clock.now = 101.0  # 89 s + 1 s = 90 s after verification: the receipt is gone
        assert source.state()["records"] == "UNAVAILABLE"


def test_polling_the_same_verification_never_extends_expiry():
    first, served_first = aged(30)
    second = load("examples/records-nodes.json")
    second["served_at_ms"] = second["verified_at_ms"] + 10_000  # same verified_at, "fresher" served clock
    rehash(second)
    answers = [json.dumps(first).encode(), json.dumps(second).encode()]
    clock = Clock()
    with RawOwner(lambda request: http(200, answers.pop(0))) as owner:
        source = make_source(owner, clock, ms=lambda: served_first)
        read(source)
        assert source.receipt_expiry("records") == pytest.approx(60.0)
        clock.now = 20.0
        read(source)
        assert source.receipt_expiry("records") == pytest.approx(60.0)  # not 100.0


def test_late_older_verification_is_ignored_without_clearing_any_receipts():
    newer, served = aged(10)
    older = load("examples/records-nodes.json")
    older["verified_at_ms"] -= 5_000
    older["generated_at_ms"] -= 5_000
    rehash(older)
    clock = Clock()

    async def exercise():
        started = asyncio.Event()
        release = asyncio.Event()

        class OutOfOrderOwner:
            async def get(self, dataset, query):
                if dataset == "jobs":
                    body = GOLDEN_BYTES["jobs"]
                elif "limit=1" in query:
                    started.set()
                    await release.wait()
                    body = json.dumps(older).encode()
                else:
                    body = json.dumps(newer).encode()
                return lp.OwnerResponse(200, body, None)

        source = lp.ResearchOwnerLearningSource(CONFIG, client=OutOfOrderOwner(), clock=lambda: served, monotonic=clock)
        query = f"scope_id={SCOPE_ID}&record_type=node"
        late = asyncio.create_task(source.read("records", f"{query}&limit=1"))
        await started.wait()
        assert (await source.read("records", query)).status == 200
        assert (await source.read("jobs", f"scope_id={SCOPE_ID}")).status == 200
        expiry = source.receipt_expiry("records")
        clock.now = 5
        release.set()
        assert (await late).status == 503
        assert source.state()["records"] == source.state()["jobs"] == "BOUND"
        assert source.receipt_expiry("records") == expiry

    asyncio.run(exercise())


def test_transport_failure_clears_every_receipt_and_a_typed_error_clears_its_dataset():
    clock = Clock()
    mode = {"fail": False}
    documents = {"records": GOLDEN_BYTES["records-nodes"], "jobs": GOLDEN_BYTES["jobs"]}

    def handler(request):
        if mode["fail"]:
            return None
        return serving(documents)(request)

    with RawOwner(handler) as owner:
        source = make_source(owner, clock)
        assert read(source).status == 200 and read(source, "jobs", "").status == 200
        assert source.state()["records"] == source.state()["jobs"] == "BOUND"
        mode["fail"] = True
        assert read(source).status == 503
        assert source.state()["records"] == source.state()["jobs"] == "UNAVAILABLE"
    body = json.dumps(typed("SNAPSHOT_CHANGED")).encode()
    with RawOwner(lambda request: http(409, body) if "records" in request["target"] else http(200, GOLDEN_BYTES["jobs"])) as owner:
        source = make_source(owner, clock)
        assert read(source, "jobs", "").status == 200
        assert read(source).status == 409
        assert source.state()["jobs"] == "BOUND" and source.state()["records"] == "UNAVAILABLE"


def test_a_new_snapshot_drops_receipts_that_belonged_to_the_old_generation():
    clock = Clock()
    jobs = load("examples/jobs.json")
    other = generation(load("examples/records-nodes.json"), "9", 1)
    source = scripted_source(clock, jobs, other)
    assert read(source, "jobs", "").status == 200
    assert source.state()["jobs"] == "BOUND"
    assert read(source).status == 200
    assert source.state() == {"manifest": "UNAVAILABLE", "lessons": "UNAVAILABLE", "records": "BOUND", "jobs": "UNAVAILABLE"}


def test_replaying_the_89s_golden_at_91s_cannot_revive_an_expired_receipt():
    body = (CONTRACT / "examples/records-age-89s.json").read_bytes()
    served = json.loads(body)["served_at_ms"]
    clock = Clock()
    with RawOwner(lambda request: http(200, body)) as owner:
        source = make_source(owner, clock, ms=lambda: served)
        assert read(source).status == 200
        clock.now = 2
        first_replay = read(source)
        assert source.state()["records"] == "UNAVAILABLE"
        after_removal = read(source)
        assert source.state()["records"] == "UNAVAILABLE"
        assert [result.status for result in (first_replay, after_removal)] == [503, 503]
        assert json.loads(after_removal.body)["code"] == "VERIFICATION_UNAVAILABLE"


def test_newer_verification_renews_an_expired_deadline():
    first, _ = aged(89)
    newer, _ = aged(89)
    newer["verified_at_ms"] += 1
    rehash(newer)
    clock = Clock()
    source = scripted_source(clock, first, newer)
    assert read(source).status == 200
    clock.now = 2
    assert source.state()["records"] == "UNAVAILABLE"
    assert read(source).status == 200
    assert source.state()["records"] == "BOUND"


def test_huge_owner_integer_is_typed_and_clears_every_receipt():
    body = GOLDEN_BYTES["records-nodes"].replace(b'"returned_items": 1', b'"returned_items": ' + b"9" * 4301)
    answers = iter([GOLDEN_BYTES["records-nodes"], body])
    with RawOwner(lambda request: http(200, next(answers))) as owner:
        source = make_source(owner, Clock())
        assert read(source).status == 200
        result = read(source)
        assert result.status == 502 and json.loads(result.body)["code"] == "INVALID_OWNER_PROJECTION"
        assert set(source.state().values()) == {"UNAVAILABLE"}


def test_projection_query_requires_scope_and_forwards_the_exact_raw_bytes(tmp_path):
    with RawOwner(serving({"manifest": GOLDEN_BYTES["manifest"]})) as owner:
        with TestClient(configured(tmp_path, owner)) as client:
            login(client)
            explicit = client.get(f"/api/v5/learning/manifest?scop%65_id={SCOPE_ID}")
            missing = client.get("/api/v5/learning/manifest")
        assert explicit.status_code == 200
        assert [request["target"] for request in owner.requests] == [f"{lp.OWNER_PATH_PREFIX}manifest?scop%65_id={SCOPE_ID}"]
        assert missing.status_code == 400 and missing.json() == typed("INVALID_QUERY")


def test_authenticated_session_read_exposes_only_the_configured_scope(tmp_path):
    with RawOwner(lambda request: pytest.fail("session read reached the owner")) as owner:
        with TestClient(configured(tmp_path, owner)) as client:
            assert client.get("/api/v5/auth").json() == {"authenticated": False}
            login(client)
            response = client.get("/api/v5/auth")
        assert response.json() == {
            "authenticated": True, "learning_scope_id": SCOPE_ID,
            "learning_scope_membership": {
                "program_id": "fixture-program", "family_lane_pairs": [{"family_id": "fixture-family", "lane": "SPOT"}],
            },
        }
        assert response.headers["Cache-Control"] == "no-store"
        assert not owner.requests


def test_malformed_cursor_has_the_frozen_error(tmp_path):
    with RawOwner(lambda request: http(200, b"{}")) as owner:
        with TestClient(configured(tmp_path, owner)) as client:
            login(client)
            response = client.get(f"/api/v5/learning/lessons?scope_id={SCOPE_ID}&cursor=!!!")
        assert response.status_code == 400 and response.json() == typed("INVALID_CURSOR")
        assert not owner.requests


def test_stage_b_is_disabled_before_non_ascii_raw_query_decoding(tmp_path):
    with RawOwner(lambda request: http(200, b"{}")) as owner:
        app = configured(tmp_path, owner)

        async def raw_query_app(scope, receive, send):
            if scope.get("path") == "/api/v5/learning/candidates":
                scope = {**scope, "query_string": b"scope_id=\xff"}
            await app(scope, receive, send)

        with TestClient(raw_query_app) as client:
            login(client)
            response = client.get("/api/v5/learning/candidates")
        assert response.status_code == 404 and response.json() == typed("DATASET_NOT_ENABLED")
        assert not owner.requests


@pytest.mark.parametrize("method", ["TRACE", "CONNECT", "CUSTOM"])
def test_unlisted_methods_still_receive_a_typed_405(tmp_path, method):
    with RawOwner(lambda request: http(200, b"{}")) as owner:
        with TestClient(configured(tmp_path, owner)) as client:
            login(client)
            response = client.request(method, "/api/v5/learning/manifest")
        assert response.status_code == 405 and response.json() == typed("METHOD_NOT_ALLOWED")
        assert response.headers["Allow"] == "GET"
        assert not owner.requests


def test_non_get_projection_rejects_method_without_buffering_a_large_body(tmp_path):
    with RawOwner(lambda request: http(200, b"{}")) as owner:
        with TestClient(configured(tmp_path, owner)) as client:
            login(client)
            response = client.post("/api/v5/learning/manifest", content=b"x" * (MAX_JSON_BODY_BYTES + 1))
        assert response.status_code == 405 and response.json() == typed("METHOD_NOT_ALLOWED")
        assert not owner.requests


@pytest.mark.parametrize("path", ["/path", "//", "/;matrix", "?", "#"])
def test_learning_owner_rejects_a_non_root_url_path(path):
    from condor.v5.config import _learning_projection_config

    with pytest.raises(ConfigurationError, match="V5_LEARNING_OWNER_URL"):
        _learning_projection_config({**ENV, "V5_LEARNING_OWNER_URL": f"http://owner.test{path}"})


@pytest.mark.parametrize("header,status,expected", [
    (b"Content-Encoding: identity\r\nContent-Encoding: gzip\r\n", 200, 502),
    (b"Retry-After: 7\r\nRetry-After: 9\r\n", 503, 503),
])
def test_duplicate_owner_headers_are_not_treated_as_singletons(header, status, expected):
    body = GOLDEN_BYTES["records-nodes"] if status == 200 else json.dumps(typed("WARMING")).encode()
    raw = http(status, body).replace(b"Connection: close\r\n", header + b"Connection: close\r\n")
    with RawOwner(lambda request: raw) as owner:
        result = read(make_source(owner, Clock()))
    assert result.status == expected
    if status == 503:
        assert result.retry_after == 1
    else:
        assert json.loads(result.body)["code"] == "INVALID_OWNER_PROJECTION"


def test_production_aiohttp_disconnect_makes_only_one_attempt(monkeypatch):
    attempts = []

    async def disconnect(*args, **kwargs):
        attempts.append(True)
        raise aiohttp.ServerDisconnectedError()

    monkeypatch.setattr(aiohttp.TCPConnector, "connect", disconnect)
    client = lp.OwnerProjectionClient(CONFIG.owner_url)
    with pytest.raises(lp.ProjectionTransportError, match="unavailable"):
        asyncio.run(client.get("manifest", f"scope_id={SCOPE_ID}"))
    assert len(attempts) == 1
