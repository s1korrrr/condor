# Fleet summary timeout diagnostics

Summary timeouts now report the phase that consumed the request deadline. The
existing 12-second total deadline, bounded glance readers, cache behaviour and
HTTP 504 response remain in effect. Dashboard and Live Activity content use
the same summary boundary.

A timeout warning contains `event=fleet_summary_timeout`, `kind`, `deadline_ms`,
`elapsed_ms`, `view`, `cache` and a bounded JSON `phases` object. `kind=deadline`
means the outer request timer expired. `kind=source_timeout` means an inner
reader raised `TimeoutError` before that timer expired. The warning is a
failure observation even though the owner log level is WARNING.

The phase keys identify cache-lock wait, summary assembly, status, local
history, account, market latest/history and fixed owner endpoint families.
Completed phases carry counts, elapsed totals, maxima and outcomes. Active
phases carry elapsed time. Names and metrics contain no bot/user identifiers,
URLs, payloads or exception text. Cancellation is recorded and propagated.
Cancelling a local-history `to_thread` await does not prove that its underlying
thread stopped; inspect native reader deadlines when diagnosing that phase.

The retained bounded-glance/deadline implementation is dependency commit
`7c985dffe60e08ec482a5881e9df2cbf2d4b95cf`, already in this branch's base. An
isolated older-source harness reproduced a 101 ms cache-lock wait escaping a
10 ms deadline and a glance request unnecessarily building the full view.
The current source covers both behaviours with regressions.

Validation on the qualified Python 3.12 runtime image:

- `pytest -q tests/test_fleet_summary.py tests/test_fleet_summary_live_shapes.py tests/test_fleet_summary_pnl.py`: 101 passed.
- Adding `tests/test_push_live_activity.py tests/test_push_routes.py`: 276 passed,
  three push retry pacing failures. The same three failures reproduce unchanged
  on the predecessor image; sender pacing code is outside this summary change.
- Ruff lint, Python compilation and `git diff --check` passed. Ruff formatting
  reports broad changes on both base and candidate files; those unrelated
  formatting changes were not applied.

Image adoption requires actual source-file qualification. An image revision
label can describe only one part of an existing hybrid image. The evaluated
predecessor already contains `fleet_pnl.exact_sum` and the required current
performance-history/push modules; a pure historical Git archive does not.
The qualified candidate changes only the two summary Python modules and keeps
all other exported filesystem entries and image configuration. Packaging was
flattened because the predecessor's 127 layers exhausted Docker's runnable
layer depth. Exact source/image hashes, failed packaging attempts and the
93,258-path comparison are retained in the root deployment evidence packet.

Revert this source change or restore the qualified predecessor image to roll
back diagnostics. Do not replace runtime databases or change strategy settings
as part of that rollback. Runtime deployment and sustained live recovery are
separate gates from these local checks.
