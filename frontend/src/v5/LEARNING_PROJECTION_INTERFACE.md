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

- Resolves to one fully validated envelope or rejects with `ProjectionReadError`; `error.error` is `{status, code, retryable, snapshot_id, unauthenticated}`.
- `status === 0`: Condor unreachable (`code: 'UPSTREAM_UNAVAILABLE'`).
- `401`: the existing Condor auth wrapper. `code === 'authentication_required'`, `unauthenticated === true`. It clears **all** projection caches.
- Any client-side validation failure (bad schema, hash, scope, time, size) is `502 INVALID_OWNER_PROJECTION`. One bad field rejects the whole envelope.
- `scope_id` is never passed by the panel. Condor appends its configured scope; a browser-supplied different `scope_id` is `400 INVALID_QUERY`.
- Params per dataset: `lessons`/`jobs`: `limit`, `cursor`. `records`: also `record_type` (required, `node` or `edge`; they are never mixed) and optional `root_id`. `manifest`: none.
- Cursors are opaque: pass `page.next_cursor` back unchanged as `cursor`. Never decode, build or edit one.
- `candidates`, `campaigns`, `assessments` are Stage B. Their routes answer `404 DATASET_NOT_ENABLED`; `readProjection` accepts them only to surface that typed error. Read `useManifest().canRead(dataset)` before offering them.

## Hooks

```ts
const view = useProjectionPages('records', { record_type: 'node' }, { pollMs: 30_000 });
view.state;      // 'loading' | 'ready' | 'unavailable' | 'expired' | 'unauthenticated'
view.rows;       // empty unless state === 'ready'
view.envelope;   // the shown validated envelope; null unless 'ready' or the owner itself reported UNAVAILABLE (no rows)
view.error;      // ProjectionError | null
view.next(); view.previous(); view.first(); view.refresh();
view.snapshotChanged;  // 409 happened: pages cleared, offer First (no automatic restart)
view.expiresInMs;      // monotonic countdown from the owner's verified_at_ms

const manifest = useManifest();
manifest.scopeId; manifest.descriptors; manifest.canRead('lessons');
```

Behaviour you can rely on:

- Opaque cursor stack; `first()` clears it. A `409 SNAPSHOT_CHANGED` clears the dataset's pages and sets `snapshotChanged`; the hook does not restart by itself.
- Superseded requests are aborted; unmount aborts.
- Expiry is anchored to `verified_at_ms`, never to the poll time: at most `90_000 - (served_at_ms - verified_at_ms)` ms after receipt the rows are cleared and `state` is `'expired'`. A poll that returns the same `verified_at_ms` does not extend it. Polls default to 30 s (minimum 30 s).
- No retained last-good view: any failure or expiry clears the rows.
- Any HTTP 401 on any projection read clears every hook's data (`state: 'unauthenticated'`).
- Hooks never prefetch and never call anything but the allowlisted GET routes; rendering a hook makes no request (reads start in an effect).
- A different `scope_id` / `scope_sha256` / `projection_revision` in any accepted envelope clears every hook and re-reads from the first page.

## Shared UI rules

- `RefList` shows an `OUT_OF_SCOPE` ref as the opaque token only plus "Unresolved · out of scope". It never shows owner, kind or anything decoded from the token. Do not filter refs again in the panel.
- `UtcTime` shows "Unknown" for null; `CopyableHash` wraps the full value and offers Copy.
- `ProjectionStatusBanner({state, envelope, error, onFirst})` is the one status line: BOUND / PARTIAL / UNAVAILABLE / expired / signed out / loading, with reason codes and issues.

## Server behaviour you can rely on (Condor)

- Unconfigured source: Stage-A routes answer typed `503 PUBLICATION_UNAVAILABLE` (`Retry-After: 1`), never fixture data. Stage-B routes always answer typed `404 DATASET_NOT_ENABLED` without an owner call.
- Success bodies are the owner's exact bytes. Typed owner errors pass through with the same status; `Retry-After` on 503 is normalised to 1..30 (default 1).
- Any owner response that fails validation, framing, size (256 000 B), encoding or the 90 s age rule becomes `502 INVALID_OWNER_PROJECTION`; an unreachable or slow (4 s) owner becomes `503 UPSTREAM_UNAVAILABLE`. There are no retries.
- Method other than GET: `405 METHOD_NOT_ALLOWED` (`Allow: GET`); a body: `413`; a target over 4096 bytes: `414`; all typed.

## Labels that belong to the panels

The envelope carries facts only. The panel writers own the honest copy: `recall` is always `NOT_EVALUATED` ("Recall: not evaluated"); lessons are historical records; every idea revision is `PROPOSED` (registration, not readiness); `contradiction_state: 'NOT_INDEXED'` means unknown, not zero; `native_state: 'RUNNING'` means completion not recorded, not liveness; counts are "on this page" unless `coverage.total_items` is non-null; `null` is unknown, never zero; Factory is "not bound in this stage" until Stage B.

## Condor configuration (backend)

Disabled unless `V5_LEARNING_SOURCE` is set. When set, **all five** names are required; a partial or invalid set fails startup.

| Variable | Value |
| --- | --- |
| `V5_LEARNING_SOURCE` | exactly `research_os_v1` enables the projection source; unset = disabled (routes answer typed `503 PUBLICATION_UNAVAILABLE`); any other value fails startup |
| `V5_LEARNING_OWNER_URL` | fixed owner projection-proxy base URL, e.g. `http://172.18.0.1:<port>` (W5 listener); validated like `V5_RESEARCH_URL` (fixed http(s) base, no path/query/credentials) |
| `V5_LEARNING_SCOPE_ID` | the configured scope ID |
| `V5_LEARNING_SCOPE_SHA256` | lowercase hex, 64 characters |
| `V5_LEARNING_PROJECTION_REVISION` | lowercase hex, 64 characters (the frozen projection revision hash) |

Documentation/example scope: `program_id=okx_spot_dca`, pairs `ok_rsi_trend_aware_dca`/SPOT, `ok_rsi_owner_replay_baseline`/SPOT, `okx_spot_dca`/SPOT, `ok_rsi_challenger_20260903`/SPOT. Tests use `fixture-*` scopes.
