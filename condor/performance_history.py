"""Forward-only native PnL observations; never an equity reconstruction."""

import hashlib
import json
import re
import sqlite3
import time
from contextlib import closing, contextmanager
from decimal import Decimal, InvalidOperation
from pathlib import Path
from uuid import uuid4

from condor.fetchers.bots import extract_bots_list, _native_observation_times

RANGES = {"1D": 86400, "1W": 604800, "1M": 2592000, "ALL": 31536000}
# Wallet reads keep one sample per bucket so a month stays under the row cap without losing day ends.
WALLET_BUCKETS = {"1D": 60, "1W": 300, "1M": 1800, "ALL": 3600}


def number(value):
    if value is None or isinstance(value, bool):
        raise ValueError("Missing numeric observation")
    try:
        result = Decimal(str(value))
    except InvalidOperation as exc:
        raise ValueError("Invalid numeric observation") from exc
    if not result.is_finite():
        raise ValueError("Nonfinite observation")
    return result


def project(bot, now):
    """Reject stale, incomplete or incompatible native controller reports."""
    if not (
        bot.get("source") == "native_mqtt"
        and bot.get("performance_current") is True
        and bot.get("identity_verified") is True
        and bot.get("status") == "running"
    ):
        raise ValueError("Native performance is not current")
    times = _native_observation_times(bot)
    for field, threshold in (
        ("performance_received_at", "performance_stale_after_seconds"),
        ("status_received_at", "status_stale_after_seconds"),
    ):
        age = Decimal(str(now)) - number(times[field])
        if not 0 <= age < number(times[threshold]):
            raise ValueError("Expired native observation")
    lifecycle = bot.get("lifecycle", {})
    payload = lifecycle.get("observation", {}).get("payload", {})
    boot = payload.get("boot_id")
    instance = payload.get("instance_id")
    if (
        not isinstance(boot, str)
        or not boot
        or not isinstance(instance, str)
        or not instance
    ):
        raise ValueError("Missing native boot identity")
    reports = bot.get("performance")
    expected = bot.get("expected_controller_ids")
    if (
        not isinstance(reports, dict)
        or not reports
        or not isinstance(expected, list)
        or len(expected) != len(set(expected))
        or set(reports) != set(expected)
    ):
        raise ValueError("Incomplete controller set")
    realized = unrealized = Decimal(0)
    pairs = []
    for controller, row in sorted(reports.items()):
        pair = row.get("custom_info", {}).get("pair")
        if not isinstance(pair, str) or not re.fullmatch(r"[A-Z0-9]+-[A-Z0-9]+", pair):
            raise ValueError("Unknown quote currency")
        pairs.append((controller, pair))
        perf = row["performance"]
        if perf.get("pnl_available") is False:
            raise ValueError("Native PnL explicitly unavailable")
        r, u = number(perf.get("realized_pnl_quote")), number(
            perf.get("unrealized_pnl_quote")
        )
        if abs(number(perf.get("global_pnl_quote")) - r - u) > Decimal("0.000001"):
            raise ValueError("Inconsistent native total")
        realized += r
        unrealized += u
    quotes = {pair.split("-")[1] for _, pair in pairs}
    if len(quotes) != 1:
        raise ValueError("Mixed quote currencies")
    identity = hashlib.sha256(
        json.dumps([instance, boot, pairs], sort_keys=True).encode()
    ).hexdigest()
    return {
        "timestamp": float(times["performance_received_at"]),
        "identity": identity,
        "quote": quotes.pop(),
        "realized_pnl_quote": str(realized),
        "unrealized_pnl_quote": str(unrealized),
        "total_pnl_quote": str(realized + unrealized),
    }


class PerformanceHistory:
    def __init__(self, path=Path("data/native-performance.sqlite3")):
        self.path = Path(path)

    @contextmanager
    def _connect(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.path, timeout=5)
        conn.row_factory = sqlite3.Row
        conn.execute(
            "CREATE TABLE IF NOT EXISTS points (server TEXT, bot TEXT, timestamp REAL, identity TEXT, segment TEXT, quote TEXT, realized_pnl_quote TEXT, unrealized_pnl_quote TEXT, total_pnl_quote TEXT, PRIMARY KEY(server,bot,timestamp))"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS cursors (server TEXT, bot TEXT, timestamp REAL, identity TEXT, segment TEXT, sampled REAL, valid INTEGER, PRIMARY KEY(server,bot))"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS points_timestamp ON points(timestamp)")
        conn.execute(
            "CREATE TABLE IF NOT EXISTS wallet_points (server TEXT, bot TEXT, timestamp REAL, currency TEXT, value_quote TEXT, source_id TEXT, PRIMARY KEY(server,bot,timestamp))"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS wallet_cursors (server TEXT, bot TEXT, timestamp REAL, sampled REAL, valid INTEGER, PRIMARY KEY(server,bot))"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS wallet_points_timestamp ON wallet_points(timestamp)")
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    def record_wallet(self, server, samples, now=None):
        """Forward-only shared-wallet valuation samples from the reporting owner.

        `samples` maps bot -> projected wallet sample or None when the read failed.
        A failed read marks the cursor invalid so the next valid sample starts after a gap.
        """
        now = time.time() if now is None else now
        with self._connect() as conn:
            for name, sample in samples.items():
                if sample is None:
                    conn.execute("UPDATE wallet_cursors SET valid=0 WHERE server=? AND bot=?", (server, name))
                    continue
                previous = conn.execute(
                    "SELECT * FROM wallet_cursors WHERE server=? AND bot=?", (server, name)
                ).fetchone()
                stamp = float(sample["timestamp"])
                if stamp > now + 5:
                    conn.execute("UPDATE wallet_cursors SET valid=0 WHERE server=? AND bot=?", (server, name))
                    continue
                if previous and stamp <= previous["timestamp"]:
                    continue
                first = not previous or not previous["valid"]
                sampled = stamp if first or stamp - previous["sampled"] >= 60 else previous["sampled"]
                if sampled == stamp:
                    conn.execute(
                        "INSERT OR IGNORE INTO wallet_points VALUES (?,?,?,?,?,?)",
                        (server, name, stamp, sample["currency"], sample["value_quote"], sample.get("source_id", "")),
                    )
                conn.execute(
                    "INSERT OR REPLACE INTO wallet_cursors VALUES (?,?,?,?,1)",
                    (server, name, stamp, sampled),
                )
            conn.execute("DELETE FROM wallet_points WHERE timestamp < ?", (now - RANGES["ALL"],))

    def read_wallet(self, server, bot, period, now=None):
        now = time.time() if now is None else now
        result = {
            "source": "reporting_wallet_observer",
            "bot_name": bot,
            "range": period,
            "coverage_start": None,
            "points": [],
            "truncated": False,
        }
        if not self.path.exists():
            return result
        with closing(sqlite3.connect(f"file:{self.path.resolve()}?mode=ro", uri=True)) as conn:
            conn.row_factory = sqlite3.Row
            tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if "wallet_points" not in tables:
                return result
            start = conn.execute(
                "SELECT MIN(timestamp) FROM wallet_points WHERE server=? AND bot=?", (server, bot)
            ).fetchone()[0]
            # Longer windows return the last sample of each bucket so day-end statistics keep full coverage.
            bucket = WALLET_BUCKETS[period]
            rows = conn.execute(
                "SELECT timestamp,currency,value_quote,source_id FROM wallet_points WHERE server=? AND bot=? AND timestamp>=? "
                "AND timestamp IN (SELECT MAX(timestamp) FROM wallet_points WHERE server=? AND bot=? AND timestamp>=? GROUP BY CAST(timestamp/? AS INTEGER)) "
                "ORDER BY timestamp DESC LIMIT 10001",
                (server, bot, now - RANGES[period], server, bot, now - RANGES[period], bucket),
            ).fetchall()
        result.update(
            coverage_start=start,
            bucket_seconds=bucket,
            points=[dict(row) for row in reversed(rows[:10000])],
            truncated=len(rows) > 10000,
        )
        return result

    def record(self, server, raw, now=None):
        now = time.time() if now is None else now
        with self._connect() as conn:
            seen = set()
            for bot in extract_bots_list(raw):
                name = bot.get("bot_name")
                if not isinstance(name, str) or not name:
                    continue
                seen.add(name)
                try:
                    point = project(bot, now)
                except (ValueError, TypeError, KeyError, AttributeError):
                    conn.execute(
                        "UPDATE cursors SET valid=0 WHERE server=? AND bot=?",
                        (server, name),
                    )
                    continue
                previous = conn.execute(
                    "SELECT * FROM cursors WHERE server=? AND bot=?", (server, name)
                ).fetchone()
                stamp = point["timestamp"]
                if previous and stamp <= previous["timestamp"]:
                    continue
                split = (
                    not previous
                    or not previous["valid"]
                    or previous["identity"] != point["identity"]
                    or stamp - previous["timestamp"] > 90
                )
                segment = uuid4().hex if split else previous["segment"]
                sampled = (
                    stamp
                    if split or stamp - previous["sampled"] >= 60
                    else previous["sampled"]
                )
                if sampled == stamp:
                    conn.execute(
                        "INSERT OR IGNORE INTO points VALUES (?,?,?,?,?,?,?,?,?)",
                        (
                            server,
                            name,
                            stamp,
                            point["identity"],
                            segment,
                            point["quote"],
                            point["realized_pnl_quote"],
                            point["unrealized_pnl_quote"],
                            point["total_pnl_quote"],
                        ),
                    )
                conn.execute(
                    "INSERT OR REPLACE INTO cursors VALUES (?,?,?,?,?,?,1)",
                    (server, name, stamp, point["identity"], segment, sampled),
                )
            for row in conn.execute(
                "SELECT bot FROM cursors WHERE server=?", (server,)
            ).fetchall():
                if row["bot"] not in seen:
                    conn.execute(
                        "UPDATE cursors SET valid=0 WHERE server=? AND bot=?",
                        (server, row["bot"]),
                    )
            conn.execute(
                "DELETE FROM points WHERE timestamp < ?", (now - RANGES["ALL"],)
            )

    def read(self, server, bot, period, now=None):
        now = time.time() if now is None else now
        result = {
            "source": "native_mqtt_observer",
            "bot_name": bot,
            "range": period,
            "coverage_start": None,
            "points": [],
            "truncated": False,
        }
        if not self.path.exists():
            return result
        with closing(
            sqlite3.connect(f"file:{self.path.resolve()}?mode=ro", uri=True)
        ) as conn:
            conn.row_factory = sqlite3.Row
            start = conn.execute(
                "SELECT MIN(timestamp) FROM points WHERE server=? AND bot=?",
                (server, bot),
            ).fetchone()[0]
            rows = conn.execute(
                "SELECT timestamp,identity,segment,quote,realized_pnl_quote,unrealized_pnl_quote,total_pnl_quote FROM points WHERE server=? AND bot=? AND timestamp>=? ORDER BY timestamp DESC LIMIT 10001",
                (server, bot, now - RANGES[period]),
            ).fetchall()
        result.update(
            coverage_start=start,
            points=[dict(row) for row in reversed(rows[:10000])],
            truncated=len(rows) > 10000,
        )
        return result


history = PerformanceHistory()
