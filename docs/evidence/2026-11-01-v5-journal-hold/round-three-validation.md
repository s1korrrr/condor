# Round-three validation and evidence correction

The identity regression is fixed. `status` remains the completed owner status;
`journalStatus` carries retained evidence only for `PaperJournalNotice`.
Identity keeps the new boot, source hash, snapshot ID and As of presentation
when new operations truth is degraded for `runtime_stopped`. The older journal
hold remains visible with its received/partial label. No clock code changed.

The prior claim of two baseline clock failures was wrong. A symlinked Condor
layout without `--preserve-symlinks` created duplicate clock module identities.
The physical-sibling baseline below passes 573/573. No clock repair was needed.
Historical round-two logs remain as evidence of the invalid setup.

## Source and layout

`S=/home/rsi/dev/rsibot/.workspace/scratch/journal-hold`.
Each workspace has physical `dashboard` and `condor` sibling directories,
not Condor source symlinks. Only locked `node_modules` directories are linked.
Dashboard and deploy fixtures come from rsibot main
`f0bd5de2b77a34d3b6b61bbf97fb94fcd1aef9d3` via `git archive`.
The baseline uses main's Condor gitlink
`8f1494ed4faa3a2dd1836c0d231c5a0a3038ee43`. The two feature copies use the
unchanged previous owner tree plus exactly this revision's source changes.

## Commands and results

From `$S/condor-r3/frontend`, before repair:

```bash
V5_WORKSPACE_ROOT="$S/workspace-r3-1" node --test test/v5-journal-identity-retention.test.mjs
```

One failed: completed identity exposed the old snapshot instead of `newboot:1`.
The permanent root real-QueryObserver identity test also failed before repair,
while the existing partial-refresh journal regression passed (1 pass, 1 fail).
Both real-query tests pass with revised source, including actual Identity
markup and As of visibility. The old-API banner and received-hold regressions
remain active; the latter now tests `PaperJournalNotice` rather than treating
generic `status` as journal-only evidence.

From `$S/workspace-r3-1/condor/frontend` after repair:

```bash
V5_WORKSPACE_ROOT="$S/workspace-r3-1" node --test --test-concurrency=2 test/v5-*.test.mjs
./node_modules/.bin/tsc -b
./node_modules/.bin/eslint src/v5/OwnerJournalCondition.tsx src/v5/usePaperObservation.ts
```

V5 Node: 359 passed, 0 failed. Focused journal suite: 21 passed.
TypeScript and focused ESLint: exit 0. Source clock files remain unchanged.

From `$S/workspace-r3-main/dashboard/condor-workspace`:

```bash
node --test --test-concurrency=2 test/*.test.mjs
```

Physical main baseline: 573 passed, 0 failed, 0 skipped (206.83 seconds).
The same command from `$S/workspace-r3-2/dashboard/condor-workspace` with
revised physical Condor source and the two root-owned journal tests passes
575/575, 0 skipped (258.10 seconds). This is feature-source evidence, not the
pending root gitlink qualification against a Condor merge commit.

## Bundle

From `$S/workspace-r3-1/condor/frontend`:

```bash
V5_WORKSPACE_ROOT="$S/workspace-r3-1" node node_modules/vite/bin/vite.js build --config vite.v5.config.ts --outDir "$S/r3-seed" --emptyOutDir false
node tooling/check-v5-reproducibility.mjs verify "$S/r3-seed"
node tooling/check-v5-reproducibility.mjs rebuild "$S/r3-reproducibility" "$S/workspace-r3-1" "$S/workspace-r3-2"
```

The old manifest rejects the changed seed. `distHashes` generated the new
manifest; only entry, entrySha256 and files changed. Two builds each match
35/35 files. Entry: `assets/v5-gDDIR_KW.js`, SHA256
`f3dbecb368dbf8c37a27f60020e6533e408090b22c778ceb32ec291f7546faf1`.
Vite's existing mixed-import/chunk-size warnings remain; both builds exit 0.

## Authority and remaining gate

This is repository-only work. No install, deploy, restart, live change,
external notification or clock edit occurred. Revert this revision for
repository rollback. Parent re-review and merge authority remain separate.
Root #632 must bind the eventual #89 merge commit and pass its full dashboard
suite before merge. A feature-source run is not that gitlink qualification.
