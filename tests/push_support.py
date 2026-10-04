"""Shared fakes for the push tests: no network, no Apple, no real key material.

``FakeApple`` plays APNs' part closely enough to exercise the real sender: it
verifies the ES256 provider token against the public key, enforces Apple's
header and size rules, and answers per-token like the real service (200, 400
BadDeviceToken, 400 DeviceTokenNotForTopic, 410 Unregistered, 403, 429, 5xx).
"""

from __future__ import annotations

import base64
import json
import uuid
from pathlib import Path
from typing import Any, Mapping

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

from condor.push.apns import ApnsHttpResponse

TEAM = "2NY8A789TN"
KEY_ID = "ABC123DEFG"
BUNDLE = "com.rsibot.mobile"
WATCH_BUNDLE = "com.rsibot.mobile.watch.app"
TOKEN_A = "a1" * 32
TOKEN_B = "b2" * 32
TOKEN_W = "c3" * 32


class Clock:
    def __init__(self, now: float = 1_790_000_000.0):
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def write_test_key(path: Path) -> ec.EllipticCurvePrivateKey:
    """A throwaway P-256 key in a 0600 file. It signs nothing real."""
    key = ec.generate_private_key(ec.SECP256R1())
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    path.write_bytes(pem)
    path.chmod(0o600)
    return key


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


class FakeApple:
    """An APNs stand-in implementing the ApnsTransport protocol."""

    def __init__(self, public_key: ec.EllipticCurvePublicKey, clock: Clock):
        self.public_key = public_key
        self.clock = clock
        self.requests: list[dict[str, Any]] = []
        self.valid_tokens: dict[str, str] = {}  # token -> topic it belongs to
        self.unregistered: dict[str, float] = {}  # token -> ms timestamp
        self.script: list[Any] = (
            []
        )  # queued overrides: (status, body, headers) or an Exception
        self.closed = False

    def add_device(self, token: str, topic: str = BUNDLE) -> None:
        self.valid_tokens[token] = topic

    async def close(self) -> None:
        self.closed = True

    async def post(
        self,
        *,
        environment: str,
        path: str,
        headers: Mapping[str, str],
        body: bytes,
        timeout: float,
    ) -> ApnsHttpResponse:
        record = {
            "environment": environment,
            "path": path,
            "headers": dict(headers),
            "body": body,
        }
        self.requests.append(record)
        if self.script:
            item = self.script.pop(0)
            if isinstance(item, Exception):
                raise item
            status, payload, extra = item
            return self._response(status, payload, extra)
        return self._answer(path, headers, body)

    def _response(
        self, status: int, payload: dict | None, extra: Mapping[str, str] | None = None
    ) -> ApnsHttpResponse:
        headers = {"apns-id": str(uuid.uuid4()), **(extra or {})}
        return ApnsHttpResponse(
            status, headers, json.dumps(payload).encode() if payload else b""
        )

    def _answer(
        self, path: str, headers: Mapping[str, str], body: bytes
    ) -> ApnsHttpResponse:
        auth = headers.get("authorization", "")
        if not auth.startswith("bearer "):
            return self._response(403, {"reason": "MissingProviderToken"})
        try:
            head, claims, signature = auth[7:].split(".")
            header = json.loads(_unb64(head))
            claim = json.loads(_unb64(claims))
            raw = _unb64(signature)
            if (
                header != {"alg": "ES256", "kid": KEY_ID}
                or claim.get("iss") != TEAM
                or len(raw) != 64
            ):
                raise ValueError("claims")
            self.public_key.verify(
                encode_dss_signature(
                    int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big")
                ),
                f"{head}.{claims}".encode(),
                ec.ECDSA(hashes.SHA256()),
            )
        except Exception:  # noqa: BLE001
            return self._response(403, {"reason": "InvalidProviderToken"})
        if self.clock() - claim["iat"] > 3600:
            return self._response(403, {"reason": "ExpiredProviderToken"})
        push_type = headers.get("apns-push-type")
        if push_type == "background":
            # Apple: background pushes use priority 5 and carry content-available, nothing visible.
            aps = json.loads(body).get("aps", {})
            if headers.get("apns-priority") != "5":
                return self._response(400, {"reason": "BadPriority"})
            if aps.get("content-available") != 1 or {"alert", "sound", "badge"} & set(
                aps
            ):
                return self._response(400, {"reason": "InvalidPushType"})
        elif push_type != "alert" or headers.get("apns-priority") not in {"5", "10"}:
            return self._response(400, {"reason": "BadPriority"})
        if len(headers.get("apns-collapse-id", "x").encode()) > 64:
            return self._response(400, {"reason": "BadCollapseId"})
        if len(body) > 4096:
            return self._response(413, {"reason": "PayloadTooLarge"})
        token = path.removeprefix("/3/device/")
        if token in self.unregistered:
            return self._response(
                410, {"reason": "Unregistered", "timestamp": self.unregistered[token]}
            )
        if token not in self.valid_tokens:
            return self._response(400, {"reason": "BadDeviceToken"})
        if self.valid_tokens[token] != headers.get("apns-topic"):
            return self._response(400, {"reason": "DeviceTokenNotForTopic"})
        json.loads(body)
        return self._response(200, None, {"apns-id": headers["apns-id"]})

    @property
    def payloads(self) -> list[dict[str, Any]]:
        return [json.loads(r["body"]) for r in self.requests]


# --------------------------------------------------------------------------- native rows


def fill_row(
    fill_id: str = "f1",
    order_id: str = "o1",
    *,
    bot: str = "rsi_modular_v2",
    side: str = "buy",
    pair: str = "BNB-USDT",
    amount: str = "0.5",
    price: str = "600",
    fee: str | None = "0.3",
    timestamp: float = 1_790_000_100.0,
    source_db: str = "db-v2",
) -> dict[str, Any]:
    return {
        "fill_id": fill_id,
        "order_id": order_id,
        "bot_name": bot,
        "connector_name": "okx",
        "source_db_id": source_db,
        "pair": pair,
        "side": side,
        "timestamp": timestamp,
        "exact_amount": amount,
        "exact_price": price,
        "exact_trade_fee_in_quote": fee,
    }


def executor_row(
    executor_id: str = "e1",
    *,
    bot: str = "rsi_modular_v2",
    pair: str = "BNB-USDT",
    status: str = "closed",
    close_type: str | None = "10",
    trailing_state: str | None = None,
    closed_at: float = 1_790_000_200.0,
    amount: float = 0.5,
    price: float = 600.0,
) -> dict[str, Any]:
    return {
        "executor_id": executor_id,
        "bot_name": bot,
        "pair": pair,
        "normalized_status": status,
        "close_type": close_type,
        "trailing_state": trailing_state,
        "trailing_trigger_price": 612.5 if trailing_state == "armed" else None,
        "closed_at": closed_at,
        "timestamp": closed_at,
        "amount_base": amount,
        "price_quote": price,
    }
