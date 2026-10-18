# Observer history storage

`PerformanceHistory` records Condor observations. Native Hummingbot accounting
remains authoritative. Missing observations stay gaps; history does not reconstruct
orders, fills, balances or owner PnL.

The default database is `data/native-performance.sqlite3`, relative to the Condor
process working directory. It requires SQLite WAL mode on local storage with
shared-memory locking. In Docker, use a named volume inside the Linux VM for
the `data` directory. Do not open that live database from host-side tools or
mount it into a process on a different host.

The first writer verifies WAL mode and performs additive schema migration in a
serialized transaction. Later writes use separate bounded transactions. Failure
to enable WAL raises an error. SQLite's normal durability and automatic
checkpoint behavior remain enabled. Concurrent readers see committed snapshots;
they must not prevent a writer from committing or block a later reader.

For an existing deployment, stop the Condor service before migration, preserve
the original database, and use SQLite's backup API inside the owning Docker VM
to copy into the new volume. Check integrity, table counts and sample bounds
before starting Condor. Keep the same application path and preserve every other
state mount. Restart only the affected support service. Rollback to an earlier
image must keep the newest database volume; do not restore old observations
over newer ones. Native execution services do not require a restart.

The regression suite covers live and paper PnL and wallet readers under an open
writer, a writer commit while an older reader remains open, and concurrent first
use. See [SQLite's WAL documentation](https://www.sqlite.org/wal.html) for the
storage and locking requirements.
