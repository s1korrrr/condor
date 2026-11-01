# Journal hold visibility — local evidence

Implemented and locally tested, not deployed. Base Condor
`8f1494ed4faa3a2dd1836c0d231c5a0a3038ee43`. Dashboard integration source is
rsibot main `f0bd5de2b77a34d3b6b61bbf97fb94fcd1aef9d3`; its dashboard tree is
unchanged. No clock code, owner semantics, execution authority or live state
changes. No browser/runtime claim. Independent review remains pending.

## Mechanism

The shared authenticated V5 shell adds `PaperJournalNotice`. It reuses the
existing coherent owner observation query and its snapshot presentation. The
notice displays the exact named reason, budget state, `journal_evidence_held`
and `native_execution_continues` on Operations, Readiness and Bots, as well as
other V5 pages. Existing page content, owner summaries and readiness gates
remain present. Missing booleans show unavailable; false stays false. Retained
or stale status keeps its snapshot label and is not current execution proof.

Known reasons are `OWNER_JOURNAL_EXCEEDED`,
`OWNER_JOURNAL_SEGMENT_CAPACITY` and `OWNER_JOURNAL_INVENTORY_UNAVAILABLE`.
An explicit held flag also remains visible without a recognized reason.
Budget numbers are nonnegative safe integers; no missing count becomes zero.
The notice never provides an archival or trading action.

## Commands and results

All temporary data is under
`/home/rsi/dev/rsibot/.workspace/scratch/journal-hold` (`S` below).
Dependencies came from `npm ci` with this branch's unchanged lockfile.

```bash
cd "$S/condor/frontend"
V5_WORKSPACE_ROOT="$S/workspace-1" node --test --test-concurrency=2 test/v5-*.test.mjs
./node_modules/.bin/tsc -b
./node_modules/.bin/eslint src/v5/OwnerJournalCondition.tsx src/v5/V5App.tsx
git diff --check
```

- Final V5 Node suite: **345 passed, 0 failed, 0 skipped**.
- Includes seven direct banner cases and the real V5 route render suite.
  Operations, Readiness and Bots each retain their page heading while showing
  the named hold and both explicit owner conditions. Existing render-loop,
  freshness, retention, safety, clock and session regressions remain green.
- TypeScript, focused ESLint and whitespace: PASS (exit 0).
- Before implementation, the new test file failed because no journal-condition
  reader existed. The final suite tests the reader and actual routed shell.
- Early route attempts exposed missing scratch layout/dependencies, not source
  regressions. The documented workspace/Condor/reporting sibling layout and
  locked dependencies were restored before the passing result.

## Reviewed bundle

The old manifest rejected the changed seed build. The new manifest was
generated with `distHashes` and checked with `verifyDist` exported by
`frontend/tooling/check-v5-reproducibility.mjs`. Only `entry`, `entrySha256` and
`files` changed. Each workspace root contains its own copy of the exact main
dashboard tree and a Condor symlink to this owner worktree.

```bash
V5_WORKSPACE_ROOT="$S/workspace-1" ./node_modules/.bin/vite build \
  --config vite.v5.config.ts --outDir "$S/seed-dist-final"
node tooling/check-v5-reproducibility.mjs rebuild \
  "$S/reproducibility-final" "$S/workspace-1" "$S/workspace-2"
node tooling/check-v5-reproducibility.mjs verify "$S/reproducibility-final/build-1"
node tooling/check-v5-reproducibility.mjs verify "$S/reproducibility-final/build-2"
```

Both independent builds reproduce **35/35 files**. Entry:
`assets/v5-AcTKaQDZ.js`, SHA256
`ad5fd2f14238c26e03cf4fd7ab1ddc62fa63e5e88384ad8f8a8d5c818a6276e4`.
Vite reports existing mixed-import/chunk-size warnings; both builds exit 0.
See `reproducibility.log.gz` and `node-tests.log.gz` for actual command output.

## Rollback and limits

Revert this owner's commit to remove the notice and restore the prior reviewed
manifest. No install or restart is needed for repository rollback. A later
deployment is separate authority. API/engine releases and archival continuation
are separate owner tasks. Hosted checks are not local proof; review is pending.
