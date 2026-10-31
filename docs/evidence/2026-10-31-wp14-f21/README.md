# F21: one deterministic V5 bundle

## Conclusion

The direct Vite recipe and the Docker recipe now produce identical dist trees.
All 35 files match the committed `frontend/v5-reviewed-build.json` manifest.
The canonical entry is `assets/v5-BdG4FGa7.js`:

`7393b0aed4dda1c735455071737ae12be388fb04c98e85fe7b5631acf32f12b8`

This replaces the old direct-build reference, `v5-PXRF8ydq.js`, whose SHA256 was
`fe4ad689dc593f9820101e527966f7c00a0f1a65053d4c96ddf108d8c62df9a4`.
This is a build-config-only change. No runtime source, owner data contract, or
dashboard source changed. The new reference still needs the parent's review;
this evidence does not grant approval, deployment, or trading authority.

## Exact cause

The direct recipe's `V5_WORKSPACE_ROOT/condor/frontend` symlink resolves to the
archived FINAL3 Condor checkout, `condor-8af1b1c37cd3/frontend`. Its workspace
models import `../../../../../condor/frontend/src/features/trading-visuals/sources.ts`.
The current Condor frontend imports the same file from its own checkout.

Vite identifies modules by resolved path, not source hash. The direct recipe
therefore included two copies of this identical module. Docker's workspace
builder stages a symlink to the current frontend, so it included one copy.
That changes chunk boundaries, import/export wiring and dependent chunk hashes.

`source-map-comparison.json` compares the full source maps from both recipes:
957 versus 956 module instances. The only source-content multiplicity difference
is `sources.ts`, SHA256
`5ea71a4ea1c7342a5dbaa00ca6b82ad789cb3989ec16b5f96f8aaec9b211ac1f`.
The duplicate is in `src-CL1-RYfi.js`; the current copy is in `v5-PXRF8ydq.js`.
The canonical build includes it once in `v5-BdG4FGa7.js`.
All other source-content hashes and their multiplicities match.

The two workspace `dashboard/condor-workspace` trees compare byte-identical.
Both recipes use Vite 8.2.2 and the same package-lock SHA256:
`794a06a6347e210ae510e87aa3c3c86d54d2d2b98fcfc82bf6c9865e113e2f10`.
Direct Node is v24.21.0 (npm 11.19.0). Docker retains its digest-pinned Node 22
base and `npm ci`. The canonical output matches across both toolchains.
No timestamp, git label, build ID, or environment define caused this mismatch.

## Repair and drift gate

The V5-only resolver maps relative workspace imports into `condor/frontend`
back to the current owning frontend. It no longer imports archived Condor files.
The ordinary Condor build and the workspace dashboard source are unchanged.

The Docker build verifies every output file against the committed SHA256
manifest before copying it to the runtime image. Changed, missing, or extra
assets fail the build. This is an independent rebuild, not a copied dist overlay.
Keep the existing digest-pinned Node image and lockfile. A future intentional
bundle change must update the manifest as an explicit reviewed artifact change.
Do not generate the expected manifest inside the image build.

`frontend/tooling/check-v5-reproducibility.mjs rebuild NEW_OUTPUT WORKSPACE
[SECOND_WORKSPACE]` makes two fresh output directories. It rebuilds and checks
both against the same manifest. The output parent must not already exist.
The optional second root tests different workspace layouts. The script never
deletes prior evidence. `verify DIST` checks an extracted image dist too.

## Fail-before / pass-after

Commands run from the Condor worktree, with:

```bash
export TMPDIR=/home/rsi/dev/rsibot/.workspace/scratch/v5-paper-dashboard/tmp
S=/home/rsi/dev/rsibot/.workspace/scratch/v5-paper-dashboard/f21
OLD=/home/rsi/dev/rsibot/.workspace/scratch/v5-wp14/final3-20261030/src/workspace-f3dcee938f3c
STAGED="$S/staged"
```

`STAGED` contains the same dashboard source with `condor/frontend` pointing to
the current owner frontend, not the archived FINAL3 frontend.

| Command | Result |
| --- | --- |
| `node frontend/tooling/check-v5-reproducibility.mjs rebuild "$S/before" "$OLD"` before resolver fix | Expected FAIL, exit 1: old reference hash reproduced, then rejected |
| `node frontend/tooling/check-v5-reproducibility.mjs rebuild "$S/after" "$OLD" "$STAGED"` after fix | PASS: both independent builds match all 35 files |
| `node --test frontend/test/v5-build-reproducibility.test.mjs` | PASS: 1 test; changed, missing, extra assets and wrong entry hash reject |
| `node --test frontend/test/*.test.mjs` | PASS: 1034 passed, 1 skipped, 0 failed |
| `frontend/node_modules/.bin/tsc -b frontend/tsconfig.json` | PASS |
| Docker image build and extracted-dist verification | PASS: all 35 files match |
| `git diff --check` | PASS |

Both independent direct builds produce the canonical entry SHA256 above.
The independently compiled Docker frontend produces the same SHA256 and files.
The previous FINAL5 Docker dist also matches this manifest byte-for-byte.
The old reference was different because its module graph duplicated a source,
not because its source text differed.

Docker command (use the final commit for `CONDOR_SOURCE_COMMIT`):

```bash
export DOCKER_CONFIG=/home/rsi/dev/rsibot/.workspace/scratch/v5-wp14/final5-20261031/docker-config
export DOCKER_BUILDKIT=1
docker build --rm=false -f Dockerfile.v5 \
  --build-context workspace=/home/rsi/dev/rsibot/.workspace/scratch/v5-wp14/final5-20261031/src/workspace-a6791df0e490 \
  --build-arg CONDOR_SOURCE_COMMIT="$(git rev-parse HEAD)" \
  --build-arg WORKSPACE_SOURCE_COMMIT=f3dcee938f3c74528e44a677b053555008f7e973 \
  -t rsibot-v5-dashboard:f21-final .
```

The first Docker invocation lacked buildx and rejected `--build-context` before
building. The qualification's existing private Docker configuration fixed that
environment error. No package or runtime fallback was used.

## Boundaries and rollback

Paper/read-only projection authority. No protected project, unit, live store,
Mac, route, credential, or running service changed. No runtime was started.
Extraction containers and prior outputs remain. The pre-existing untracked
`.workspace/` directory remains untouched. Python was not rerun: backend source
and Python packaging are unchanged. No new browser claim or screenshot is made.
Hosted CI is not claimed. Rollback is a normal revert of this build-only commit.
The existing worktree remains because this task did not create it and its
retained evidence paths still use it.
