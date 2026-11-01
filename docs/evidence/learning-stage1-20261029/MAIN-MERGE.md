# PR #84: merge current main

## Scope and authority

Merge `origin/main` into `feat/andrzej_learning_stage1_condor_20261029` with
`git merge --no-ff origin/main`. Do not rebase or force-push.

- Original PR head: `637ff764a6d63ad07f32735e13715544a0f9eb3a`.
- Main parent: `be2a3365801d9d1ec3e12d79a365c07ef1c4fefd` (merged #82).
- Authority: repository-process-only. No activation, deployment, services,
  protected stacks, systemd, Mac, model/provider calls, or orders.
- Preserve all unrelated state and existing evidence. Do not delete worktrees.
- Scratch and TMPDIR: `/home/rsi/dev/rsibot/.workspace/scratch/condor84-main-merge/`.
- Rollback: revert the published merge in a new reviewed commit; never reset or
  rewrite published history. No runtime restart is needed or authorized.

## Plan and completion bar

1. Inspect the exact parents and merge conflicts.
2. Preserve the read contract and disabled learning projections together.
3. Regenerate the reviewed manifest for the intentional frontend change.
4. Run the full requested Python, Node, TypeScript, V5 build, reproducibility,
   and whitespace checks. Inspect the final delta against main.
5. Commit the merge, push without force, and update PR #84.

## Conflict resolution

The only textual conflict was `frontend/src/v5/V5App.tsx`, in the imports.
Retain #84's `LearningPage`, `ResearchFactoryPage`, and `DecisionLineagePage`
and main's `usePaperWorkspace`. Keep main's coherent observation hook in Capital
and Operations and #84's three routes. No side replaces the other.

The automatic merge retains main's owner-typed fields, string-list capabilities,
snapshot-bound pagination capped at 200, bounded coherent retry, serial reads,
and reproducibility tooling. The final delta against main must not modify those
implementations. Learning bindings remain absent by default, with effect NONE.

## Build and validation

The old reviewed entry is `assets/v5-BdG4FGa7.js`, SHA256
`7393b0aed4dda1c735455071737ae12be388fb04c98e85fe7b5631acf32f12b8`,
with 35 manifest files. #84 intentionally adds learning components, routes,
navigation, and the learning read helper to the V5 module graph. The expected
bundle must change; the manifest verifier and Docker gate must not change.

Build inputs use the preserved F21 dashboard sources copied from
`/home/rsi/dev/rsibot/.workspace/scratch/v5-paper-dashboard/f21/staged/dashboard/`.
A scratch workspace points `condor/frontend` at this PR's frontend. The second
rebuild uses the existing F21 staged workspace to check path independence.
The existing sibling `condor/.worktrees/dashboard` layout is reused by Node
tests without changing it.

### Manifest result

The new reviewed entry is `assets/v5-CdTC88sa.js`, SHA256
`d1b16d36276d6f0f2fae0a961baea406b9b32dc64246425e7c984615d23e6297`.
The manifest still lists 35 files. Twenty-one are byte-identical to main;
thirteen content-hashed asset names change, and `v5.html` changes its links.
The old manifest rejects the new build with exit 1 before regeneration.
After regeneration, the candidate and two fresh independent builds pass the
unchanged verifier for all 35 files. No gate, lockfile, build config, or Docker
recipe was weakened or changed.

### Commands and results

Run from `/home/rsi/dev/rsibot/condor/.worktrees/learning-stage1-20261029`:

```bash
export S=/home/rsi/dev/rsibot/.workspace/scratch/condor84-main-merge
export TMPDIR="$S/tmp"
export PYTHONPATH=.:tests:/home/rsi/dev/rsibot/.workspace/scratch/v5-paper-dashboard/pytest-plugin
/home/rsi/dev/rsibot/condor/.venv/bin/python -m pytest -q -o addopts= tests
node --test frontend/test/*.test.mjs
frontend/node_modules/.bin/tsc -b frontend/tsconfig.json
(cd frontend && V5_WORKSPACE_ROOT="$S/workspace" node node_modules/vite/bin/vite.js build --config vite.v5.config.ts --outDir "$S/candidate-dist" --emptyOutDir false)
node frontend/tooling/check-v5-reproducibility.mjs verify "$S/candidate-dist"
node frontend/tooling/check-v5-reproducibility.mjs rebuild "$S/repro" "$S/workspace" /home/rsi/dev/rsibot/.workspace/scratch/v5-paper-dashboard/f21/staged
frontend/node_modules/.bin/tsc --project "$S/v5-full.tsconfig.json" --noEmit
git diff --check
git diff --check origin/main
```

The build output directories must be new for a later reproduction. Preserve
existing results. The full V5 typecheck config mirrors the private dashboard
typecheck helper, with its config and all dashboard inputs isolated in scratch.

- Python: PASS, 4,347 passed, 3 skipped, 18 deprecation warnings, 317.55 seconds.
  The fleet-summary timing test passed in the full suite; no rerun was needed.
- Node: PASS, 1,058 passed, 1 skipped, 0 failed (1,059 total).
- Condor TypeScript build: PASS.
- Full private V5/dashboard TypeScript check: PASS.
- V5 bundle: PASS; expected large-chunk and mixed static/dynamic-import warnings.
- Manifest negative check: expected FAIL against the old manifest, exit 1.
- Manifest positive check and two fresh rebuilds: PASS, all 35 files each.
- Worktree and PR delta whitespace checks: PASS.

Logs are in `$S/pytest.log`, `node-tests.log`, `tsc.log`, `v5-build.log`,
`old-manifest-rejection.log`, `repro.log`, and `v5-full-tsc.log`.
`manifest-change.json` records the exact changed asset names.

### Audit and limits

The final source delta against main adds only the learning projections and
their integration points. Main's paper owner, dashboard bridge, upstream,
frontend contracts, policy, coherent observation hooks, reproducibility tool,
Vite config, and Docker recipe remain unchanged. The merged source executes
main's hook in Capital and Operations and exposes all three learning routes.
The existing full Python and Node suites cover these boundaries together.

The staged first-parent delta includes eight trailing-whitespace lines in F21
raw logs already committed on main. They are not edits from this task. Preserve
those source receipts unchanged; the actual PR delta against main passes
`git diff --check origin/main`.

No browser, image build, deployment, or runtime activation was performed in
this merge task. Prior browser receipts remain historical, not fresh evidence
for this merge. No independent reviewer or new trading authority is claimed.
The existing worktree and all scratch evidence remain, as deletion is forbidden.
