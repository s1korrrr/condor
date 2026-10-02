"""The real HTTP/2 transport against a local cleartext HTTP/2 server (skipped without ``h2``).

This proves the wire shape httpx produces for APNs: method, path, lowercase
pseudo-header ordering, our headers and the body, over genuine HTTP/2 framing.
It does not and cannot prove Apple's TLS endpoint accepts our credentials.
"""

import asyncio
import json

import pytest

h2_connection = pytest.importorskip("h2.connection")
h2_events = pytest.importorskip("h2.events")
h2_config = pytest.importorskip("h2.config")

from condor.push.apns import (  # noqa: E402
    ApnsClient,
    HttpxApnsTransport,
    ProviderTokens,
    build_request,
)
from tests.push_support import (  # noqa: E402
    BUNDLE,
    KEY_ID,
    TEAM,
    TOKEN_A,
    Clock,
    write_test_key,
)
from tests.test_push_apns import _event  # noqa: E402


class H2Server:
    def __init__(self, status=200, body=b""):
        self.requests = []
        self.status, self.body = status, body
        self.server = None

    async def handle(self, reader, writer):
        conn = h2_connection.H2Connection(
            config=h2_config.H2Configuration(client_side=False, header_encoding="utf-8")
        )
        conn.initiate_connection()
        writer.write(conn.data_to_send())
        pending = {}
        while True:
            data = await reader.read(65535)
            if not data:
                break
            for event in conn.receive_data(data):
                if isinstance(event, h2_events.RequestReceived):
                    pending[event.stream_id] = {
                        "headers": dict(event.headers),
                        "body": b"",
                    }
                elif isinstance(event, h2_events.DataReceived):
                    pending[event.stream_id]["body"] += event.data
                    conn.acknowledge_received_data(len(event.data), event.stream_id)
                elif isinstance(event, h2_events.StreamEnded):
                    self.requests.append(pending[event.stream_id])
                    conn.send_headers(
                        event.stream_id,
                        [(":status", str(self.status)), ("apns-id", "from-fake-apple")],
                    )
                    conn.send_data(event.stream_id, self.body, end_stream=True)
            writer.write(conn.data_to_send())
            await writer.drain()
        writer.close()

    async def __aenter__(self):
        self.server = await asyncio.start_server(self.handle, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]
        return self

    async def __aexit__(self, *exc):
        self.server.close()
        await self.server.wait_closed()


def test_httpx_transport_speaks_real_http2_with_our_headers_and_body(tmp_path):
    async def go():
        clock = Clock()
        write_test_key(tmp_path / "k.p8")
        async with H2Server(200) as server:
            transport = HttpxApnsTransport(
                {"sandbox": f"http://127.0.0.1:{server.port}"}, prior_knowledge=True
            )
            client = ApnsClient(
                ProviderTokens(tmp_path / "k.p8", KEY_ID, TEAM, clock=clock),
                transport,
                clock=clock,
            )
            request = build_request(
                _event(),
                token=TOKEN_A,
                topic=BUNDLE,
                environment="sandbox",
                device_id="d",
                now=0,
                expires_at=3600,
                silent=False,
            )
            outcome = await client.send(request)
            await transport.close()
        return outcome, server.requests

    outcome, requests = asyncio.run(go())
    assert outcome.ok and outcome.apns_id == "from-fake-apple"
    seen = requests[0]
    assert (
        seen["headers"][":method"] == "POST"
        and seen["headers"][":path"] == f"/3/device/{TOKEN_A}"
    )
    assert (
        seen["headers"]["apns-topic"] == BUNDLE
        and seen["headers"]["apns-push-type"] == "alert"
    )
    assert (
        seen["headers"]["authorization"].startswith("bearer ")
        and seen["headers"]["apns-collapse-id"] == "fill:abc"
    )
    assert (
        json.loads(seen["body"])["rsibot"]["link"]
        == "rsibot://bot/rsi_modular_v2/fills"
    )


def test_httpx_transport_surfaces_apples_reason_and_410_timestamp(tmp_path):
    async def go():
        clock = Clock()
        write_test_key(tmp_path / "k.p8")
        body = json.dumps(
            {"reason": "Unregistered", "timestamp": 1_790_000_123_000}
        ).encode()
        async with H2Server(410, body) as server:
            transport = HttpxApnsTransport(
                {"sandbox": f"http://127.0.0.1:{server.port}"}, prior_knowledge=True
            )
            client = ApnsClient(
                ProviderTokens(tmp_path / "k.p8", KEY_ID, TEAM, clock=clock),
                transport,
                clock=clock,
            )
            request = build_request(
                _event(),
                token=TOKEN_A,
                topic=BUNDLE,
                environment="sandbox",
                device_id="d",
                now=0,
                expires_at=3600,
                silent=False,
            )
            outcome = await client.send(request)
            await transport.close()
        return outcome

    outcome = asyncio.run(go())
    assert (outcome.kind, outcome.status, outcome.reason, outcome.apns_timestamp) == (
        "dead",
        410,
        "Unregistered",
        1_790_000_123.0,
    )
