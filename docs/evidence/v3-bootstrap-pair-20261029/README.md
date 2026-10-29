# PR0: Condor portfolio bootstrap admission

The local Condor adapter admits the captured pairless V3 portfolio through its
native operation pair proof. No execution-owner code, financial accounting,
configuration, runtime, or deployment changed.

## Scope and authority

- Owner: `condor`, branch `feat/andrzej_v3_bootstrap_pair_20261029`.
- Base: freshly fetched `fork/main`, `8a436d65b27c2e770fd49ef83ac213124679c0c7`.
- Authority: `repository-process-only`; live reporting GETs only. Push and PR
  creation are explicitly authorized. Merge and deployment are excluded.
- Completion: real capture; fail-before/pass-after; invalid-proof rejection;
  full tests; Black/isort/diff checks; self-audit; pushed branch and PR.
- Rollback: revert this task's commit. No state migration or data repair is needed.
- No delegation, root sync, codegraph, deletion, restart, deploy, or trading action.
  Retain the worktree because this task forbids deletion.

## Cause and correction

At base `condor/web/fleet_summary.py:686`, `project_runtime_view()` requires
`runtime_status.controllers[].pair` to be a valid string. The native V3 portfolio
has one controller with `pair: null`. Its five operation-pair rows carry the
controller identity, connector and observation time. The string-only check
returns `None`, so the source selection at base line 1503 cannot use the fresh
runtime executor count or trading capability.

The corrected adapter validates the native `runtime_status.operations` proof
before admitting the aggregate read. It requires schema 1, at least two distinct
pairs per pairless controller, exact controller and connector association, valid
pair syntax, and the same observation time as `runtime_status.updated_at`.
Every operation row must name a known controller. Duplicate scopes and executor
scopes outside the proof are rejected. Each active executor must still have its
matching native lifecycle row.

Proof age must meet the existing native rule: `-5 s <= age < min(threshold, 30 s)`.
Missing, malformed, mismatched, future or expired proof is rejected. A paired
controller keeps the existing path, including its stale-observation semantics.
The adapter does not assign a pair, expand controller rows, or duplicate totals.
Inventory remains owned by the separate holdings projection.

Read topology: native V3 runtime export, then reporting bootstrap GET, then
Condor `project_runtime_view()`, then fleet-card source selection. This change
only affects the last two steps. V1/V2 paired-controller compatibility is
covered by the existing fleet live-shape tests. Native execution/recovery,
capital concurrency, physical clients and deployed behavior are not exercised.
They are outside this projection-only task.

## Capture and provenance

Captured read-only on 2026-10-29 with `docker exec -i rsibot-reporting python -`
using port 5111, GET `/api/v1/bootstrap?bot=meridian_v3`. The first request
without a bot query returned HTTP 400; the corrected GET succeeded.

The captured `updated_at` is `2026-10-29T12:56:56+00:00`. The controller is
`modular_spot_meridian_v3_unified_live`, connector `okx`. The native proof lists
BNB-USDC, BTC-USDC, ETH-USDC, SOL-USDC and XRP-USDC. One active executor also
appears in lifecycle evidence. No timestamp, identity or pair was fabricated.

`tests/fixtures/v3_pairless_bootstrap_20261029.json` keeps only runtime and
monitoring fields used at this boundary. It omits balances, amounts, prices,
PnL, order details, paths, logs and unrelated response sections. It retains
controller/executor identity, pair, connector and clock fields plus the native
trading capability. Secret-bearing keys were rejected before capture output.

Fixture SHA256:
`96dac3a3dbd1ce3e0dc8159871af2bb11e2a6fd39b1483877bf0edaea8a3a65e`.
The broader initial runtime capture is preserved locally in
`~/.codex/.tmp/condor-pr0-20261029/captured-runtime-input.json`, SHA256
`2ca3a2d7e6f9dad3404a30064e559c2c504f602779f8dcb6a1519c86180536cf`.
Tests use the capture's clock; this historical fixture is not a claim of current
runtime freshness.

## Repair register

| Area | Cause and acceptance | State and evidence |
| --- | --- | --- |
| V3 fallback | Pairless portfolio must use exact fresh native pair proof. | VERIFIED locally: captured payload and fleet-card regression. |
| Invalid proof | Missing/malformed/mismatched/expired evidence must be rejected. | VERIFIED locally: negative and expiry-boundary cases. |
| Executor association | Active/lifecycle and controller/pair/connector scope must agree. | VERIFIED locally: initial unbound-executor counterexample failed, then passed. |
| Malformed duplicate controller | Reject before building a hash set of malformed pair values. | VERIFIED locally: TypeError counterexample failed, then passed. |
| V1/V2 compatibility | Preserve paired-controller admission and separate holdings truth. | VERIFIED locally by existing fleet live-shape tests. |
| V5 failures | Five known hostile-input tests fail on unchanged base too. | NOT CAUSED BY PR0: baseline 5 failed, 31 passed. |
| Runtime adoption | No live code change is authorized. | NOT RUN: no merge, deploy or restart. |
| Independent review | This implementation task prohibits delegation. | NOT RUN: final diff self-audit only. |

## Verification

`red-native-capture.txt`: the first real-input test fails on unchanged base
because the view is `None` (1 failed).

`red-final-fixture-base.txt`: the final reduced fixture is also tested against
immutable base source loaded into a disposable pytest process. Both projection
and fleet-card tests fail (2 failed). This does not overwrite source files or
change a running service.

`red-executor-scope.txt` and `red-malformed-controller.txt` retain the adverse
counterexamples found during implementation.

`source-audit.txt` compares parsed source definitions. Only
`project_runtime_view()` changes among existing definitions; the new helper is
`_portfolio_pairs_valid`. Black formats the complete touched module. The other
54 existing definitions have identical ASTs to the base.

Commands use `/Users/s1kor/dev/trading/rsibot/condor/.venv/bin/python` (Python
3.12.10). Run from this worktree:

```bash
PYTHONPATH="$PWD:$PWD/tests" nice -n 10 /Users/s1kor/dev/trading/rsibot/condor/.venv/bin/python -m pytest -q tests/
/Users/s1kor/dev/trading/rsibot/condor/.venv/bin/python -m black --check condor/web/fleet_summary.py tests/test_fleet_summary_portfolio_bootstrap.py
/Users/s1kor/dev/trading/rsibot/condor/.venv/bin/python -m isort --check-only condor/web/fleet_summary.py tests/test_fleet_summary_portfolio_bootstrap.py
git diff --check
```

Final results are recorded below. Command output is retained alongside this file, with trailing whitespace
removed for Git diff checks. Byte-preserved raw copies remain locally under
`~/.codex/.tmp/condor-pr0-20261029/raw-command-output/`. Pytest also reports existing temporary-directory cleanup warnings from
macOS permission fixtures; these are not new test failures.

| Final check | Result |
| --- | --- |
| PR0 capture, hostile proofs and fleet-card tests | 51 passed (`final-pr0.txt`). |
| Full `tests/` suite | 3,789 passed, 8 skipped, 5 failed, 6 warnings in 96.23 s; exit 1 (`final-full-suite.txt`). |
| Unchanged-base V5 hostile-input file | 31 passed, the same 5 failed (`base-v5-hostile.txt`). |
| Black 26.1.0 | PASS on both changed Python files. |
| isort 8.0.1 | PASS on both changed Python files. |
| `git diff --check` | PASS. |
| Source AST audit | Only the runtime admission function changed; one helper added. |
| Hosted CI | Not used as validation; local checks provide this evidence. |
| Merge / deployment / live runtime adoption | NOT RUN; outside authority. |

The five unchanged-base failures are in `tests/test_v5_paper_hostile_inputs.py`:
`test_permissions_and_repeated_opens_do_not_leak_descriptors[directory]`,
`test_permissions_and_repeated_opens_do_not_leak_descriptors[file]`,
`test_searchable_but_unlistable_parent_is_a_readable_source`, and
`test_condor_io_fault_is_unavailable_not_http_500[fstat/read]`.

The feature worktree is retained at
`/Users/s1kor/dev/trading/rsibot/.worktrees/condor-v3-bootstrap-pair-20261029`.
Unrelated root and shared Condor work was not staged or changed by this task.
