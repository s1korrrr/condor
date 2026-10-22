# Condor status-read deadline repair

## Objective and completion bar

Bound the fleet-summary `BOTS_STATUS` read to the existing owner-read budget so
a stale or missing cached value cannot consume the whole request deadline. The
route must return an explicit unavailable status, preserve its existing
12-second total deadline and same-view cache lock, and allow a queued same-view
request to make progress after the first build settles.

Completion requires a deterministic failing test before the change, a passing
regression after it, relevant owner tests, and a reviewed diff against the
deployed-source ancestry.

This is a required Condor dependency for root PR #490's integrated monitoring
qualification: the fleet-summary route must not let a pending status fetch
consume its full request deadline and starve same-view dashboard polls.

## Owner, scope, and authority

- Owner repository: `condor/`.
- Worktree: `/Users/s1kor/.codex/worktrees/condor-status-deadline-20261022`.
- Branch: `feat/andrzej_condor_status_deadline_20261022`.
- Base: fetched `fork/main` `78bf269e120c81c08e4bf9d6496738834ce0c942`, which
  contains deployed summary commit `2571dc0d`.
- Authority ceiling: `repository-process-only`.
- Owned paths: `condor/web/routes/fleet_summary.py`, focused fleet-summary
  tests, and this plan.
- Forbidden: strategy, orders, configuration, history reset, live reads that
  can write history, deployment, restart, push, merge, and external messages.

## Evidence and assumptions

- The deployed route hash matches source commit `2571dc0d`.
- At 09:42 UTC one request spent 12 seconds in summary build; its status read
  was still active at the request deadline. Another request spent 8.635 seconds
  waiting on the same-view cache lock and then timed out during build.
- In the deployed source, `LiveReaders.bots_status()` calls SDS
  `get_or_fetch(BOTS_STATUS)` without a per-read timeout. Owner reads are
  bounded at 6 seconds and Market Picture reads at 4 seconds.
- The route begins its 12-second deadline before it waits for the per-view
  lock. A bounded status read should let a serialized request finish within
  the existing deadline when the remaining inputs complete within their
  current bounds. The focused tests will check this directly.
- An SDS fetch can continue after a waiting route reader is cancelled because
  the service shields shared in-flight work. This change does not alter that
  service behavior or its history persistence.

## Hypothesis register

| Hypothesis | Prediction | Result |
| --- | --- | --- |
| An uncapped status read is the cause of the first 12-second stall. | A short test status deadline returns unavailable before the total deadline while unrelated reads finish. | Confirmed: fail-before timed out at the route deadline; pass-after returns unavailable within the read budget. |
| The long status-bound build contributes to same-view lock starvation. | A second same-view request queued behind a held status read completes after the status reader reaches its bound. | Confirmed for the reproducer: the build completes, caches explicit unavailable status, and the queued same-view request reuses it. |
| Lock acquisition itself is defective. | If the first build completes within its source budget, cancellation or completion still leaves a later request blocked. | Not reproduced: cancellation releases the existing lock; no coalescing rewrite is justified. |

## Validation

- Red: focused regression shows a stalled status call outlives the per-read
  budget or causes the queued request to hit the total deadline.
- Green: the bounded reader returns unavailable; a queued request completes;
  cancellation releases the lock and a following request succeeds.
- Run `python -m pytest -q tests/test_fleet_summary.py` in the Condor venv.
- Run formatting/lint checks for touched Python files, `git diff --check`, and
  inspect final status and diff.
- Compare the exact route and SDS source used by the test branch with deployed
  commit `2571dc0d`; report inherited post-deployment changes separately.
- Parent performs immutable image qualification and owns any deployment.

## Rollback

Revert only the task commit on this feature branch. The repair adds no state,
database migration, configuration, dependency, or runtime service. Deployment
rollback remains the parent's operation and uses the recorded deployed Condor
image.

## Results

- Confirmed: `get_or_fetch(BOTS_STATUS)` can remain pending beyond the 12-second
  request deadline. The initial regression failed with a route deadline after
  300ms while the test fetch remained pending.
- Implemented: `LiveReaders.bots_status()` now bounds the request-side wait at
  `OWNER_TIMEOUT` (6 seconds in production) and reports the existing unavailable
  value (`None`) on timeout. SDS coalescing and background fetch/history behavior
  are unchanged.
- Verified: the exact deployed route and `fork/main` route were byte-identical
  before this edit. The route diff from deployed commit `2571dc0d` is only the
  status-read timeout. The feature worktree also contains later upstream
  changes in other files; image qualification must use the exact deployed image
  and the route-only overlay.
- `PYTHONPATH=tests /Users/s1kor/dev/trading/rsibot/condor/.venv/bin/python -m
  pytest -q tests/test_fleet_summary.py`: 50 passed.
- The new concurrency regression models the SDS shared-flight shield: both
  route callers return with status unavailable, the underlying fetch remains
  one coalesced flight, and the queued request reuses the newly cached view.
  A separate cancellation regression confirms that caller cancellation releases
  the lock for a subsequent request.
- The history concurrency behavior remains unchanged. On a status timeout the
  current summary reports status unavailable and reads the last durable history;
  the existing shared SDS fetch may still complete and persist later.
- `git diff --check` passes. Repository Black/isort checks fail on existing
  formatting elsewhere in both edited files. The formatting hook rewrote those
  unrelated regions, so they were restored. The focused test additions require
  no Black or isort changes.
- Evidence ceiling: deterministic route tests and local source checks only.
  No live request, deployed image qualification, service restart, or deployment
  was performed by this task.
