"""Responses are gzip-compressed on the wire only where it helps and never changes semantics.

The phone's background refresh downloaded ~3-5 MB of uncompressed chart JSON per run (a 211 KB pair
chart gzips to ~33 KB, a 688 KB composite page to ~48 KB), which pushed refreshes past iOS's budget.
"""

import gzip
import json

from fastapi import FastAPI, WebSocket
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.testclient import TestClient

from condor.web.app import create_app
from condor.web.compression import SelectiveGZipMiddleware

BIG = {"candles": [{"t": i, "o": 1.0, "h": 2.0, "l": 0.5, "c": 1.5} for i in range(2000)]}
PDF = b"%PDF-1.7" + bytes(range(256)) * 400
TEXT = b"line of recorded research text\n" * 300
TEXT_FILE = None


def _client(tmp_path=None):
    global TEXT_FILE
    if tmp_path is not None:
        TEXT_FILE = tmp_path / "doc.txt"
        TEXT_FILE.write_bytes(TEXT)
    app = FastAPI()

    @app.get("/json")
    def big_json():
        return JSONResponse(BIG, headers={"ETag": '"abc"'})

    @app.get("/small")
    def small_json():
        return JSONResponse({"ok": True})

    @app.get("/pdf")
    def pdf():
        return Response(PDF, media_type="application/pdf")

    @app.get("/download")
    def download():
        return StreamingResponse(iter([PDF, PDF]), media_type="application/octet-stream",
                                 headers={"Content-Length": str(2 * len(PDF))})

    @app.get("/js")
    def js():
        return Response("var a = 1;\n" * 2000, media_type="text/javascript")

    @app.get("/encoded")
    def encoded():
        return Response(gzip.compress(b"x" * 5000), headers={"Content-Encoding": "gzip"},
                        media_type="application/json")

    @app.get("/not-modified")
    def not_modified():
        return Response(status_code=304, headers={"ETag": '"abc"'})

    @app.get("/text-file")
    def text_file():
        return FileResponse(TEXT_FILE, media_type="text/plain")

    app.add_middleware(SelectiveGZipMiddleware)
    return TestClient(app)


def test_large_json_is_gzipped_and_decodes_to_the_same_body_and_etag():
    raw = _client().get("/json", headers={"Accept-Encoding": "gzip"})
    assert raw.status_code == 200
    assert raw.headers["content-encoding"] == "gzip"
    assert "accept-encoding" in raw.headers["vary"].lower()
    assert raw.headers["etag"] == '"abc"'
    assert raw.json() == BIG  # the client transparently decompresses
    assert int(raw.headers["content-length"]) < len(json.dumps(BIG)) / 4


def test_text_assets_are_gzipped():
    response = _client().get("/js", headers={"Accept-Encoding": "gzip, deflate, br"})
    assert response.headers["content-encoding"] == "gzip"


def test_binary_and_streamed_downloads_keep_their_exact_bytes_and_length():
    client = _client()
    pdf = client.get("/pdf", headers={"Accept-Encoding": "gzip"})
    assert "content-encoding" not in pdf.headers
    assert pdf.content == PDF and int(pdf.headers["content-length"]) == len(PDF)
    download = client.get("/download", headers={"Accept-Encoding": "gzip"})
    assert "content-encoding" not in download.headers
    assert download.content == PDF + PDF and int(download.headers["content-length"]) == 2 * len(PDF)


def test_no_gzip_request_small_body_encoded_body_and_304_are_untouched():
    client = _client()
    plain = client.get("/json", headers={"Accept-Encoding": "identity"})
    assert "content-encoding" not in plain.headers and plain.json() == BIG
    assert "content-encoding" not in client.get("/small", headers={"Accept-Encoding": "gzip"}).headers
    encoded = client.get("/encoded", headers={"Accept-Encoding": "gzip"})
    assert encoded.headers["content-encoding"] == "gzip" and encoded.content == b"x" * 5000
    not_modified = client.get("/not-modified", headers={"Accept-Encoding": "gzip"})
    assert not_modified.status_code == 304 and "content-encoding" not in not_modified.headers


def test_the_condor_app_compresses():
    assert any(m.cls is SelectiveGZipMiddleware for m in create_app().user_middleware)


def test_byte_range_responses_are_never_compressed(tmp_path):
    # Content-Range offsets describe the identity bytes; compressing a partial body would break resume.
    client = _client(tmp_path)
    part = client.get("/text-file", headers={"Accept-Encoding": "gzip", "Range": "bytes=0-1499"})
    assert part.status_code == 206 and "content-encoding" not in part.headers
    assert part.content == TEXT[:1500] and part.headers["content-range"].startswith("bytes 0-1499/")
    whole = client.get("/text-file", headers={"Accept-Encoding": "gzip"})
    assert whole.headers["content-encoding"] == "gzip" and whole.content == TEXT


def test_an_explicitly_refused_gzip_is_not_sent():
    client = _client()
    for header in ("gzip;q=0, identity;q=1", "identity", "br", "gzip; q=0.0", "*;q=0"):
        response = client.get("/json", headers={"Accept-Encoding": header})
        assert "content-encoding" not in response.headers, header
        assert response.json() == BIG
    for header in ("gzip;q=0.5", "deflate, gzip", "*"):
        assert client.get("/json", headers={"Accept-Encoding": header}).headers.get("content-encoding") == "gzip", header


def test_lifespan_and_websocket_scopes_pass_through():
    app = FastAPI()
    started = []

    @app.on_event("startup")
    def startup():
        started.append(True)

    @app.websocket("/ws")
    async def ws(socket: WebSocket):
        await socket.accept()
        await socket.send_text("x" * 5000)
        await socket.close()

    app.add_middleware(SelectiveGZipMiddleware)
    with TestClient(app) as client:  # runs the lifespan through the middleware
        with client.websocket_connect("/ws", headers={"Accept-Encoding": "gzip"}) as socket:
            assert socket.receive_text() == "x" * 5000
    assert started == [True]


def test_a_compressed_range_capable_file_cannot_be_resumed_with_its_validator(tmp_path):
    # The gzip representation has different bytes: its strong ETag must not let If-Range splice identity
    # ranges onto a compressed copy. Weak validators fail If-Range (strong comparison) and still revalidate.
    client = _client(tmp_path)
    identity = client.get("/text-file", headers={"Accept-Encoding": "identity"})
    compressed = client.get("/text-file", headers={"Accept-Encoding": "gzip"})
    assert compressed.headers["content-encoding"] == "gzip"
    assert compressed.headers["etag"] == "W/" + identity.headers["etag"]
    resumed = client.get("/text-file", headers={"Range": "bytes=100-199", "If-Range": compressed.headers["etag"],
                                                 "Accept-Encoding": "gzip"})
    assert resumed.status_code == 200 and resumed.content == TEXT
    exact = client.get("/text-file", headers={"Range": "bytes=100-199", "If-Range": identity.headers["etag"]})
    assert exact.status_code == 206 and exact.content == TEXT[100:200]


def test_json_validators_are_unchanged_for_route_revalidation():
    # API routes compare If-None-Match themselves (some accept only strong tags) and never serve ranges.
    response = _client().get("/json", headers={"Accept-Encoding": "gzip"})
    assert response.headers["content-encoding"] == "gzip" and response.headers["etag"] == '"abc"'
