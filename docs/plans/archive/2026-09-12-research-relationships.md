# Research relationships in Condor

## Goal
Show source-backed research relationships in Condor with useful topology, navigation and provenance; verify and publish linked Condor and rsibot PRs.

## Current State
Condor clean worktree starts at fork/main fddf7bc018ef2773f14494d064a2a21a2c82fc12. The rsibot repair worktree contains commit 8375bca0. Primary checkouts contain unrelated work and remain untouched. The actual graph has repaired source memberships and artifact references. The running reader on 8873 predates Condor's existing summary/pagination API.

## Target State
Default to recorded dependencies, offer all resolved relationships and the complete catalog, and allow hidden records to be found and revealed. Explain repaired relationship meaning and show source hashes. Preserve unavailable lane/status and economic attribution. Authority is repository-process-only: local read-only previews, tests, commits, pushes and PRs are authorized; production restarts, merges, trades and backtests are excluded.

## Risks and Failure Modes
Topology could hide selected records, filters could fabricate catalog totals, source membership could be mistaken for economic support, and an outdated reader could break detail navigation. Large real graphs require browser verification.

## Milestones
1. Implement topology and URL state with focused regression tests; independently inspect backend boundaries.
2. Wire page controls and explain relationship provenance without changing source data.
3. Run frontend tests/build/lint and backend tests; verify an isolated browser preview using the actual graph and matching reader.
4. Review the diff, resolve findings, commit intentional files, push both branches and open linked PRs.

## Verification
Run `node --test test/research-*.test.mjs`, `npm run build`, `npm run lint`; backend `python -m pytest tests/test_research_read.py tests/test_research_lab_read.py tests/test_research_relation_pages.py -q`. Browser checks cover topology, hidden search/selection, detail/relationships, navigation and failures. Use a separate read-only reader and preview; do not restart the live stack.

## Decision Log
- 2026-09-12: Use two linked owner-repository PRs. Existing 64 MiB network boundary accommodates the repaired 36.7 MB projection; no backend limit change is needed.
- 2026-09-12: Preserve required summary/pagination semantics; verify with a matching isolated reader instead of silently dropping API parameters.

## Progress Log
- Backend audit passed 105 tests and confirmed live-reader version drift. Topology implementation is complete in separately owned files.

## Rollback / Recovery
Revert the Condor commit to restore catalog layout; stop only task-owned previews. Graph repair is append-only and source records were preserved. Do not delete graph events or mutate SQLite to roll back. PRs remain unmerged pending review.

- 2026-09-12: Implementation, independent review, 104 Research frontend tests, 105 backend tests, production build and scoped lint completed. Full lint exactly matches the untouched base (71 errors,20 warnings). Browser verified topology, hidden reveal, source navigation, all Research tabs, missing-record error and narrow viewport. See docs/reports/2026-09-12-research-relationships.md.
- 2026-09-12: rsibot repair pushed and PR160 opened. Both remote jobs were prevented from starting by account billing/spending-limit restrictions (INFRA_FAILURE); no remote code execution occurred. Condor publication follows this final scoped audit.
