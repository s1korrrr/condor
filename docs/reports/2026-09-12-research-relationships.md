# Research relationships: implementation and verification

Condor now defaults to recorded dependencies. Nodes with relationships includes every resolved relationship; All indexed nodes retains the complete catalog. The catalog counts remain distinct from the layout counts. Search covers the complete catalog and labels hidden results. Reveal and Find in network preserve record selection and focus across URL updates and renderer remounts.

Recorded history explains source membership, saved-artifact references and historical idea references. It shows direction, recorded basis, repair rule and source SHA-256 hashes. These relations do not increase modern idea usage or produce economic verdicts. Existing unavailable lane/status values remain unavailable.

Companion implementation: https://github.com/s1korrrr/rsibot/pull/160

## Verification

- `cd frontend && node --test test/research-*.test.mjs`: 104 passed. After the final focus-token purity adjustment, `node --test test/research-page.test.mjs`: 10 passed.
- `cd frontend && npm run build`: passed (TypeScript and Vite production build).
- Scoped `npx eslint src/pages/Research.tsx src/features/research/ResearchInspector.tsx src/features/research/ResearchNetwork.tsx src/features/research/research-detail.ts src/features/research/lab-state.ts src/features/research/lab-network-engine.js src/features/research/lab-network-engine.d.ts`: passed.
- `cd frontend && npm run lint`: 71 errors, 20 warnings. An untouched archive of base fddf7bc018ef2773f14494d064a2a21a2c82fc12 with the same installed dependencies produces the identical diagnostics after normalizing filesystem paths and whitespace. PRE_EXISTING; no new lint diagnostics.
- Owner Python `-m pytest tests/test_research_read.py tests/test_research_lab_read.py tests/test_research_relation_pages.py -q`: 105 passed.
- `git diff --check`: passed.
- Independent reviewer found and re-verified two fixed regressions: lost reveal focus after remount, and blank graph after a failed topology renderer replacement. Final review: no remaining reproducible findings; 55 focused tests passed.

## Browser observations

The isolated preview used the actual repaired Research OS graph, the matching reader from rsibot repair commit 8375bca0, and the real Condor research route, validators, sanitizer, byte limits and document streaming. Authentication and configured-server discovery were test fixtures. No private credentials, execution routes or live service restarts were used.

Observed projection aeb37888b4bb43ec7294bc6ac518ccf9208256bdcc8a96d2528dd5bed2835934:

| Mode | Nodes in topology | Resolved edges | Catalog unresolved edges |
| --- | ---: | ---: | ---: |
| Recorded dependencies | 64,182 | 81,224 | 18 |
| Nodes with relationships | 112,476 | 111,732 | 18 |
| All indexed nodes | 182,649 | 111,732 | 18 |

The all-node catalog retained 70,173 isolates. Full network projection was 36,695,049 bytes, below the existing 64 MiB bound. Catalog totals include unresolved edges; layout counts do not invent their endpoints.

Verified interactions:

- Search for an actual repaired experiment, select it, inspect seven relationships, expand artifact provenance, follow its metrics artifact, read the incoming relationship and open the frozen metrics JSON.
- Switch all three topologies. Search hidden idea `idea:CAT-002`, reveal it, verify URL selection and focus, then manually switch back to dependencies and retain the hidden-selection notice and inspector.
- Reload with selected record and graph query; selection and detail restored.
- Ideas, Papers, Experiments, Queue, Research loop, Evidence gaps, Archive and Overview reached source responses. Observed 30,058 ideas, 106 papers, 3,375 experiments, 85 bounded queue candidates, 107 research-loop records, 39,562 gaps and 142,852 archive records.
- Missing-record request showed `Research node not found` and Retry detail.
- Desktop and 390px viewport visual inspection: topology/search controls wrap and remain usable. Viewport restored after checking.
- Browser console had no warnings or errors during normal recorded-flow checks. The deliberate missing-record check is an expected failed read, not a successful source response.

## Deployment boundary

The existing reader at port 8873 rejects Condor's already-required `projection=summary` and relation pagination parameters. The isolated matching reader at 8874 supports these; its paged detail response contained 13 source-document references. The running stack was not restarted or deployed. A normal coordinated reader/frontend update remains necessary before claiming the running Condor service uses this implementation.

The actual graph was concurrently active and reported Index pending during this preview. The UI retained that state. These counts are an observed revision, not a claim that all later events are indexed.

## Recovery

Revert the Condor commit to restore its earlier display. No graph records are written by Condor. Stop only the task-owned preview processes; do not restart active trading owners. The companion repair uses append-only graph events and documents separate graph-recovery constraints.
