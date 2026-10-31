# V5 dashboard polish — 2026-10-31

## Contract

Objective: reduce fixture full-data latency with three concurrent pinned section
reads; retain two whole-read attempts, 409 restart and one bounded 503 retry.
Render same-snapshot partial sections honestly; withhold aggregate totals until
the complete read is available. Repair decimal, monitor-label, punctuation,
Settings-state and read-validator presentation gaps.

Authority: repository-process-only. Fixture reads and temporary private Serve
only. No API source changes, protected stacks, units, Docker networks, Mac,
trades, deployment, merge or promotion. Base: Condor be2a3365; workspace rsibot
origin/main. Do not edit learning routes or condor/v5/learning.py from #84.
This work merges only after the live-trial move and receives new qualification.

Evidence: API PaperEnvelope at 5a24d9c2; retained native replay fixtures.
Validate with focused fail-before/pass-after probes, full Python and Node suites,
tsc -b, workspace tests, API-app fixture benchmark, reproducible bundle builds,
and browser screenshots through a dedicated verified Tailscale Serve route.
TMPDIR and disposable evidence: .workspace/scratch/v5-dashboard-polish.

Rollback: revert the task commits; remove only the task's Serve route and stop
only the task's fixture service. No runtime restart is required or authorized.

## Progress

- Baseline inspected; shared root and owner checkouts preserved.
- Root sync Git CURRENT; research handoff refresh reported graph writer busy.
- Pool, strict consumers and presentation changes complete. Existing learning
  routes and learning owner remain unchanged.
- Final local checks: 4,242 Python passes / 8 skips; 1,060 frontend Node passes /
  1 skip; 443 workspace Node passes; both typechecks pass.
- Full-envelope API73 parity: 240 timed page reads; Bots p95 0.144023 seconds
  serial versus 0.124160 seconds with pool three. This is not FINAL6 requalification.
- Reproducible cross-root bundle: 35 identical files. Manifest and exact hashes
  are recorded in `docs/evidence/2026-10-31-v5-dashboard-polish/README.md`.
- Sixteen requested browser views and one extra fault view inspected. Own
  fixture process, browser tabs and Serve route removed; other routes preserved.
- Two unchanged baseline ESLint errors remain. Final full tests are green.
- Draft publication is separate from parent review, merge and requalification.
