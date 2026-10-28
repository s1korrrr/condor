"""Small SQLite journal owned only by the isolated V5 dashboard."""

from __future__ import annotations

import fcntl
import json
import os
import sqlite3
import stat
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any

MAX_ROWS = 200
MAX_DATABASE_BYTES = 32 * 1024 * 1024
MAX_TICKS = 20_000
REPORT_RESERVATION_BYTES = 24 * 1024
MAX_RESERVATION_BYTES = 3 * 1024 * 1024


class StateCapacityError(RuntimeError):
    """V5 journal has reached a bounded row or storage limit."""


class RuntimeInUseError(RuntimeError):
    """Another V5 process already owns this runtime root."""


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


class WorkspaceState:
    def __init__(
        self, runtime_root: Path, *, clock=lambda: time.time_ns() // 1_000_000
    ):
        self.root = runtime_root.resolve()
        self.path = self.root / "workspace.sqlite3"
        self.clock = clock
        self.root.mkdir(parents=True, exist_ok=True)
        os.chmod(self.root, 0o700)
        if self.root.is_symlink():
            raise ValueError("V5 runtime root may not be a symlink")
        self._lock_fd = os.open(
            self.root / "workspace.lock",
            os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0),
            0o600,
        )
        if not stat.S_ISREG(os.fstat(self._lock_fd).st_mode):
            os.close(self._lock_fd)
            raise ValueError("V5 runtime lock must be a regular file")
        try:
            fcntl.flock(self._lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            os.close(self._lock_fd)
            self._lock_fd = None
            raise RuntimeInUseError("V5 runtime is already active") from exc
        if self.path.is_symlink():
            self.close()
            raise ValueError("V5 state database may not be a symlink")
        try:
            self._initialize()
            os.chmod(self.path, 0o600)
        except Exception:
            self.close()
            raise

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=2.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA busy_timeout=2000")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    @contextmanager
    def _connection(self):
        connection = self._connect()
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def close(self) -> None:
        fd = getattr(self, "_lock_fd", None)
        if fd is not None:
            self._lock_fd = None
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            finally:
                os.close(fd)

    def _initialize(self) -> None:
        with self._connection() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL,
                    loop_id TEXT,
                    kind TEXT NOT NULL,
                    status TEXT NOT NULL,
                    started_at_ms INTEGER NOT NULL,
                    finished_at_ms INTEGER,
                    summary TEXT NOT NULL,
                    effect TEXT NOT NULL CHECK(effect = 'NONE')
                );
                CREATE TABLE IF NOT EXISTS ticks (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                    status TEXT NOT NULL,
                    at_ms INTEGER NOT NULL,
                    summary TEXT NOT NULL,
                    evidence_refs TEXT NOT NULL,
                    report TEXT,
                    error TEXT
                );
                CREATE INDEX IF NOT EXISTS ticks_session_idx ON ticks(session_id, at_ms);
                CREATE UNIQUE INDEX IF NOT EXISTS one_active_report_loop
                    ON sessions(kind) WHERE kind='loop' AND status='RUNNING';
                CREATE TABLE IF NOT EXISTS reservations (
                    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
                    bytes INTEGER NOT NULL CHECK(bytes >= 0)
                );
                """
            )
            # A process restart is a hard stop. Never resume loops or replay work.
            now = self.clock()
            db.execute(
                "UPDATE sessions SET status='INTERRUPTED', finished_at_ms=?, "
                "summary='Process restarted; pending work was not replayed' "
                "WHERE status='RUNNING'",
                (now,),
            )
            db.execute(
                "DELETE FROM reservations WHERE session_id IN "
                "(SELECT id FROM sessions WHERE status='INTERRUPTED')"
            )

    @staticmethod
    def _session(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "agent_id": row["agent_id"],
            "loop_id": row["loop_id"],
            "kind": row["kind"],
            "status": row["status"],
            "started_at_ms": row["started_at_ms"],
            "finished_at_ms": row["finished_at_ms"],
            "summary": row["summary"],
            "effect": row["effect"],
        }

    def create_session(
        self,
        agent_id: str,
        *,
        kind: str,
        loop_id: str | None = None,
        summary: str = "",
        reserve_bytes: int | None = None,
        expected_sessions: int = 0,
        expected_ticks: int = 1,
    ) -> dict[str, Any]:
        if kind not in {"inspect", "report", "loop"}:
            raise ValueError("invalid session kind")
        session_id = uuid.uuid4().hex
        now = self.clock()
        if reserve_bytes is None:
            reserve_bytes = (
                REPORT_RESERVATION_BYTES
                if kind == "report"
                else 4_096
                if kind == "inspect"
                else 0
            )
        if reserve_bytes < 0 or reserve_bytes > MAX_RESERVATION_BYTES:
            raise StateCapacityError("requested journal reservation exceeds limit")
        with self._connection() as db:
            sessions_count = db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
            ticks_count = db.execute("SELECT COUNT(*) FROM ticks").fetchone()[0]
            if sessions_count + 1 + expected_sessions > MAX_ROWS:
                raise StateCapacityError("V5 journal session limit reached")
            if ticks_count + expected_ticks > MAX_TICKS:
                raise StateCapacityError("V5 journal tick limit reached")
            self._ensure_capacity(db, reserve_bytes + 2_048)
            try:
                db.execute(
                    "INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?, 'NONE')",
                    (
                        session_id,
                        agent_id,
                        loop_id,
                        kind,
                        "RUNNING",
                        now,
                        None,
                        summary[:500],
                    ),
                )
            except sqlite3.IntegrityError as exc:
                if kind == "loop":
                    raise RuntimeError("active report loop already exists") from exc
                raise
            if reserve_bytes:
                db.execute(
                    "INSERT INTO reservations VALUES(?,?)", (session_id, reserve_bytes)
                )
        return self.session(session_id)  # type: ignore[return-value]

    def finish_session(
        self, session_id: str, status: str, summary: str
    ) -> dict[str, Any] | None:
        if status not in {"COMPLETED", "BLOCKED", "FAILED", "STOPPED", "INTERRUPTED"}:
            raise ValueError("invalid terminal session status")
        with self._connection() as db:
            db.execute(
                "UPDATE sessions SET status=?, finished_at_ms=?, summary=? "
                "WHERE id=? AND status='RUNNING'",
                (status, self.clock(), summary[:500], session_id),
            )
            db.execute("DELETE FROM reservations WHERE session_id=?", (session_id,))
        return self.session(session_id)

    def add_tick(
        self,
        session_id: str,
        *,
        status: str,
        summary: str,
        evidence_refs: list[str] | None = None,
        report: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> dict[str, Any]:
        if status not in {"COMPLETED", "BLOCKED", "FAILED", "STOPPED"}:
            raise ValueError("invalid tick status")
        tick_id = uuid.uuid4().hex
        refs = [str(value)[:128] for value in (evidence_refs or [])[:32]]
        safe_report = _bounded_report(report) if report is not None else None
        required_bytes = (
            len(_json(safe_report).encode())
            + len(summary[:1000].encode())
            + len(_json(refs).encode())
            + 1_024
        )
        with self._connection() as db:
            session_row = db.execute(
                "SELECT kind FROM sessions WHERE id=?", (session_id,)
            ).fetchone()
            if session_row is None:
                raise KeyError("session not found")
            reservation_row = db.execute(
                "SELECT bytes FROM reservations WHERE session_id=?", (session_id,)
            ).fetchone()
            reservation = int(reservation_row[0]) if reservation_row else 0
            consume_reservation = (
                min(reservation, REPORT_RESERVATION_BYTES)
                if session_row["kind"] == "loop"
                else 0
            )
            self._ensure_capacity(db, required_bytes, exclude_reservation=reservation)
            if not reservation and session_row["kind"] == "report":
                raise StateCapacityError("report outcome reservation missing")
            if reservation and session_row["kind"] == "loop":
                db.execute(
                    "UPDATE reservations SET bytes=? WHERE session_id=?",
                    (
                        max(0, reservation - max(consume_reservation, required_bytes)),
                        session_id,
                    ),
                )
            elif reservation:
                db.execute("DELETE FROM reservations WHERE session_id=?", (session_id,))
            tick_count = db.execute("SELECT COUNT(*) FROM ticks").fetchone()[0]
            if tick_count >= MAX_TICKS:
                raise StateCapacityError("V5 journal tick limit reached")
            db.execute(
                "INSERT INTO ticks VALUES(?,?,?,?,?,?,?,?)",
                (
                    tick_id,
                    session_id,
                    status,
                    self.clock(),
                    summary[:1000],
                    _json(refs),
                    _json(safe_report) if safe_report is not None else None,
                    error[:160] if error else None,
                ),
            )
        return self._tick(self._tick_row(tick_id))

    def _tick_row(self, tick_id: str) -> sqlite3.Row:
        with self._connection() as db:
            row = db.execute("SELECT * FROM ticks WHERE id=?", (tick_id,)).fetchone()
        if row is None:
            raise KeyError("tick not found")
        return row

    @staticmethod
    def _tick(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "status": row["status"],
            "at_ms": row["at_ms"],
            "summary": row["summary"],
            "evidence_refs": json.loads(row["evidence_refs"]),
            "report": json.loads(row["report"]) if row["report"] else None,
            "error": row["error"],
        }

    def session(self, session_id: str) -> dict[str, Any] | None:
        with self._connection() as db:
            row = db.execute(
                "SELECT * FROM sessions WHERE id=?", (session_id,)
            ).fetchone()
            if row is None:
                return None
            value = self._session(row)
            ticks = db.execute(
                "SELECT * FROM ticks WHERE session_id=? ORDER BY at_ms,id",
                (session_id,),
            ).fetchall()
        value["ticks"] = [self._tick(tick) for tick in ticks]
        value["journal"] = "\n".join(
            f"{tick['at_ms']}: {tick['summary']}" for tick in value["ticks"]
        )
        return value

    def sessions(self, limit: int = 100) -> list[dict[str, Any]]:
        with self._connection() as db:
            rows = db.execute(
                "SELECT * FROM sessions ORDER BY started_at_ms DESC LIMIT ?",
                (max(1, min(100, limit)),),
            ).fetchall()
        return [self._session(row) for row in rows]

    def active_loop(self) -> dict[str, Any] | None:
        with self._connection() as db:
            row = db.execute(
                "SELECT * FROM sessions WHERE kind='loop' AND status='RUNNING' LIMIT 1"
            ).fetchone()
        return self._session(row) if row else None

    def storage_status(self) -> dict[str, Any]:
        with self._connection() as db:
            sessions = db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
            ticks = db.execute("SELECT COUNT(*) FROM ticks").fetchone()[0]
            reserved = db.execute(
                "SELECT COALESCE(SUM(bytes),0) FROM reservations"
            ).fetchone()[0]
        return {
            "status": (
                "LIMIT_REACHED"
                if sessions >= MAX_ROWS
                or self._database_bytes() + reserved >= MAX_DATABASE_BYTES
                or ticks >= MAX_TICKS
                else "AVAILABLE"
            ),
            "sessions_used": sessions,
            "session_limit": MAX_ROWS,
            "ticks_used": ticks,
            "tick_limit": MAX_TICKS,
            "bytes_used": self._database_bytes(),
            "bytes_reserved": reserved,
            "bytes_limit": MAX_DATABASE_BYTES,
        }

    def _database_bytes(self) -> int:
        size = 0
        for candidate in (
            self.path,
            Path(str(self.path) + "-wal"),
            Path(str(self.path) + "-shm"),
        ):
            try:
                size += candidate.stat().st_size
            except FileNotFoundError:
                pass
        return size

    def _ensure_capacity(
        self, db: sqlite3.Connection, needed: int, *, exclude_reservation: int = 0
    ) -> None:
        reserved = db.execute(
            "SELECT COALESCE(SUM(bytes),0) FROM reservations"
        ).fetchone()[0]
        if (
            self._database_bytes()
            + max(0, int(reserved) - exclude_reservation)
            + needed
            > MAX_DATABASE_BYTES
        ):
            raise StateCapacityError("V5 journal storage capacity reached")

    @staticmethod
    def backup_database(source: Path, destination: Path) -> None:
        """Create a consistent SQLite backup without copying live WAL files."""
        source = source.resolve(strict=True)
        destination = destination.expanduser().resolve()
        if source == destination or destination.exists() or destination.is_symlink():
            raise ValueError("backup destination must be a new path")
        destination.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(
            destination,
            os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0),
            0o600,
        )
        os.close(descriptor)
        source_db = sqlite3.connect(source.as_uri() + "?mode=ro", uri=True, timeout=5)
        target_db = sqlite3.connect(destination, timeout=5)
        try:
            source_db.backup(target_db)
        finally:
            target_db.close()
            source_db.close()

    def _bounded_report(self, report: dict[str, Any]) -> dict[str, Any]:
        return _bounded_report(report)


def _bounded_report(report: dict[str, Any]) -> dict[str, Any]:
    """Keep only bounded fields from the trusted advisory envelope."""
    allowed = {
        "request_id",
        "status",
        "advice",
        "requested_at_ms",
        "received_at_ms",
        "expires_at_ms",
        "effect",
        "reason",
        "context_hash",
        "snapshot_id",
        "runtime_id",
        "model",
        "prompt_version",
        "validity",
        "rejection",
    }
    filtered = {key: report[key] for key in allowed if key in report}
    if "rejection" in filtered:
        filtered["rejection"] = str(filtered["rejection"])[:300]
    advice = filtered.get("advice")
    if isinstance(advice, dict):
        allowed_advice = {"assessment", "reason_codes", "evidence_refs", "summary"}
        safe_advice = {key: advice[key] for key in allowed_advice if key in advice}
        if isinstance(safe_advice.get("reason_codes"), list):
            safe_advice["reason_codes"] = [
                str(value)[:64] for value in safe_advice["reason_codes"][:8]
            ]
        if isinstance(safe_advice.get("evidence_refs"), list):
            safe_advice["evidence_refs"] = [
                str(value)[:128] for value in safe_advice["evidence_refs"][:32]
            ]
        if isinstance(safe_advice.get("summary"), str):
            safe_advice["summary"] = safe_advice["summary"][:1_000]
        filtered["advice"] = safe_advice
    filtered["effect"] = "NONE"
    encoded = _json(filtered)
    if len(encoded.encode("utf-8")) > 16_000:
        raise ValueError("report envelope exceeds storage limit")
    return filtered
