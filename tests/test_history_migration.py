import json
import sqlite3
from contextlib import closing

import pytest

from condor.history_migration import HistoryMigrationError, main, migrate
from condor.performance_history import PerformanceHistory


def seed_points(path, rows):
    history = PerformanceHistory(path)
    with history._connect() as conn:
        for server, bot, stamp in rows:
            conn.execute(
                "INSERT INTO points VALUES (?,?,?,?,?,?,?,?,?)",
                (server, bot, stamp, "boot-a", "seg-1", "USDC", "1", "2", "3"),
            )
            conn.execute(
                "INSERT OR REPLACE INTO cursors VALUES (?,?,?,?,?,?,1)", (server, bot, stamp, "boot-a", "seg-1", stamp)
            )
        return history


def count(path, table, server, bot):
    with closing(sqlite3.connect(path)) as conn:
        return conn.execute(f"SELECT COUNT(*) FROM {table} WHERE server=? AND bot=?", (server, bot)).fetchone()[0]


@pytest.fixture
def databases(tmp_path):
    source, dest = tmp_path / "source.sqlite3", tmp_path / "dest.sqlite3"
    seed_points(source, [("native-ok-rsi", "ok_rsi", 100.0 + n) for n in range(3)]
                + [("native-ok-rsi", "rsi_v5", 500.0)])
    seed_points(dest, [("shared", "rsi_modular_v2", 900.0)])
    return source, dest


def test_dry_run_reports_counts_and_writes_nothing(databases):
    source, dest = databases
    report = migrate(source, dest, bot="ok_rsi", old_server="native-ok-rsi", new_server="shared")
    assert report["applied"] is False
    assert report["points"] == {"source_rows": 3, "inserted": 0, "already_present": 0}
    assert count(dest, "points", "shared", "ok_rsi") == 0


def test_apply_copies_only_the_named_bot_under_the_new_server_and_no_cursors(databases):
    source, dest = databases
    report = migrate(source, dest, bot="ok_rsi", old_server="native-ok-rsi", new_server="shared", apply=True)
    assert report["points"] == {"source_rows": 3, "inserted": 3, "already_present": 0}
    assert count(dest, "points", "shared", "ok_rsi") == 3
    assert count(dest, "points", "shared", "rsi_v5") == 0
    assert count(dest, "points", "native-ok-rsi", "ok_rsi") == 0
    assert count(dest, "points", "shared", "rsi_modular_v2") == 1
    assert count(dest, "cursors", "shared", "ok_rsi") == 0  # the live recorder starts its own segment
    assert count(source, "points", "native-ok-rsi", "ok_rsi") == 3  # source is never rewritten
    # The copied history is readable through the normal API read path.
    read = PerformanceHistory(dest).read("shared", "ok_rsi", "1D", now=200.0)
    assert [point["timestamp"] for point in read["points"]] == [100.0, 101.0, 102.0]


def test_apply_is_idempotent_and_never_overwrites(databases):
    source, dest = databases
    migrate(source, dest, bot="ok_rsi", old_server="native-ok-rsi", new_server="shared", apply=True)
    with closing(sqlite3.connect(dest)) as conn:
        conn.execute("UPDATE points SET total_pnl_quote='live' WHERE bot='ok_rsi' AND timestamp=100.0")
        conn.commit()
    again = migrate(source, dest, bot="ok_rsi", old_server="native-ok-rsi", new_server="shared", apply=True)
    assert again["points"] == {"source_rows": 3, "inserted": 0, "already_present": 3}
    with closing(sqlite3.connect(dest)) as conn:
        assert conn.execute(
            "SELECT total_pnl_quote FROM points WHERE bot='ok_rsi' AND timestamp=100.0"
        ).fetchone()[0] == "live"


def test_wallet_samples_are_copied_and_older_sources_without_balances_are_accepted(tmp_path):
    source, dest = tmp_path / "old.sqlite3", tmp_path / "dest.sqlite3"
    with closing(sqlite3.connect(source)) as conn:
        conn.execute(
            "CREATE TABLE wallet_points (server TEXT, bot TEXT, timestamp REAL, currency TEXT, value_quote TEXT, "
            "source_id TEXT, PRIMARY KEY(server,bot,timestamp))"
        )
        conn.execute("INSERT INTO wallet_points VALUES ('a','b',10.0,'USDT','5','s')")
        conn.commit()
    report = migrate(source, dest, bot="b", old_server="a", new_server="c", apply=True)
    assert report["wallet_points"] == {"source_rows": 1, "inserted": 1, "already_present": 0}
    assert report["points"]["source_rows"] == 0
    with closing(sqlite3.connect(dest)) as conn:
        assert conn.execute("SELECT server,balances_json FROM wallet_points").fetchall() == [("c", None)]


@pytest.mark.parametrize(
    "kwargs",
    [
        {"bot": "../x", "old_server": "a", "new_server": "b"},
        {"bot": "x", "old_server": "a", "new_server": "a"},
        {"bot": "x", "old_server": "", "new_server": "b"},
    ],
)
def test_invalid_identities_are_refused(databases, kwargs):
    source, dest = databases
    with pytest.raises(HistoryMigrationError):
        migrate(source, dest, **kwargs)


def test_missing_source_and_same_file_are_refused(tmp_path, databases):
    source, dest = databases
    with pytest.raises(HistoryMigrationError):
        migrate(tmp_path / "absent.sqlite3", dest, bot="x", old_server="a", new_server="b")
    with pytest.raises(HistoryMigrationError):
        migrate(source, source, bot="ok_rsi", old_server="native-ok-rsi", new_server="shared")


def test_cli_defaults_to_dry_run_and_reports_refusals(databases, capsys):
    source, dest = databases
    args = ["--source", str(source), "--dest", str(dest), "--bot", "ok_rsi", "--old-server", "native-ok-rsi",
            "--new-server", "shared"]
    assert main(args) == 0
    assert json.loads(capsys.readouterr().out)["applied"] is False
    assert count(dest, "points", "shared", "ok_rsi") == 0
    assert main(args + ["--apply"]) == 0
    assert count(dest, "points", "shared", "ok_rsi") == 3
    assert main(["--source", str(source), "--dest", str(source), "--bot", "ok_rsi",
                 "--old-server", "a", "--new-server", "b"]) == 2
