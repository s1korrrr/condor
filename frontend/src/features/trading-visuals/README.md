# Optional monitoring workspace

Public Condor builds independently with `npm ci && npm run build` from
`frontend`. Overview and Trading Visuals display an explicit unavailable state
when this optional workspace is absent. Portfolio, Bots and Research retain
their own routes and data contracts.

The build resolves `@workspace-monitoring` to the public unavailable components
by default. An integration owner can explicitly set `CONDOR_WORKSPACE_ENTRY` to
an absolute entry file exporting React components named `Overview` and
`TradingVisuals`, and supply its own build configuration and typecheck. Condor
does not auto-discover private siblings or contain a copied reporting model,
chart implementation or private source manifest.

The public `sources.ts` contract validates authorized source discovery. Condor
authentication, server selection and backend route authorization remain owned
here regardless of which optional presentation is selected. A build-time
integration selection grants no runtime capability or order authority.

Run `node --test test/*.test.mjs` for the public boundary and behavior checks.
