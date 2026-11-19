# V5 dashboard honest states

S6 owns integration. The change covers the read-only paper dashboard’s Research, Market and System displays, the boot screen, and direct links to known V5 pages. The Condor patch pairs with the rsibot workspace patch that owns System history and check summaries. Roll back by reverting both repository changes together.

The initial fetch and branch creation pinned Condor main at `d5d2a5126f6a37c496b6923c8a2e0fcac1dd8cea`. That line lacks the audited Market and System views. The writer continued from the audited rsibot-pinned Condor commit `3715b1adda8a61bcc7e3be910e69fede8e2e6b56` on the existing task branch. The rsibot workspace base is `279e39de1`.

- [x] Pin the two repository bases and check file ownership.
- [x] Show one shared loading, empty, unavailable or error notice and provide a reason and Retry where the read can be repeated.
- [x] Preserve Research HTTP status and render 503 with a reason. Limit V5 to its connected Overview and Graph views.
- [x] Use the candle query state before reporting missing changes or breadth. Explain which prices are needed and why the breakeven comparison can be withheld.
- [x] Put System tabs in the shared page row. Name every check that needs attention and label the history tile as a count of services.
- [x] Simplify the boot text and footnotes.
- [x] Run the typechecks, focused suites and backend baseline suites through the Mac gate.
- [x] Capture before and after at 1280×800 and 390×844 in dark and light against local fixtures. Confirm Retry sends another Research read.
- [x] Align Condor with the V5 R2 release at `c3e9822dc2a63befc60055f40d0b3e4824831bba`. Keep the rsibot Condor gitlink at the original base.
- [x] Register the remaining known SPA routes after the #91 owner approved restoring the fix. Verify the failing-before and passing-after route case and keep API errors on their existing paths.

S6 owns integration with the parallel Bots patch. Kestrel owns the reviewed-build pin. The verification receipt and screenshots are under `.tmp/s6-p2-spa/` in the task worktree.
