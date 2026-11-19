# V5 dashboard honest states

S6 owns integration. The change covers the read-only paper dashboard’s Research, Market and System displays and the boot screen. The Condor patch pairs with the rsibot workspace patch that owns System history and check summaries. Roll back by reverting both repository changes together.

The initial fetch and branch creation pinned Condor main at `d5d2a5126f6a37c496b6923c8a2e0fcac1dd8cea`. That line lacks the audited Market and System views. The writer continued from the audited rsibot-pinned Condor commit `3715b1adda8a61bcc7e3be910e69fede8e2e6b56` on the existing task branch. The rsibot workspace base is `279e39de1`.

- [x] Pin the two repository bases and check file ownership.
- [x] Show one shared loading, empty, unavailable or error notice and provide a reason and Retry where the read can be repeated.
- [x] Preserve Research HTTP status and render 503 with a reason. Limit V5 to its connected Overview and Graph views.
- [x] Use the candle query state before reporting missing changes or breadth. Explain which prices are needed and why the breakeven comparison can be withheld.
- [x] Put System tabs in the shared page row. Name every check that needs attention and label the history tile as a count of services.
- [x] Simplify the boot text and footnotes.
- [x] Run the typechecks, focused suites and backend baseline suites through the Mac gate.
- [x] Capture before and after at 1280×800 and 390×844 in dark and light against local fixtures. Confirm Retry sends another Research read.
- [x] Restore the server, route regression and reviewed-build pin to the release base after S6’s collision check. Compare the final UI build with the captured fixture build outside the checkout.

S6 owns the integration with the parallel Bots patch and its final bundle. The SPA deep-link repair moves to a separate PR after Condor #91 merges. The reviewed-build pin stays with #91/#98. The scope-change verification is in the task worktree at `.tmp/s6-p2-scope/verification.md`.
