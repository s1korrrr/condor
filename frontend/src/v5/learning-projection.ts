/**
 * Browser side of the frozen V5 Learning / Factory / Lineage projections
 * (rsibot `1d8c0ab6` Stage A and `bf9f3c14` Stage B).
 *
 * Read-only, authority NONE. This module is the single shared base for the
 * Learning (W7), Lineage (W7) and Research Factory (W8) panels. The published
 * names are listed in `LEARNING_PROJECTION_INTERFACE.md`.
 *
 * Rules the implementation enforces for every consumer:
 * - a response is either one fully validated envelope or one typed error;
 *   a single bad field rejects the whole envelope (no partial rendering);
 * - there is no fixture fallback: failures and expiry clear affected pages,
 *   but a ledger rejection never replaces a still-live page;
 * - cursors are opaque tokens: they are echoed unchanged, never decoded;
 * - polls never extend freshness: expiry is anchored to the owner's
 *   `verified_at_ms`, not to the time a poll arrived.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  ContractViolation, parseStrictJson, readScopeMembership, validateEnvelope, validateErrorBody,
} from './learning-projection-validate';
import { freshnessError, ProjectionFreshness, ProjectionStore, type FreshnessMiss, type StoreClock, type StoreRead } from './learning-projection-store';
import { STAGE_B_REVISION } from './learning-projection-schemas';

/** Stage-A datasets that Condor serves with a success schema. */
export const STAGE_A_DATASETS = ['manifest', 'lessons', 'records', 'jobs'] as const;
/** Stage-B paths are disabled under a Stage-A configuration. */
export const STAGE_B_DATASETS = ['candidates', 'campaigns', 'assessments'] as const;
export const ALL_DATASETS = [...STAGE_A_DATASETS, ...STAGE_B_DATASETS] as const;

export type ProjectionDataset = (typeof ALL_DATASETS)[number];
export type PagedDataset = Exclude<ProjectionDataset, 'manifest'>;
/** Order of the six manifest descriptors (frozen). */
export const MANIFEST_DATASET_ORDER = ['lessons', 'records', 'jobs', 'candidates', 'campaigns', 'assessments'] as const;
export type DescriptorDataset = (typeof MANIFEST_DATASET_ORDER)[number];

/** A projection read is fresh for at most this long after the owner's `verified_at_ms` (inclusive). */
export const MAX_VERIFICATION_AGE_MS = 90_000;
/** Allowed amount by which a timestamp may be ahead of the local clock. */
export const MAX_FUTURE_SKEW_MS = 5_000;
/** Responses are rejected above this many decoded bytes (Condor client cap). */
export const MAX_PROJECTION_RESPONSE_BYTES = 256_000;
/** Minimum interval between automatic refreshes; the owner verifies every 30 s. */
export const MIN_POLL_MS = 30_000;

export type Hash = string;
export type Id = string;
export type Lane = 'SPOT' | 'FUTURES' | 'PROXY' | 'MIXED' | 'UNAVAILABLE';
export type EnvelopeStatus = 'BOUND' | 'PARTIAL' | 'UNAVAILABLE';
export type RowStatus = 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE';

export type IssueCode =
  | 'MISSING_SOURCE' | 'SOURCE_CHANGED' | 'SCOPE_UNKNOWN' | 'UNSUPPORTED_NATIVE_SCHEMA' | 'OMITTED_CONTENT'
  | 'UNRESOLVED_REFERENCE' | 'CONTRADICTIONS_NOT_INDEXED' | 'COMPLETION_NOT_RECORDED' | 'INDEX_INCOMPLETE'
  | 'NOT_PUBLISHED' | 'CLOCK_SKEW' | 'PREREGISTRATION_SEAL_MISSING';

/** Closed registry of projection error codes (owner, proxy and Condor). */
export type ProjectionErrorCode =
  | 'INVALID_QUERY' | 'INVALID_CURSOR'
  | 'ROOT_NOT_IN_SCOPE' | 'DATASET_NOT_ENABLED' | 'ROUTE_NOT_FOUND'
  | 'METHOD_NOT_ALLOWED' | 'REQUEST_BODY_NOT_ALLOWED' | 'TARGET_TOO_LONG'
  | 'SNAPSHOT_CHANGED'
  | 'PROJECTION_BUSY' | 'PROJECTION_DEADLINE' | 'WARMING' | 'VERIFICATION_UNAVAILABLE'
  | 'PUBLICATION_UNAVAILABLE' | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_INVALID' | 'INVALID_OWNER_PROJECTION';

/** The existing pre-auth Condor wrapper code for a missing/expired session (HTTP 401). */
export const AUTHENTICATION_REQUIRED = 'authentication_required';

export interface Coverage {
  state: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE';
  total_items: number | null;
  returned_items: number;
  omitted_items: number | null;
  unresolved_membership_items: number | null;
  excluded_proposed_edges: number | null;
  pending_events: number | null;
}

export interface Page {
  limit: number;
  /** Opaque. Pass it back unchanged as `cursor`; never decode, build or edit it. */
  next_cursor: string | null;
  has_more: boolean;
}

export interface Issue { code: IssueCode; record_id: Id | null; detail: string }

export interface SourceRef {
  root: 'STORE' | 'OUTPUT' | 'SOURCE';
  relative_path: string;
  pointer: string;
  sha256: Hash;
  bytes: number;
}

export interface Ref {
  owner: 'research_os' | 'hummingbot_api' | 'hummingbot';
  kind: string;
  record_id: Id;
  revision: Hash | null;
  /** Index into the *same row's* `sources`, or null. */
  source_index: number | null;
  /** OUT_OF_SCOPE refs expose only the opaque ID: no details, no expansion. */
  resolution: 'RESOLVED' | 'NOT_PUBLISHED' | 'UNAVAILABLE' | 'OUT_OF_SCOPE';
}

export interface Scope {
  scope_id: Id;
  scope_sha256: Hash;
  program_id: Id;
  family_lane_pairs: { family_id: Id; lane: Exclude<Lane, 'UNAVAILABLE'> }[];
}

export interface RecordedScope {
  venue: string;
  capital_model: string;
  window: string | { start: number; end_exclusive: number } | null;
  regimes: string[];
  scope_state: 'RECORDED' | 'UNAVAILABLE';
}

export interface RowScope {
  membership_basis: 'LESSON_PROGRAM' | 'OWN_FAMILY_LANE' | 'EXPERIMENT_PARENT' | 'ASSERTED_PARENT';
  family_id: Id | null;
  lane: Lane;
  program_id: Id | null;
  recorded_scope: RecordedScope | null;
}

export interface RowBase {
  record_id: Id;
  native_revision: Hash | null;
  row_scope: RowScope;
  recorded_at_ms: number | null;
  available_at_ms: number | null;
  sources: SourceRef[];
  row_status: RowStatus;
  issues: Issue[];
  row_sha256: Hash;
}

/** A verified base-only row for something the owner could not project completely. */
export interface UnavailableRowStub extends RowBase {
  native_kind: string;
  row_status: 'UNAVAILABLE';
}

export interface LessonRow extends RowBase {
  native_kind: 'decision';
  row_status: 'COMPLETE' | 'PARTIAL';
  lesson_id: Id;
  program_id: Id;
  title: string;
  statement: string;
  reopening_condition: string;
  domain: 'HYPOTHESIS' | 'IMPLEMENTATION' | 'DATA' | 'EXECUTION' | 'RESEARCH_PROCESS';
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  evidence_state: 'VALID' | 'PROVISIONAL' | 'INVALID' | 'UNAVAILABLE';
  supersedes: Ref | null;
  outcome_refs: Ref[];
  /** Always the literal NOT_EVALUATED: render "Recall: not evaluated". */
  recall: 'NOT_EVALUATED';
  /** NOT_INDEXED means "no contradiction data indexed", never "zero contradictions". */
  contradiction_state: 'RECORDED' | 'NOT_INDEXED' | 'UNAVAILABLE';
  contradictory_refs: Ref[];
  reference_total: number | null;
}

export type RecordNodeKind =
  | 'idea' | 'idea_revision' | 'experiment' | 'run' | 'assessment' | 'outcome' | 'lesson'
  | 'campaign' | 'decision' | 'evidence' | 'metrics' | 'report' | 'artifact_bundle';

export interface RecordNodeRow extends RowBase {
  native_kind: string;
  row_status: 'COMPLETE' | 'PARTIAL';
  record_type: 'node';
  kind: RecordNodeKind;
  title: string;
  native_state: string | null;
  summary: string | null;
  identities: { name: string; value: Id }[];
}

export type RecordRelation =
  | 'revision_of' | 'uses_idea' | 'attempt_of' | 'decides' | 'derived_from'
  | 'supersedes' | 'assesses' | 'evaluates' | 'records_outcome_for' | 'produced';

export interface RecordEdgeRow extends RowBase {
  native_kind: 'edge';
  row_status: 'COMPLETE' | 'PARTIAL';
  record_type: 'edge';
  edge_id: Id;
  from_ref: Ref;
  to_ref: Ref;
  relation: RecordRelation;
  basis: 'EXPLICIT';
}

export interface JobRow extends RowBase {
  native_kind: 'run';
  row_status: 'COMPLETE' | 'PARTIAL';
  job_kind: 'RESEARCH_ATTEMPT';
  attempt_id: Id;
  experiment_ref: Ref;
  /** Native RUNNING means "completion not recorded", never process liveness. */
  native_state: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'INTERRUPTED' | 'CANCELLED';
  completion: 'RECORDED' | 'NOT_RECORDED';
  started_at_ms: number | null;
  finished_at_ms: number | null;
  artifact_refs: Ref[];
  reference_total: number | null;
  provider_usage: 'NOT_PUBLISHED';
  money: 'NOT_PUBLISHED';
  replay_allowed: false;
}

export interface DatasetDescriptor {
  dataset: DescriptorDataset;
  native_schema_ids: string[];
  availability: EnvelopeStatus;
  reason_codes: string[];
  total_items: number | null;
  max_limit: 50;
  capabilities: {
    /** True when the dataset is enabled in this stage. Capability, not current health. */
    read: boolean;
    dispatch: false;
    activate: false;
    release: false;
    adopt: false;
    recall: 'NOT_EVALUATED';
  };
}

export interface ProjectionEnvelope<Row> {
  schema: 'research_knowledge.v5_read_projection.v1';
  owner: 'research_os';
  authority: 'READ_ONLY';
  effect: 'NONE';
  dataset: ProjectionDataset;
  scope: Scope | null;
  projection_revision: Hash;
  snapshot_id: Hash | null;
  publication_sha256: Hash | null;
  database_sha256: Hash | null;
  source_revision: string | null;
  source_snapshot: string | null;
  event_signature: string | null;
  status: EnvelopeStatus;
  reason_codes: string[];
  generated_at_ms: number | null;
  /** The owner's last completed verification. Only the owner's scheduler advances it. */
  verified_at_ms: number | null;
  served_at_ms: number;
  coverage: Coverage;
  page: Page;
  items: Row[];
  issues: Issue[];
  envelope_sha256: Hash;
}

export type ManifestEnvelope = ProjectionEnvelope<DatasetDescriptor>;
export type LessonsEnvelope = ProjectionEnvelope<LessonRow | UnavailableRowStub>;
export type RecordsEnvelope = ProjectionEnvelope<RecordNodeRow | RecordEdgeRow | UnavailableRowStub>;
export type JobsEnvelope = ProjectionEnvelope<JobRow | UnavailableRowStub>;

interface FactoryRow extends RowBase { row_status: 'COMPLETE' | 'PARTIAL' }

export interface CandidateRow extends FactoryRow {
  native_kind: 'idea_revision';
  idea_id: Id;
  idea_revision_id: Id;
  title: string;
  hypothesis: string;
  truncated_fields: 'hypothesis'[];
  registration_state: 'PROPOSED';
  implementation_qualification: 'NOT_PUBLISHED';
  readiness: 'NOT_PUBLISHED';
  execution_permission: 'NONE';
  reference_total: number | null;
  experiment_refs: Ref[];
  assessment_refs: Ref[];
}

interface CampaignBase extends FactoryRow {
  campaign_id: Id;
  dispatch_permission: 'NONE';
  reference_total: number | null;
  candidate_refs: Ref[];
  attempt_refs: Ref[];
}

export type CampaignRow = CampaignBase & ({
  native_kind: 'paper_campaign';
  preregistration_seal: 'MISSING' | 'VERIFIED';
  stage: string;
  query: string;
  experiment_ref: Ref;
} | {
  native_kind: 'decision';
  title: string;
  native_state: string;
  reason: string | null;
});

export interface AssessmentComparison {
  baseline_id: string;
  metric: string;
  unit: string;
  delta: string;
  comparable_group: string;
  comparison_group: string;
  conditions: {
    baseline_id: string;
    metric: string;
    unit: string;
    window: string | { start: string; end_exclusive: string };
    venue: string;
    instrument: string;
    capital_model: string;
    costs_identity: string;
    execution_identity: string;
    validation: string;
  };
}

export interface AssessmentRow extends FactoryRow {
  native_kind: 'assessment';
  idea_revision_id: Id;
  assessment_id: Id;
  evaluation_id: Id;
  verdict: 'SUPPORTED' | 'CONTRADICTED' | 'INCONCLUSIVE';
  validity: 'VALID' | 'INVALID' | 'UNAVAILABLE';
  attribution: 'ISOLATED' | 'COMBINED' | 'UNAVAILABLE';
  admission: 'ADMITTED_COMPARISON' | 'RECORDED_ONLY';
  hurdle_status?: string;
  run_ref: Ref;
  supersedes: Ref | null;
  comparison: AssessmentComparison | null;
}

export interface DatasetRows {
  manifest: DatasetDescriptor;
  lessons: LessonRow | UnavailableRowStub;
  records: RecordNodeRow | RecordEdgeRow | UnavailableRowStub;
  jobs: JobRow | UnavailableRowStub;
  candidates: CandidateRow | UnavailableRowStub;
  campaigns: CampaignRow | UnavailableRowStub;
  assessments: AssessmentRow | UnavailableRowStub;
}

/** Type guard for the per-dataset stub (verified base-only row). */
export function isUnavailableStub<R extends { row_status: RowStatus }>(row: R): row is Extract<R, { row_status: 'UNAVAILABLE' }> {
  return row.row_status === 'UNAVAILABLE';
}

/** Query parameters a panel may set. The reader gets `scope_id` from Condor's session read. */
export interface ProjectionParams {
  /** 1..50, default 25. */
  limit?: number;
  /** Opaque token from a previous page's `page.next_cursor`. */
  cursor?: string;
  /** `records` only (required there). Nodes and edges are never mixed in one page. */
  record_type?: 'node' | 'edge';
  /** `records` only: an in-scope root; one-hop neighbourhood, independently paginated. */
  root_id?: string;
  idea_revision_id?: string;
}

/**
 * A typed projection failure. `status` is the HTTP status or its local equivalent (0 when Condor could not
 * be reached). 401 is the existing Condor auth wrapper: `code === 'authentication_required'`
 * and `unauthenticated === true`; it clears every projection cache.
 */
export interface ProjectionError {
  status: number;
  code: ProjectionErrorCode | typeof AUTHENTICATION_REQUIRED | 'STALE_OR_EXPIRED';
  retryable: boolean;
  snapshot_id: Hash | null;
  unauthenticated: boolean;
  freshness?: FreshnessMiss;
}

// ---------------------------------------------------------------------------
// Read API
// ---------------------------------------------------------------------------

/** What a hook shows. `ready` is the only state that carries rows. */
export type ProjectionViewState = 'loading' | 'ready' | 'unavailable' | 'expired' | 'unauthenticated';

export interface ProjectionPagesView<D extends PagedDataset> {
  state: ProjectionViewState;
  /** The validated envelope currently shown. Present when `ready`, and for an owner-reported UNAVAILABLE envelope (no rows). */
  envelope: ProjectionEnvelope<DatasetRows[D]> | null;
  /** Empty unless `state === 'ready'`. */
  rows: DatasetRows[D][];
  error: ProjectionError | null;
  /** Zero-based index in the cursor stack (0 = first page). */
  pageIndex: number;
  hasNext: boolean;
  hasPrevious: boolean;
  /** True after a 409 SNAPSHOT_CHANGED: old pages were cleared; offer `first()`. */
  snapshotChanged: boolean;
  /** Milliseconds until the shown data expires (monotonic, from `verified_at_ms`), or null. Read at render time. */
  expiresInMs: number | null;
  assessmentRelationships?: ReadonlyMap<string, string> | null;
  next: () => void;
  previous: () => void;
  first: () => void;
  refresh: () => void;
}

export interface ProjectionPagesOptions {
  /** False: no read is made and the view stays `loading`. Default true. */
  enabled?: boolean;
  /** Automatic refresh interval; clamped to at least MIN_POLL_MS. 0 disables polling. Default MIN_POLL_MS. */
  pollMs?: number;
}

export interface ManifestView {
  state: ProjectionViewState;
  envelope: ManifestEnvelope | null;
  scope: Scope | null;
  /** `scope.scope_id`. */
  scopeId: Id | null;
  /** The six descriptors in frozen order (also when the owner reports UNAVAILABLE). Capability metadata, not rows. */
  descriptors: DatasetDescriptor[];
  descriptor: (dataset: DescriptorDataset) => DatasetDescriptor | null;
  /** True only when the manifest is shown (`ready`) and the dataset descriptor has `capabilities.read`. */
  canRead: (dataset: DescriptorDataset) => boolean;
  error: ProjectionError | null;
  expiresInMs: number | null;
  refresh: () => void;
}

/** The rejection value of `readProjection`; `.error` is the typed failure. */
export class ProjectionReadError extends Error {
  readonly error: ProjectionError;
  constructor(error: ProjectionError) {
    super(`${error.status} ${error.code}`);
    this.name = 'ProjectionReadError';
    this.error = error;
  }
}

export function isProjectionReadError(value: unknown): value is ProjectionReadError {
  return value instanceof ProjectionReadError;
}

const typedError = (status: number, code: ProjectionError['code'], snapshot_id: Hash | null = null): ProjectionError => ({
  status, code, retryable: status === 503 || status === 0, snapshot_id, unauthenticated: false,
});
const invalidProjection = () => typedError(502, 'INVALID_OWNER_PROJECTION');

/** UTC epoch milliseconds as `YYYY-MM-DD HH:MM:SS UTC`; null or invalid is null (never 1970). */
export function formatUtc(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) return null;
  return new Date(value).toISOString().replace('T', ' ').replace(/\.000Z$/, ' UTC').replace(/Z$/, ' UTC');
}

// --- scope binding and the store registry -----------------------------------------------------------------

interface ClearableStore { clearForAuth: () => void; clearForScopeChange: () => void }
const stores = new Set<ClearableStore>();
const freshness = new ProjectionFreshness();

/** Registers a store for 401 and scope-change clearing. Returns the unregister function. (Used by the hooks.) */
export function registerProjectionStore(store: ClearableStore): () => void {
  stores.add(store);
  return () => { stores.delete(store); };
}

/** Drop every cached projection page and stop all reads. Done automatically on any HTTP 401. */
export function clearProjectionCaches(): void {
  for (const store of [...stores]) store.clearForAuth();
}

// --- one validated read -----------------------------------------------------------------------------------

function buildQuery(scopeId: string, params: ProjectionParams): string {
  const query = new URLSearchParams({ scope_id: scopeId });
  if (params.record_type) query.set('record_type', params.record_type);
  if (params.root_id) query.set('root_id', params.root_id);
  if (params.idea_revision_id) query.set('idea_revision_id', params.idea_revision_id);
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.cursor) query.set('cursor', params.cursor); // opaque: passed through, never decoded
  return `?${query.toString()}`;
}

async function readJson(response: Response, limit: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new ContractViolation('missing response body');
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let bytes = 0;
  let text = '';
  const decode = (chunk?: Uint8Array) => {
    try { return decoder.decode(chunk, { stream: chunk !== undefined }); }
    catch { throw new ContractViolation('invalid UTF-8'); }
  };
  try {
    while (true) {
      const { done, value } = await reader.read().catch(() => { throw new TypeError('response stream failed'); });
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new ContractViolation('response beyond the cap');
      text += decode(value);
    }
    return parseStrictJson(text + decode());
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

export type ReadResult<D extends ProjectionDataset> =
  | { ok: true; envelope: ProjectionEnvelope<D extends keyof DatasetRows ? DatasetRows[D] : never>; expiresAt: number | null }
  | { ok: false; error: ProjectionError };

/** Non-throwing form used by the hooks. Aborted reads resolve `{ok:false}` with status 0; callers drop them. */
export async function readProjectionResult<D extends ProjectionDataset>(
  dataset: D, params: ProjectionParams = {}, signal?: AbortSignal, fetcher: typeof fetch = fetch,
): Promise<ReadResult<D>> {
  const unavailable = (): ReadResult<D> => ({ ok: false, error: typedError(0, 'UPSTREAM_UNAVAILABLE') });
  const unauthenticated = (): ReadResult<D> => {
    clearProjectionCaches();
    return { ok: false, error: { status: 401, code: AUTHENTICATION_REQUIRED, retryable: false, snapshot_id: null, unauthenticated: true } };
  };
  const init = { credentials: 'include', headers: { Accept: 'application/json' }, signal, cache: 'no-store' } as const;
  const get = async (url: string) => {
    try { return await fetcher(url, init); }
    catch { return null; }
  };
  try {
    if (signal?.aborted) return unavailable();
    const session = await get('/api/v5/auth');
    if (signal?.aborted || !session) return unavailable();
    if (session.status === 401) return unauthenticated();
    if (session.status !== 200) return unavailable();
    const info = await readJson(session, 2048) as {
      authenticated?: unknown; learning_scope_id?: unknown; learning_scope_membership?: unknown;
      learning_scope_sha256?: unknown; learning_projection_revision?: unknown;
    } | null;
    if (signal?.aborted) return unavailable();
    if (info?.authenticated === false) return unauthenticated();
    if (info?.authenticated !== true) return { ok: false, error: invalidProjection() };
    const scopeId = info.learning_scope_id;
    if (scopeId === undefined) {
      return (STAGE_B_DATASETS as readonly string[]).includes(dataset)
        ? { ok: false, error: typedError(404, 'DATASET_NOT_ENABLED') }
        : { ok: false, error: typedError(503, 'PUBLICATION_UNAVAILABLE') };
    }
    if (typeof scopeId !== 'string' || !scopeId) return { ok: false, error: invalidProjection() };
    const stageB = info.learning_projection_revision === STAGE_B_REVISION;
    const scopeSha256 = stageB && typeof info.learning_scope_sha256 === 'string' ? info.learning_scope_sha256 : undefined;
    if (stageB && (!scopeSha256 || !/^[a-f0-9]{64}$/.test(scopeSha256))) return { ok: false, error: invalidProjection() };
    const membership = readScopeMembership(info.learning_scope_membership);
    const response = await get(`/api/v5/learning/${dataset}${buildQuery(scopeId, params)}`);
    if (signal?.aborted || !response) return unavailable();
    if (response.status === 401) return unauthenticated();
    const document = await readJson(response, response.status === 200 ? MAX_PROJECTION_RESPONSE_BYTES : 2048);
    if (signal?.aborted) return unavailable();
    if (response.status === 200) {
      const recordType = dataset === 'records' ? params.record_type : undefined;
      const envelope = await validateEnvelope(dataset, document, {
        recordType, ideaRevisionId: params.idea_revision_id, maxAgeMs: MAX_VERIFICATION_AGE_MS, stageB, scopeId, scopeSha256, membership,
      });
      if (signal?.aborted) return unavailable();
      const received = envelope as unknown as ProjectionEnvelope<unknown>;
      const admission = freshness.observe(dataset, received, realClock.now(), MAX_VERIFICATION_AGE_MS);
      if ('changed' in admission && admission.changed) {
        for (const store of [...stores]) store.clearForScopeChange();
      }
      if (admission.miss) return { ok: false, error: freshnessError(admission.miss, received.snapshot_id) };
      return { ok: true, envelope: envelope as never, expiresAt: admission.expiresAt };
    }
    const body = validateErrorBody(response.status, document);
    return { ok: false, error: { status: response.status, code: body.code as ProjectionErrorCode, retryable: body.retryable, snapshot_id: body.snapshot_id, unauthenticated: false } };
  } catch (error) {
    if (signal?.aborted || error instanceof TypeError || error instanceof DOMException) return unavailable();
    if (!(error instanceof ContractViolation)) throw error;
    return { ok: false, error: invalidProjection() };
  }
}

/**
 * Reads the configured scope, then one authenticated GET of `/api/v5/learning/<dataset>`. Resolves to a fully validated envelope or rejects
 * with a `ProjectionReadError`. A cancelled read rejects with an `AbortError`.
 */
export async function readProjection<D extends ProjectionDataset>(
  dataset: D, params: ProjectionParams = {}, options: { signal?: AbortSignal } = {},
): Promise<ProjectionEnvelope<D extends keyof DatasetRows ? DatasetRows[D] : never>> {
  const result = await readProjectionResult(dataset, params, options.signal);
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (!result.ok) throw new ProjectionReadError(result.error);
  return result.envelope;
}

// --- hooks ------------------------------------------------------------------------------------------------

const realClock: StoreClock = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const storeRead: StoreRead = readProjectionResult;

export function clampPollMs(pollMs: number | undefined): number {
  if (pollMs === undefined) return MIN_POLL_MS;
  return pollMs <= 0 ? 0 : Math.max(MIN_POLL_MS, pollMs);
}

function useStore(dataset: ProjectionDataset, params: ProjectionParams, options: ProjectionPagesOptions | undefined) {
  const enabled = options?.enabled ?? true;
  const pollMs = clampPollMs(options?.pollMs);
  const { record_type: recordType, root_id: rootId, idea_revision_id: ideaRevisionId, limit } = params; // the cursor is owned by the store
  const [store] = useState(() => new ProjectionStore({
    dataset, params: { record_type: recordType, root_id: rootId, idea_revision_id: ideaRevisionId, limit }, read: storeRead, clock: realClock, maxAgeMs: MAX_VERIFICATION_AGE_MS, pollMs, freshness,
  }));
  useEffect(() => {
    if (!enabled) return undefined;
    store.configure({ dataset, params: { record_type: recordType, root_id: rootId, idea_revision_id: ideaRevisionId, limit }, pollMs });
    const unregister = registerProjectionStore(store);
    store.start();
    return () => { unregister(); store.dispose(); };
  }, [store, enabled, dataset, recordType, rootId, ideaRevisionId, limit, pollMs]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { store, snapshot };
}

const expiresIn = (expiresAt: number | null) => expiresAt === null ? null : Math.max(0, Math.round(expiresAt - realClock.now()));

/** Paged, cancellable, expiry-aware read of one dataset. The cursor stack is internal and opaque. */
export function useProjectionPages<D extends PagedDataset>(
  dataset: D, params: ProjectionParams = {}, options?: ProjectionPagesOptions,
): ProjectionPagesView<D> {
  const { store, snapshot } = useStore(dataset, params, options);
  const envelope = snapshot.envelope as ProjectionEnvelope<DatasetRows[D]> | null;
  return {
    state: snapshot.state,
    envelope,
    rows: snapshot.state === 'ready' && envelope ? envelope.items : [],
    error: snapshot.error,
    pageIndex: snapshot.pageIndex,
    hasNext: snapshot.hasNext,
    hasPrevious: snapshot.hasPrevious,
    snapshotChanged: snapshot.snapshotChanged,
    expiresInMs: expiresIn(snapshot.expiresAt),
    assessmentRelationships: snapshot.assessmentRelationships,
    next: store.next, previous: store.previous, first: store.first, refresh: store.refresh,
  };
}

/** The configured scope and the per-dataset descriptors (`capabilities.read`). */
export function useManifest(options?: ProjectionPagesOptions): ManifestView {
  const { store, snapshot } = useStore('manifest', {}, options);
  const envelope = snapshot.envelope as ManifestEnvelope | null;
  const descriptors = envelope?.items ?? [];
  const descriptor = (dataset: DescriptorDataset) => descriptors.find(item => item.dataset === dataset) ?? null;
  return {
    state: snapshot.state,
    envelope,
    scope: envelope?.scope ?? null,
    scopeId: envelope?.scope?.scope_id ?? null,
    descriptors,
    descriptor,
    canRead: dataset => snapshot.state === 'ready' && descriptor(dataset)?.capabilities.read === true,
    error: snapshot.error,
    expiresInMs: expiresIn(snapshot.expiresAt),
    refresh: store.refresh,
  };
}
