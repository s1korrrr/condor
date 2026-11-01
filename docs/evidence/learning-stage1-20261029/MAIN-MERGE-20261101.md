# PR #84: merge paper-read hardening from main

## Result and scope

Phase 1 passes the requested local checks. This work does not merge the PR,
update rsibot #625, build an image, publish a service, or change a running stack.

- PR branch: `feat/andrzej_learning_stage1_condor_20261029`.
- First parent: `c2dcc1ad1a98e3ca52729dd8e07429089044c0e9`.
- Main parent: `22f520f2222c0f87fff8886a50a0259d7f183f85`.
- Authority: repository-process-only and disposable local build/test files.
- Forbidden: live services, provider calls, orders, credentials, real research
  data writes, merges on GitHub, force-pushes, and history rewrites.
- Completion bar: a two-parent merge, preserved learning and paper-read behavior,
  reproducible V5 bundle, full owner checks, and a normal push to the existing PR.
- Rollback: revert the published merge with a new reviewed commit. Do not reset
  or rewrite the branch. No runtime restart is needed or authorized.

The original PR branch is checked out in another clean worktree. To preserve
that checkout, this task fetched origin and created its own detached worktree
from the exact remote PR head. It pushes `HEAD` to that existing remote branch.
It does not move the other worktree's local branch or edit its files.

## Merge and conflict resolution

Command: `git merge --no-ff --no-commit origin/main`.

The only textual conflict was `frontend/v5-reviewed-build.json`. Neither parent's
manifest describes the combined module graph. Regenerate it from the merged
build with the unchanged exported `distHashes` helper, the built `v5.html` entry,
and `verifyDist`. Do not hand-select one parent's asset names or change the gate.

`condor/v5/app.py` merged automatically. It retains main's read behavior and
#84's disabled learning router. No source conflict required manual resolution.

## Read-path identity

Compared every existing file under `frontend/src` and `condor/v5` with main
`22f520f2222c0f87fff8886a50a0259d7f183f85`. Exactly 362 files have identical
bytes. This includes the dedicated Bots, Settings, Readiness, Operations,
Market, paper-owner, dashboard-bridge, clock, safety, and observation sources.

Four shared integration files are **not** byte-identical to main:

- `condor/v5/app.py`: learning import, injected source, router, and static routes.
- `frontend/src/v5/V5App.tsx`: three learning imports and three learning routes.
- `frontend/src/v5/V5AppShell.tsx`: three learning navigation entries.
- `frontend/src/v5/api.ts`: the separate non-authorizing `learningRead` helper.

Removing only those explicit learning additions restores exact main bytes in
all four files. In particular, Capital and Operations bodies in `V5App.tsx`
remain unchanged. The literal claim that every shared read-path file is
byte-identical would be false; this report does not make that claim.

The machine-readable 362-file SHA256 inventory and the shared-file check are
retained in the task's scratch `read-path-identity.json`.

## Bundle evidence

- Before, PR #84: `assets/v5-CdTC88sa.js`.
  SHA256: `d1b16d36276d6f0f2fae0a961baea406b9b32dc64246425e7c984615d23e6297`.
- Before, main: `assets/v5-OBYSWSaP.js`.
  SHA256: `1511494b786890b341dd283d5215435a3fc511daeae46e98f8ec5481210620ec`.
- After merge: `assets/v5-DBz0T5N9.js`.
  SHA256: `68b0d052d8fcf541fe818b70e1f1b076ef10a63cbf14405b3d60c17cd2748e7d`.
- Candidate build and two fresh independent output directories: all 35 files
  match the regenerated manifest. File membership and SHA256 contents match.
- Negative control: the original #84 manifest rejects the merged output.
- The manifest verifier, Vite configuration, Docker recipe, and locks are unchanged.

Private dashboard inputs were copied to scratch. They still match the root
source bytes at `1cd593aaa42dccabf6eb3e9bb6376a0af442c7af`. The native V5 builder
also runs its complete private-dashboard TypeScript check before the Vite build.

## Exact checks

Run from the task's Condor worktree:

```bash
export S=/home/rsi/dev/rsibot/.workspace/scratch/v5-paper-batch-20261101
export TMPDIR="$S/tmp"
export PYTHONPATH=.:tests:/home/rsi/dev/rsibot/.workspace/scratch/v5-paper-dashboard/pytest-plugin
(cd frontend && npm ci --no-audit --no-fund)
/home/rsi/dev/rsibot/condor/.venv/bin/python -m pytest -q -o addopts= tests
node --test frontend/test/*.test.mjs
frontend/node_modules/.bin/tsc -b frontend/tsconfig.json
node "$S/workspace/dashboard/v5-workspace/build.mjs" "$PWD/frontend"
(cd frontend && npm run build)
node frontend/tooling/check-v5-reproducibility.mjs verify frontend/dist-v5
node frontend/tooling/check-v5-reproducibility.mjs rebuild "$S/repro" "$S/workspace" "$S/workspace"
git diff --check
git diff --cached --check
git diff --check origin/main
```

- Full pytest: **4,365 passed, 8 skipped**, 18 warnings, 288.07 seconds.
- Full Node suite: **1,223 passed, 1 skipped**, 0 failed, 1,224 total.
- Condor TypeScript, full private V5 TypeScript, ordinary frontend build, V5
  build, manifest checks, and whitespace checks: **PASS**.
- V5 build warnings: existing large chunks and mixed static/dynamic imports.
- Fresh browser, image, deployed runtime, and live-stack checks: **not run**.
  They are outside Phase 1. No independent review is claimed.

Logs, the original manifests, rebuilt outputs, and identity inventory remain
under `$S`, outside the removable worktree. Root-main sync was checked with
`python3 scripts/sync_root_main.py --dry-run --skip-research`; it did not refresh
or write the real research data. Other checkouts and dirty work are preserved.

## Handoff boundary

Blocked on parent: review and merge #84, then supply the final Condor main SHA
before Phase 2.

Changed: a merge from main, the generated V5 manifest, and this evidence note.

Found: no failing executed check. Four shared integration files necessarily
carry #84 learning additions; dedicated read implementations match main bytes.
