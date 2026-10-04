"""APNs sender: ES256 provider token, request builder and an injectable HTTP/2 transport.

Token-based auth. The operator places an APNs auth key (.p8) in a private
file; this module reads it by path when a token is minted and never stores,
logs or echoes its contents. Provider tokens are cached for 45 minutes (Apple:
refresh at least every 60, and no more often than every 20).

Tests inject a transport that plays Apple's part; nothing here contacts Apple
unless the real ``HttpxApnsTransport`` is installed by the worker.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import stat
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Protocol

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

from condor.push.events import ALERT_CLASSES, AlertEvent, clean_text, interruption_level

ENDPOINTS = {
    "production": "https://api.push.apple.com",
    "sandbox": "https://api.sandbox.push.apple.com",
}
MAX_PAYLOAD_BYTES = 4096
TOKEN_TTL_SECONDS = 45 * 60  # Apple rejects tokens older than 60 minutes
TOKEN_MIN_REFRESH_SECONDS = (
    20 * 60
)  # ... and throttles minting more often than every 20
KEY_MAX_BYTES = 8 * 1024


class ApnsKeyError(RuntimeError):
    """The APNs key is missing, unsafe or unusable. Never carries key material."""


class ApnsDependencyError(RuntimeError):
    """A library the real transport needs is not installed."""


# --------------------------------------------------------------------------- key and token


def read_private_bytes(path: Path | str, *, max_bytes: int = KEY_MAX_BYTES) -> bytes:
    """Read a private file: regular, not a symlink, not readable by group or others."""
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError as exc:
        raise ApnsKeyError(
            f"APNs key file cannot be opened ({exc.__class__.__name__})"
        ) from None
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            raise ApnsKeyError("APNs key file must be a regular file with mode 0600")
        data = stream.read(max_bytes + 1)
    if not data or len(data) > max_bytes:
        raise ApnsKeyError("APNs key file is empty or too large")
    return data


def load_signing_key(path: Path | str) -> ec.EllipticCurvePrivateKey:
    data = read_private_bytes(path)
    try:
        key = serialization.load_pem_private_key(data, password=None)
    except Exception as exc:  # noqa: BLE001 - never echo key material
        raise ApnsKeyError(
            f"APNs key is not a valid PEM private key ({exc.__class__.__name__})"
        ) from None
    if not isinstance(key, ec.EllipticCurvePrivateKey) or key.curve.name != "secp256r1":
        raise ApnsKeyError("APNs key must be an EC P-256 key")
    return key


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def make_provider_token(
    key: ec.EllipticCurvePrivateKey, key_id: str, team_id: str, issued_at: float
) -> str:
    """ES256 JWT: header {alg, kid}, claims {iss: team, iat}; signature is raw r||s."""
    header = _b64(
        json.dumps({"alg": "ES256", "kid": key_id}, separators=(",", ":")).encode()
    )
    claims = _b64(
        json.dumps(
            {"iss": team_id, "iat": int(issued_at)}, separators=(",", ":")
        ).encode()
    )
    signing_input = f"{header}.{claims}".encode("ascii")
    r, s = decode_dss_signature(key.sign(signing_input, ec.ECDSA(hashes.SHA256())))
    return f"{header}.{claims}." + _b64(r.to_bytes(32, "big") + s.to_bytes(32, "big"))


class ProviderTokens:
    """Caches the provider token; re-reads the key file each time it mints."""

    def __init__(
        self,
        key_path: Path | str,
        key_id: str,
        team_id: str,
        *,
        clock: Callable[[], float] = time.time,
        loader: Callable[[Path | str], ec.EllipticCurvePrivateKey] = load_signing_key,
    ):
        self._path, self._key_id, self._team_id = key_path, key_id, team_id
        self._clock, self._loader = clock, loader
        self._token: str | None = None
        self._issued_at = 0.0

    def token(self) -> str:
        now = self._clock()
        if (
            self._token is None
            or now - self._issued_at >= TOKEN_TTL_SECONDS
            or now < self._issued_at
        ):
            self._mint(now)
        assert self._token is not None
        return self._token

    def refresh_after_rejection(self) -> str | None:
        """A fresh token after Apple says ours expired, or None if minting again is too soon."""
        now = self._clock()
        if (
            self._token is not None
            and 0 <= now - self._issued_at < TOKEN_MIN_REFRESH_SECONDS
        ):
            return None
        self._mint(now)
        return self._token

    def _mint(self, now: float) -> None:
        key = self._loader(self._path)
        self._token = make_provider_token(key, self._key_id, self._team_id, now)
        self._issued_at = now

    @property
    def issued_at(self) -> float:
        return self._issued_at


# --------------------------------------------------------------------------- request


@dataclass(frozen=True)
class ApnsRequest:
    environment: str
    path: str
    headers: Mapping[str, str]
    body: bytes


def build_payload(
    event: AlertEvent,
    *,
    silent: bool,
    recipient_user_id: int | None = None,
    recipient_device_id: str | None = None,
    recipient_server_id: str | None = None,
) -> dict[str, Any]:
    """The notification. No action buttons: categories open the app and nothing else."""
    level = "passive" if silent else interruption_level(event.severity)
    aps: dict[str, Any] = {
        "alert": {"title": event.title, "body": event.body},
        "thread-id": event.thread_id,
        "category": ALERT_CLASSES[event.cls].category,
        "interruption-level": level,
    }
    if level != "passive":
        aps["sound"] = "default"
    meta: dict[str, Any] = {
        "v": 1,
        "id": event.id,
        "class": event.cls,
        "kind": event.kind,
        "link": event.deep_link,
        "ts": int(event.occurred_at),
    }
    if event.bot:
        meta["bot"] = event.bot
    if any(
        value is not None
        for value in (recipient_user_id, recipient_device_id, recipient_server_id)
    ):
        if (
            type(recipient_user_id) is not int
            or recipient_user_id <= 0
            or not isinstance(recipient_device_id, str)
            or not recipient_device_id
            or not isinstance(recipient_server_id, str)
            or not recipient_server_id
        ):
            raise ValueError("notification recipient binding is invalid")
        meta["recipient_user_id"] = str(recipient_user_id)
        meta["recipient_device_id"] = recipient_device_id
        meta["recipient_server_id"] = recipient_server_id
    return {"aps": aps, "rsibot": meta}


def encode_payload(payload: dict[str, Any]) -> bytes:
    """JSON within Apple's 4 KB limit; the body is shortened before anything is dropped."""
    body = payload["aps"]["alert"]["body"]
    while True:
        raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode(
            "utf-8"
        )
        if len(raw) <= MAX_PAYLOAD_BYTES:
            return raw
        if len(body) <= 40:
            raise ValueError("notification payload exceeds the APNs limit")
        body = clean_text(body, max(40, len(body) // 2), multiline=True)
        payload["aps"]["alert"]["body"] = body


def build_request(
    event: AlertEvent,
    *,
    token: str,
    topic: str,
    environment: str,
    device_id: str,
    now: float,
    expires_at: float,
    silent: bool,
    recipient_user_id: int | None = None,
    recipient_server_id: str | None = None,
) -> ApnsRequest:
    level = "passive" if silent else interruption_level(event.severity)
    headers = {
        "apns-topic": topic,
        "apns-push-type": "alert",
        "apns-priority": "5" if level == "passive" else "10",
        "apns-expiration": str(int(max(expires_at, now + 60))),
        "apns-collapse-id": event.collapse_key,
        # Stable per (event, device): a retry carries the same id, so Apple's logs correlate.
        "apns-id": str(
            uuid.uuid5(uuid.NAMESPACE_URL, f"rsibot:{event.id}:{device_id}")
        ),
    }
    return ApnsRequest(
        environment=environment,
        path=f"/3/device/{token}",
        headers=headers,
        body=encode_payload(
            build_payload(
                event,
                silent=silent,
                recipient_user_id=recipient_user_id,
                recipient_device_id=(
                    device_id if recipient_user_id is not None else None
                ),
                recipient_server_id=recipient_server_id,
            )
        ),
    )


# --------------------------------------------------------------------------- transport


@dataclass(frozen=True)
class ApnsHttpResponse:
    status: int
    headers: Mapping[str, str]
    body: bytes


class ApnsTransport(Protocol):
    async def post(
        self,
        *,
        environment: str,
        path: str,
        headers: Mapping[str, str],
        body: bytes,
        timeout: float,
    ) -> ApnsHttpResponse: ...

    async def close(self) -> None: ...


class HttpxApnsTransport:
    """HTTP/2 via httpx. Needs the ``h2`` package (``httpx[http2]``); see the runbook.

    ``endpoints`` and ``prior_knowledge`` exist so a test can aim it at a local
    cleartext HTTP/2 server; the worker always uses Apple's hosts over TLS.
    """

    def __init__(
        self,
        endpoints: Mapping[str, str] | None = None,
        *,
        prior_knowledge: bool = False,
    ):
        self._endpoints = dict(endpoints or ENDPOINTS)
        self._prior_knowledge = prior_knowledge
        self._clients: dict[str, Any] = {}

    def _client(self, environment: str):
        if environment not in self._endpoints:
            raise ValueError("unknown APNs environment")
        if environment not in self._clients:
            try:
                import h2  # noqa: F401
                import httpx
            except ImportError:
                raise ApnsDependencyError(
                    "APNs needs HTTP/2: add h2==4.4.1 (with hpack==4.2.0, hyperframe==6.1.0) "
                    "to deploy/condor-stack/requirements-condor.txt"
                ) from None
            self._clients[environment] = httpx.AsyncClient(
                base_url=self._endpoints[environment],
                http1=not self._prior_knowledge,
                http2=True,
                limits=httpx.Limits(
                    max_connections=4, max_keepalive_connections=2, keepalive_expiry=300
                ),
                follow_redirects=False,
                trust_env=False,
            )
        return self._clients[environment]

    async def post(
        self,
        *,
        environment: str,
        path: str,
        headers: Mapping[str, str],
        body: bytes,
        timeout: float,
    ) -> ApnsHttpResponse:
        response = await self._client(environment).post(
            path, headers=dict(headers), content=body, timeout=timeout
        )
        return ApnsHttpResponse(
            response.status_code,
            {k.lower(): v for k, v in response.headers.items()},
            response.content,
        )

    async def close(self) -> None:
        for client in self._clients.values():
            await client.aclose()
        self._clients.clear()


# --------------------------------------------------------------------------- client


@dataclass(frozen=True)
class ApnsOutcome:
    kind: str  # sent | retry | dead | rejected | auth
    status: int | None
    reason: str | None
    apns_id: str | None = None
    retry_after: float | None = None
    apns_timestamp: float | None = None  # 410: when Apple saw the token die

    @property
    def ok(self) -> bool:
        return self.kind == "sent"


_DEAD_400 = frozenset({"BadDeviceToken"})
_CONFIG_400 = frozenset(
    {
        "DeviceTokenNotForTopic",
        "BadTopic",
        "TopicDisallowed",
        "MissingTopic",
        "BadCertificateEnvironment",
    }
)


def classify(status: int, reason: str | None) -> str:
    if status == 200:
        return "sent"
    if status == 410 or (status == 400 and reason in _DEAD_400):
        return "dead"
    if status == 403:
        return "auth"
    if status == 429 or status >= 500:
        return "retry"
    return "rejected"  # incl. 400 config reasons, 405, 413: retrying the same request cannot help


class ApnsClient:
    def __init__(
        self,
        tokens: ProviderTokens,
        transport: ApnsTransport,
        *,
        timeout: float = 15.0,
        clock: Callable[[], float] = time.time,
    ):
        self.tokens, self.transport, self.timeout, self._clock = (
            tokens,
            transport,
            timeout,
            clock,
        )
        self.last_success_at: float | None = None
        self.last_error: str | None = None
        self.consecutive_failures = 0
        self.auth_ok: bool | None = None  # None until the first send

    async def send(self, request: ApnsRequest) -> ApnsOutcome:
        outcome = await self._attempt(request, refreshed=False)
        if outcome.ok:
            self.last_success_at, self.last_error, self.consecutive_failures = (
                self._clock(),
                None,
                0,
            )
            self.auth_ok = True
        else:
            self.consecutive_failures += 1
            self.last_error = (
                f"{outcome.status or 'transport'} {outcome.reason or ''}".strip()
            )
            if outcome.kind == "auth":
                self.auth_ok = False
        return outcome

    async def _attempt(self, request: ApnsRequest, *, refreshed: bool) -> ApnsOutcome:
        try:
            bearer = self.tokens.token()
        except ApnsKeyError as exc:
            return ApnsOutcome("auth", None, "KeyUnavailable:" + str(exc)[:80])
        headers = {**request.headers, "authorization": f"bearer {bearer}"}
        try:
            response = await self.transport.post(
                environment=request.environment,
                path=request.path,
                headers=headers,
                body=request.body,
                timeout=self.timeout,
            )
        except ApnsDependencyError:
            return ApnsOutcome("retry", None, "MissingHttp2Dependency")
        except (asyncio.TimeoutError, OSError) as exc:
            return ApnsOutcome("retry", None, "Transport:" + exc.__class__.__name__)
        except (
            Exception
        ) as exc:  # noqa: BLE001 - any client failure is a retryable transport error
            return ApnsOutcome("retry", None, "Transport:" + exc.__class__.__name__)
        reason = None
        if response.body:
            try:
                parsed = json.loads(response.body)
                reason = parsed.get("reason") if isinstance(parsed, dict) else None
            except (ValueError, UnicodeDecodeError):
                reason = None
        reason = reason if isinstance(reason, str) and len(reason) <= 60 else None
        kind = classify(response.status, reason)
        if kind == "auth" and reason == "ExpiredProviderToken" and not refreshed:
            if self.tokens.refresh_after_rejection() is not None:
                return await self._attempt(request, refreshed=True)
        retry_after = None
        raw_retry = response.headers.get("retry-after")
        if raw_retry:
            try:
                retry_after = max(0.0, min(float(raw_retry), 3600.0))
            except ValueError:
                retry_after = None
        stamp = None
        if response.status == 410 and response.body:
            try:
                stamp = float(json.loads(response.body).get("timestamp")) / 1000.0
            except (ValueError, TypeError, AttributeError):
                stamp = None
        return ApnsOutcome(
            kind,
            response.status,
            reason,
            apns_id=response.headers.get("apns-id"),
            retry_after=retry_after,
            apns_timestamp=stamp,
        )
