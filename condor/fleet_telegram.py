"""Read-only Telegram commands for the registered Condor trading fleet.

This module is a separate process from Condor's web server. It deliberately
does not import ``main`` or any trading/control handlers. One replica owns the
Telegram token and durable polling offset.

The private config file contains an exact numeric Telegram user allowlist and
one entry per bot. Each bot entry names its native API origin, BasicAuth
credentials, native bot name, and the fixed GET paths for status, health,
orders, fills, and executors. No endpoint can be supplied by a Telegram user.
"""

from __future__ import annotations

import asyncio
import fcntl
import json
import logging
import os
import re
import sqlite3
import sys
import time
from datetime import datetime, timezone
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import quote, urlsplit

import aiohttp
from telegram import Bot
from telegram.error import Conflict, InvalidToken, RetryAfter, TelegramError

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


@dataclass(frozen=True)
class WorkerConfig:
    authorized_user_ids: frozenset[int]
    bots: tuple[BotSource, ...]
    request_timeout_seconds: float = DEFAULT_REQUEST_TIMEOUT
    poll_timeout_seconds: int = DEFAULT_POLL_TIMEOUT


def _private_file(path: str, kind: str) -> str:
    value = Path(path).read_text(encoding="utf-8").strip()
    if not value:
        raise ConfigError(f"{kind} file is empty")
    return value


def _safe_endpoint(value: Any, *, field: str) -> str:
    if (
        not isinstance(value, str)
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
        if len(label.strip()) > 80 or not re.fullmatch(
            r"[A-Za-z0-9_.-]{1,80}", bot_name.strip()
        ):
            raise ConfigError(f"bots[{index}] has an invalid label or native bot name")
        base_url = row.get("api_base_url")
        parsed = urlsplit(base_url if isinstance(base_url, str) else "")
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
        ):
            raise ConfigError(f"bots[{index}].api_base_url must be an HTTP(S) origin")
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
        bots.append(
            BotSource(
                identity,
                label.strip(),
                f"{parsed.scheme}://{parsed.netloc}",
                username,
                password,
                bot_name.strip(),
                endpoints,
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
    return WorkerConfig(
        frozenset(authorized), tuple(bots), request_timeout, poll_timeout
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
        assert self.session is not None
        path = source.endpoints[key]
        # Bot identity can be interpolated only after URL encoding and config validation.
        url = source.api_base_url.rstrip("/") + path
        try:
            async with self.session.get(
                url,
                auth=aiohttp.BasicAuth(source.api_username, source.api_password),
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
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            raise NativeReadError(type(exc).__name__) from None


class NativeReadError(RuntimeError):
    """Safe, concise per-source read failure."""


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


def _render_value(value: Any, *, max_chars: int = 1050) -> str:
    text = json.dumps(value, ensure_ascii=False, default=str, separators=(",", ":"))
    return text if len(text) <= max_chars else text[: max_chars - 18] + "… [truncated]"


def _render_rows(command: str, payload: Any) -> str:
    rows = _extract_rows(payload, command)
    if not rows:
        return "Records: 0"
    # Keep the output compact while retaining native ownership and identifiers.
    safe_fields = {
        "orders": (
            "id",
            "order_id",
            "client_order_id",
            "bot_name",
            "trading_pair",
            "pair",
            "symbol",
            "side",
            "type",
            "status",
            "normalized_status",
            "price",
            "price_quote",
            "amount",
            "amount_base",
            "executed_amount",
            "created_at",
            "timestamp",
            "updated_at",
        ),
        "fills": (
            "id",
            "fill_id",
            "trade_id",
            "order_id",
            "bot_name",
            "trading_pair",
            "pair",
            "symbol",
            "side",
            "price",
            "price_quote",
            "amount",
            "amount_base",
            "fee",
            "fee_asset",
            "timestamp",
            "created_at",
            "updated_at",
        ),
        "executors": (
            "id",
            "executor_id",
            "bot_name",
            "controller_id",
            "type",
            "executor_type",
            "trading_pair",
            "pair",
            "symbol",
            "side",
            "status",
            "normalized_status",
            "close_type",
            "net_pnl_quote",
            "timestamp",
            "created_at",
            "updated_at",
        ),
    }[command]
    lines = []
    for row in rows[:12]:
        compact = {
            key: row[key]
            for key in safe_fields
            if key in row and isinstance(row[key], (str, int, float, bool, type(None)))
        }
        lines.append(
            _render_value(
                compact or {"record": "available", "fields": sorted(row)[:12]},
                max_chars=300,
            )
        )
    if len(rows) > 12:
        lines.append(f"… and {len(rows) - 12} more records")
    return f"Records: {len(rows)} (showing {min(len(rows), 12)})\n" + "\n".join(lines)


def _render_status(payload: Any) -> str:
    if not isinstance(payload, dict) or not isinstance(
        payload.get("runtime_status"), dict
    ):
        raise NativeReadError("native API response did not contain runtime_status")
    status = payload["runtime_status"]
    source_timestamp = status.get("updated_at")
    if not isinstance(source_timestamp, (str, int, float)) or isinstance(
        source_timestamp, bool
    ):
        raise NativeReadError("runtime_status did not contain its source updated_at")
    try:
        timestamp = float(source_timestamp)
    except (TypeError, ValueError):
        try:
            parsed = datetime.fromisoformat(source_timestamp.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            timestamp = parsed.timestamp()
        except (AttributeError, TypeError, ValueError):
            raise NativeReadError("runtime_status updated_at is invalid") from None
    age_seconds = time.time() - timestamp
    age_text = f"age {int(age_seconds)}s"
    freshness_state = (
        "FUTURE_CLOCK"
        if age_seconds < -5
        else ("STALE" if age_seconds > SOURCE_STALE_AFTER_SECONDS else "recent")
    )
    state = status.get("status") or status.get("state") or status.get("bot_status")
    summary = status.get("summary")
    if not isinstance(summary, dict):
        summary = {}
    if freshness_state == "STALE":
        state = "stale runtime snapshot"
    elif freshness_state == "FUTURE_CLOCK":
        state = "runtime timestamp is in the future"
    elif state is None:
        state = "runtime snapshot received"
    summary_fields = (
        "active_executor_count",
        "lifecycle_executor_count",
        "positions_held_count",
        "controller_count",
        "pnl_available",
        "net_pnl_quote",
        "realized_pnl_quote",
        "unrealized_pnl_quote",
        "fees_quote",
    )
    safe_summary = {}
    safe_summary = {
        key: summary[key]
        for key in summary_fields
        if key in summary
        and isinstance(summary[key], (str, int, float, bool, type(None)))
    }
    shown: dict[str, Any] = {"summary": safe_summary}
    for key in ("active_orders_count", "active_orders_status"):
        value = status.get(key)
        if isinstance(value, (str, int, float, bool, type(None))):
            shown[key] = value
    parity = payload.get("runtime_parity")
    if isinstance(parity, dict):
        parity_summary = {}
        for key in ("pnl_comparison_status", "runtime_status_available"):
            value = parity.get(key)
            if isinstance(value, (str, int, float, bool, type(None))):
                parity_summary[key] = value
        mismatches = parity.get("mismatches")
        if isinstance(mismatches, list):
            parity_summary["mismatch_count"] = len(mismatches)
            fields = []
            for item in mismatches:
                if isinstance(item, str):
                    fields.append(item[:80])
                elif isinstance(item, dict):
                    field = item.get("field") or item.get("key") or item.get("path")
                    if isinstance(field, str):
                        fields.append(field[:80])
            if fields:
                parity_summary["mismatch_fields"] = fields[:8]
        shown["runtime_parity"] = parity_summary
    if isinstance(payload.get("execution_mode"), str):
        shown["execution_mode"] = payload["execution_mode"]
    projection = payload.get("api_projection")
    if isinstance(projection, dict):
        shown["data_owner"] = {
            key: projection[key]
            for key in ("bot_name", "source", "execution_owner")
            if key in projection
        }
    freshness_detail = (
        f"Source freshness: {freshness_state}, runtime_status.updated_at ({age_text})"
    )
    return f"State: {state or 'status received'}\n{freshness_detail}\n{_render_value(shown, max_chars=750)}"


def _split_response(text: str) -> list[str]:
    chunks: list[str] = []
    remaining = text
    while len(remaining) > MAX_TELEGRAM_TEXT:
        split_at = remaining.rfind("\n", 0, MAX_TELEGRAM_TEXT)
        if split_at < 500:
            split_at = MAX_TELEGRAM_TEXT
        chunks.append(remaining[:split_at])
        remaining = remaining[split_at:].lstrip("\n")
    if remaining:
        chunks.append(remaining)
    return chunks


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

    def _select_sources(self, target: str) -> list[BotSource] | None:
        if target == "all":
            return list(self.config.bots)
        return [source for source in self.config.bots if source.id == target]

    async def _read_source(
        self, client: NativeReadClient, source: BotSource, command: str
    ) -> str:
        try:
            if command == "status":
                data = await client.get(source, "status")
                _validate_owner_identity(data, source)
                body = _render_status(data)
                return f"{source.label} [{source.id}]\n{body}"
            data = await client.get(source, command)
            _validate_owner_identity(data, source, require_rows=True)
            return f"{source.label} [{source.id}]\n{_render_rows(command, data)}"
        except NativeReadError as exc:
            return f"{source.label} [{source.id}]\nUnavailable: {exc}"
        except Exception as exc:  # source isolation; never echo response or URL
            logger.warning(
                "Fleet read failed for source=%s command=%s error=%s",
                source.id,
                command,
                type(exc).__name__,
            )
            return f"{source.label} [{source.id}]\nUnavailable: unexpected read error"

    async def execute(self, command: str, target: str) -> str:
        if command in {"start", "help"}:
            return "Read-only fleet commands:\n/status [all|bot]\n/orders [all|bot]\n/fills [all|bot]\n/executors [all|bot]"
        if command not in COMMANDS:
            return "Supported commands: /status, /orders, /fills, /executors"
        sources = self._select_sources(target)
        if not sources:
            known = ", ".join(source.id for source in self.config.bots)
            return f"Unknown source. Available: all, {known}"
        # Preserve one section for every configured source, including failed APIs.
        async with NativeReadClient(self.config) as client:
            sections = await asyncio.gather(
                *(self._read_source(client, source, command) for source in sources)
            )
        return "\n\n".join(sections)

    async def process_update(self, update: Any) -> None:
        message = getattr(update, "message", None)
        if message is None:
            return
        user = getattr(message, "from_user", None)
        chat = getattr(message, "chat", None)
        user_id = getattr(user, "id", None)
        chat_id = getattr(chat, "id", None)
        chat_type = getattr(chat, "type", None)
        if (
            user_id not in self.config.authorized_user_ids
            or chat_type != "private"
            or chat_id != user_id
        ):
            return
        parsed = parse_command(getattr(message, "text", None))
        if parsed is None:
            return
        response = await self.execute(*parsed)
        for chunk in _split_response(response):
            await self._bot.send_message(chat_id=chat_id, text=chunk)
        self.last_successful_command = time.time()
        self.state.heartbeat(
            status="running",
            last_poll_at=self.last_poll_at,
            last_successful_poll_at=self.last_successful_poll_at,
            last_successful_command=self.last_successful_command,
        )

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
        try:
            while not self._stopping.is_set():
                try:
                    if not initialized:
                        await self._bot.initialize()
                        initialized = True
                    self.last_poll_at = time.time()
                    updates = await self._bot.get_updates(
                        offset=offset,
                        timeout=self.config.poll_timeout_seconds,
                        allowed_updates=["message"],
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
