# K17 Agent decisions history — writer handoff

## Root cause

The observation owner returned full advisory inputs and raw results before
Condor projected them. Two 64-KiB parts per record could exhaust Condor's
unchanged 256,000-byte transport guard before projection. The page therefore
requested only one record per agent.

There is also an inconsistent acceptance target: 100 records at all the stated
caps cannot fit under 256,000 bytes. Even an ASCII example with a seven-character
assessment uses 617,129 bytes. This repair does not manufacture a passing bound.

## Repair

- Authority: repository-process-only. No execution, control, or live-state path changed.
- Owner branch: `feat/andrzej_v5_k17_projected_history`, commit
  `e355455a602dfcf880203dbcf131ec5c89609591`, based on
  `13c16ae0cb77f2efa3d864d18d7b2e5b22fdebf1`.
- Reader branch: `feat/andrzej_v5_k17_history_reader`, based on
  `9713792a28f43c1de4982cf11c825ada026af7f0`.
- The new authenticated `GET /v1/advice/history/projected` accepts limits 1–100.
  It emits flat, whitelisted records, never advisory input or raw provider text.
  The legacy route retains its response and authentication contract.
- The projection retains request identity, task, status, effect, five owner
  times, bounded model, exact-string cost, coverage, and bounded advice. Pending
  requests retain their reservation time. Orphan results use the authoritative
  request task when their result has no task field.
- Condor reads only the projected route for the timeline, with canonical limits
  1–5. It retains the effect/time/task checks and rejects the complete envelope
  on a bad record. A missing projected route returns an explicit 503 code.
  There is no full-record fallback.
- The page requests five reports per agent. It retains newest-first ordering,
  dim historical rows, future/expired withholding, and honest bounded-history
  wording. An older owner gets an installation explanation.

### Transport bound

The accepted projection permits 128 request-ID characters, 256 status/model
characters, 64 ASCII cost characters, two 1,000-character advice strings, eight
64-character reason codes, and 32 128-character evidence references. Task,
coverage, effect, and five timestamps have fixed finite bounds. A JSON-escaped
control character can require six bytes. The tests use that wire worst case,
not just ASCII or a representative provider reply.

- One maximum projected record: **44,055 bytes**.
- Five-record envelope: **220,309 bytes**, leaving 35,691 bytes below the guard.
- Six-record envelope: **264,365 bytes**, over the guard.
- A 100-record envelope at those bounds: **4,405,629 bytes**, not under the guard.

Five is therefore the largest universally safe read limit under this accepted
field contract. Raising it needs a separate, explicit aggregate-byte contract,
smaller fields, or another transport design. The requested 100-record-under-cap
proof remains unmet because it is mathematically incompatible with the caps.

## Simplification

The journal reuses one read-only row query for both history views. Condor reuses
its existing display projector and the page's existing timeline/withholding
model. There is no second journal, new dependency, cache, retry, raw fallback,
raised response cap, spending path, or service.

## Verification

Every heavy command below ran serially under the unchanged gate with
`--thread dash-k17 --wait 5400 -- nice -n 10`. The gate eventually admitted the
worktree creation; it did not refuse this retry. No gate was bypassed.

Working directories:

- `W=/Users/s1kor/dev/trading/rsibot/.worktrees/mac.noindex/v5-k17`
- Owner: `W/hummingbot-api`
- Reader: `W/condor`
- Frontend: `W/condor/frontend`

Environment: Python 3.12, pytest 9.1.1, FastAPI 0.120.1, Pydantic 2.12.3,
Node v24.10.0. These are local checks, not qualification of the pinned Linux
observation image. No browser, device, deployed service, container, or live
endpoint was used.

### Exact gated commands and final results

Worktree setup — PASS, exit 0, detached root `a807c065f`:

```sh
python3 /Users/s1kor/.codex/.tmp/mac-gate/mac-heavy-gate.py --thread dash-k17 --wait 5400 -- nice -n 10 git -C /Users/s1kor/dev/trading/rsibot worktree add --detach /Users/s1kor/dev/trading/rsibot/.worktrees/mac.noindex/v5-k17 origin/main
```

Frontend directory — PASS, exit 0, 375 packages installed. npm reported 11
existing audit findings: seven moderate and four high. No audit fix ran.

```sh
python3 /Users/s1kor/.codex/.tmp/mac-gate/mac-heavy-gate.py --thread dash-k17 --wait 5400 -- nice -n 10 npm ci --ignore-scripts
```

Owner directory — PASS, **14 passed**, exit 0:

```sh
python3 /Users/s1kor/.codex/.tmp/mac-gate/mac-heavy-gate.py --thread dash-k17 --wait 5400 -- nice -n 10 /Library/Frameworks/Python.framework/Versions/3.12/bin/python3 -m pytest -q --tb=line test/test_v5_advisory_projected_history.py
```

Owner directory, broader advisory/observation selection — FAIL, **40 passed,
63 failed**, exit 1. Sixty failures are the pre-existing Linux `rsi` account
assumption; three are `/proc/self/fd` assumptions. Neither was weakened.

```sh
python3 /Users/s1kor/.codex/.tmp/mac-gate/mac-heavy-gate.py --thread dash-k17 --wait 5400 -- nice -n 10 /Library/Frameworks/Python.framework/Versions/3.12/bin/python3 -m pytest -q --tb=line test/test_v5_advisory.py test/test_v5_advisory_scheduler.py test/test_v5_advisory_service.py test/test_v5_advisory_quiesce.py test/test_v5_observation_app.py test/test_v5_advisory_projected_history.py
```

Reader directory — PASS, **477 passed**, exit 0:

```sh
python3 /Users/s1kor/.codex/.tmp/mac-gate/mac-heavy-gate.py --thread dash-k17 --wait 5400 -- nice -n 10 env PYTHONPATH=.:tests /Library/Frameworks/Python.framework/Versions/3.12/bin/python3 -m pytest -q --tb=line tests/test_v5_advisor_history.py tests/test_v5_workspace_auth.py tests/test_v5_workspace_upstream.py tests/test_v5_paper_read_contract.py tests/test_v5_dashboard_bridge.py
```

Reader directory, additional advisor privacy boundary — PASS, **3 passed**, exit 0:

```sh
python3 /Users/s1kor/.codex/.tmp/mac-gate/mac-heavy-gate.py --thread dash-k17 --wait 5400 -- nice -n 10 env PYTHONPATH=.:tests /Library/Frameworks/Python.framework/Versions/3.12/bin/python3 -m pytest -q --tb=line tests/test_v5_workspace_advisor_boundary.py
```

Frontend directory — PASS, **808 passed, 0 failed, 0 skipped**, exit 0:

```sh
python3 /Users/s1kor/.codex/.tmp/mac-gate/mac-heavy-gate.py --thread dash-k17 --wait 5400 -- nice -n 10 node --test --test-reporter=tap test/v5-*.test.mjs
```

Worktree root — PASS, **typecheck exit 0**:

```sh
python3 /Users/s1kor/.codex/.tmp/mac-gate/mac-heavy-gate.py --thread dash-k17 --wait 5400 -- nice -n 10 env NODE_OPTIONS=--max-old-space-size=1536 node dashboard/v5-workspace/typecheck.mjs condor/frontend .
```

Worktree root — PASS, **677 passed, 0 failed, 0 skipped**, exit 0:

```sh
python3 /Users/s1kor/.codex/.tmp/mac-gate/mac-heavy-gate.py --thread dash-k17 --wait 5400 -- nice -n 10 node --test --test-reporter=tap dashboard/condor-workspace/test/*.test.mjs
```

Worktree root — PASS, **four offline cross-owner scenarios**, exit 0:

```sh
python3 /Users/s1kor/.codex/.tmp/mac-gate/mac-heavy-gate.py --thread dash-k17 --wait 5400 -- nice -n 10 env PYTHONPATH=hummingbot-api:condor:condor/tests /Library/Frameworks/Python.framework/Versions/3.12/bin/python3 /Users/s1kor/.codex/.tmp/dash-k17/projected-history-smoke.py
```

That smoke routes real owner responses through the real `V5Upstream` byte guard
and real Condor app, using an in-memory HTTP adapter. It checks five records in
order, limit rejection before an upstream read, whole-envelope 502 rejection,
and older-owner 503 refusal without fallback. Fixtures remain local and retained.

### Red-before-green evidence and unsuccessful preparation

- The original nine owner route tests failed against the unchanged owner with
  404 instead of the required 200/401/422. The gated command was the focused
  owner command above with `--tb=short` instead of `--tb=line`.
- Four added noncanonical-limit cases returned 200 instead of 422; the orphan
  case returned 503 instead of 200. The focused owner command with `--tb=line`
  recorded **5 failed / 9 passed** before those repairs, then **14 passed**.
- The reader history file recorded **33 failed / 15 passed** before its repair:

```sh
python3 /Users/s1kor/.codex/.tmp/mac-gate/mac-heavy-gate.py --thread dash-k17 --wait 5400 -- nice -n 10 env PYTHONPATH=.:tests /Library/Frameworks/Python.framework/Versions/3.12/bin/python3 -m pytest -q --tb=short tests/test_v5_advisor_history.py
```

- The frontend/guarded-route regression command recorded **37 passed / 5 failed**
  before its repair, including the parent test count:

```sh
python3 /Users/s1kor/.codex/.tmp/mac-gate/mac-heavy-gate.py --thread dash-k17 --wait 5400 -- nice -n 10 node --test test/v5-agent-decisions.test.mjs test/v5-route-render-loop.test.mjs
```

- Early owner fixture preparation recorded nine setup errors for the missing
  host `rsi` account, then nine failures including two fixture cadence refusals.
  These are not counted as causal regression proof. The fixture now maps only
  the synthetic owner account to the local UID and spaces reservations by days.
  Production permission checks are unchanged.
- Running the reader file without `PYTHONPATH=.:tests` produced one collection
  error. The final commands include that repository test import path.
- The first full frontend pass attempt exposed the remaining obsolete
  latest-only text assertion. It was updated as listed below; the final full
  run is the recorded 808/808 result, not a skipped assertion.
- The first offline smoke failed before any scenario because macOS's `/var`
  alias was not canonical. Resolving only its new disposable fixture directory
  fixed that setup failure; owner path validation was not changed. Both logs
  and both fixture directories remain retained.

Local logs and the replayable smoke are under
`/Users/s1kor/.codex/.tmp/dash-k17/`: `owner-focused-green.log`,
`owner-query-orphan-red.log`, `owner-suite-native-mac.log`,
`condor-python-green.log`, `condor-advisor-boundary.log`,
`condor-frontend-green.log`, `typecheck.log`, `workspace-suite.log`,
`projected-history-smoke.log`, and `projected-history-smoke-canonical-path.log`.

### Every changed assertion / fixture: old → new

1. Reader multiple-record cases: limits `2,100` → `2,5`. A 400 status → 200;
   `INVALID_HISTORY_QUERY` → returned record count equals the limit; no owner
   calls → exactly one projected owner URL. Limit 100 remains a rejected-query
   case, with new rejected limits 6 and 25.
2. Reader expected upstream call:
   `/v1/advice/history?task_id=market_context&limit=1` →
   `/v1/advice/history/projected?task_id=market_context&limit=1`.
3. Reader owner fixtures: nested full `input`/`result` → flat projected fields.
   Pending `result: null` → explicit `RESULT_NOT_PUBLISHED`, request ID, effect,
   and request time. Existing output assertions stay the same. Private raw/input
   poison fields remain in the adversarial fixture and must still be absent.
4. Whole-envelope negative fixture: one invalid record at limit 1 → one valid
   plus one invalid record at limit 5; the expected whole-response 502 stays.
5. Time-bound, exact time-value, auth, private-field, non-string filtering,
   original full-response byte-guard, and original transport-allowlist assertions
   remain unchanged; only projected fixture access paths change where needed.
6. Frontend source text: three positive matches for `Older reports are not shown
   yet`, `full input, so only one report fits in a read`, and `slimmer history,
   the full timeline will appear here` → a positive `Up to 5 reports per agent`
   match plus an explicit exclusion of the obsolete latest-only/slimmer text.
   New rendered older-owner checks require the missing-projection explanation
   and `No full-record fallback`.
7. Frontend requested URL: `/api/v5/advisor/history?task_id=market_context&limit=1`
   → the same URL with `limit=5`.
8. Rendered honest-limits match: `Only the latest report from each agent is shown
   for now` → `Up to 5 reports per agent, newest first`.
9. Guarded route-render history fixture: empty records → two reports per agent
   with distinct request IDs and times 1,000/2,000 ms. Four added assertions
   require bounded-history wording, the older report, newer-before-older order,
   and at least three reads all ending in `&limit=5`. Existing shared-provider,
   advancing-clock, decimal-scan, and anti-render-loop assertions stay intact.
10. New owner, projected-transport, missing-owner, and multi-row render tests
    have no replaced old assertions. They add whitelist/cap/size, malformed
    query, identity, no-fallback, and ordering checks. The existing future,
    expired, untimed, status-filter, dim, and exact-value assertions stay intact.

`git diff --check`, staged diff checks, stats, and status inspection passed in
both touched owners. The detached root has only its two expected changed
submodule pointers; those pointers are not committed or pushed.

## Remaining

- **CHECK-D needed.** No independent reviewer or delegate was started.
- The 100-record-under-256,000-byte target cannot coexist with the stated caps.
  The candidate deliberately uses the proven five-record bridge limit instead.
- The broader owner selection is not green on this Mac: 60 missing-`rsi`
  failures and three `/proc/self/fd` failures. Kestrel must run native Linux /
  pinned-profile qualification. Local fixture proof does not clear that gate.
- **Install hummingbot-api BEFORE Condor. Kestrel installs.** For a rollback,
  return the reader to the prior release before removing the new owner route.
  These are ordering notes, not installation or rollback execution authority.
- No merge, PR creation, deployment, bot/order action, service/container change,
  real credential inspection, SSH, or live-service read occurred. No repository
  file, branch, worktree, or task receipt was deleted.
  The task worktree and both branches remain retained by instruction.
