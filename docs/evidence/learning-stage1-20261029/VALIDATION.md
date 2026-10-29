# WP09 and minimal WP14 — verified handoff

## Result

Fixture implementation is complete. It stays disabled by default. No provider,
research execution, native activation, deployment or trading action occurred.
No subagents were started. No contract change is requested. Condor #82 at
`a9422fd32a4a17de9a68b06d25bc30768b91c282` remains the PR base.

The nine role descriptions and all inherited source, tests and screenshots were
preserved. The recovered worktree contained more partial files than the original
handoff listed. This task reviewed and completed that whole package.

## Changed

- Fixed twelve-role code manifest, including the nine new specialist descriptions.
  Models and tools cannot come from Markdown. All new bindings remain blocked;
  the empty tool allowlist denies all. Existing V5 advisory paths stay separate.
- Bounded fixture-only lessons, releases, adoption, retraction, campaign,
  candidate and workflow projections. Scope, identity, hash, clock and page bounds
  are checked. Missing release bindings remain visibly blocked.
- Explicit job lifecycle, state history, nonzero reservations, UNKNOWN usage,
  no-dispatch evidence and no-replay behavior from UPDATE 3.
- Learning, research factory and decision lineage views. They reuse #79 tiles
  and filterable, keyboard-resizable tables. Exact references and UTC times remain
  inspectable. Trial references never imply a known outcome.
- Regression repairs: reject future-available candidates; reject malformed nested
  bindings, schema identities and lifecycle shapes as validation errors; do not
  show zero blocked roles when the role manifest is missing.

## Contract identity

The ten embedded owner fixtures were compared directly with JSON at rsibot #602
`798ea9b4da65006e3010597ea55fe527a0b80ffc`: **PASS, exact decoded equality**.
The canonical source module hash is
`568c72a9a90829a57a9747e3d93d1d727107104064a4b92fca7f95ccec3fd1e0`.
Native/API final heads remain #224
`4f0e98f456d6b4e3f3cb7979aadec8bf9c9b614c` and #75
`5e93ef6177562677c349aa7474fc9013b216387d`.

Full semantic validation and reference resolution remain with the owners.
Condor does not claim that a displayed envelope has passed every owner gate.
WP03 integration is not enabled: the fixed workflow request route returns only
explicit fixture previews when constructor-bound; otherwise it returns disabled.
There is no dispatch queue, generic delegation, or paid request to replay.

## Commands and results

Run from this Condor worktree unless a different directory is stated:

```bash
export TMPDIR=/home/rsi/dev/rsibot/.workspace/scratch/learning-condor-stage1-resume/tmp
export UV_PROJECT_ENVIRONMENT=/home/rsi/dev/rsibot/condor/.venv
export PYTHONPATH=.:tests
uv run --with pytest-asyncio pytest tests/test_v5_role_registry.py tests/test_v5_learning_projection.py tests/test_v5_workflow_projection.py tests/test_v5_learning_isolation.py tests/test_v5_workspace_auth.py tests/test_v5_workspace_upstream.py tests/test_v5_audit_regressions.py tests/test_v5_paper_binding.py --basetemp="$TMPDIR/pytest-wp09-final" -p no:cacheprovider -q
uv run --with pytest-asyncio pytest tests/test_v5_*.py --basetemp="$TMPDIR/pytest-all-v5-final" -p no:cacheprovider -q
```

- WP09: **PASS, 158 tests**.
- Complete existing/new Condor V5 backend suites: **PASS, 778 tests**.
  Twelve existing aiohttp deprecation warnings remain.
- First direct Python attempt: **FAIL at collection**, because the environment
  lacked the tests import path and pytest-asyncio. Correcting the command above
  resolved it; no product code workaround was added.

From `frontend/`:

```bash
node --test test/v5-learning-projection.test.mjs test/v5-research-factory.test.mjs test/v5-decision-lineage.test.mjs test/v5-workspace-policy.test.mjs test/v5-workspace-evidence.test.mjs test/v5-paper-binding.test.mjs
node --test test/v5-*.test.mjs
npx eslint src/v5/LearningPanel.tsx src/v5/ResearchFactoryPanel.tsx src/v5/DecisionLineagePanel.tsx src/v5/V5App.tsx src/v5/api.ts test/v5-learning-projection.test.mjs test/v5-research-factory.test.mjs test/v5-decision-lineage.test.mjs
npm run lint
npm run build
```

- WP14: **PASS, 32 tests**. All V5 frontend files: **PASS, 93 tests**.
  Node counts include shared test-module imports; they are not 93 independent flows.
- Changed frontend source/tests lint: **PASS**.
- Repository lint: **FAIL, four errors and one warning already present at #82**.
  Reproduced the same five rules against `git show HEAD:<file>` via ESLint stdin:
  RecordedCandleChart.tsx:14, DataTable.tsx:144 (warning),
  V5AppShell.tsx:32 at base / :35 here, policy.ts:105 and :290.
  No unrelated lint repair was made.
- Ordinary frontend build: **PASS**.

From the rsibot root:

```bash
node dashboard/v5-workspace/build.mjs /home/rsi/dev/rsibot/condor/.worktrees/learning-stage1-20261029/frontend
python3 scripts/check_agent_context.py
```

- Complete private dashboard build: **PASS**, including its typecheck.
  Existing chunk-size/dynamic-import warnings remain.
- Agent context check: **PASS**. This is a static check, not model-behavior proof.
- Black and isort on the four new backend modules, four new test files and
  disposable fixture launcher: **PASS**. `git diff --check`: **PASS**.

New regression evidence is retained in `logs/boundary-red.log`,
`logs/shape-red.log` and `logs/ui-red.log`. They failed before repair. Their
corresponding final suites pass. Logs contain no production credentials.

## Browser evidence

The disposable launcher is `fixture_dashboard.py` in this directory. It uses
constructor-injected fixtures, a separate runtime directory and a fake upstream.
Source dates inside the pinned synthetic records remain their original epoch
dates; these are not real market observations. The snapshot generation clock is
explicitly frozen. Forecast quality, inventory, bags, capital occupancy, risk
restrictions, rollback and native execution stay UNKNOWN when unbound.

The exact tailnet HTTPS origin on Razer port `24443` was opened in the shared
real browser. Upstream port was `18795`. Authentication succeeded. Learning,
factory and lineage loaded without read errors. All three views were captured at
1440 and 390 CSS-pixel viewport widths in light, dark and colour-blind themes.
Each capture was looked at through full-size images or labelled contact sheets.
The browser export may downscale/crop its raster; the viewport widths were
independently read through `innerWidth`.

Observed checks:

- Factory owner pagination visited all eight pages through candidate 199.
  The final next-page button was disabled. Catalog counts stayed 200/10/200.
- A final populated-trial fixture was also captured in all six size/theme states.
  All bounded trial refs remain available. Missing outcomes stay unknown.
- Search for DISPATCH_UNKNOWN produced one job row. Keyboard ArrowRight on the
  focused resize separator changed its accessible width from 150 to 166.
- Mobile navigation opened and navigated to Learning. Evidence expansion exposed
  all ten release consumer bindings. Adoption and retraction sections were checked.
- Document width equalled viewport width at 1440 and 390. Wide tables scroll in
  their own regions. No unnamed buttons/inputs or read-error alerts were found.
  This is a scoped smoke, not a full WCAG conformance audit.
- The existing global V5 banner still truthfully says baseline/account owners are
  unbound. It was not hidden or relabelled as a healthy production connection.

`resume-captures.json` maps each preserved PNG name to its browser artifact.
Use final-factory images for the final populated-trial view. Earlier factory
images intentionally retain the empty-trial state. Earlier inherited PNGs without
the `resume-` prefix are preserved history, not final verification evidence.

Final contact sheets:

- `resume-contact-learning-1440.png`
- `resume-contact-learning-390.png`
- `resume-contact-final-factory-1440.png`
- `resume-contact-final-factory-390.png`
- `resume-contact-lineage-1440.png`
- `resume-contact-lineage-390.png`

Additional detail captures: `resume-learning-390-lower-light.png`,
`resume-learning-1440-bindings-light.png`,
`resume-learning-1440-adoption-light.png`.

After verification, only task Serve route `24443` was withdrawn. Parsed Serve
configuration before/after proves every pre-existing route is unchanged,
including inherited route `23443`. The task browser tab was closed and only the
new disposable server process was stopped. No protected running surface changed.

## Shared-file hunks

The four shared files retain exactly the recovered minimal source diff:

- `condor/v5/app.py`: import at 29; constructor injection at 258; authenticated
  router registration at 348; three SPA deep links at 1204. Seven added lines.
- `frontend/src/v5/V5App.tsx`: three imports at 14; three route entries in the
  existing route expression at 77. Four additions, one replaced line.
- `frontend/src/v5/V5AppShell.tsx`: three navigation entries at 16–18. Three additions.
- `frontend/src/v5/api.ts`: non-authorizing read helper at 95. Eight additions.

No other #79/#82 shared hunk changed.

## Blocked on me / limits

No operator input is needed for this fixture PR. New owner bindings, paid budgets,
production deployment, readiness and execution remain separately gated. D02–D13
remain unresolved. No thresholds or trading authority were invented.

The worktree remains intentionally: the task forbids deletion. All task files and
evidence are committed on the task branch. Rollback is to leave this stacked PR
unmerged. No restart, data migration or production rollback is required.
