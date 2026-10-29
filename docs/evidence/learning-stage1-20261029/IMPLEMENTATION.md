# WP09 and minimal WP14 implementation

## Contract

Continue the preserved partial implementation on
`feat/andrzej_learning_stage1_condor_20261029`, based on Condor #82
`a9422fd3`. Completion means fixed role manifests, bounded fixture projections,
three accessible operator views, regression checks, browser screenshots, and a
stacked PR. Scope is Condor only. Existing shared-file changes stay minimal.

Authority is `repository-process-only`: fixture implementation, local checks,
a disposable tailnet-private dashboard, task-branch push and PR creation.
No provider calls, paid work, research registrations, economic runs, production
changes, activation, credentials, orders, or merges. No delegation.

The source contract is rsibot #602 at
`798ea9b4da65006e3010597ea55fe527a0b80ffc`. Native/API contracts are #224
`4f0e98f456d6b4e3f3cb7979aadec8bf9c9b614c` and #75
`5e93ef6177562677c349aa7474fc9013b216387d`. Condor does not vendor native
proposal contracts or import another repository's Git history. Canonical
fixture envelopes are pinned in the projection tests. Their hashes and displayed
fields are checked here; full semantic validation remains with each owner.

## Steps

1. Preserve and inspect the inherited work. Read the final revision notice.
2. Reproduce boundary gaps, then repair only the new projection modules.
3. Run WP09, WP14, existing V5 suites, lint, ordinary and private builds.
4. Build a disposable dashboard. Verify its new Serve route in a real browser.
   Inspect all three views at 1440 and 390 in light, dark and colour-blind themes.
5. Withdraw only the new Serve route. Commit intentional files, push, open PR.

## Validation and rollback

Use the Condor uv environment with `PYTHONPATH=.:tests` and `pytest-asyncio`.
Put temporary files under workspace scratch, not `/tmp`. Run the exact WP09 and
WP14 commands from the parent plan, then all existing V5 tests. Run ordinary
frontend lint/build and the root private build against this owner worktree.
Record failures separately from passing checks. Do not repair unrelated lint.

Runtime sources are constructor-injected fixtures only; default routes are
unavailable and all roles remain blocked. No paid queue exists to replay.
Rollback is to leave this feature branch unmerged. No runtime restart or data
migration is needed. Retain all prior files and screenshots; task instructions
forbid deleting the worktree or any inherited artifact.
