# V5 dashboard polish — 2026-10-31

## R1 freshness repair

Complete: shared retained-snapshot age labels for Capital, Bots and Paper
identity; shared 30-second freshness bound; explicit Capital clock and stale
total gating; negative-zero normalization. Retention, owner holds, progress
isolation and errors stay unchanged. Authority and rollback remain below.
Evidence: `docs/evidence/2026-10-31-v5-dashboard-polish/round3-r1.md`.
Seven defect probes fail before and pass after. Full suites and both typechecks
pass. Two real workspace roots reproduce the reviewed 35-file bundle.
Fresh independent review and integration requalification remain required.

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

## Fix round — independent review B1/B2

Cause: background progress replaced cached complete query data. Missing in-flight
sections then entered absence projections. Retain the complete query result at
the shared snapshot hook; expose attempt-bound progress separately. First-load
sections must say pending, not missing. Owner holds survive refresh and errors
until a complete newer result replaces them. Retain native as-of timestamps.

Also bind reads/progress to cancellation and attempt identity; normalize leading
zeros only in display; validate recursive financial fields in every TS section;
prove Python/TS parity. Strip trailing whitespace from committed evidence logs.
Regenerate the reviewed manifest against both paired branches. No authority change.

Deferred follow-ups: Checking can briefly hide a prior Stale/Unavailable health
summary; Settings adds a five-section read every 15 seconds; decimal significant
digits below 1e-6; pair-chart remounts. The injected-delay benchmark is included
in this round. Pagination remains serial within each worker, so deployed p95 is
not inferred from the pool size or fixture target.

Final local evidence: `docs/evidence/2026-10-31-v5-dashboard-polish/round2.md`.
4,256 Python passes / 8 skips, 1,079 Node passes / 1 skip, 446 workspace Node
passes, both typechecks pass. Final focused regressions/bundle checks: 47 passes.
Python/TS agree on all 14 object-section monetary-container cases. Before-diff
whitespace findings: 32; after: zero. Cross-root bundle: 35 identical files.
Injected 300 ms/request Bots p95: 3.114860 s serial, 1.285031 s pool three,
20 timed samples each. No deployed latency or independent approval is inferred.
