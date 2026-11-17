# V5 dashboard C4

Owner: V5 dashboard boss; writer only, no children.

- Objective: shared owner-title precision, manifest-bounded root statics and favicon, bounded width fixes.
- Condor branch: `feat/andrzej_v5_dashboard_backlog_c4`, base `45ec2f8240a3c42d0c9d4aad91d814b1ec94fc8b`.
- Worktree: `/Users/s1kor/dev/trading/rsibot/.worktrees/mac.noindex/v5-c4/condor`.
- Rsibot companion branch: `feat/andrzej_v5_dashboard_backlog_c4` from `origin/main` at `209b10912f6c75554e0f97e0bc35ad6e55a6e831`. Scope amended after the transitive title audit found private Capital's raw owner-title bypass: repair that sink, its title assertions and the Condor gitlink only. No accounting or read-state behavior changes.
- Authority: repository-process-only; display and GET routes only. Push task branch; no merge, deploy, services, orders, bots, real credentials or tokens.
- Root checkout is untouched; no reset, discard, force, or cleanup. Scratch and retained test logs: `/var/tmp/dash-c4`.
- Git backing is now task-owned at `.workspace/condor-owner.git` in the rsibot C4 worktree. A borrowed v5-k17 store disappeared before the first push; source was relinked without checkout/reset and all 684 hashed source/test/build-input files stayed identical. Both actual task worktrees are locked and retained; see the report's recovery receipt.
- Inputs: install-10 screenshots, compare.json and recapture.json under `/Users/s1kor/.codex/.tmp/v5-i10live.noindex/results`.
- Acceptance: regression failures on the pinned base; listed four local gates pass; reproducible reviewed manifest; live install acceptance remains with boss.
- Rollback: do not install this branch, or have the authorized owner restore install 10; no state migration.
- Bootstrap used read-only `check`, not `initialize` (the latter syncs unrelated HQ outside this task).
- Contract clarification from arithmetic: the supplied wallet `199123.96997705845820` has 13 places after trailing-zero removal, so the shared 12-place rule rounds it to `≈ 199123.969977058458 (rounded)`. A true 12-place value padded with zeros stays exact.

## Progress

- [x] Isolated exact Condor baseline; preserved unrelated dirty checkout.
- [x] Fail-first regressions.
- [x] Shared title and root static repair, including transitive private Capital.
- [x] Width evidence, scoped fixes, backlog.
- [x] Required local checks: typecheck PASS; frontend 850/0; Python 656/0; private workspace 681/0, no skipped cases.
- [x] Reproducibility: two fresh 26-file builds match `assets/v5-MyocE3Dw.js`, SHA256 `62ebcdeaab7fa3eaae84f8587cb2fe1781b5ec9d121e9694a4c30ce3df77d21f`. Actual built-file smoke: 25 hashes, six root image types, six rejected paths.
- [x] Writer self-review and handoff package prepared. Commit/push identities are recorded in the final handoff after remote verification; no PR, merge, deploy or cleanup is performed.
- [ ] Deferred to boss: independent exact-head review and live install acceptance. Install both repository pins together; retain worktrees and all evidence.

Full commands, changed assertion families, fail-first identities, Backlog, evidence limits and rollback: `docs/reports/v5-dashboard-c4-20261117.md`.
