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

## Parent cleanup (2026-10-29)

Completed as a normal follow-up commit, without rewriting history. All 60 PNGs,
the capture JSON and `fixture_dashboard.py` moved byte-for-byte to:
`/home/rsi/dev/rsibot/.workspace/evidence/learning-stage1-20261029/`.
`VALIDATION.md` records each path, byte count and SHA-256, plus the new capture
hashes. The launcher SHA-256 is
`43f6235bb204e78f47ad50c77993a921d689677a0a76646b184ef2d781251d9e`.
No test fixture moved and no fixture value changed.

All nonempty evidence cells now show a short identity and a closed reference
disclosure. Full hashes and pinned identities remain selectable monospace text.
All times in fixture snapshots carry a synthetic-clock label. Stale snapshots
retain that label when their source generation has the explicit fixture prefix;
epoch values alone never imply synthetic data. The four #79/#82 shared files
have no new hunks in this cleanup.

WP09/WP14, both full V5 suites, ordinary/private builds and changed-file ESLint
pass. The two new regression tests failed before implementation. Twelve new
Factory/Lineage captures cover both widths and all three themes. Each was
inspected, as was the expanded hash detail. Only the new Serve route was removed.
Independent review remains pending; no production authority is implied.

## Independent-review fix round (2026-10-29)

The reviewer reproduced two malformed-owner 500s at `ae092e84`. Both now return
typed `INVALID_RESEARCH_PROJECTION` 502s. A single owner-schema boundary runs
before every owner-data read. It uses the 12 exact frozen owner JSON Schemas,
included as package data. Existing semantic checks now raise the typed error.
Routes catch that type, not arbitrary exceptions. Role input types are validated
before registry lookup. Invalid owner workflow receipts return a typed 502;
bad workflow requests remain 422. No dispatch or replay path was added.

The generic regression exercises 1,965 malformed-field requests, with valid
controls for every schema/route pair. Injected programming errors still return
500, proving the route does not conceal implementation bugs. Frozen fixture
dictionaries remain unchanged. Synthetic test builders now fill required owner
fields from those dictionaries. Their money objects use the frozen `quote_asset`
unit and explicit nullable `asset` field instead of the invalid `quote_currency`
unit. A malformed release manifest is rejected rather than projected as merely
incomplete; structurally valid but unqualified releases still remain blocked.

The common reference disclosure now uses singular/plural labels correctly.
There is no layout change, so no new screenshots or Serve route were needed.
The four #79/#82 shared files have no new hunks. See `VALIDATION.md` for the
red/green outputs, commands and counts. Re-review remains pending.
