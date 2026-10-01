"""Read-only Telegram commands for the registered Condor trading fleet.

This module is a separate process from Condor's web server. It deliberately
does not import ``main`` or any trading/control handlers. One replica owns the
Telegram token and durable polling offset.

The private config file contains an exact numeric Telegram user allowlist and
one entry per bot. Each bot entry names its native API origin, BasicAuth
credentials, native bot name, and the fixed GET paths for status,
orders, fills, and executors. No endpoint can be supplied by a Telegram user.
"""

from __future__ import annotations

import asyncio
import fcntl
import hashlib
import json
import logging
import os
import re
import sqlite3
import sys
import time
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit

import aiohttp
from telegram import Bot, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.error import BadRequest, Conflict, InvalidToken, RetryAfter, TelegramError

from condor import fleet_telegram_views as views
from condor.fleet_trade_alerts import TradeAlerts, render_fill_alert, source_key

logger = logging.getLogger("condor.fleet_telegram")

COMMANDS = frozenset({"status", "orders", "fills", "executors", "start", "help"})
MAX_TELEGRAM_TEXT = 3900
DEFAULT_REQUEST_TIMEOUT = 8.0
DEFAULT_POLL_TIMEOUT = 25
MAX_RETRY_SECONDS = 30
MAX_TELEGRAM_RETRY_SECONDS = 60
HEARTBEAT_MAX_AGE_SECONDS = 90
SOURCE_STALE_AFTER_SECONDS = 60


class ConfigError(ValueError):
    """Private fleet worker configuration is invalid."""


class WorkerHold(RuntimeError):
    """Telegram needs operator action before polling may safely resume."""


@dataclass(frozen=True)
class BotSource:
    id: str
    label: str
    api_base_url: str
    api_username: str
    api_password: str
    native_bot_name: str
    endpoints: Mapping[str, str]
    require_owner_identity: bool = True
    quote_currency: str = "quote"


@dataclass(frozen=True)
class CatalogueConfig:
    api_base_url: str
    api_username: str
    api_password: str
    endpoint: str
    aliases: Mapping[str, str]
    refresh_seconds: int = 30


@dataclass(frozen=True)
class WorkerConfig:
    authorized_user_ids: frozenset[int]
    bots: tuple[BotSource, ...]
    request_timeout_seconds: float = DEFAULT_REQUEST_TIMEOUT
    poll_timeout_seconds: int = DEFAULT_POLL_TIMEOUT
    trade_alerts: bool = False
    discovery: CatalogueConfig | None = None


def _private_file(path: str, kind: str) -> str:
    value = Path(path).read_text(encoding="utf-8").strip()
    if not value:
        raise ConfigError(f"{kind} file is empty")
    return value


def _safe_endpoint(value: Any, *, field: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) > 512
        or not value.startswith("/")
        or value.startswith("//")
    ):
        raise ConfigError(f"{field} must be an absolute path on the configured API")
    parsed = urlsplit(value)
    if parsed.scheme or parsed.netloc or parsed.fragment or "\\" in value:
        raise ConfigError(f"{field} must be a local API path")
    if any(part == ".." for part in parsed.path.split("/")):
        raise ConfigError(f"{field} cannot traverse API paths")
    return value


def _catalogue_endpoint(value: str, *, field: str, key: str, bot_id: str) -> str:
    """Accept only the catalogue's fixed per-bot GET routes and query fields."""
    parsed = urlsplit(value)
    if key == "status":
        expected_path = f"/bot-orchestration/{bot_id}/status"
        if parsed.path != expected_path or parsed.query:
            raise ConfigError(f"{field} is not the fixed bot status route")
        return value
    paths = {
        "bootstrap": "/trading-visuals/bootstrap",
        "runtime_status": "/trading-visuals/runtime-status",
        "orders": "/trading-visuals/orders",
        "fills": "/trading-visuals/fills",
        "executors": "/trading-visuals/executors",
    }
    if parsed.path != paths.get(key):
        raise ConfigError(f"{field} is not an allowed reporting route")
    try:
        pairs = parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=True)
    except ValueError as exc:
        raise ConfigError(f"{field} has an invalid query") from exc
    names = [name for name, _ in pairs]
    if names.count("bot") != 1 or any(name not in {"bot", "limit"} for name in names):
        raise ConfigError(f"{field} has unsupported query fields")
    if dict(pairs).get("bot") != bot_id:
        raise ConfigError(f"{field} is bound to a different bot")
    limits = [value for name, value in pairs if name == "limit"]
    if limits and (
        len(limits) != 1 or not limits[0].isdecimal() or not 1 <= int(limits[0]) <= 1000
    ):
        raise ConfigError(f"{field} has an invalid row limit")
    return value


def _http_origin(value: Any, *, field: str) -> str:
    parsed = urlsplit(value if isinstance(value, str) else "")
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise ConfigError(f"{field} must be an HTTP(S) origin")
    return f"{parsed.scheme}://{parsed.netloc}"


def _catalogue_source_rows(payload: Any, config: WorkerConfig) -> tuple[BotSource, ...]:
    """Validate the complete native catalogue before exposing any new sources."""
    if (
        not isinstance(payload, dict)
        or payload.get("schema_version") != "native-catalogue/1"
    ):
        raise ConfigError("catalogue schema is unavailable or unsupported")
    rows = payload.get("bots")
    if not isinstance(rows, list) or not rows or len(rows) > 128:
        raise ConfigError("catalogue bot list is empty or outside its limit")
    discovery = config.discovery
    if discovery is None:
        raise ConfigError("catalogue discovery is not configured")
    required_endpoints = {
        "bootstrap",
        "status",
        "runtime_status",
        "orders",
        "fills",
        "executors",
    }
    registration_ids: set[str] = set()
    target_ids: set[str] = set()
    sources: list[BotSource] = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            raise ConfigError(f"catalogue bots[{index}] is not an object")
        registration_id = row.get("id")
        if (
            not isinstance(registration_id, str)
            or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}", registration_id) is None
            or registration_id in registration_ids
        ):
            raise ConfigError(f"catalogue bots[{index}] has an invalid or duplicate id")
        registration_ids.add(registration_id)
        source_id = discovery.aliases.get(registration_id, registration_id.lower())
        if source_id == "all" or source_id in target_ids:
            raise ConfigError("catalogue aliases produce a duplicate source id")
        target_ids.add(source_id)
        display_name = row.get("display_name", registration_id)
        if (
            not isinstance(display_name, str)
            or not display_name.strip()
            or len(display_name) > 120
            or any(ord(char) < 32 for char in display_name)
        ):
            raise ConfigError(f"catalogue bots[{index}] has an invalid display name")
        capabilities = row.get("capabilities")
        if (
            not isinstance(capabilities, dict)
            or type(capabilities.get("status")) is not bool
            or type(capabilities.get("reporting")) is not bool
        ):
            raise ConfigError(f"catalogue bots[{index}] has invalid capabilities")
        endpoints = row.get("endpoints")
        if not isinstance(endpoints, dict) or not required_endpoints.issubset(
            endpoints
        ):
            raise ConfigError(f"catalogue bots[{index}] is missing read endpoints")
        paths = {}
        for key in required_endpoints:
            field = f"catalogue bots[{index}].endpoints.{key}"
            safe_path = _safe_endpoint(endpoints[key], field=field)
            paths[key] = _catalogue_endpoint(
                safe_path,
                field=field,
                key=key,
                bot_id=registration_id,
            )
        if not capabilities["status"] or not capabilities["reporting"]:
            raise ConfigError(
                f"catalogue bots[{index}] is not available for read-only reporting"
            )
        # The Telegram status view consumes the owner-identified runtime report;
        # the separate orchestration status endpoint has a different wire shape.
        paths["status"] = paths["runtime_status"]
        sources.append(
            BotSource(
                source_id,
                display_name.strip(),
                discovery.api_base_url,
                discovery.api_username,
                discovery.api_password,
                registration_id,
                paths,
            )
        )
    return tuple(sources)


def _catalogue_cache_payload(sources: tuple[BotSource, ...]) -> dict[str, Any]:
    """Persist only public registration metadata, never credentials."""
    rows = []
    for source in sources:
        endpoints = dict(source.endpoints)
        status_path = endpoints["status"]
        endpoints["status"] = f"/bot-orchestration/{source.native_bot_name}/status"
        endpoints.setdefault(
            "bootstrap", f"/trading-visuals/bootstrap?bot={source.native_bot_name}"
        )
        endpoints.setdefault("runtime_status", status_path)
        rows.append(
            {
                "id": source.native_bot_name,
                "display_name": source.label,
                "capabilities": {"status": True, "reporting": True},
                "endpoints": {
                    key: endpoints[key]
                    for key in (
                        "bootstrap",
                        "status",
                        "runtime_status",
                        "orders",
                        "fills",
                        "executors",
                    )
                },
            }
        )
    return {"schema_version": "native-catalogue/1", "bots": rows}


def _same_native_endpoint(left: str, right: str) -> bool:
    """Allow a bounded row limit to differ while preserving exact route ownership."""

    def identity(value: str) -> tuple[str, tuple[tuple[str, str], ...]]:
        parsed = urlsplit(value)
        query = tuple(
            sorted(
                (key, item) for key, item in parse_qsl(parsed.query) if key != "limit"
            )
        )
        return parsed.path, query

    return identity(left) == identity(right)


def load_config(path: str) -> WorkerConfig:
    """Load and validate the read-only fleet registry without logging secrets."""
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ConfigError("fleet config cannot be read or is not valid JSON") from exc
    if not isinstance(raw, dict):
        raise ConfigError("fleet config must be a JSON object")

    ids = raw.get("authorized_user_ids")
    if not isinstance(ids, list) or not ids:
        raise ConfigError("authorized_user_ids must contain at least one numeric ID")
    authorized: set[int] = set()
    for item in ids:
        if isinstance(item, bool) or not isinstance(item, int) or item <= 0:
            raise ConfigError("authorized_user_ids must contain positive integers")
        authorized.add(item)

    bot_rows = raw.get("bots")
    if not isinstance(bot_rows, list) or not bot_rows:
        raise ConfigError("bots must contain at least one registered source")
    bots: list[BotSource] = []
    seen_ids: set[str] = set()
    seen_native_names: set[str] = set()
    required_endpoints = {"status", "orders", "fills", "executors"}
    for index, row in enumerate(bot_rows):
        if not isinstance(row, dict):
            raise ConfigError(f"bots[{index}] must be an object")
        identity = row.get("id")
        label = row.get("label")
        bot_name = row.get("native_bot_name")
        if not all(
            isinstance(v, str) and v.strip() for v in (identity, label, bot_name)
        ):
            raise ConfigError(f"bots[{index}] needs id, label, and native_bot_name")
        identity = identity.strip().lower()
        if (
            identity == "all"
            or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,39}", identity)
            or identity in seen_ids
        ):
            raise ConfigError(f"bots[{index}] has an invalid or duplicate id")
        seen_ids.add(identity)
        if len(label.strip()) > 120 or any(ord(char) < 32 for char in label) or not re.fullmatch(
            r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}", bot_name.strip()
        ):
            raise ConfigError(f"bots[{index}] has an invalid label or native bot name")
        if bot_name.strip() in seen_native_names:
            raise ConfigError(f"bots[{index}] has a duplicate native bot name")
        seen_native_names.add(bot_name.strip())
        base_url = _http_origin(
            row.get("api_base_url"), field=f"bots[{index}].api_base_url"
        )
        endpoints = row.get("endpoints")
        if not isinstance(endpoints, dict) or set(endpoints) != required_endpoints:
            raise ConfigError(
                f"bots[{index}].endpoints must define exactly status, orders, fills, and executors"
            )
        endpoints = {
            key: _safe_endpoint(value, field=f"bots[{index}].endpoints.{key}")
            for key, value in endpoints.items()
        }
        endpoints = {
            key: value.replace("{bot}", quote(bot_name.strip(), safe=""))
            for key, value in endpoints.items()
        }
        username = row.get("api_username")
        password = row.get("api_password")
        if (
            not isinstance(username, str)
            or not username
            or not isinstance(password, str)
            or not password
        ):
            raise ConfigError(f"bots[{index}] needs API credentials")
        currency = row.get("quote_currency", "quote")
        if not isinstance(currency, str) or not re.fullmatch(
            r"[A-Za-z0-9]{1,16}", currency
        ):
            raise ConfigError("quote_currency must be an asset label")
        bots.append(
            BotSource(
                identity,
                label.strip(),
                base_url,
                username,
                password,
                bot_name.strip(),
                endpoints,
                quote_currency=currency,
            )
        )

    try:
        request_timeout = float(
            raw.get("request_timeout_seconds", DEFAULT_REQUEST_TIMEOUT)
        )
        poll_timeout = int(raw.get("poll_timeout_seconds", DEFAULT_POLL_TIMEOUT))
    except (TypeError, ValueError) as exc:
        raise ConfigError("timeouts must be numeric") from exc
    if not 1 <= request_timeout <= 30 or not 1 <= poll_timeout <= 50:
        raise ConfigError("timeouts are outside the supported bounds")
    trade_alerts = raw.get("trade_alerts", False)
    if type(trade_alerts) is not bool:
        raise ConfigError("trade_alerts must be boolean")
    discovery = None
    raw_discovery = raw.get("discovery")
    if raw_discovery is not None:
        if not isinstance(raw_discovery, dict) or set(raw_discovery) != {
            "api_base_url",
            "api_username",
            "api_password",
            "endpoint",
            "aliases",
            "refresh_seconds",
        }:
            raise ConfigError(
                "discovery must define origin, credentials, endpoint, aliases, and refresh_seconds"
            )
        discovery_origin = _http_origin(
            raw_discovery.get("api_base_url"), field="discovery.api_base_url"
        )
        discovery_username = raw_discovery.get("api_username")
        discovery_password = raw_discovery.get("api_password")
        if (
            not isinstance(discovery_username, str)
            or not discovery_username
            or not isinstance(discovery_password, str)
            or not discovery_password
        ):
            raise ConfigError("discovery needs API credentials")
        endpoint = _safe_endpoint(
            raw_discovery.get("endpoint"), field="discovery.endpoint"
        )
        aliases = raw_discovery.get("aliases")
        if not isinstance(aliases, dict):
            raise ConfigError("discovery.aliases must be an object")
        normalized_aliases: dict[str, str] = {}
        for registration_id, alias in aliases.items():
            if (
                not isinstance(registration_id, str)
                or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}", registration_id)
                is None
                or not isinstance(alias, str)
                or re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,39}", alias) is None
                or alias == "all"
            ):
                raise ConfigError(
                    "discovery alias keys and values must be valid source IDs"
                )
            normalized_aliases[registration_id] = alias
        if len(set(normalized_aliases.values())) != len(normalized_aliases):
            raise ConfigError("discovery aliases must be unique")
        refresh_seconds = raw_discovery.get("refresh_seconds")
        if type(refresh_seconds) is not int or not 5 <= refresh_seconds <= 3600:
            raise ConfigError("discovery.refresh_seconds must be between 5 and 3600")
        seed_by_id = {source.id: source for source in bots}
        if any(
            alias in seed_by_id and seed_by_id[alias].native_bot_name != registration_id
            for registration_id, alias in normalized_aliases.items()
        ):
            raise ConfigError("discovery alias conflicts with a configured source")
        discovery = CatalogueConfig(
            discovery_origin,
            discovery_username,
            discovery_password,
            endpoint,
            normalized_aliases,
            refresh_seconds,
        )
    return WorkerConfig(
        frozenset(authorized),
        tuple(bots),
        request_timeout,
        poll_timeout,
        trade_alerts,
        discovery,
    )


class OffsetStore:
    """SQLite-backed Telegram offset and worker heartbeat store."""

    def __init__(self, path: str):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock_file = open(str(self.path) + ".lock", "a+")
        try:
            fcntl.flock(self._lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            self._lock_file.close()
            raise ConfigError("another fleet Telegram worker owns this state") from exc
        self.db = sqlite3.connect(self.path, timeout=5)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
        )
        self.db.commit()

    def get_offset(self) -> int | None:
        row = self.db.execute(
            "SELECT value FROM state WHERE key='update_offset'"
        ).fetchone()
        return int(row[0]) if row else None

    def get_value(self, key: str) -> str | None:
        row = self.db.execute("SELECT value FROM state WHERE key=?", (key,)).fetchone()
        return row[0] if row else None

    def set_catalogue(self, sources: str, retired_labels: str) -> None:
        """Commit the active snapshot and pending retired-alert labels together."""
        with self.db:
            self.db.executemany(
                "INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (
                    ("catalogue_sources", sources),
                    ("catalogue_retired_alert_labels", retired_labels),
                ),
            )

    def get_heartbeat(self) -> dict[str, Any]:
        row = self.db.execute(
            "SELECT value FROM state WHERE key='heartbeat'"
        ).fetchone()
        if not row:
            return {}
        try:
            value = json.loads(row[0])
            return value if isinstance(value, dict) else {}
        except json.JSONDecodeError:
            return {}

    def set_offset(self, offset: int) -> None:
        self._set("update_offset", str(offset))

    def heartbeat(
        self,
        *,
        status: str,
        last_poll_at: float | None = None,
        last_successful_poll_at: float | None = None,
        last_successful_command: float | None = None,
    ) -> None:
        now = time.time()
        payload = {
            "status": status,
            "updated_at": now,
            "last_poll_at": last_poll_at,
            "last_successful_poll_at": last_successful_poll_at,
            "last_successful_command": last_successful_command,
        }
        self._set("heartbeat", json.dumps(payload, separators=(",", ":")))
        heartbeat_path = Path(str(self.path) + ".heartbeat.json")
        temp_path = Path(str(heartbeat_path) + ".tmp")
        temp_path.write_text(
            json.dumps(payload, separators=(",", ":")), encoding="utf-8"
        )
        os.replace(temp_path, heartbeat_path)

    def _set(self, key: str, value: str) -> None:
        self.db.execute(
            "INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )
        self.db.commit()

    def close(self) -> None:
        self.db.close()
        fcntl.flock(self._lock_file.fileno(), fcntl.LOCK_UN)
        self._lock_file.close()


class NativeReadClient:
    """Small GET-only adapter against each bot's configured native API."""

    def __init__(self, config: WorkerConfig):
        self.config = config
        self.timeout = aiohttp.ClientTimeout(
            total=config.request_timeout_seconds,
            connect=min(3.0, config.request_timeout_seconds),
        )
        self.session: aiohttp.ClientSession | None = None

    async def __aenter__(self) -> "NativeReadClient":
        self.session = aiohttp.ClientSession(
            timeout=self.timeout, raise_for_status=False
        )
        return self

    async def __aexit__(self, *_: Any) -> None:
        if self.session is not None:
            await self.session.close()

    async def get(self, source: BotSource, key: str) -> Any:
        path = source.endpoints[key]
        return await self.get_url(
            source.api_base_url,
            source.api_username,
            source.api_password,
            path,
        )

    async def get_catalogue(self) -> Any:
        discovery = self.config.discovery
        if discovery is None:
            raise NativeReadError("catalogue discovery is not configured")
        return await self.get_url(
            discovery.api_base_url,
            discovery.api_username,
            discovery.api_password,
            discovery.endpoint,
        )

    async def get_url(
        self, api_base_url: str, username: str, password: str, path: str
    ) -> Any:
        assert self.session is not None
        # Callers provide only prevalidated API origins and fixed catalogue paths.
        url = api_base_url.rstrip("/") + path
        try:
            async with self.session.get(
                url,
                auth=aiohttp.BasicAuth(username, password),
                allow_redirects=False,
            ) as response:
                if response.status < 200 or response.status >= 300:
                    raise NativeReadError(f"HTTP {response.status}")
                if (
                    response.content_length is not None
                    and response.content_length > 2 * 1024 * 1024
                ):
                    raise NativeReadError("response exceeded size limit")
                chunks: list[bytes] = []
                total = 0
                while True:
                    chunk = await response.content.read(
                        min(64 * 1024, 2 * 1024 * 1024 + 1 - total)
                    )
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > 2 * 1024 * 1024:
                        raise NativeReadError("response exceeded size limit")
                    chunks.append(chunk)
                raw = b"".join(chunks)
                try:
                    return json.loads(raw)
                except (UnicodeDecodeError, json.JSONDecodeError):
                    raise NativeReadError("invalid JSON response") from None
        except aiohttp.ClientResponseError as exc:
            status = exc.status
            if type(status) is int and 100 <= status <= 599:
                raise NativeReadError(f"HTTP {status}") from None
            raise NativeReadError("ClientResponseError") from None
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            raise NativeReadError(type(exc).__name__) from None


class NativeReadError(RuntimeError):
    """Safe, concise per-source read failure."""


_NATIVE_READ_REASON_CODES = {
    "response exceeded size limit": "response_too_large",
    "invalid JSON response": "invalid_json",
    "native API response did not identify its bot owner": "owner_identity_missing",
    "native API returned a different bot identity": "owner_identity_mismatch",
    "native API response did not contain a rows list": "rows_missing",
    "native API response contained a malformed row": "row_malformed",
    "native API row did not identify the registered bot": "row_owner_mismatch",
    "native API returned an unknown record schema": "record_schema_invalid",
    "runtime_status or its source updated_at is invalid": "status_timestamp_invalid",
    "trade alert history reached 1000-fill coverage limit": "history_coverage_limit",
}
_NATIVE_READ_HTTP_STATUS = re.compile(r"HTTP ([1-5][0-9]{2})\Z")
_NATIVE_READ_TRANSPORT_REASONS = {
    "ClientError": "client_error",
    "ClientConnectionError": "connection_error",
    "ClientConnectionResetError": "connection_reset",
    "ClientConnectorCertificateError": "tls_certificate_error",
    "TimeoutError": "request_timeout",
    "ServerTimeoutError": "request_timeout",
    "ConnectionTimeoutError": "request_timeout",
    "SocketTimeoutError": "request_timeout",
    "ClientConnectorError": "connection_error",
    "ClientConnectorDNSError": "dns_error",
    "ClientConnectorSSLError": "tls_error",
    "ClientOSError": "connection_error",
    "ClientPayloadError": "response_payload_error",
    "ClientProxyConnectionError": "proxy_connection_error",
    "ClientResponseError": "http_response_error",
    "ClientSSLError": "tls_error",
    "ClientHttpProxyError": "proxy_response_error",
    "ContentTypeError": "response_content_type_error",
    "ServerConnectionError": "server_connection_error",
    "ServerDisconnectedError": "server_disconnected",
    "ServerFingerprintMismatch": "tls_fingerprint_mismatch",
    "TooManyRedirects": "redirect_rejected",
    "InvalidURL": "invalid_api_url",
    "InvalidUrlClientError": "invalid_api_url",
    "InvalidUrlRedirectClientError": "invalid_api_url",
    "NonHttpUrlClientError": "invalid_api_url",
    "NonHttpUrlRedirectClientError": "invalid_api_url",
    "RedirectClientError": "redirect_rejected",
    "UnixClientConnectorError": "connection_error",
    "WSServerHandshakeError": "websocket_handshake_error",
}


def safe_native_read_error(error: NativeReadError) -> dict[str, str | int | None]:
    """Return a bounded diagnostic without forwarding exception text."""
    message = str(error)
    status = _NATIVE_READ_HTTP_STATUS.fullmatch(message)
    if status:
        return {"reason": "http_status", "http_status": int(status.group(1))}
    reason = _NATIVE_READ_REASON_CODES.get(message)
    if reason is not None:
        return {"reason": reason, "http_status": None}
    reason = _NATIVE_READ_TRANSPORT_REASONS.get(message)
    return {"reason": reason or "native_read_error", "http_status": None}


def _validate_owner_identity(
    payload: Any, source: BotSource, *, require_rows: bool = False
) -> None:
    """Reject a projection whose declared bot owner differs from the registry."""
    if not isinstance(payload, dict):
        if source.require_owner_identity:
            raise NativeReadError("native API response did not identify its bot owner")
        return
    projection = payload.get("api_projection")
    nested = payload.get("runtime_status")
    if not isinstance(projection, dict) and isinstance(nested, dict):
        projection = nested.get("api_projection")
    if isinstance(projection, dict):
        owner = projection.get("bot_name")
        if owner != source.native_bot_name:
            raise NativeReadError("native API returned a different bot identity")
    elif source.require_owner_identity:
        raise NativeReadError("native API response did not identify its bot owner")
    if require_rows:
        rows = payload.get("rows")
        if not isinstance(rows, list):
            raise NativeReadError("native API response did not contain a rows list")
        for row in rows:
            if not isinstance(row, dict):
                raise NativeReadError("native API response contained a malformed row")
            if row.get("bot_name") != source.native_bot_name:
                raise NativeReadError(
                    "native API row did not identify the registered bot"
                )


def _extract_rows(data: Any, command: str) -> list[dict[str, Any]]:
    if not isinstance(data, dict):
        raise NativeReadError("native API returned an unknown record schema")
    rows = data.get("rows")
    if not isinstance(rows, list):
        raise NativeReadError("native API response did not contain a rows list")
    if any(not isinstance(row, dict) for row in rows):
        raise NativeReadError("native API response contained a malformed row")
    return rows


def _render_rows(command: str, payload: Any, page: int = 0) -> str:
    return views.records(command, _extract_rows(payload, command), page).text


def _render_status(payload: Any, currency: str = "quote") -> str:
    try:
        return views.status(payload, currency)
    except (ValueError, TypeError, AttributeError) as exc:
        raise NativeReadError(
            "runtime_status or its source updated_at is invalid"
        ) from exc


def _split_response(text: str) -> list[str]:
    return views.chunks(text, MAX_TELEGRAM_TEXT)


def parse_command(text: str | None) -> tuple[str, str | None] | None:
    if not text:
        return None
    match = re.fullmatch(r"\s*/([a-zA-Z]+)(?:@[A-Za-z0-9_]+)?(?:\s+([^\s]+))?\s*", text)
    if not match:
        return None
    command = match.group(1).lower()
    if command not in COMMANDS:
        return None
    target = match.group(2).lower() if match.group(2) else "all"
    return command, target


class FleetTelegramWorker:
    def __init__(
        self, config: WorkerConfig, token: str, state_path: str, bot: Any | None = None
    ):
        self.config = config
        self._seed_sources = config.bots
        self._token = token
        self._bot = bot or Bot(token=token)
        self.state = OffsetStore(state_path)
        previous = self.state.get_heartbeat()
        self.last_poll_at: float | None = None
        self.last_successful_poll_at: float | None = previous.get(
            "last_successful_poll_at"
        )
        self.last_successful_command = previous.get("last_successful_command")
        self._stopping = asyncio.Event()
        self._catalogue_lock = asyncio.Lock()
        self._catalogue_next_refresh = 0.0
        stored_error = self.state.get_value("catalogue_discovery_error")
        self.catalogue_error: str | None = stored_error or None
        self._missing_seed_ids: frozenset[str] = frozenset()
        self.trade_alerts = TradeAlerts(self.state.db) if config.trade_alerts else None
        self._retired_alert_labels: dict[str, str] = {}
        retired_raw = (
            self.state.get_value("catalogue_retired_alert_labels")
            if config.discovery is not None else None
        )
        if retired_raw is not None:
            try:
                retired = json.loads(retired_raw)
                if not isinstance(retired, dict) or any(
                    not isinstance(key, str)
                    or re.fullmatch(r"[0-9a-f]{64}", key) is None
                    or not isinstance(label, str)
                    or not label.strip()
                    or len(label) > 120
                    or any(ord(char) < 32 for char in label)
                    for key, label in retired.items()
                ):
                    raise ValueError("invalid retired alert source metadata")
                self._retired_alert_labels = retired
            except (json.JSONDecodeError, ValueError):
                self.catalogue_error = "catalogue_cache_invalid"
                self.state._set("catalogue_discovery_error", self.catalogue_error)
        self._restore_catalogue_cache()
        if self.trade_alerts:
            for source in self.config.bots:
                self.trade_alerts.start(source_key(source), time.time())

    def _reconcile_catalogue_sources(
        self, discovered: tuple[BotSource, ...]
    ) -> tuple[tuple[BotSource, ...], list[BotSource], dict[str, str]]:
        """Use successful snapshots for discovery, retaining seeds and pending alerts."""
        seeds = {source.native_bot_name: source for source in self._seed_sources}
        existing = {source.native_bot_name: source for source in self.config.bots}
        merged = {source.id: source for source in self._seed_sources}
        additions: list[BotSource] = []
        for source in discovered:
            previous = seeds.get(source.native_bot_name) or existing.get(
                source.native_bot_name
            )
            if previous is not None:
                if (
                    (previous.native_bot_name not in seeds and previous.api_base_url != source.api_base_url)
                    or any(
                        key not in previous.endpoints
                        or not _same_native_endpoint(
                            previous.endpoints[key], source.endpoints[key]
                        )
                        for key in ("status", "orders", "fills", "executors")
                    )
                ):
                    raise ConfigError("catalogue changed a registered source identity")
                # Keep its established URLs, quote label and dedup key.
                selected = replace(previous, label=source.label)
            else:
                selected = source
                additions.append(selected)
            collision = merged.get(selected.id)
            if collision is not None and collision.native_bot_name != selected.native_bot_name:
                raise ConfigError("catalogue alias conflicts with another registered source")
            merged[selected.id] = selected
        ordered = tuple(merged[key] for key in sorted(merged))
        retired_labels = dict(self._retired_alert_labels)
        if self.trade_alerts is not None:
            pending = {
                row[0]
                for row in self.state.db.execute(
                    "SELECT DISTINCT source FROM trade_outbox WHERE delivered=0"
                )
            }
            retired_labels = {
                key: label for key, label in retired_labels.items() if key in pending
            }
            active_keys = {source_key(source) for source in ordered}
            for source in self.config.bots:
                key = source_key(source)
                if key not in active_keys and key in pending:
                    retired_labels[key] = source.label
            for key in active_keys:
                retired_labels.pop(key, None)
        return ordered, additions, retired_labels

    def _restore_catalogue_cache(self) -> None:
        if self.config.discovery is None:
            return
        raw = self.state.get_value("catalogue_sources")
        if raw is None:
            return
        try:
            payload = json.loads(raw)
            discovered = _catalogue_source_rows(payload, self.config)
            sources, _, _ = self._reconcile_catalogue_sources(discovered)
            self.config = replace(self.config, bots=sources)
            registered = {source.native_bot_name for source in discovered}
            self._missing_seed_ids = frozenset(
                source.id for source in self._seed_sources
                if source.native_bot_name not in registered
            )
        except (json.JSONDecodeError, ConfigError, TypeError, ValueError):
            self.catalogue_error = "catalogue_cache_invalid"
            self.state._set("catalogue_discovery_error", self.catalogue_error)

    def _select_sources(self, target: str) -> list[BotSource] | None:
        if target == "all":
            return list(self.config.bots)
        return [source for source in self.config.bots if source.id == target]

    @staticmethod
    def _callback_target(source_id: str) -> str:
        if len(source_id) <= 40:
            return source_id
        return "b-" + hashlib.sha256(source_id.encode("utf-8")).hexdigest()[:24]

    def _resolve_callback_target(self, target: str) -> str | None:
        if target == "all":
            return target
        matches = [
            source.id
            for source in self.config.bots
            if self._callback_target(source.id) == target
        ]
        return matches[0] if len(matches) == 1 else None

    async def refresh_catalogue(self, *, force: bool = False) -> bool:
        """Merge newly registered read sources while retaining prior identities."""
        discovery = self.config.discovery
        if discovery is None:
            return False
        now = time.monotonic()
        if not force and now < self._catalogue_next_refresh:
            return False
        async with self._catalogue_lock:
            now = time.monotonic()
            if not force and now < self._catalogue_next_refresh:
                return False
            self._catalogue_next_refresh = now + discovery.refresh_seconds
            try:
                async with NativeReadClient(self.config) as client:
                    payload = await client.get_catalogue()
                discovered = _catalogue_source_rows(payload, self.config)
                sources, additions, retired_labels = self._reconcile_catalogue_sources(
                    discovered
                )
                cached = json.dumps(
                    _catalogue_cache_payload(discovered),
                    separators=(",", ":"),
                    sort_keys=True,
                )
                if len(cached.encode("utf-8")) > 256 * 1024:
                    raise ConfigError("catalogue cache exceeds its size limit")
                retired_json = json.dumps(retired_labels, separators=(",", ":"), sort_keys=True)
                self.state.set_catalogue(cached, retired_json)
                self.config = replace(self.config, bots=sources)
                self._retired_alert_labels = retired_labels
                registered = {source.native_bot_name for source in discovered}
                self._missing_seed_ids = frozenset(
                    source.id for source in self._seed_sources
                    if source.native_bot_name not in registered
                )
                if self.trade_alerts is not None:
                    for source in additions:
                        # Start at discovery, never announce old fill history.
                        self.trade_alerts.start(source_key(source), time.time())
                self.catalogue_error = None
                self.state._set("catalogue_discovery_error", "")
                return True
            except Exception as exc:
                if isinstance(exc, NativeReadError):
                    details = safe_native_read_error(exc)
                    reason = str(details["reason"])
                    if details["http_status"] is not None:
                        reason += f" HTTP {details['http_status']}"
                elif isinstance(exc, ConfigError):
                    reason = "catalogue_invalid"
                else:
                    reason = "catalogue_read_error"
                self.catalogue_error = str(reason)
                self.state._set("catalogue_discovery_error", self.catalogue_error)
                logger.warning(
                    "Bot catalogue refresh failed error_type=%s reason=%s; retaining %d registered source(s)",
                    type(exc).__name__,
                    reason,
                    len(self.config.bots),
                )
                return False

    def _with_catalogue_notice(self, view: views.View, source_id: str | None = None) -> views.View:
        if self.catalogue_error is None and not self._missing_seed_ids:
            return view
        if self.catalogue_error is not None:
            notice = (
                "ℹ️ <i>Bot discovery unavailable · showing last-known sources "
                f"({views.clean(self.catalogue_error, 40)}).</i>\n\n"
            )
        elif source_id in self._missing_seed_ids:
            notice = "ℹ️ <i>Configured source is absent from the current native catalogue.</i>\n\n"
        elif source_id is None:
            notice = (
                "ℹ️ <i>Some configured sources are absent from the current "
                "native catalogue.</i>\n\n"
            )
        else:
            return view
        return replace(view, text=notice + view.text)

    async def _read_source(
        self, client: NativeReadClient, source: BotSource, command: str, page: int = 0
    ) -> views.View:
        title = views.header(source.label, command)
        try:
            data = await client.get(source, command)
            _validate_owner_identity(data, source, require_rows=command != "status")
            if command == "status":
                alert_status = ""
                if self.trade_alerts is not None:
                    error = self.state.db.execute(
                        "SELECT value FROM state WHERE key IN (?,?) AND value != ''",
                        (
                            "trade_alert_error:" + source_key(source),
                            "trade_alert_delivery_error",
                        ),
                    ).fetchone()
                    last = self.state.db.execute(
                        "SELECT value FROM state WHERE key=?",
                        ("trade_alert_last_read:" + source_key(source),),
                    ).fetchone()
                    current = (
                        last is not None and 0 <= time.time() - float(last[0]) < 60
                    )
                    alert_status = "\n\n🔔 Trade alerts: " + (
                        "receiving native fills"
                        if current and not (error and error[0])
                        else "delayed / awaiting source"
                    )
                return views.View(
                    title + _render_status(data, source.quote_currency) + alert_status
                )
            result = views.records(command, _extract_rows(data, command), page)
            return views.View(title + result.text, result.page, result.pages)
        except NativeReadError as exc:
            return views.View(
                title
                + "⚠️ <b>Data unavailable</b>\n"
                + views.clean(str(exc), 180)
                + "\n\nTry Refresh in a moment. No trading action was taken."
            )
        except Exception as exc:
            logger.warning(
                "Fleet read failed for source=%s command=%s error=%s",
                source.id,
                command,
                type(exc).__name__,
            )
            return views.View(
                title
                + "⚠️ <b>Data unavailable</b>\nThe source could not be read. Try Refresh."
            )

    async def render(self, command: str, target: str, page: int = 0):
        await self.refresh_catalogue()
        if command in {"start", "help"} or command not in COMMANDS:
            return [
                (
                    "all",
                    self._with_catalogue_notice(
                        views.View(views.help_text(self.config.bots))
                    ),
                )
            ]
        sources = self._select_sources(target)
        if not sources:
            return [
                (
                    "all",
                    self._with_catalogue_notice(
                        views.View(
                            "⚠️ <b>Unknown source</b>\n\n"
                            + views.help_text(self.config.bots)
                        )
                    ),
                )
            ]
        async with NativeReadClient(self.config) as client:
            result = await asyncio.gather(
                *(
                    self._read_source(client, source, command, page)
                    for source in sources
                )
            )
        return [
            (source.id, self._with_catalogue_notice(message, source.id))
            for source, message in zip(sources, result)
        ]

    async def execute(self, command: str, target: str) -> str:
        return "\n\n".join(
            message.text for _, message in await self.render(command, target)
        )

    def keyboard(self, command: str, target: str, page: int = 0, pages: int = 1):
        def button(label, action, target_id=target, index=0):
            target_id = (
                self._callback_target(target_id) if target_id != "all" else target_id
            )
            return InlineKeyboardButton(
                label, callback_data=f"fleet:{target_id}:{action}:{index}"
            )

        rows = [
            [button("📊 Status", "status"), button("📋 Orders", "orders")],
            [button("💱 Fills", "fills"), button("⚙️ Executors", "executors")],
        ]
        navigation = []
        if page > 0:
            navigation.append(button("‹ Previous", command, index=page - 1))
        if page + 1 < pages:
            navigation.append(button("Next ›", command, index=page + 1))
        if navigation:
            rows.append(navigation)
        rows.append(
            [
                button(
                    "🔄 Refresh",
                    (
                        command
                        if command in {"status", "orders", "fills", "executors"}
                        else "status"
                    ),
                    index=page,
                ),
                button("❔ Help", "help"),
            ]
        )
        if len(self.config.bots) > 1:
            for start in range(0, len(self.config.bots), 3):
                rows.append(
                    [
                        button(source.label[:30], "status", source.id)
                        for source in self.config.bots[start : start + 3]
                    ]
                )
        return InlineKeyboardMarkup(rows)

    def _authorized(self, user, chat):
        user_id = getattr(user, "id", None)
        return (
            user_id in self.config.authorized_user_ids
            and getattr(chat, "type", None) == "private"
            and getattr(chat, "id", None) == user_id
        )

    async def process_update(self, update: Any) -> None:
        query = getattr(update, "callback_query", None)
        if query is not None:
            message = getattr(query, "message", None)
            if not self._authorized(
                getattr(query, "from_user", None), getattr(message, "chat", None)
            ):
                return
            parsed = views.parse_callback(getattr(query, "data", None))
            resolved_target = (
                self._resolve_callback_target(parsed[1]) if parsed is not None else None
            )
            if (
                parsed is None
                or resolved_target is None
                or (
                    resolved_target != "all"
                    and not self._select_sources(resolved_target)
                )
            ):
                try:
                    await self._bot.answer_callback_query(
                        callback_query_id=query.id,
                        text="This button is no longer available. Send /help.",
                    )
                except BadRequest:
                    logger.info("Ignoring expired unsupported callback")
                return
            command, _, page = parsed
            target = resolved_target
            try:
                await self._bot.answer_callback_query(callback_query_id=query.id)
            except BadRequest:
                # An expired acknowledgement must not poison the durable update cursor.
                logger.info(
                    "Callback acknowledgement expired; refreshing authorized view"
                )
        else:
            message = getattr(update, "message", None)
            if not self._authorized(
                getattr(message, "from_user", None), getattr(message, "chat", None)
            ):
                return
            text = getattr(message, "text", None)
            parsed = parse_command(text)
            if parsed is None:
                if not isinstance(text, str) or not text.startswith("/"):
                    return
                parsed = ("help", "all")
            command, target = parsed
            page = 0
        chat_id = message.chat.id
        rendered = await self.render(command, target, page)
        edited = False
        for source_id, result in rendered:
            for chunk in _split_response(result.text):
                options = dict(
                    chat_id=chat_id,
                    text=chunk,
                    parse_mode="HTML",
                    reply_markup=self.keyboard(
                        command, source_id, result.page, result.pages
                    ),
                )
                if query is not None and not edited:
                    try:
                        await self._bot.edit_message_text(
                            message_id=message.message_id, **options
                        )
                    except BadRequest as exc:
                        if "message is not modified" not in str(exc).lower():
                            # Deleted/inaccessible old panels can be replaced with a new view.
                            await self._bot.send_message(**options)
                    edited = True
                else:
                    await self._bot.send_message(**options)
        self.last_successful_command = time.time()
        self.state.heartbeat(
            status="running",
            last_poll_at=self.last_poll_at,
            last_successful_poll_at=self.last_successful_poll_at,
            last_successful_command=self.last_successful_command,
        )

    async def notify_trades(self):
        """Read bounded native history and deliver a durable fill outbox."""
        if self.trade_alerts is None:
            return
        await self.refresh_catalogue()
        by_key = {source_key(source): source for source in self.config.bots}
        async with NativeReadClient(self.config) as client:
            for key, source in by_key.items():
                try:
                    path = urlsplit(source.endpoints["fills"])
                    query = [
                        (k, v) for k, v in parse_qsl(path.query) if k != "limit"
                    ] + [("limit", "1000")]
                    endpoint = urlunsplit(("", "", path.path, urlencode(query), ""))
                    read_source = replace(
                        source, endpoints={**source.endpoints, "fills": endpoint}
                    )
                    payload = await client.get(read_source, "fills")
                    _validate_owner_identity(payload, source, require_rows=True)
                    rows = _extract_rows(payload, "fills")
                    if not self.trade_alerts.has_coverage(key, rows):
                        # Never quietly advance a truncated history window.
                        raise NativeReadError(
                            "trade alert history reached 1000-fill coverage limit"
                        )
                    self.trade_alerts.ingest(key, rows, self.config.authorized_user_ids)
                    self.state._set("trade_alert_last_read:" + key, str(time.time()))
                    self.state._set("trade_alert_error:" + key, "")
                except (NativeReadError, ValueError) as exc:
                    details = (
                        safe_native_read_error(exc)
                        if isinstance(exc, NativeReadError)
                        else {"reason": "fill_validation_error", "http_status": None}
                    )
                    self.state._set(
                        "trade_alert_error:" + key,
                        json.dumps(details, separators=(",", ":"), sort_keys=True),
                    )
                    logger.warning(
                        "Trade alert read held source=%s error_type=%s reason=%s http_status=%s",
                        source.id,
                        (
                            "NativeReadError"
                            if isinstance(exc, NativeReadError)
                            else "ValueError"
                        ),
                        details["reason"],
                        (
                            details["http_status"]
                            if details["http_status"] is not None
                            else "none"
                        ),
                    )
        delivery_sources = set(by_key) | set(self._retired_alert_labels)
        for identity, key, recipient, rows in self.trade_alerts.pending(
            self.config.authorized_user_ids, delivery_sources
        ):
            source = by_key.get(key)
            label = source.label if source is not None else self._retired_alert_labels[key]
            await self._bot.send_message(
                chat_id=recipient,
                text=render_fill_alert(label, rows),
                parse_mode="HTML",
                reply_markup=self.keyboard("fills", source.id) if source is not None else None,
            )
            # Telegram has no idempotency key: ambiguous network/crash delivery can
            # repeat delivery. Persist only confirmed success, never silently lose it.
            self.trade_alerts.sent(identity)
            self.state._set("trade_alert_last_sent", str(time.time()))
            logger.info(
                "Trade alert delivered source=%s fills=%d",
                source.id if source is not None else "retired",
                len(rows),
            )

    async def trade_loop(self):
        delay = 5.0
        while not self._stopping.is_set():
            try:
                await self.notify_trades()
                self.state._set("trade_alert_delivery_error", "")
                delay = 5.0
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("Trade notification retry error=%s", type(exc).__name__)
                self.state._set("trade_alert_delivery_error", type(exc).__name__)
                delay = min(60.0, delay * 2)
                if isinstance(exc, RetryAfter):
                    requested = exc.retry_after
                    delay = max(
                        delay,
                        (
                            requested.total_seconds()
                            if hasattr(requested, "total_seconds")
                            else float(requested)
                        ),
                    )
            try:
                await asyncio.wait_for(self._stopping.wait(), timeout=delay)
            except asyncio.TimeoutError:
                pass

    async def run(self) -> None:
        offset = self.state.get_offset()
        retry_seconds = 1.0
        previous_status = self.state.get_heartbeat().get("status")
        if previous_status in {"conflict", "invalid_token", "rate_limited_hold"}:
            raise ConfigError(
                f"worker remains failed closed after {previous_status}; operator review is required"
            )
        self.state.heartbeat(status="starting")
        initialized = False
        trade_task = None
        try:
            while not self._stopping.is_set():
                try:
                    if not initialized:
                        await self._bot.initialize()
                        initialized = True
                        if self.trade_alerts is not None:
                            trade_task = asyncio.create_task(self.trade_loop())
                    self.last_poll_at = time.time()
                    updates = await self._bot.get_updates(
                        offset=offset,
                        timeout=self.config.poll_timeout_seconds,
                        allowed_updates=["message", "callback_query"],
                    )
                    retry_seconds = 1.0
                    self.last_successful_poll_at = time.time()
                    self.state.heartbeat(
                        status="running",
                        last_poll_at=self.last_poll_at,
                        last_successful_poll_at=self.last_successful_poll_at,
                        last_successful_command=self.last_successful_command,
                    )
                    for update in updates:
                        await self.process_update(update)
                        # Acknowledge only after read and reply completed. A crash can
                        # repeat the last reply once, but cannot silently lose it.
                        offset = int(update.update_id) + 1
                        self.state.set_offset(offset)
                except asyncio.CancelledError:
                    raise
                except InvalidToken:
                    logger.error("Telegram rejected the configured bot token")
                    self.state.heartbeat(
                        status="invalid_token",
                        last_poll_at=self.last_poll_at,
                        last_successful_poll_at=self.last_successful_poll_at,
                        last_successful_command=self.last_successful_command,
                    )
                    raise
                except Conflict:
                    logger.error(
                        "Telegram polling conflict: another process owns this bot token"
                    )
                    self.state.heartbeat(
                        status="conflict",
                        last_poll_at=self.last_poll_at,
                        last_successful_poll_at=self.last_successful_poll_at,
                        last_successful_command=self.last_successful_command,
                    )
                    raise
                except RetryAfter as exc:
                    retry_value = exc.retry_after
                    if hasattr(retry_value, "total_seconds"):
                        retry_value = retry_value.total_seconds()
                    retry_after = max(1.0, float(retry_value))
                    if retry_after > MAX_TELEGRAM_RETRY_SECONDS:
                        logger.error(
                            "Telegram requested a retry delay beyond the worker limit; entering operator hold"
                        )
                        self.state.heartbeat(
                            status="rate_limited_hold",
                            last_poll_at=self.last_poll_at,
                            last_successful_poll_at=self.last_successful_poll_at,
                            last_successful_command=self.last_successful_command,
                        )
                        raise WorkerHold(
                            "Telegram retry delay exceeds configured bound"
                        )
                    logger.warning(
                        "Telegram rate limited polling; retrying after %.0fs",
                        retry_after,
                    )
                    self.state.heartbeat(
                        status="retrying",
                        last_poll_at=self.last_poll_at,
                        last_successful_poll_at=self.last_successful_poll_at,
                        last_successful_command=self.last_successful_command,
                    )
                    await asyncio.sleep(retry_after)
                except TelegramError as exc:
                    # Telegram exceptions may include request URLs. Never stringify.
                    logger.warning(
                        "Telegram polling failed (%s); retrying in %.0fs",
                        type(exc).__name__,
                        retry_seconds,
                    )
                    self.state.heartbeat(
                        status="retrying",
                        last_poll_at=self.last_poll_at,
                        last_successful_poll_at=self.last_successful_poll_at,
                        last_successful_command=self.last_successful_command,
                    )
                    await asyncio.sleep(retry_seconds)
                    retry_seconds = min(MAX_RETRY_SECONDS, retry_seconds * 2)
                except WorkerHold:
                    raise
                except (
                    Exception
                ) as exc:  # bounded recovery also covers local DB hiccups
                    logger.error(
                        "Fleet Telegram worker error (%s); retrying in %.0fs",
                        type(exc).__name__,
                        retry_seconds,
                    )
                    self.state.heartbeat(
                        status="retrying",
                        last_poll_at=self.last_poll_at,
                        last_successful_poll_at=self.last_successful_poll_at,
                        last_successful_command=self.last_successful_command,
                    )
                    await asyncio.sleep(retry_seconds)
                    retry_seconds = min(MAX_RETRY_SECONDS, retry_seconds * 2)
        finally:
            if trade_task is not None:
                trade_task.cancel()
                await asyncio.gather(trade_task, return_exceptions=True)
            current_status = self.state.get_heartbeat().get("status")
            if current_status not in {"conflict", "invalid_token", "rate_limited_hold"}:
                self.state.heartbeat(
                    status="stopped",
                    last_poll_at=self.last_poll_at,
                    last_successful_poll_at=self.last_successful_poll_at,
                    last_successful_command=self.last_successful_command,
                )
            self.state.close()
            if initialized:
                try:
                    await self._bot.shutdown()
                except Exception as exc:
                    logger.warning(
                        "Telegram client shutdown failed (%s)", type(exc).__name__
                    )

    def stop(self) -> None:
        self._stopping.set()


def _required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise ConfigError(f"required environment variable {name} is not set")
    return value


async def _main() -> None:
    config_path = _required_env("CONDOR_FLEET_TELEGRAM_CONFIG")
    token_path = _required_env("CONDOR_FLEET_TELEGRAM_TOKEN_FILE")
    state_path = _required_env("CONDOR_FLEET_TELEGRAM_STATE")
    config = load_config(config_path)
    token = _private_file(token_path, "Telegram token")
    worker = FleetTelegramWorker(config, token, state_path)
    await worker.run()


def healthcheck(state_path: str, *, now: float | None = None) -> bool:
    """Return whether the worker has polled Telegram recently enough."""
    path = Path(str(state_path) + ".heartbeat.json")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        last_poll = data.get("last_successful_poll_at")
        age = (time.time() if now is None else now) - float(last_poll)
        return (
            data.get("status") in {"running", "retrying"}
            and 0 <= age <= HEARTBEAT_MAX_AGE_SECONDS
        )
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        return False


def main() -> None:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    for noisy_logger in ("httpx", "httpcore", "telegram", "telegram.ext"):
        logging.getLogger(noisy_logger).setLevel(logging.WARNING)
    if sys.argv[1:] == ["--healthcheck"]:
        try:
            healthy = healthcheck(_required_env("CONDOR_FLEET_TELEGRAM_STATE"))
        except ConfigError:
            healthy = False
        raise SystemExit(0 if healthy else 1)
    try:
        asyncio.run(_main())
    except ConfigError as exc:
        logger.error("Fleet Telegram configuration error: %s", exc)
        raise SystemExit(2) from None
    except (Conflict, InvalidToken, WorkerHold):
        raise SystemExit(3) from None


if __name__ == "__main__":
    main()
