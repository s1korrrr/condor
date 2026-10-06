"""Responses are gzip-compressed on the wire only where it helps and never changes semantics.

The phone's background refresh downloaded ~3-5 MB of uncompressed chart JSON per run (a 211 KB pair
chart gzips to ~33 KB, a 688 KB composite page to ~48 KB), which pushed refreshes past iOS's budget.
"""

import gzip
import json

from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.testclient import TestClient

from condor.web.app import create_app
from condor.web.compression import SelectiveGZipMiddleware

BIG = {"candles": [{"t": i, "o": 1.0, "h": 2.0, "l": 0.5, "c": 1.5} for i in range(2000)]}
PDF = b"%PDF-1.7" + bytes(range(256)) * 400


def _client():
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
