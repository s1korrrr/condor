# V5 Research Factory: W8 owner repair

Repository-process-only. Condor branch `feat/andrzej_v5_lfl_factory_panel`, red baseline
`4ab494beeeb2b4ecd4b86f2d1bb912968e47280d`. Release `279a8d37` (W6 + W7) was merged first,
without force, at `05a50a9af8ea588622580545d39ede3de6964b16`. Contract pin: rsibot
`bf9f3c14de413c56b7c3ddacf16b10e2d4c4027c`. Acceptance: repaired round-two findings, capped
local verification, and one owner bounded final verification; a failure there cuts W8.

Scope: display/read-only behavior, V5 tests and this plan. No owner services, live dashboard,
real credentials or tokens, orders, bots, deployment, or release merge. D07/D12 off. No W7
panel edits. No root checkout changes, reset, stash, amend or rebase. Scratch only in
`/var/tmp/*.noindex`; heavy work through the Mac `dash-w8` gate. Rollback: withhold W8's PR;
the release already contains W6 and W7 and no runtime state is changed by this branch.

- [x] Non-force merge of the pinned release.
- [x] Reproduce round-two defects on the exact baseline.
- [x] Repair cursor recovery and native comparison admission; cover auth metadata.
- [x] Run focused Python/Node, typecheck, ESLint and offline Chrome.
- [ ] Owner bounded final verification after the non-force push.

## Native comparison pin

`STAGE-B.md` §503 binds comparison conditions to the native rule and preserves native bytes.
The pinned implementation is rsibot `bc90e1390e3e8030245ec9376efbe798b57bd3e2`,
`research_os/src/research_os/research_knowledge/comparison.py`, `validate_comparison`.
Both validators reject empty or placeholder identities after native whitespace stripping
and uppercasing. This covers `comparable_group`, all nine string fields in `conditions`,
and the string form of `window`. Object windows keep the ordered ISO rule. Display,
hashes and owner bytes are not normalized by the check.

## Fail-first evidence

Applied only the new tests to an archive of `4ab494beeeb2b4ecd4b86f2d1bb912968e47280d`.

| Finding | Baseline result | Repair evidence |
| --- | --- | --- |
| Sol B1: failed Stage-B continuation | `503`, `404` and `400` on Next each failed the assertion that refresh omits the rejected cursor. A live candidate page also failed the cursor assertion after a locally retired reply. | Refresh requests the first page without the cursor. A still-live page survives a local ledger miss until refresh or expiry, with its invalid continuation hidden. |
| Sol B2 / Sonnet S1: Stage-A retired response | Expired records reset to `pageIndex: 0`; the shared banner incorrectly contained `First page`. The separate Stage-B reset guard already passed. | Stage A: expired before refresh, then unavailable with `pageIndex: 1`, `hasPrevious: true`, `snapshotChanged: false`, polling continues, no First. Both Stage-A assertions also pass against W6 `043b9842`. Stage B: unavailable, index 0, First shown, no old cursor on First. |
| Sol B3: comparison placeholders | Python accepted all 17 resealed variants as 200 instead of `502 INVALID_OWNER_PROJECTION`; the browser missed all 17 expected rejections. Includes `costs_identity = " UNKNOWN "` and native whitespace/case variants. | Both runtimes reject all 17. A non-placeholder native string window is still accepted. |
| Sonnet S2: Stage-B auth route coverage | Both tests passed on the unmodified base: the route already returned the right fields. Removing only `learning_projection_revision` and `learning_scope_sha256` from the scratch archive made the configured-B test fail. | The authenticated, configured-B response includes all four fields with exact pinned values. Unauthenticated and unconfigured responses omit them. No auth production change. |

## Commands and Results

Commands ran from the Condor worktree unless marked otherwise. All batches used
`python3 /Users/s1kor/.codex/.tmp/mac-gate/mac-heavy-gate.py --thread dash-w8 --wait 5400 -- nice -n 10 sh -c '…'`.
`scratch` below was `/var/tmp/dash-w8-round2.9BCFAE64-BA88-4227-8628-A6317E55E0F6.noindex`;
temporary fixtures, dependencies, browser profile and logs are not part of the patch.
The first post-fix Node run failed one expectation about Stage A's state after refresh.
The exact W6 parity check established the expected state; the final Node run passed.

```sh
export TMPDIR="$scratch/tmp"
py=/Library/Frameworks/Python.framework/Versions/3.12/bin/python3
pytest_env() { env -u PYTHONPATH PYTHONDONTWRITEBYTECODE=1 PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 "$py" -m pytest -p no:cacheprovider -p pytest_asyncio.plugin -q "$@"; }

# FAIL as expected: 17 failed, 2 passed, 78 deselected.
(cd "$scratch/base" && pytest_env tests/test_v5_factory_projection.py -k "native_placeholders or authenticated_stage_b_route")
# FAIL as expected: 23 failed, 1 passed.
(cd "$scratch/base" && node --test --test-name-pattern "native placeholders|on Next|Stage A.*retired|retired candidate|expired Stage B candidate" frontend/test/v5-research-factory.test.mjs)
# FAIL as expected after removing the two pin fields in the scratch archive: 1 failed, 1 passed.
(cd "$scratch/base" && pytest_env tests/test_v5_factory_projection.py -k authenticated_stage_b_route)
# PASS against the exact W6 store and banner in the scratch archive: 2 passed.
w6=043b9842b09f38d9ff25c9a7c81be7f178b55e17
for file in frontend/src/v5/learning-projection-store.ts frontend/src/v5/projection-ui.tsx; do git show "$w6:$file" > "$scratch/base/$file"; done
(cd "$scratch/base" && node --test --test-name-pattern "Stage A.*retired" frontend/test/v5-research-factory.test.mjs)

# PASS: 183 passed.
pytest_env tests/test_v5_factory_projection.py tests/test_v5_learning_projection_contract.py
# PASS: 28 passed, 93 deselected.
pytest_env tests/test_v5_learning_projection_source.py -k "unset_configuration or startup or settings_from_env_carries or retired_generation_cannot or newer_identity_bearing or projection_route_headers_stay or older_generation_cannot or cache_clear_preserves or resealed_foreign_program or retired_unavailable_response or production_aiohttp_disconnect"
# PASS: 209 passed; the consumer scan includes both merged W7 panels.
node --test frontend/test/v5-projection-consumers.test.mjs frontend/test/v5-research-factory.test.mjs frontend/test/v5-learning-projection.test.mjs frontend/test/v5-learning-projection-contract.test.mjs frontend/test/v5-owner-display.test.mjs frontend/test/v5-lfl-panels.test.mjs frontend/test/v5-decision-lineage.test.mjs
# PASS: typecheck, from the detached rsibot worktree.
(cd .. && NODE_OPTIONS=--max-old-space-size=1536 node dashboard/v5-workspace/typecheck.mjs condor/frontend .)
# PASS: ESLint on changed and adjacent projection files.
(cd frontend && node_modules/.bin/eslint src/v5/ResearchFactoryPanel.tsx src/v5/api.ts src/v5/factory-assessment-relationships.ts src/v5/learning-projection.ts src/v5/learning-projection-schemas.ts src/v5/learning-projection-store.ts src/v5/learning-projection-validate.ts src/v5/projection-ui.tsx test/v5-projection-consumers.test.mjs test/v5-research-factory.test.mjs test/v5-learning-projection-contract.test.mjs)
# PASS: offline Chrome; the scratch build bundles the actual Factory and V5 shell CSS with in-memory Stage-B responses.
node "$scratch/layout-build.mjs" "$PWD/frontend"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu --disable-background-networking --no-first-run --no-default-browser-check --enable-logging=stderr "--host-resolver-rules=MAP * ~NOTFOUND" "--user-data-dir=$scratch/chrome" --virtual-time-budget=7000 --dump-dom "file://$scratch/layout.html" > "$scratch/layout-dom.html" 2> "$scratch/chrome.log"
node "$scratch/layout-check.mjs" "$scratch/layout-dom.html"
# PASS: whitespace check and no changes to either W7 panel versus release.
git diff --check 279a8d37
git diff --quiet 279a8d37 -- frontend/src/v5/LearningPanel.tsx frontend/src/v5/DecisionLineagePanel.tsx
```

| Chrome viewport | Root/body scroll width | Main width/scroll width | Overflow |
| --- | --- | --- | --- |
| 1280 | 1280 / 1280 | 1274 / 1274 | 0 |
| 390 | 390 / 390 | 384 / 384 | 0 |

Both viewport runs rendered three sections and 48 articles with an assessment selected
while the manifest was unavailable. No live services were used. No V5 consumer passes
`enabled` to the projection hooks. The legacy exports `ProjectionNotice`, `ProjectionClock`,
`EvidenceList` and `MetricTiles` were left alone for separate cleanup.

## Rulings I Assumed

- Preserve a still-live page after a local ledger rejection, but discard the failed Stage-B
  continuation so the next refresh or poll starts at the first page. Offer First on a locally
  retired reply only once no live page remains, and only in Stage B.
- Keep the accepted relationship rule: no inferred labels without an ordered, complete cursor
  chain under one receipt, capped at 128 pages or 2,000 rows.
