"""SQLite persistence for push: the shared device registry and the worker's outbox.

Two files, two owners, on purpose:

``registry.sqlite``  shared. The web routes write devices and test requests; the
    worker writes the heartbeat, deactivates dead tokens and finishes requests.
    Writes are tiny and short. It uses the default rollback journal rather than
    WAL because WAL needs shared memory between processes, which two containers
    sharing a bind mount do not reliably have. Every connection sets a busy
    timeout and writes with BEGIN IMMEDIATE.

``outbox.sqlite``    worker only, guarded by an exclusive file lock (same
    discipline as the Telegram worker). Dedup keys, source activation times,
    events, per-device delivery state and watched conditions. WAL.

Dedup (``seen``) rows are never pruned: a fill that fell out of the retention
window while still inside the native 1000-row history would otherwise announce
again. They are ~100 bytes each.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import sqlite3
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Sequence
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from condor.push.events import (
    ALERT_CLASSES,
    ALWAYS_ON_CLASSES,
    AlertEvent,
    Condition,
    default_classes,
)

PLATFORMS = ("iphone", "watch")
MAX_DEVICES_PER_USER = 8
TOKEN = re.compile(r"[0-9a-f]{32,200}")
HHMM = re.compile(r"([01][0-9]|2[0-3]):[0-5][0-9]")
MAX_ATTEMPTS = 8
TEST_COOLDOWN_SECONDS = 10.0
MAX_PENDING_TESTS = 4


class RegistryError(ValueError):
    """A registration or request was refused. The message is safe to show the caller."""


# --------------------------------------------------------------------------- devices


def device_id_for(token: str) -> str:
    return hashlib.sha256(token.encode("ascii")).hexdigest()[:32]


def normalize_token(value: Any) -> str:
    token = value.strip().lower() if isinstance(value, str) else ""
    if not TOKEN.fullmatch(token):
        raise RegistryError("device token must be 32-200 hexadecimal characters")
    return token


def normalize_classes(raw: Any) -> dict[str, bool]:
    if not isinstance(raw, Mapping):
        raise RegistryError("classes must be an object of class id to true/false")
    out: dict[str, bool] = {}
    for name, value in raw.items():
        if name not in ALERT_CLASSES or type(value) is not bool:
            raise RegistryError(
                f"unknown alert class or non-boolean value: {str(name)[:40]}"
            )
        out[name] = value
    return out


def normalize_quiet(raw: Any) -> dict[str, Any]:
    """Quiet hours: during the window alerts arrive silently (passive, no sound).

    Critical alerts bypass it unless ``bypass_critical`` is false.
    """
    if not isinstance(raw, Mapping) or set(raw) - {
        "enabled",
        "start",
        "end",
        "tz",
        "bypass_critical",
    }:
        raise RegistryError("quiet_hours has unsupported fields")
    enabled = raw.get("enabled", False)
    bypass = raw.get("bypass_critical", True)
    if type(enabled) is not bool or type(bypass) is not bool:
        raise RegistryError(
            "quiet_hours.enabled and bypass_critical must be true or false"
        )
    start, end, tz = (
        raw.get("start", "22:00"),
        raw.get("end", "07:00"),
        raw.get("tz", "UTC"),
    )
    if not (
        isinstance(start, str)
        and HHMM.fullmatch(start)
        and isinstance(end, str)
        and HHMM.fullmatch(end)
    ):
        raise RegistryError("quiet_hours start and end must be HH:MM")
    if enabled and start == end:
        raise RegistryError("quiet_hours start and end must differ")
    if not isinstance(tz, str) or len(tz) > 64:
        raise RegistryError("quiet_hours.tz must be an IANA time zone")
    try:
        ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError, OSError):
        raise RegistryError("quiet_hours.tz is not a known time zone") from None
    return {
        "enabled": enabled,
        "start": start,
        "end": end,
        "tz": tz,
        "bypass_critical": bypass,
    }


def in_quiet_hours(quiet: Mapping[str, Any], now: float) -> bool:
    if not quiet.get("enabled"):
        return False
    try:
        local = datetime.fromtimestamp(now, ZoneInfo(quiet.get("tz", "UTC")))
        minute = local.hour * 60 + local.minute
        start = int(quiet["start"][:2]) * 60 + int(quiet["start"][3:])
        end = int(quiet["end"][:2]) * 60 + int(quiet["end"][3:])
    except (ZoneInfoNotFoundError, ValueError, OSError, KeyError, TypeError):
        return False  # an unreadable window must not silence alerts
    return start <= minute < end if start < end else minute >= start or minute < end


@dataclass(frozen=True)
class Device:
    device_id: str
    user_id: int
    token: str
    platform: str
    bundle_id: str
    environment: str
    app_version: str
    classes: Mapping[str, bool]  # overrides only; see enabled_classes()
    quiet: Mapping[str, Any]
    active: bool
    registered_at: float
    last_seen: float
    recipient_server_id: str
    deactivated_reason: str | None = None

    def enabled_classes(self) -> dict[str, bool]:
        merged = {**default_classes(), **self.classes}
        for name in ALWAYS_ON_CLASSES:
            merged[name] = True
        return merged

    def class_enabled(self, cls: str) -> bool:
        return self.enabled_classes().get(cls, False)

    def public(self) -> dict[str, Any]:
        """A device as the app sees it. The token is never returned, only its tail."""
        return {
            "device_id": self.device_id,
            "recipient_server_id": self.recipient_server_id,
            "platform": self.platform,
            "bundle_id": self.bundle_id,
            "environment": self.environment,
            "app_version": self.app_version,
            "token_suffix": self.token[-6:],
            "classes": self.enabled_classes(),
            "quiet_hours": dict(self.quiet),
            "active": self.active,
            "deactivated_reason": self.deactivated_reason,
            "registered_at": self.registered_at,
            "last_seen": self.last_seen,
        }


def _device(row: sqlite3.Row, recipient_server_id: str) -> Device:
    return Device(
        device_id=row["device_id"],
        user_id=row["user_id"],
        token=row["token"],
        platform=row["platform"],
        bundle_id=row["bundle_id"],
        environment=row["environment"],
        app_version=row["app_version"],
        classes=json.loads(row["classes"]),
        quiet=json.loads(row["quiet"]),
        active=bool(row["active"]),
        registered_at=row["registered_at"],
        last_seen=row["last_seen"],
        recipient_server_id=recipient_server_id,
        deactivated_reason=row["deactivated_reason"],
    )


def _open(path: Path, *, wal: bool) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    existed = path.exists()
    db = sqlite3.connect(path, timeout=10, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout=10000")
    db.execute("PRAGMA journal_mode=" + ("WAL" if wal else "DELETE"))
    if not existed:
        os.chmod(path, 0o600)
    return db


@contextmanager
def _transaction(db: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    db.execute("BEGIN IMMEDIATE")
    try:
        yield db
    except BaseException:
        db.execute("ROLLBACK")
        raise
    else:
        db.execute("COMMIT")


class Registry:
    """Devices, test requests and the worker heartbeat. Safe for two processes."""

    def __init__(self, path: Path | str):
        self.path = Path(path)
        db = self._connect()
        try:
            for statement in (
                """CREATE TABLE IF NOT EXISTS devices (
                    device_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, token TEXT NOT NULL UNIQUE,
                    platform TEXT NOT NULL, bundle_id TEXT NOT NULL, environment TEXT NOT NULL,
                    app_version TEXT NOT NULL, classes TEXT NOT NULL, quiet TEXT NOT NULL,
                    active INTEGER NOT NULL DEFAULT 1, registered_at REAL NOT NULL, last_seen REAL NOT NULL,
                    deactivated_reason TEXT)""",
                "CREATE INDEX IF NOT EXISTS devices_user ON devices(user_id)",
                """CREATE TABLE IF NOT EXISTS push_requests (
                    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL,
                    device_ids TEXT NOT NULL, state TEXT NOT NULL, result TEXT,
                    created REAL NOT NULL, updated REAL NOT NULL)""",
                "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            ):
                db.execute(statement)
            with _transaction(db):
                db.execute(
                    "INSERT OR IGNORE INTO meta(key,value) VALUES ('recipient_server_id',?)",
                    (uuid.uuid4().hex,),
                )
                server_id = db.execute(
                    "SELECT value FROM meta WHERE key='recipient_server_id'"
                ).fetchone()[0]
                if not isinstance(server_id, str) or not re.fullmatch(
                    r"[0-9a-f]{32}", server_id
                ):
                    raise RegistryError(
                        "push registry installation identity is invalid"
                    )
                self.recipient_server_id = server_id
        finally:
            db.close()

    def _connect(self) -> sqlite3.Connection:
        return _open(self.path, wal=False)

    # ---- devices

    def upsert_device(
        self,
        *,
        user_id: int,
        token: str,
        platform: str,
        bundle_id: str,
        environment: str,
        app_version: str,
        classes: Mapping[str, bool] | None = None,
        quiet: Mapping[str, Any] | None = None,
        now: float | None = None,
    ) -> Device:
        now = time.time() if now is None else now
        token = normalize_token(token)
        if platform not in PLATFORMS:
            raise RegistryError("platform must be iphone or watch")
        version = re.sub(r"[^0-9A-Za-z._+-]", "", str(app_version))[:32]
        device_id = device_id_for(token)
        db = self._connect()
        try:
            with _transaction(db):
                row = db.execute(
                    "SELECT * FROM devices WHERE token=?", (token,)
                ).fetchone()
                if row is None:
                    count = db.execute(
                        "SELECT COUNT(*) FROM devices WHERE user_id=?", (user_id,)
                    ).fetchone()[0]
                    if count >= MAX_DEVICES_PER_USER:
                        raise RegistryError(
                            "too many registered devices; unregister one first"
                        )
                    db.execute(
                        "INSERT INTO devices VALUES (?,?,?,?,?,?,?,?,?,1,?,?,NULL)",
                        (
                            device_id,
                            user_id,
                            token,
                            platform,
                            bundle_id,
                            environment,
                            version,
                            json.dumps(dict(classes or {}), sort_keys=True),
                            json.dumps(
                                dict(quiet or normalize_quiet({})), sort_keys=True
                            ),
                            now,
                            now,
                        ),
                    )
                else:
                    same_owner = row["user_id"] == user_id
                    if not same_owner:
                        count = db.execute(
                            "SELECT COUNT(*) FROM devices WHERE user_id=?", (user_id,)
                        ).fetchone()[0]
                        if count >= MAX_DEVICES_PER_USER:
                            raise RegistryError(
                                "too many registered devices; unregister one first"
                            )
                    saved_classes = json.loads(row["classes"]) if same_owner else {}
                    saved_quiet = (
                        json.loads(row["quiet"]) if same_owner else normalize_quiet({})
                    )
                    db.execute(
                        """UPDATE devices SET user_id=?, platform=?, bundle_id=?, environment=?,
                           app_version=?, classes=?, quiet=?, active=1, registered_at=?, last_seen=?,
                           deactivated_reason=NULL WHERE token=?""",
                        (
                            user_id,
                            platform,
                            bundle_id,
                            environment,
                            version,
                            json.dumps(
                                dict(classes if classes is not None else saved_classes),
                                sort_keys=True,
                            ),
                            json.dumps(
                                dict(quiet if quiet is not None else saved_quiet),
                                sort_keys=True,
                            ),
                            now,
                            now,
                            token,
                        ),
                    )
                device = _device(
                    db.execute(
                        "SELECT * FROM devices WHERE token=?", (token,)
                    ).fetchone(),
                    self.recipient_server_id,
                )
            return device
        finally:
            db.close()

    def get_device(self, device_id: str) -> Device | None:
        db = self._connect()
        try:
            row = db.execute(
                "SELECT * FROM devices WHERE device_id=?", (device_id,)
            ).fetchone()
            return None if row is None else _device(row, self.recipient_server_id)
        finally:
            db.close()

    def devices_for_user(self, user_id: int) -> list[Device]:
        db = self._connect()
        try:
            rows = db.execute(
                "SELECT * FROM devices WHERE user_id=? ORDER BY registered_at, device_id",
                (user_id,),
            ).fetchall()
            return [_device(row, self.recipient_server_id) for row in rows]
        finally:
            db.close()

    def active_devices(self) -> list[Device]:
        db = self._connect()
        try:
            rows = db.execute(
                "SELECT * FROM devices WHERE active=1 ORDER BY device_id"
            ).fetchall()
            return [_device(row, self.recipient_server_id) for row in rows]
        finally:
            db.close()

    def delete_device(self, user_id: int, device_id: str) -> bool:
        db = self._connect()
        try:
            with _transaction(db):
                return (
                    db.execute(
                        "DELETE FROM devices WHERE device_id=? AND user_id=?",
                        (device_id, user_id),
                    ).rowcount
                    > 0
                )
        finally:
            db.close()

    def deactivate(
        self,
        device_id: str,
        reason: str,
        *,
        apns_timestamp: float | None = None,
        expected: Device | None = None,
    ) -> bool:
        """Stop sending to a token Apple reports dead.

        Apple's guidance for 410 Unregistered: deactivate only if the token was
        not re-registered after ``apns_timestamp``; a fresh registration wins.
        """
        db = self._connect()
        try:
            with _transaction(db):
                if expected is not None and expected.device_id != device_id:
                    return False
                predicates = ["device_id=?", "active=1"]
                values: list[Any] = [reason[:60], device_id]
                if expected is not None:
                    predicates.extend(
                        (
                            "user_id=?",
                            "token=?",
                            "registered_at=?",
                            "environment=?",
                            "bundle_id=?",
                            "EXISTS (SELECT 1 FROM meta WHERE key='recipient_server_id' AND value=?)",
                        )
                    )
                    values.extend(
                        (
                            expected.user_id,
                            expected.token,
                            expected.registered_at,
                            expected.environment,
                            expected.bundle_id,
                            expected.recipient_server_id,
                        )
                    )
                if apns_timestamp is not None:
                    predicates.append("registered_at<=?")
                    values.append(apns_timestamp)
                return (
                    db.execute(
                        "UPDATE devices SET active=0, deactivated_reason=? WHERE "
                        + " AND ".join(predicates),
                        values,
                    ).rowcount
                    > 0
                )
        finally:
            db.close()

    # ---- test requests

    def add_test_request(
        self, user_id: int, device_ids: Sequence[str], *, now: float | None = None
    ) -> str:
        now = time.time() if now is None else now
        db = self._connect()
        try:
            with _transaction(db):
                recent = db.execute(
                    "SELECT MAX(created) FROM push_requests WHERE user_id=? AND kind='test'",
                    (user_id,),
                ).fetchone()[0]
                if recent is not None and now - recent < TEST_COOLDOWN_SECONDS:
                    raise RegistryError("wait a few seconds between test alerts")
                pending = db.execute(
                    "SELECT COUNT(*) FROM push_requests WHERE user_id=? AND state IN ('pending','queued')",
                    (user_id,),
                ).fetchone()[0]
                if pending >= MAX_PENDING_TESTS:
                    raise RegistryError(
                        "too many test alerts are waiting for the push worker"
                    )
                request_id = hashlib.sha256(
                    f"{user_id}:{now}:{os.urandom(8).hex()}".encode()
                ).hexdigest()[:24]
                db.execute(
                    "INSERT INTO push_requests VALUES (?,?,?,?,?,NULL,?,?)",
                    (
                        request_id,
                        user_id,
                        "test",
                        json.dumps(sorted(device_ids)),
                        "pending",
                        now,
                        now,
                    ),
                )
            return request_id
        finally:
            db.close()

    def requests(self, state: str, *, limit: int = 20) -> list[dict[str, Any]]:
        db = self._connect()
        try:
            rows = db.execute(
                "SELECT * FROM push_requests WHERE state=? ORDER BY created LIMIT ?",
                (state, limit),
            ).fetchall()
            return [self._request(row) for row in rows]
        finally:
            db.close()

    def get_request(self, user_id: int, request_id: str) -> dict[str, Any] | None:
        db = self._connect()
        try:
            row = db.execute(
                "SELECT * FROM push_requests WHERE id=? AND user_id=?",
                (request_id, user_id),
            ).fetchone()
            return None if row is None else self._request(row)
        finally:
            db.close()

    @staticmethod
    def _request(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "user_id": row["user_id"],
            "kind": row["kind"],
            "device_ids": json.loads(row["device_ids"]),
            "state": row["state"],
            "result": json.loads(row["result"]) if row["result"] else None,
            "created": row["created"],
            "updated": row["updated"],
        }

    def set_request(
        self,
        request_id: str,
        state: str,
        result: Any = None,
        *,
        now: float | None = None,
    ) -> None:
        now = time.time() if now is None else now
        db = self._connect()
        try:
            with _transaction(db):
                db.execute(
                    "UPDATE push_requests SET state=?, result=COALESCE(?, result), updated=? WHERE id=?",
                    (
                        state,
                        None if result is None else json.dumps(result, sort_keys=True),
                        now,
                        request_id,
                    ),
                )
        finally:
            db.close()

    def prune_requests(self, older_than: float) -> None:
        db = self._connect()
        try:
            with _transaction(db):
                db.execute(
                    "DELETE FROM push_requests WHERE state NOT IN ('pending','queued') AND updated < ?",
                    (older_than,),
                )
        finally:
            db.close()

    # ---- worker heartbeat

    def set_meta(self, key: str, value: Any) -> None:
        db = self._connect()
        try:
            with _transaction(db):
                db.execute(
                    "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (key, json.dumps(value, sort_keys=True)),
                )
        finally:
            db.close()

    def get_meta(self, key: str) -> Any:
        db = self._connect()
        try:
            row = db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
            return None if row is None else json.loads(row["value"])
        finally:
            db.close()


# --------------------------------------------------------------------------- outbox


@dataclass(frozen=True)
class DeliveryRow:
    event: AlertEvent
    device_id: str
    attempts: int
    created: float
    recipient_user_id: int | None
    recipient_server_id: str | None


def backoff_seconds(attempts: int) -> float:
    """Delay before the next try after ``attempts`` failures: 15s, 30s, ... capped at 15 minutes."""
    return float(min(900, 15 * 2 ** max(attempts - 1, 0)))


class Outbox:
    """Worker-owned dedup, activation and per-device delivery state."""

    def __init__(self, path: Path | str):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._lock_file = open(str(self.path) + ".lock", "a+")
        try:
            fcntl.flock(self._lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            self._lock_file.close()
            raise RegistryError("another push worker owns this state") from exc
        self.db = _open(self.path, wal=True)
        for statement in (
            "CREATE TABLE IF NOT EXISTS sources (source TEXT PRIMARY KEY, started REAL NOT NULL)",
            "CREATE TABLE IF NOT EXISTS seen (source TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY(source, key))",
            "CREATE TABLE IF NOT EXISTS primed (source TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY(source, kind))",
            """CREATE TABLE IF NOT EXISTS events (
                id TEXT PRIMARY KEY, cls TEXT NOT NULL, severity TEXT NOT NULL, payload TEXT NOT NULL,
                occurred REAL NOT NULL, created REAL NOT NULL)""",
            """CREATE TABLE IF NOT EXISTS deliveries (
                event_id TEXT NOT NULL, device_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
                attempts INTEGER NOT NULL DEFAULT 0, next_attempt REAL NOT NULL, last_error TEXT,
                apns_id TEXT, sent_at REAL, created REAL NOT NULL, updated REAL NOT NULL,
                recipient_user_id INTEGER, recipient_server_id TEXT,
                PRIMARY KEY(event_id, device_id))""",
            "CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(state, next_attempt)",
            "CREATE TABLE IF NOT EXISTS conditions (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        ):
            self.db.execute(statement)
        # Existing queued deliveries have no trustworthy recipient owner. Keep
        # them unbound so the deliverer cancels them rather than sending them
        # to whoever currently owns the same APNs token.
        with _transaction(self.db):
            columns = {
                row["name"] for row in self.db.execute("PRAGMA table_info(deliveries)")
            }
            if "recipient_user_id" not in columns:
                self.db.execute(
                    "ALTER TABLE deliveries ADD COLUMN recipient_user_id INTEGER"
                )
            if "recipient_server_id" not in columns:
                self.db.execute(
                    "ALTER TABLE deliveries ADD COLUMN recipient_server_id TEXT"
                )

    # ---- activation and dedup

    def start_source(self, source: str, now: float) -> None:
        with _transaction(self.db):
            self.db.execute("INSERT OR IGNORE INTO sources VALUES (?,?)", (source, now))

    def started(self, source: str) -> float | None:
        row = self.db.execute(
            "SELECT started FROM sources WHERE source=?", (source,)
        ).fetchone()
        return None if row is None else row[0]

    def is_seen(self, source: str, key: str) -> bool:
        return (
            self.db.execute(
                "SELECT 1 FROM seen WHERE source=? AND key=?", (source, key)
            ).fetchone()
            is not None
        )

    def seen_checker(self, source: str):
        return lambda key: self.is_seen(source, key)

    def is_primed(self, source: str, kind: str) -> bool:
        return (
            self.db.execute(
                "SELECT 1 FROM primed WHERE source=? AND kind=?", (source, kind)
            ).fetchone()
            is not None
        )

    # ---- commit

    def commit(
        self,
        source: str,
        *,
        seen: Iterable[str] = (),
        events: Sequence[AlertEvent] = (),
        devices: Sequence[Device] = (),
        primed: str | None = None,
        conditions: Mapping[str, Condition | None] | None = None,
        now: float | None = None,
    ) -> int:
        """Record dedup keys, events and their per-device deliveries atomically.

        Returns the number of delivery rows created. An event id that already
        exists creates nothing, so a replayed commit is harmless.
        """
        now = time.time() if now is None else now
        created = 0
        with _transaction(self.db):
            for key in seen:
                self.db.execute(
                    "INSERT OR IGNORE INTO seen VALUES (?,?)", (source, key)
                )
            if primed is not None:
                self.db.execute(
                    "INSERT OR IGNORE INTO primed VALUES (?,?)", (source, primed)
                )
            for key, state in (conditions or {}).items():
                if state is None:
                    self.db.execute("DELETE FROM conditions WHERE key=?", (key,))
                else:
                    self.db.execute(
                        "INSERT INTO conditions(key,value) VALUES(?,?) "
                        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                        (key, json.dumps(state.to_dict(), sort_keys=True)),
                    )
            for event in events:
                inserted = self.db.execute(
                    "INSERT OR IGNORE INTO events VALUES (?,?,?,?,?,?)",
                    (
                        event.id,
                        event.cls,
                        event.severity,
                        json.dumps(event.to_dict(), sort_keys=True),
                        event.occurred_at,
                        now,
                    ),
                ).rowcount
                if not inserted:
                    continue
                for device in devices:
                    if device.active and device.class_enabled(event.cls):
                        created += self.db.execute(
                            "INSERT OR IGNORE INTO deliveries(event_id,device_id,next_attempt,created,updated,recipient_user_id,recipient_server_id) "
                            "VALUES (?,?,?,?,?,?,?)",
                            (
                                event.id,
                                device.device_id,
                                now,
                                now,
                                now,
                                device.user_id,
                                device.recipient_server_id,
                            ),
                        ).rowcount
        return created

    def conditions(self) -> dict[str, Condition]:
        return {
            row["key"]: Condition.from_dict(json.loads(row["value"]))
            for row in self.db.execute("SELECT key, value FROM conditions")
        }

    # ---- delivery state

    def due(self, now: float, limit: int = 100) -> list[DeliveryRow]:
        rows = self.db.execute(
            """SELECT d.event_id, d.device_id, d.attempts, d.created,
                      d.recipient_user_id, d.recipient_server_id, e.payload
               FROM deliveries d JOIN events e ON e.id = d.event_id
               WHERE d.state='pending' AND d.next_attempt <= ?
               ORDER BY d.created, e.occurred, d.device_id LIMIT ?""",
            (now, limit),
        ).fetchall()
        return [
            DeliveryRow(
                AlertEvent.from_dict(json.loads(r["payload"])),
                r["device_id"],
                r["attempts"],
                r["created"],
                r["recipient_user_id"],
                r["recipient_server_id"],
            )
            for r in rows
        ]

    def mark(
        self,
        event_id: str,
        device_id: str,
        state: str,
        now: float,
        *,
        error: str | None = None,
        apns_id: str | None = None,
        retry_at: float | None = None,
        attempt: bool | None = None,
    ) -> None:
        """Move one delivery to ``state``; ``pending`` with ``retry_at`` schedules a retry.

        ``attempt`` says whether this counts toward MAX_ATTEMPTS; by default sent,
        failed and dead do, and so does a scheduled retry.
        """
        if attempt is None:
            attempt = state in ("sent", "failed", "dead") or (
                state == "pending" and retry_at is not None
            )
        with _transaction(self.db):
            self.db.execute(
                """UPDATE deliveries SET state=?, attempts=attempts+?, last_error=?,
                   apns_id=COALESCE(?, apns_id), sent_at=CASE WHEN ?='sent' THEN ? ELSE sent_at END,
                   next_attempt=COALESCE(?, next_attempt), updated=?
                   WHERE event_id=? AND device_id=?""",
                (
                    state,
                    1 if attempt else 0,
                    error,
                    apns_id,
                    state,
                    now,
                    retry_at,
                    now,
                    event_id,
                    device_id,
                ),
            )

    def deliveries_for(self, event_id: str) -> list[dict[str, Any]]:
        return [
            dict(row)
            for row in self.db.execute(
                "SELECT device_id, state, attempts, last_error FROM deliveries WHERE event_id=? ORDER BY device_id",
                (event_id,),
            )
        ]

    def counts(self) -> dict[str, int]:
        return {
            row[0]: row[1]
            for row in self.db.execute(
                "SELECT state, COUNT(*) FROM deliveries GROUP BY state"
            )
        }

    def prune(self, now: float, retention_seconds: float) -> int:
        """Drop finished deliveries and orphaned events past retention. Dedup rows stay."""
        cutoff = now - retention_seconds
        with _transaction(self.db):
            removed = self.db.execute(
                "DELETE FROM deliveries WHERE state != 'pending' AND updated < ?",
                (cutoff,),
            ).rowcount
            self.db.execute(
                "DELETE FROM events WHERE created < ? AND id NOT IN (SELECT event_id FROM deliveries)",
                (cutoff,),
            )
        return removed

    # ---- small state

    def get_kv(self, key: str) -> Any:
        row = self.db.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
        return None if row is None else json.loads(row[0])

    def set_kv(self, key: str, value: Any) -> None:
        with _transaction(self.db):
            self.db.execute(
                "INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, json.dumps(value, sort_keys=True)),
            )

    def close(self) -> None:
        self.db.close()
        fcntl.flock(self._lock_file.fileno(), fcntl.LOCK_UN)
        self._lock_file.close()


def delivery_report(
    outbox_path: Path | str, *, now: float, days: int = 14
) -> dict[str, Any]:
    """Counts for the Telegram cut-over comparison, read through a read-only connection.

    Opened with ``mode=ro`` so it never takes the worker's lock or writes. Run it
    inside the push container (the same filesystem that owns the WAL files).
    """
    db = sqlite3.connect(f"file:{outbox_path}?mode=ro", uri=True, timeout=10)
    try:
        since = now - days * 86400
        by_day: dict[str, dict[str, dict[str, int]]] = {}
        for day, cls, state, count in db.execute(
            """SELECT date(e.occurred, 'unixepoch'), e.cls, d.state, COUNT(*)
               FROM deliveries d JOIN events e ON e.id = d.event_id
               WHERE e.occurred >= ? GROUP BY 1, 2, 3 ORDER BY 1, 2, 3""",
            (since,),
        ):
            by_day.setdefault(day, {}).setdefault(cls, {})[state] = count
        last_sent = db.execute(
            "SELECT MAX(sent_at) FROM deliveries WHERE state='sent'"
        ).fetchone()[0]
        return {
            "since": since,
            "last_sent_at": last_sent,
            "states": {
                state: n
                for state, n in db.execute(
                    "SELECT state, COUNT(*) FROM deliveries GROUP BY state"
                )
            },
            "by_utc_day": by_day,
        }
    finally:
        db.close()
