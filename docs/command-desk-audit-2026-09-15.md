# Command desk audit — 15 September 2026

Scope: Bots Command desk, native lifecycle UI, shared dashboard WebSocket,
authentication/read boundaries, accounting projection, SPA delivery, and their
Capital/Trading Visuals/Operations integration. No trading orders or engine
configuration changes were made. This is a bounded engineering audit, not proof
that the entire trading stack has no defects.

## Findings resolved

| Finding | Severity | Evidence and resolution |
| --- | --- | --- |
| Late same-owner command callback could erase a newer command guard | High | Reproduced a late rejected stop clearing a newer start submission. `ActiveBotsTab.tsx` now retains HTTP-pending state across navigation and settles only the matching request generation. No automatic retry; 65-second browser deadline exceeds the backend's 5+55-second deadlines. Timeout remains an unknown execution outcome. |
| Existing WebSocket subscription outlived user/server authorization or JWT expiry | High | Local mocked broadcast continued sending after revocation. `ws_manager.py` now verifies signed expiry and checks current in-memory role/server access before every private send, including cached snapshots. Revocation releases subscriptions and closes the socket. |
| Candle-duration request bypassed subscription membership | Medium | An authenticated unsubscribed connection could reach duration/backfill handling. Both current access and existing subscription are now required. Malformed envelope types are ignored safely. |
| Authorization socket closure would retry indefinitely; old-session messages could refill cache | Medium | `websocket.ts` now stops retrying on authorization close, expires only the matching session and discards late frames after session changes. |
| Dashboard shell had no script/framing policy at deployed edge | Medium, defense in depth | Runtime GET headers confirmed absence. Shell now restricts scripts to same origin, blocks objects, constrains base/framing, and sets nosniff/referrer headers. Authenticated reports and developer API docs keep their existing policies. |
| Obsolete position screen remained in source and render tests | Low | Removed unused discovery/polling/render branch; existing tests now exercise production Command desk and unchanged shared evidence components. |
| Two transform golden expectations omitted existing `custom_info` output | Low | Verified only four missing empty dictionaries differed. Updated expectations; runtime accounting unchanged. |

## Logic and architecture review

The execution owner remains authoritative. Managed net units, current market
value, remaining inventory basis, gross fill spend and account holdings are
different quantities. Current-position gross purchase attribution remains
unavailable without complete lineage. Stale/future/mismatched owner observations
hide current values; unknown order detail is not an empty order book. Conditional
controller plans do not become working orders. Native controls still require
fresh identity/capability evidence and an exact completed owner acknowledgement.

Authorization checks use in-memory configuration lookups, not network or JWT
signature verification per frame. Native command, reporting source, identifier,
loopback/redirect and read-only boundaries were reviewed. No arbitrary outbound
destination or new HTML/code injection sink was added. Removing the obsolete
screen reduced the integrated active-tab bundle from roughly 102 KB to 100 KB.

## Official documentation checked

- [React state identity and keys](https://react.dev/learn/preserving-and-resetting-state): owner remounts reset local confirmation; persistent command evidence is owner/session keyed.
- [TanStack query cancellation](https://tanstack.com/query/latest/docs/framework/react/guides/query-cancellation): observation reads consume the query AbortSignal.
- [MDN AbortSignal.any](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/any_static): query cancellation and bounded transport timeout are combined.
- [OWASP WebSocket security](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html): session expiration, message-level authorization and validation.
- [MDN script-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src): bundled same-origin module scripts remain permitted without unsafe-inline/eval.

## Verification

- Full Condor frontend suite: 223 passed, one existing skip before the final timeout regression; final focused command/socket suite: 8 passed.
- Root dashboard workspace suite: 87 passed.
- Relevant backend boundary suite: 107 passed, one existing skip. Additional final header/golden/socket suite: 29 passed.
- Changed production frontend ESLint and TypeScript build passed.
- Public Condor build passed. Integrated owner build passed via `node dashboard/condor-workspace/build.mjs` (3279 modules). A direct generic Vite attempt lacked the private reporting alias; replaced by the documented owner build, not treated as application success.
- `npm audit --omit=dev --json`: zero known vulnerabilities.
- Browser fixtures: actual Command desk renders exact quantities, owner switching and working-order detail; stale observations hide values; health failure retains workspace. Live read confirmed recovery, fills and Capital account scope. No live lifecycle write was exercised.
- Independent reviews: lifecycle/session settlement, backend authorization, shared UI cleanup and shell header scope. No remaining actionable findings in that reviewed scope.

## Limitations and residual risks

Browser auth retains the existing local-storage token model; the shell policy
reduces script-injection exposure but does not eliminate all XSS risk or provide
server-side per-token logout revocation. Do not treat this as a new auth design.
Tailnet transport and deployment topology remain unchanged.

Native exchange logs contained earlier reconnect warnings with subsequent
recovery. Native engines were not restarted or changed. Recent Condor startup
and connection logs were clean; this is not a claim that historical logs contain
no warnings. Test tooling emitted pre-existing module-type and old protected
pytest-temp cleanup warnings; no user artifacts were deleted to silence them.
Economic correctness and venue reconciliation were not re-qualified by UI tests.

Rollback: revert this focused audit commit and redeploy the previous Condor image.
Keep source manifests and rollout receipts; no engine restart is required.
