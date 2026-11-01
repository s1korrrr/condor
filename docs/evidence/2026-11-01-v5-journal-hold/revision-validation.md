# Dual-review revision validation

The owner hold regressions passed in round two. Correction: the reported two
clock failures were harness errors, not baseline source failures. Symlinked
Condor paths created duplicate clock module identities without
`--preserve-symlinks`. Round three uses physical Condor siblings and records
the corrected validation in `round-three-validation.md`. No clock code changed.
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

The historical symlink-layout run reported 571 passed and 2 failed from 573
tests (234.61 seconds). The same layout mistake affected its prior-head
comparison. That comparison did not establish baseline clock failures.
Keep its logs as evidence of the invalid setup, not a source defect. No
separate clock repair is needed for those results.

Initial dashboard attempts lacked frozen deploy fixtures and Python export
modules in scratch. Restoring the exact main archive fixed those import
failures; the three host-boundary tests then passed. Source tests were not
weakened. Logs retain the failed attempts separately.

Rollback: revert this revision commit and the original feature commit as
needed. No runtime rollback was executed. Earlier review approvals do not
approve this head. Re-review remains required.
