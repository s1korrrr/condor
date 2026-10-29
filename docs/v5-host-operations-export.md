# Read-only V5 host observations

This follow-up builds on approved Condor #79. It does not change the owner API,
the ordinary Condor routes, or any lifecycle authority.

Set `V5_HOST_OPERATIONS_FILE` to the absolute path of the monitor's sanitized
`rsibot.v5-paper.read.v1` operations export. Mount its directory read-only.
Mount the directory, not the file: the host publisher replaces the file atomically.
The monitor must publish it with a shared reader group and mode `0640`.

The existing authenticated `/api/v5/dashboard/read` route serves the exact
allowlisted `/api/v1/operations` request from this file when the paper bot is
bound. It supplies the configured paper bot identity for the compatibility
projection. It does not call the observation API or advisor for this read.
The owner `/v1/paper/operations` route remains native paper evidence; this host
export is a separate read-only source, not a second order or capital owner.

Missing files return collecting with no invented zero services. Invalid files,
symlinks, nonfinite values, oversized records and future timestamps fail closed.
Exports older than 90 seconds become stale and retain their original timestamp.
The frontend keeps restart counts unknown when the monitor did not observe them.
The current root publisher declares raw log capture disabled and does not copy
container output, private paths, exception text or credentials into the export.

Validation: `PYTHONPATH="$PWD:$PWD/tests:<scratch-test-deps>" python -m pytest -q
tests/test_v5*.py`. The integration route test proves authentication, native
schema compatibility, fail-closed handling and zero upstream/provider calls.
No real provider credentials or protected runtime state are needed.
