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
import json
import logging
import os
import re
import sqlite3
import sys
import time
from datetime import datetime, timezone
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import quote, urlsplit, parse_qsl, urlencode, urlunsplit

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
class WorkerConfig:
    authorized_user_ids: frozenset[int]
    bots: tuple[BotSource, ...]
    request_timeout_seconds: float = DEFAULT_REQUEST_TIMEOUT
    poll_timeout_seconds: int = DEFAULT_POLL_TIMEOUT
    trade_alerts: bool = False


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
        currency = row.get("quote_currency", "quote")
        if not isinstance(currency, str) or not re.fullmatch(
            r"[A-Za-z0-9]{1,16}", currency
        ):
            raise ConfigError("quote_currency must be an asset label")
        bots.append(
            BotSource(
                identity,
                label.strip(),
                f"{parsed.scheme}://{parsed.netloc}",
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
    return WorkerConfig(
        frozenset(authorized), tuple(bots), request_timeout, poll_timeout, trade_alerts
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
        self.trade_alerts = TradeAlerts(self.state.db) if config.trade_alerts else None
        if self.trade_alerts:
            for source in config.bots:
                self.trade_alerts.start(source_key(source), time.time())

    def _select_sources(self, target: str) -> list[BotSource] | None:
        if target == "all":
            return list(self.config.bots)
        return [source for source in self.config.bots if source.id == target]

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
        if command in {"start", "help"} or command not in COMMANDS:
            return [("all", views.View(views.help_text(self.config.bots)))]
        sources = self._select_sources(target)
        if not sources:
            return [
                (
                    "all",
                    views.View(
                        "⚠️ <b>Unknown source</b>\n\n"
                        + views.help_text(self.config.bots)
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
        return [(source.id, message) for source, message in zip(sources, result)]

    async def execute(self, command: str, target: str) -> str:
        return "\n\n".join(
            message.text for _, message in await self.render(command, target)
        )

    def keyboard(self, command: str, target: str, page: int = 0, pages: int = 1):
        def button(label, action, target_id=target, index=0):
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
            if parsed is None or (
                parsed[1] != "all" and not self._select_sources(parsed[1])
            ):
                try:
                    await self._bot.answer_callback_query(
                        callback_query_id=query.id,
                        text="This button is no longer available. Send /help.",
                    )
                except BadRequest:
                    logger.info("Ignoring expired unsupported callback")
                return
            command, target, page = parsed
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
                    self.state._set("trade_alert_error:" + key, type(exc).__name__)
                    logger.warning(
                        "Trade alert read held source=%s error=%s",
                        source.id,
                        type(exc).__name__,
                    )
        for identity, key, recipient, rows in self.trade_alerts.pending(
            self.config.authorized_user_ids, by_key
        ):
            source = by_key.get(key)
            if source is None:
                continue
            await self._bot.send_message(
                chat_id=recipient,
                text=render_fill_alert(source.label, rows),
                parse_mode="HTML",
                reply_markup=self.keyboard("fills", source.id),
            )
            # Telegram has no idempotency key: ambiguous network/crash delivery can
            # repeat delivery. Persist only confirmed success, never silently lose it.
            self.trade_alerts.sent(identity)
            self.state._set("trade_alert_last_sent", str(time.time()))
            logger.info(
                "Trade alert delivered source=%s fills=%d", source.id, len(rows)
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
