# V5 Bots first paint and polling

S6 owns this Condor change. Authority is repository-process-only for the paper dashboard. The implementation and branch push belong to this worktree. S6 opens the PR. Local fixture validation and authorized read-only browser observations provide evidence. Roll back by reverting the task commit on its eventual target branch.

- [x] Fetch Condor and create `feat/andrzej_v5_polish_bots_speed` from the requested `origin/main` at `d5d2a5126f6a37c496b6923c8a2e0fcac1dd8cea`.
- [x] Trace the reported path to the V5 release at `c3e9822dc2a63befc60055f40d0b3e4824831bba`. This release contains the six-tile Bots view, Overview, and `/api/v5/money`. The requested main base contains none of the three. S6 selected this release SHA as the P1 base. It is the parent for the Condor commit and review diff.
- [x] Measure the baseline and identify the network and render costs. Warm desktop navigation from Overview showed six dashes, then the first number at 5.34 s. In a separate steady-state desktop minute, 64 API calls and 81 long tasks were observed, 80 over 200 ms, with a 946 ms maximum. Native status requests started five times. Captured desktop and phone baseline screenshots in both themes.
- [x] Reuse the Overview Money row on first paint, reveal coherent sections as they arrive, and pace a single Bots snapshot cycle. Use the shared loader and hook for validation reuse and scheduling. Keep the current six tile values and original snapshot swap once all sections arrive.
- [x] Prove first paint, poll serialization, validated payload reuse and completed-snapshot continuity. The integration typecheck passed and all 209 tests passed across 12 frontend files. Each check used the Mac heavy gate with the load5 guard.
- [x] Compare equivalent production builds in the T3 browser with identical read-only fixtures. Capture the desktop and phone views in dark and light themes in Nest scratch.
- [x] Verify the diff and prepare `feat/andrzej_v5_polish_bots_speed` for the requested branch push. Leave the worktree for S6.

## Confirmed causes

- Bots already requests the Overview Money query, but the tile projection gates wallet and accounting values on the complete snapshot. The first render therefore ignores the sampled row.
- The shell journal notice independently starts a five-section observation cycle on Bots. The Bots view starts its own nine-section cycle and both reread owner status, holdings, executors, and risk.
- The one-second clock reruns the pair and exit projections. In the pinned release policy, each projection validates whole section payloads through `paperSectionError`. On the Mac, the release-policy fixture probe with 20 positions and 450 executors took 334–340 ms for the existing projections and 3.7–3.9 ms to validate the executor payload once.

## Baseline verification

- The release source was archived from `c3e9822d` and the dashboard workspace from `279e39de`. The integration typecheck passed after placing both sources under the same scratch root so relative Condor imports resolve. The first invocation referenced the main checkout's Condor and failed to resolve two release-only imports.
- Under the required Mac gate, `node --test test/v5-dashboard-polish.test.mjs` passed 43 of 43 and `node --test test/v5-bots-summary.test.mjs` passed 28 of 28 against the release archive. These runs establish the existing contract before a candidate exists.
- The first-number and manual-refresh regressions failed on the release source. The first rendered six dashes with the sampled Money query populated. The second started a second load when manual refresh was called during a slow poll with cached data.

## Candidate verification

- On a warm 1280×800 dark viewport, the first number changed from 6,368 ms to 13 ms. The 390×844 light first frame rendered all six fixture values at 11 ms. All six completed tile values were identical across builds.
- In the 60 seconds after snapshot completion, API requests fell from 58 to 39, owner read requests fell from 45 to 24 and long tasks fell from 89 to 0. The baseline maximum was 656 ms. The two candidate starts in the minute were 25.855 s apart. Resource Timing showed no overlaps and a 20.008 s gap after each of four observed completed cycles.
- The phone tiles used two columns with no page overflow. The desktop executor filter reduced 450 rows to 130 and keyboard resize changed the first column from 180 px to 196 px. Chart hover showed a recorded candle with OHLC, volume and final state.
- The fixture method, timings, commands, counts and screenshot artifacts are retained in Nest scratch under `s6-p1-bots-speed.noindex`. The live dashboard was observed through the browser for the initial baseline. Candidate runtime evidence comes from fixtures.
