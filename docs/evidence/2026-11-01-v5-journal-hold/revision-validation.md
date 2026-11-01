# Dual-review revision validation

The owner hold regressions pass. Two existing root-main clock tests remain
failed and reproduce on the pre-revision Condor head. No clock code changed.
No install, deploy, restart, live read or external notification was performed.

`S=/home/rsi/dev/rsibot/.workspace/scratch/journal-hold`.
Commands ran from `$S/condor-r2/frontend` unless stated otherwise.

```bash
V5_WORKSPACE_ROOT="$S/workspace-r2-1" node --test --test-concurrency=2 test/v5-*.test.mjs
node --test test/v5-journal-*.test.mjs
./node_modules/.bin/tsc -b
./node_modules/.bin/eslint src/v5/OwnerJournalCondition.tsx src/v5/paper-journal.ts src/v5/paper-safety.ts src/v5/usePaperObservation.ts src/v5/usePaperSnapshot.ts
node tooling/check-v5-reproducibility.mjs rebuild "$S/r2-reproducibility" "$S/workspace-r2-1" "$S/workspace-r2-2"
```

- Component probes: two failed before repair; both pass afterward.
- Focused journal suite: 20 passed. Final V5 suite: 358 passed.
- TypeScript and focused ESLint: exit 0.
- Old manifest rejects the seed. New manifest matches 35/35 files in each of
  two independently built copies of rsibot-main dashboard source.
- Root-owned permanent QueryObserver regression: 1 passed. It checks partial
  failure, reset, remount and qualified complete supersession. It failed before.

Both root-main dashboard source copies come from
`f0bd5de2b77a34d3b6b61bbf97fb94fcd1aef9d3`. From the second copy:

```bash
cd "$S/workspace-r2-2/dashboard/condor-workspace"
node --test --test-concurrency=2 test/*.test.mjs
node --test test/v5-document-clock-claude.test.mjs
```

The clock file has two passes and two failures, both on this revision and on
pre-revision Condor `478ed147227c10aae3c0f845a1b6681585b8e7b6`:
`remounts within the entire tolerated skew/fresh window cannot revive totals`
and `pages first mounted at different wall-clock times share the document
high-water mark`. The latter reports 15s rather than the expected retained
45s. This is not a green dashboard qualification. Parent owns the separate
clock repair; this task explicitly forbids changing that code.

Final full rsibot-main dashboard result with all source fixtures present:
573 tests, 571 passed, 2 failed, 0 skipped (234.61 seconds). Both failures are
the baseline-reproduced clock cases above. No other test failed.

Initial dashboard attempts lacked frozen deploy fixtures and Python export
modules in scratch. Restoring the exact main archive fixed those import
failures; the three host-boundary tests then passed. Source tests were not
weakened. Logs retain the failed attempts separately.

Rollback: revert this revision commit and the original feature commit as
needed. No runtime rollback was executed. Earlier review approvals do not
approve this head. Re-review remains required.
