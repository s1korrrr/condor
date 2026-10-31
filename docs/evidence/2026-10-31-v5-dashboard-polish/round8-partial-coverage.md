# Round-7 repair: partial owner risk and scoped safety supersession

The two reported safety-supersession defects are repaired locally. Independent
review of the new heads remains required. Inputs: Condor `b599e513` and rsibot
`61edd9ecd`. No owner, API, clock, totals, query-retention or deployment changes.
The workspace delta is tests and evidence only. Its Condor gitlink is unchanged.

## Cause and shared-boundary repair

The owner deliberately publishes partial risk while any owner/native hold
remains. API #73 maps this to degraded. The complete/available-only gate could
not prune a superseded pause or named hold in those real owner flows.

The qualifier now also accepts degraded/partial risk only when its reason is
one of six pinned owner-hold or four native-entry-hold reasons, and that reason
is actually published among its own holds. Every present controller still
needs explicit boolean operator.paused, operator.emergency and native.complete
flags. Schema errors, a cursor, unknown reasons, OWNER_MARK_UNAVAILABLE and
other partial/degraded conditions remain fail-safe. Complete/available risk
continues to qualify under the same existing flags and schema requirements.

Qualification no longer discards a whole older risk read. Safety evidence is
superseded per bot/controller. A qualifying newer read may prune only covered
controllers. Missing controllers retain their signals, including after registry
removal in a replacement boot. Owner-level holds need an explicit newer hold
list. An omitted list is unknown, not an empty list.

Remaining safety scopes are projected from their original read; snapshot IDs,
owner boot/sequence and native values are preserved. Covered controllers and
covered owner holds are removed from that safety-only projection. It never
supplies data totals or replaces the retained complete data snapshot. This also
prevents a retained BNB emergency from resurrecting a covered BTC pause. The
banner states that omitted controllers remain unknown, not cleared.

## Pinned source and real fixtures

Pinned owner: `1e131c74ec7b3633780b22442d0ded08954ac3cc`,
`scripts/meridian_v5_paper_observation.py`. The workspace engine pin ee8ca6ad
has the identical observation file. Full file SHA256:
`85f351a494c8cd53947ebebd71c5374941745b6433b8b3e45c036a58f7ff77f4`.
The fixture `tests/fixtures/paper-c1-1e131c74/owner-observation.py.txt` is a
byte-identical source snapshot, checked against git show at the immutable pin.
It is test data, not imported or executed by production code.

The source-contract test derives the owner reasons from the explanations
dictionary and native reasons from causes.append. It compares them with the
production constants and checks the pinned hash and section partial rule.
All ten published reason classes have positive qualification tests. The API
partial-to-degraded mapping was checked at `5a24d9c2`,
`services/strategies/v5_advisory/paper_observation.py:368`.

The supersession scenarios now use the native-entry-holds and
ingress-unreadable-hold owner fixtures, mapped into the API envelope. The native
fixture supplies four explicit controller rows, including native.complete=false
for SOL. The ingress fixture supplies the remaining owner hold and real partial
metadata. Named reset removes stop_persistence_failed while ingress remains;
scoped resume clears BNB while another native hold remains. Mixed updates and
explicit emergency-clear consumer fixtures use that same partial shape.
Complete API fixtures remain an additional path for the GPT coverage case.

The raw clock-anomaly fixture contains a quarantined numeric timestamp of 1e18.
Existing TS validation rejects that unsafe integer. It is retained as a negative
schema/fail-safe case; the validator was not loosened to make it qualify. Thus
the valid positive owner-hold scenarios use ingress rather than normalizing the
quarantined clock evidence. This is not a claim about owner emergency-clear
operation reachability, which remains unconfirmed in the task plan.

## Fail-before and pass-after

| Regression set | Before | After |
| --- | --- | --- |
| Original Claude partial-owner-hold probes | 0 pass / 2 fail | 2 pass |
| Original GPT omitted-controller real-renderer probe | 0 pass / 1 fail | 1 pass |
| Final ten real-query scenarios, original b599e513 safety source | 2 pass / 8 fail | 10 pass |

Claude's probe uses FE to select the repaired checkout. GPT's baseline ran with
its supplied deps.cjs. Its portable after-copy changes only the helper import
to this paired checkout; assertions are unchanged. The final ten-scenario
baseline uses the real renderer/QueryClient helper with only paper-safety.ts
replaced in memory by git show b599e513. No source file is edited for baseline
or mutation runs. The two baseline passes are missing owner-list retention and
non-hold partial rejection, already conservative in the old qualifier.

Coverage tests exercise both complete API risk and partial owner risk, omitted
controllers, registry removal/new boot and repeated renders. Unit tests also
prove later explicit coverage can clear a retained signal, and a later explicit
owner-hold list can supersede owner evidence. Nine unknown-flag cases, existing
incompleteness and equal/lower-sequence cases remain intact. Existing real
first-frame, error, refocus, skew, hold-retention and bot-switch tests still pass.

## Mutation evidence

| Removed safeguard | Real-renderer assertion failures |
| --- | ---: |
| Partial qualification | 4 |
| Controller coverage | 4 |
| Owner-hold-list coverage | 1 |
| All-clear-only supersession restored | 4 |
| Qualification bypassed for populated mark-fault risk | 1 |
| Render sampling / first-load error display / timestamp ordering | 2 / 1 / 2 |

All eight boundary mutation audits pass by rejecting their mutants. Earlier
no-high-water, per-mount-clock and always-fresh audits still trigger 6 / 2 / 2
assertion failures. Audits require ERR_ASSERTION, exact failure counts and no
snapshot-cache/render-loop warnings; setup failures do not count.

The old null-body unavailable-risk regression remains unchanged. Coverage now
also protects that case when qualification is bypassed, so the qualification
mutant targets a populated OWNER_MARK_UNAVAILABLE risk read with explicit
controller coverage. This isolates the qualification guard rather than relying
on absent data. Intermediate extractor, label and mutation-harness failures
are retained in the initial logs; final stable-source suites supersede them.

## Commands and dependency setup

All temporary data uses TMPDIR under
`/home/rsi/dev/rsibot/.workspace/scratch/v5-dashboard-polish`. Run npm ci in the
linked Condor frontend first: happy-dom and react-test-renderer are locked
Condor devDependencies, not supplied by a stale shared node_modules link.
This round ran `npm ci --ignore-scripts --no-audit --no-fund` there.

```bash
# Condor task worktree
export TMPDIR=/home/rsi/dev/rsibot/.workspace/scratch/v5-dashboard-polish
PYTHONPATH=.:tests:/home/rsi/dev/rsibot/.workspace/scratch/v5-paper-dashboard/pytest-plugin \
  /home/rsi/dev/rsibot/condor/.venv/bin/python -m pytest -q -o addopts= tests
node --test --test-reporter=tap frontend/test/*.test.mjs
(cd frontend && node_modules/.bin/tsc -b)
(cd frontend && node_modules/.bin/eslint src/v5/paper-safety.ts)

# Paired workspace worktree, dashboard/condor-workspace
node --preserve-symlinks --test --test-reporter=tap test/*.test.mjs
../../condor/frontend/node_modules/.bin/tsc --noEmit -p .
```

Final Condor Node: 1,155 pass / 1 skip. Workspace Node: 567 pass.
Both typechecks and targeted lint pass. The full Condor suite includes 48
owner-contract, supersession and risk-evidence checks. The workspace suite
includes ten real-query scenarios and eight boundary mutation audits. No
snapshot-cache, render-loop or unwrapped-act warnings occur in the final log.
Expected react-test-renderer deprecation notices remain. Full-branch whitespace
checks pass in both repositories. Logs are stripped of trailing whitespace and
stored with gzip -n.

Final Python: 4,256 pass / 8 skip / 18 warnings in 201.88 s. The first full
run, concurrent with the Node suites, had 4,255 pass / 8 skip and one failure
in the existing fleet-summary 100 ms Event.wait watchdog. Its untouched
standalone rerun passed in 1.09 s. The final full Python run followed both Node
suites sequentially and passes. Both the original failure and final logs are
retained; no test timeout, source behavior or assertion was weakened.

## Rebuilt reviewed bundle

```bash
node frontend/tooling/check-v5-reproducibility.mjs rebuild \
  "$TMPDIR/round8-final-repro" \
  /home/rsi/dev/rsibot/.worktrees/v5-workspace-polish \
  "$TMPDIR/workspace-independent"
```

Two independent workspace roots reproduce all 35 reviewed files. Entry:
`assets/v5-BuCUXUL9.js`. Entry SHA256:
`e53e13fb94fafcc31eee956f4d167de6867a3d83c0740a5d4bf05c15fdd50f79`.
Manifest SHA256:
`8a0f9143fb2c2c25de6466f686a59a294d06fd0d7d1e7db23eecf3faffd185ca`.

## Integration limits and rollback

Workspace checks use the newer linked Condor checkout, not #625's unchanged
be2a3365 gitlink. Merge #85 and bump that pin before building #625. Whichever
Condor branch merges second with #84 must regenerate the manifest. Both drafts
remain held for the live-trial move, paired integration and requalification.
No new browser, deployed latency, live service, stack, unit, Docker network,
Mac or trading claim. Revert this round's feature commits to roll back; no
runtime operation is required. Unmounted Query-gcTime evidence expiry and the
pre-sleep frame remain deferred. No unrelated source behavior was changed.
