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

## Round-3 review repair: shared clocks and early safety signals

Completed fixture repair: one shared 5,000 ms future-skew validator, exact
<= 30,000 ms freshness, millisecond page-session high-water clocks, compact
stable retained labels and Operations parity. Positive received emergency,
pause and native entry-hold signals render before the snapshot completes.
Retention/query/coherence semantics remain unchanged. Both reviewer regressions
are retained in the workspace test suite and pass fully.

Final receipt: `docs/evidence/2026-10-31-v5-dashboard-polish/round4-clocks.md`.
4,256 Python pass / 8 skip; 1,091 Condor Node pass / 1 skip; 506 workspace Node
pass; both typechecks pass. Rebuilt manifest and cross-root 35-file identity
are recorded there. #625 was validated against the newer linked Condor checkout,
not its `be2a3365` pin. Merge #85 and bump that pin before building #625.
No new deployed latency, browser or qualification claim. Existing deferred
Settings extra read, sub-1e-6 digits and pair-chart remount items remain deferred.

## Round-4 review repair: document/query lifetime

Completed: document-wide singleton clock/high-water mark with one subscription
set and interval; positive risk evidence retained for the lifetime of the cached
Query, separate from totals/progress; received late risk signals preserved after
peer failure. Emergency signals override an older clear data snapshot and render
beside first-load errors. Only a complete newer snapshot clears older signals.

New evidence: `docs/evidence/2026-10-31-v5-dashboard-polish/round5-cache-safety.md`.
Original Claude probes: 0/5 -> 5/5 pass. GPT faithful probes: 9/13 -> 13/13 pass.
Real-hook regressions: 0/15 on old source -> 10/15 pass. Unsafe no-high-water,
per-hook-clock and always-fresh mutants trigger 6, 2 and 2 assertion failures.
Full suites: 4,256 Python pass / 8 skip; 1,110 Condor Node pass / 1 skip; 529
workspace Node pass. Both typechecks pass. Rebuilt cross-root 35-file manifest.
The #625 Condor-pin dependency, held merge order and requalification requirement
remain. No new browser, deployed latency, service or authority claim.

## Round-5 review repair: render and risk boundaries

Scope: Condor #85 at `d4f15a67` and workspace #625 at `585e993fc`.
Authority remains repository-process-only. No API, live stack, service, unit,
Docker network, learning-route, deployment or trading changes are authorized.
Rollback is a revert of this round's feature commits; no runtime state changes.

Completed implementation: observe the document clock before the external-store
read on every render. Keep `getSnapshot` cached. Remove the temporal harness's
synthetic focus dispatch. Retain both reviewers' real React/QueryClient suites,
including layout-effect first-frame capture and stopped-interval rerenders.

Safety clearance now uses the coherent completed risk section, never status.
The risk must be available, complete, schema-valid and affirmatively clear.
Compare owner `source.boot_id` and `source.sequence`, not wall time. A subsequent
qualified replacement boot supersedes the previous boot; sequence orders reads
within a boot. Missing ordering evidence retains safety fail-safe. A retained
null generated time does not prevent clearance when owner ordering is known.
First-load errors render an unavailable panel beside retained safety evidence.

Validation: both reviewer baseline failures; real-renderer regressions; unsafe
clock, unavailable-risk, timestamp-order and pending-error mutants; full Python
and both Node suites; both typechecks; targeted lint; independent-root V5 bundle
rebuild and full-branch whitespace checks. Record results and hashes in
`docs/evidence/2026-10-31-v5-dashboard-polish/round6-render-boundaries.md`.
Keep #625's old Condor pin explicit: merge #85 and bump the pin before build.
Keep #84 independent; regenerate the manifest if it merges second.

Deferred, not repaired in this round:
- Positive safety evidence expires with the Query after gcTime while unmounted.
- A pre-sleep committed frame cannot change until an event or render occurs.
- Previous stale/unavailable summary briefly replaced by Checking on refresh.
- Settings extra five-section read, sub-1e-6 significant digits, pair-chart remounts.
- Deployed latency and separate requalification remain unverified here.

## Round-6 review repair: selective safety supersession

Input: Condor `d81f105f` and workspace `6ad6fa0e`. Authority and rollback remain
repository-process-only and revert-only. No services or owner changes.

Separate qualification to supersede from absence of holds. A coherent completed
risk read supersedes older safety evidence by owner boot/sequence if it is
available, complete, schema-valid, has no continuation, and every controller
explicitly publishes boolean paused, emergency and native-complete flags. It
may still carry holds. Its own signals remain visible. Missing flags, degraded
risk, incomplete risk and unknown ordering keep older evidence fail-safe.

Retain scoped-resume, named-durability-reset, mixed-controller and explicit
emergency-clear regressions at both the pure boundary and real QueryClient
completion path. Restore the obsolete all-clear condition as an isolated mutant
and require all four real-renderer scenarios to reject it. Run full suites,
both typechecks, lint, whitespace checks and independent-root bundle rebuilds.
Results: `docs/evidence/2026-10-31-v5-dashboard-polish/round7-selective-supersession.md`.

Workspace test prerequisite: run `npm ci` in the linked Condor frontend first.
The real-renderer tests require Condor's happy-dom and react-test-renderer dev
dependencies; a stale symlinked node_modules is not sufficient. #625 still
requires #85 to merge and its Condor pin to be bumped before build.

Found, not repaired: the reviewer reports no in-boot emergency-clear path in
the pinned owner, because emergency is OR-merged at
`meridian_v5_paper_control.py:1129-1134`. This is pre-existing and unconfirmed
in this implementation round. The explicit emergency-clear fixture tests
consumer supersession, not the reachability of that owner operation.
The deferred gcTime safety expiry, pre-sleep frame and other items above remain.
