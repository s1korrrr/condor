# Learning projection: shared interface for W7 and W8

Read-only, authority `NONE`. Contract: rsibot `1d8c0ab6` (`docs/plans/active/2026-11-18-v5-learning-factory-lineage-projection.md` §5 plus the frozen appendix `2026-11-18-v5-lfl-contract/`). This is the Condor side. The panels (`LearningPanel`, `DecisionLineagePanel`, `ResearchFactoryPanel`) build on the names below; they must not call `fetch`, `learningRead` or the legacy `/learning/research` route for projection data.

Status: names and types are final. Everything below is implemented on `feat/andrzej_v5_lfl_condor_binding` (the hand-off's last line gives the HEAD).

## Modules

| File | Exports |
| --- | --- |
| `learning-projection.ts` | `readProjection`, `readProjectionResult` (non-throwing), `useProjectionPages`, `useManifest`, `clearProjectionCaches`, `registerProjectionStore`, `clampPollMs`, `formatUtc`, `ProjectionReadError`, `isProjectionReadError`, `isUnavailableStub`, constants (`MAX_VERIFICATION_AGE_MS = 90_000`, `MIN_POLL_MS = 30_000`, `MANIFEST_DATASET_ORDER`), and the types `ProjectionEnvelope<Row>`, `Coverage`, `Page`, `Issue`, `SourceRef`, `Ref`, `Scope`, `RowScope`, `RowBase`, `UnavailableRowStub`, `LessonRow`, `RecordNodeRow`, `RecordEdgeRow`, `JobRow`, `DatasetDescriptor`, `DatasetRows`, `ProjectionParams`, `ProjectionError`, `ProjectionErrorCode`, `ProjectionViewState`, `ProjectionPagesView`, `ManifestView` |
| `projection-ui.tsx` | `ProjectionStatusBanner`, `SourceRefList`, `RefList`, `IssueList`, `UtcTime`, `CopyableHash` |
| `learning-projection-validate.ts` / `-store.ts` / `-schemas.ts` | internals: strict parser + schema/relational validation, the framework-free state machine behind the hooks, and the schemas generated from the vendored frozen appendix (`node tooling/gen-learning-schemas.mjs`; a test fails when it is stale). Panels do not import these |
| `api.ts` | `learningRead` keeps `roles` and the legacy `research?...` fixture route; its `manifest` path now delegates to `readProjection('manifest')` and throws `V5ApiError`. New code uses `readProjection` |

## Reading

```ts
const envelope = await readProjection('lessons', { limit: 25, cursor });   // throws ProjectionReadError
```

- Resolves to one fully validated, freshness-admitted envelope or rejects with `ProjectionReadError`; `error.error` is `{status, code, retryable, snapshot_id, unauthenticated, freshness?}`. `readProjectionResult` also returns the monotonic `expiresAt` on success (`null` for an owner `UNAVAILABLE` envelope).
- `status === 0`: Condor unreachable (`code: 'UPSTREAM_UNAVAILABLE'`).
- `401`: the existing Condor auth wrapper. `code === 'authentication_required'`, `unauthenticated === true`. It clears **all** projection caches.
- Any client-side validation failure (bad schema, hash, scope, time, size) is `502 INVALID_OWNER_PROJECTION`. One bad field rejects the whole envelope.
- When the browser's own ledger rejects an envelope, a retired generation returns `409 SNAPSHOT_CHANGED` with `freshness: 'retired'`. Other out-of-order or expired verifications return the client-only `503 STALE_OR_EXPIRED` with `freshness: 'ignored'` or `'expired'`. None exposes rows. `learningRead('manifest')` wraps these as `V5ApiError` with the same status and code. The `freshness` field is local to the browser, not part of a wire error.
- `scope_id` is not a panel parameter; the reader supplies it on the wire (see amendment below).
- Params per dataset beyond `scope_id`: `lessons`/`jobs`: `limit`, `cursor`. `records`: also `record_type` (required, `node` or `edge`; they are never mixed) and optional `root_id`. `manifest`: none.
- Cursors are opaque: pass `page.next_cursor` back unchanged as `cursor`. Never decode, build or edit one.
- `candidates`, `campaigns`, `assessments` are Stage B. Their routes answer `404 DATASET_NOT_ENABLED`; `readProjection` accepts them only to surface that typed error. Read `useManifest().canRead(dataset)` before offering them.

### Stage-A contract amendment: scope bootstrap

The authenticated, non-projection `GET /api/v5/auth` returns `learning_scope_id` and `learning_scope_membership: { program_id, family_lane_pairs: [{ family_id, lane }, …] }` only when the projection is configured. The browser reader sends the ID as `scope_id` on every projection GET, including manifest, and validates scope summaries and rows against the trusted membership. Condor requires the configured ID, returns `400 INVALID_QUERY` for a missing or different ID, and forwards valid raw query bytes unchanged. Condor never inserts or rewrites `scope_id`. No projection schema or owner wire error code changed. W7/W8 fetch mocks must include the scope membership in the authenticated session reply, matching the envelope fixtures.

## Hooks

```ts
const view = useProjectionPages('records', { record_type: 'node' }, { pollMs: 30_000 });
view.state;      // 'loading' | 'ready' | 'unavailable' | 'expired' | 'unauthenticated'
view.rows;       // empty unless state === 'ready'
view.envelope;   // the shown validated envelope; null unless 'ready' or the owner itself reported UNAVAILABLE (no rows)
view.error;      // ProjectionError | null
view.next(); view.previous(); view.first(); view.refresh();
view.snapshotChanged;  // wire 409: pages cleared, offer First (no automatic restart)
view.expiresInMs;      // monotonic countdown from the owner's verified_at_ms

const manifest = useManifest();
manifest.scopeId; manifest.descriptors; manifest.canRead('lessons');
```

Behaviour you can rely on:

- Opaque cursor stack; `first()` clears it. A wire `409 SNAPSHOT_CHANGED` from either Condor or the owner clears the dataset's pages and sets `snapshotChanged`; the hook does not restart by itself. A replay rejected by the browser's local ledger cannot clear a live page or set `snapshotChanged`.
- Superseded requests are aborted; unmount aborts.
- The process and browser session each retain their ledger across all cache clears. First admission fixes the deadline per `(dataset, snapshot_id, verified_at_ms)` at `90_000 - (served_at_ms - verified_at_ms)` monotonic ms from admission. Re-login or retry may show a replay only until that original deadline. Polls default to 30 s (minimum 30 s).
- Retired snapshots, verifications below the global maximum, and ties from different snapshots are not admitted by either ledger, regardless of envelope status. A strictly newer `UNAVAILABLE` with a snapshot ID and verification time advances the ledger but gives no receipt, deadline or rows. Existing deadlines are never renewed by replays. Wire read failures and expiry still clear their affected pages.
- Any HTTP 401 on any projection read clears every hook's data (`state: 'unauthenticated'`).
- Hooks never prefetch and only make the session GET and allowlisted projection GET; rendering a hook makes no request (reads start in an effect).
- A strictly newer verification of another snapshot (which binds scope and revision) retires the previous generation, clears every hook, and re-reads from the first page. Cancelled reads cannot change the ledger or caches. Deadlines below the maximum are unreachable and can be dropped. After 4,096 retirements the ledger rejects further generation changes until process/session restart rather than forgetting a retired ID; the current generation may still advance its verification.

## Shared UI rules

- `RefList` shows an `OUT_OF_SCOPE` ref as the opaque token only plus "Unresolved · out of scope". It never shows owner, kind or anything decoded from the token. Do not filter refs again in the panel.
- `UtcTime` shows "Unknown" for null; `CopyableHash` wraps the full value and offers Copy.
- `ProjectionStatusBanner({state, envelope, error, onFirst})` is the one status line: BOUND / PARTIAL / UNAVAILABLE / expired / signed out / loading, with reason codes and issues.

## Server behaviour you can rely on (Condor)

- Unconfigured source: Stage-A routes answer typed `503 PUBLICATION_UNAVAILABLE` (`Retry-After: 1`), never fixture data. Stage-B routes always answer typed `404 DATASET_NOT_ENABLED` without an owner call.
- Success bodies are the owner's exact bytes. Typed owner errors pass through with the same status; `Retry-After` on 503 is normalised to 1..30 (default 1).
- Condor uses existing wire errors: `409 SNAPSHOT_CHANGED` clears the dataset's pages and offers First for retired generations; retryable `503 VERIFICATION_UNAVAILABLE` with `Retry-After: 1` clears the affected dataset for other ignored or expired tuples. The `X-V5-Projection-Freshness` header was removed; browser consumers and mocks handle these like the same owner errors. Equal tuples can repopulate a cleared receipt only within its original deadline.
- Any owner response that fails validation, framing, size (256 000 B), encoding or the 90 s age rule becomes `502 INVALID_OWNER_PROJECTION`; an unreachable or slow (4 s) owner becomes `503 UPSTREAM_UNAVAILABLE`. There are no retries.
- Method other than GET: `405 METHOD_NOT_ALLOWED` (`Allow: GET`); a body: `413`; a target over 4096 bytes: `414`; all typed.

## Labels that belong to the panels

The envelope carries facts only. The panel writers own the honest copy: `recall` is always `NOT_EVALUATED` ("Recall: not evaluated"); lessons are historical records; every idea revision is `PROPOSED` (registration, not readiness); `contradiction_state: 'NOT_INDEXED'` means unknown, not zero; `native_state: 'RUNNING'` means completion not recorded, not liveness; counts are "on this page" unless `coverage.total_items` is non-null; `null` is unknown, never zero; Factory is "not bound in this stage" until Stage B.

## Condor configuration (backend)

Do not configure `V5_LEARNING_*` on any build without W7. Merge W6 and W7 together and build the install only after both are present: the legacy Learning page expects the old manifest shape.

Disabled unless `V5_LEARNING_SOURCE` is set. When set, **all five** names are required; a partial or invalid set fails startup.

| Variable | Value |
| --- | --- |
| `V5_LEARNING_SOURCE` | exactly `research_os_v1` enables the projection source; unset = disabled (routes answer typed `503 PUBLICATION_UNAVAILABLE`); any other value fails startup |
| `V5_LEARNING_OWNER_URL` | fixed HTTP(S) owner projection-proxy origin (W5 listener); path must be empty or `/`; no query, fragment or credentials |
| `V5_LEARNING_SCOPE_ID` | must match the selected vendored artifact |
| `V5_LEARNING_SCOPE_SHA256` | canonical SHA-256 of a vendored scope artifact (see `condor/v5/schemas/learning_scopes/PIN.md`); unknown or mismatched pins fail startup |
| `V5_LEARNING_PROJECTION_REVISION` | lowercase hex, 64 characters (the frozen projection revision hash) |

Documentation/example scope: `program_id=okx_spot_dca`, pairs `ok_rsi_trend_aware_dca`/SPOT, `ok_rsi_owner_replay_baseline`/SPOT, `okx_spot_dca`/SPOT, `ok_rsi_challenger_20260903`/SPOT. Tests use `fixture-*` scopes.
