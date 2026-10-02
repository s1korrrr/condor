"""Carry one bot's recorded history from another Condor's database under a new server name.

Condor keys native PnL and wallet-valuation samples by ``(server, bot, timestamp)``. When a bot moves
from one native API (for example V1's ``native-ok-rsi``) to a shared API with another saved server name,
its earlier samples stay under the old name and the dashboard would show a fresh, empty history.

This copies only that bot's rows from a *copy* of the source database into the destination under the new
server name. It never rewrites the source, never copies live cursors (the destination recorder starts a new
segment at the first live sample, so the move is a visible gap, not an invented continuation), and never
overwrites an existing destination sample (``INSERT OR IGNORE``). The default is a dry run.

    python -m condor.history_migration --source copy-of-source.sqlite3 --dest /state/condor/data/native-performance.sqlite3 \
        --bot ok_rsi --old-server native-ok-rsi --new-server rsibot-stack-v2 [--apply]
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from contextlib import closing
from pathlib import Path

from condor.performance_history import PerformanceHistory

IDENTITY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$")
POINT_COLUMNS = (
    "server", "bot", "timestamp", "identity", "segment", "quote",
    "realized_pnl_quote", "unrealized_pnl_quote", "total_pnl_quote",
)
WALLET_COLUMNS = ("server", "bot", "timestamp", "currency", "value_quote", "source_id", "balances_json")


class HistoryMigrationError(ValueError):
    pass


def _identity(value: str, label: str) -> str:
    if not isinstance(value, str) or not IDENTITY.fullmatch(value):
        raise HistoryMigrationError(f"{label} must be a simple identity")
    return value


def _tables(conn: sqlite3.Connection) -> dict[str, set[str]]:
    tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    return {name: {row[1] for row in conn.execute(f"PRAGMA table_info({name})")} for name in tables}


def _source_rows(source: sqlite3.Connection, table: str, columns: tuple[str, ...], bot: str, old_server: str):
    present = _tables(source).get(table)
    if present is None:
        return []
    # A source written by an older Condor may lack a column (for example balances_json): copy it as NULL.
    selected = ", ".join(column if column in present else "NULL" for column in columns)
    return source.execute(
        f"SELECT {selected} FROM {table} WHERE server=? AND bot=? ORDER BY timestamp", (old_server, bot)
    ).fetchall()


def migrate(
    source_db: Path,
    dest_db: Path,
    *,
    bot: str,
    old_server: str,
    new_server: str,
    apply: bool = False,
) -> dict:
    """Copy `bot`'s points and wallet samples. Returns row counts; writes only when `apply` is true."""
    bot, old_server, new_server = (
        _identity(bot, "bot"), _identity(old_server, "old server"), _identity(new_server, "new server"),
    )
    if old_server == new_server:
        raise HistoryMigrationError("old and new server names are identical; nothing to rebind")
    source_db, dest_db = Path(source_db), Path(dest_db)
    if not source_db.is_file():
        raise HistoryMigrationError("source database does not exist")
    if source_db.resolve() == dest_db.resolve():
        raise HistoryMigrationError("source and destination must be different files")
    with closing(sqlite3.connect(f"file:{source_db.resolve()}?mode=ro", uri=True)) as source:
        points = _source_rows(source, "points", POINT_COLUMNS, bot, old_server)
        wallet = _source_rows(source, "wallet_points", WALLET_COLUMNS, bot, old_server)
    report = {
        "bot": bot, "old_server": old_server, "new_server": new_server, "applied": apply,
        "points": {"source_rows": len(points), "inserted": 0, "already_present": 0},
        "wallet_points": {"source_rows": len(wallet), "inserted": 0, "already_present": 0},
    }
    if not apply:
        return report
    history = PerformanceHistory(dest_db)
    with history._connect() as dest:  # creates the schema and holds one write transaction
        for name, columns, rows in (
            ("points", POINT_COLUMNS, points), ("wallet_points", WALLET_COLUMNS, wallet),
        ):
            marks = ",".join("?" for _ in columns)
            for row in rows:
                values = (new_server, *tuple(row)[1:])
                cursor = dest.execute(
                    f"INSERT OR IGNORE INTO {name} ({','.join(columns)}) VALUES ({marks})", values
                )
                report[name]["inserted" if cursor.rowcount == 1 else "already_present"] += 1
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source", type=Path, required=True, help="a copy of the source Condor database")
    parser.add_argument("--dest", type=Path, required=True)
    parser.add_argument("--bot", required=True)
    parser.add_argument("--old-server", required=True)
    parser.add_argument("--new-server", required=True)
    parser.add_argument("--apply", action="store_true", help="write to the destination (default: dry run)")
    args = parser.parse_args(argv)
    try:
        report = migrate(
            args.source, args.dest, bot=args.bot, old_server=args.old_server,
            new_server=args.new_server, apply=args.apply,
        )
    except (HistoryMigrationError, sqlite3.Error) as error:
        print(f"history migration refused: {error}", file=sys.stderr)
        return 2
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
