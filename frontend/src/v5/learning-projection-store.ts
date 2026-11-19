/**
 * Framework-free state machine behind `useProjectionPages` / `useManifest`.
 *
 * One store = one dataset + one filter. It owns the opaque cursor stack, request cancellation, the monotonic
 * expiry anchored to the owner's `verified_at_ms`, polling, and the "clear, never retain" rules:
 *   - a failure or expiry clears the rows; a ledger rejection never replaces a live page;
 *   - 409 SNAPSHOT_CHANGED clears the pages and waits for an explicit `first()`;
 *   - 401 clears everything and the store stays `unauthenticated`;
 *   - a poll that returns the same `verified_at_ms` cannot extend expiry.
 */
import type {
  AssessmentRow, PagedDataset, ProjectionDataset, ProjectionEnvelope, ProjectionError, ProjectionParams, ProjectionViewState, UnavailableRowStub,
} from './learning-projection';
import { AssessmentTraversal } from './factory-assessment-relationships';
import { STAGE_B_REVISION } from './learning-projection-schemas';

export type StoreRead = (
  dataset: ProjectionDataset, params: ProjectionParams, signal: AbortSignal,
) => Promise<{ ok: true; envelope: ProjectionEnvelope<unknown>; expiresAt?: number | null } | { ok: false; error: ProjectionError }>;

export interface StoreClock {
  /** Monotonic milliseconds (performance.now). Never the wall clock, never a poll timestamp. */
  now: () => number;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface StoreSnapshot {
  state: ProjectionViewState;
  /** Present when `ready`, and for an owner-reported UNAVAILABLE envelope (which carries no rows). */
  envelope: ProjectionEnvelope<unknown> | null;
  error: ProjectionError | null;
  pageIndex: number;
  hasNext: boolean;
  hasPrevious: boolean;
  snapshotChanged: boolean;
  /** Monotonic instant at which the shown data expires, or null. */
  expiresAt: number | null;
  assessmentRelationships?: ReadonlyMap<string, string> | null;
}

export interface StoreOptions {
  dataset: ProjectionDataset;
  params: ProjectionParams;
  read: StoreRead;
  clock: StoreClock;
  maxAgeMs: number;
  /** 0 disables polling. */
  pollMs: number;
  freshness?: ProjectionFreshness;
}

const INITIAL: StoreSnapshot = {
  state: 'loading', envelope: null, error: null, pageIndex: 0, hasNext: false, hasPrevious: false, snapshotChanged: false, expiresAt: null,
};

export type FreshnessMiss = 'retired' | 'ignored' | 'expired';
type Admission = { expiresAt: number | null; changed: boolean; miss?: 'expired' } | { miss: 'ignored' | 'retired' };
const MAX_RETIRED_SNAPSHOTS = 4096;

export function freshnessError(miss: FreshnessMiss, snapshotId: string | null): ProjectionError {
  return {
    status: miss === 'retired' ? 409 : 503,
    code: miss === 'retired' ? 'SNAPSHOT_CHANGED' : 'STALE_OR_EXPIRED',
    retryable: miss !== 'retired', snapshot_id: snapshotId, unauthenticated: false, freshness: miss,
  };
}

export class ProjectionFreshness {
  private globalMaxVerifiedAt = -1;
  private currentSnapshot: string | null = null;
  private retired = new Set<string>();
  private deadlines = new Map<ProjectionDataset, number>();

  observe(dataset: ProjectionDataset, envelope: ProjectionEnvelope<unknown>, now: number, maxAgeMs: number): Admission {
    const { snapshot_id: snapshot, verified_at_ms: verifiedAt } = envelope;
    if (snapshot !== null && this.retired.has(snapshot)) return { miss: 'retired' };
    const current = this.currentSnapshot;
    const maximum = this.globalMaxVerifiedAt;
    if (verifiedAt !== null && (verifiedAt < maximum || (verifiedAt === maximum && snapshot !== current))) {
      return { miss: 'ignored' };
    }
    let changed = false;
    if (snapshot !== null && verifiedAt !== null && verifiedAt > maximum) {
      if (current !== null && current !== snapshot) {
        if (this.retired.size >= MAX_RETIRED_SNAPSHOTS) return { miss: 'ignored' };
        this.retired.add(current);
        changed = true;
      }
      this.globalMaxVerifiedAt = verifiedAt;
      this.currentSnapshot = snapshot;
      this.deadlines.clear();
    }
    if (envelope.status === 'UNAVAILABLE') {
      const deadline = verifiedAt === maximum ? this.deadlines.get(dataset) : undefined;
      return deadline !== undefined && now >= deadline ? { expiresAt: deadline, changed, miss: 'expired' }
        : { expiresAt: null, changed };
    }
    if (snapshot === null || verifiedAt === null) return { miss: 'ignored' };
    let expiresAt = this.deadlines.get(dataset);
    if (expiresAt === undefined) {
      expiresAt = now + (maxAgeMs - (envelope.served_at_ms - verifiedAt));
      this.deadlines.set(dataset, expiresAt);
    }
    return now >= expiresAt ? { expiresAt, changed, miss: 'expired' } : { expiresAt, changed };
  }
}

export class ProjectionStore {
  private snapshot: StoreSnapshot = INITIAL;
  private listeners = new Set<() => void>();
  /** `stack[i]` is the opaque cursor that fetches page i (null = first page). Never decoded. */
  private stack: (string | null)[] = [null];
  private admittedRevision: string | null = null;
  private controller: AbortController | null = null;
  private expiryTimer: unknown = null;
  private pollTimer: unknown = null;
  private disposed = false;

  private options: StoreOptions;
  private freshness: ProjectionFreshness;
  private assessmentTraversal = new AssessmentTraversal();

  constructor(options: StoreOptions) {
    this.options = options;
    this.freshness = options.freshness ?? new ProjectionFreshness();
  }

  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly getSnapshot = () => this.snapshot;

  /** Point the store at another dataset / filter / poll interval: everything shown or paged is dropped. */
  configure(next: Pick<StoreOptions, 'dataset' | 'params' | 'pollMs'>) {
    this.abort();
    this.clearTimers();
    this.options = { ...this.options, ...next };
    this.stack = [null];
    this.admittedRevision = null;
    this.assessmentTraversal.clear();
    this.set({ ...INITIAL });
  }

  /** Start (or restart from the current page). Idempotent for the caller; a new call supersedes the previous request. */
  start = () => {
    this.disposed = false;
    if (this.snapshot.state !== 'unauthenticated') void this.load(this.snapshot.pageIndex);
  };
  refresh = () => { void this.load(this.snapshot.pageIndex); };
  first = () => { this.stack = [null]; this.assessmentTraversal.clear(); void this.load(0, true); };
  next = () => {
    const cursor = this.snapshot.envelope?.page.next_cursor;
    if (!this.snapshot.hasNext || !cursor) return;
    const index = this.snapshot.pageIndex + 1;
    this.stack = [...this.stack.slice(0, index), cursor];
    void this.load(index);
  };
  previous = () => {
    const index = this.snapshot.pageIndex - 1;
    if (index >= 0) void this.load(index);
  };

  /** 401 anywhere: drop data and stop, until the caller explicitly refreshes after signing in. */
  clearForAuth() {
    this.abort();
    this.clearTimers();
    this.stack = [null];
    this.admittedRevision = null;
    this.assessmentTraversal.clear();
    this.set({ ...INITIAL, state: 'unauthenticated', error: { status: 401, code: 'authentication_required', retryable: false, snapshot_id: null, unauthenticated: true } });
  }

  /** Scope or revision changed under the page: drop data and re-read from the first page. */
  clearForScopeChange() {
    if (this.disposed || this.snapshot.state === 'unauthenticated') return;
    this.clearTimers();
    this.stack = [null];
    this.admittedRevision = null;
    this.assessmentTraversal.clear();
    this.set({ ...INITIAL });
    void this.load(0, true);
  }

  /** Stops requests and timers. Reversible by `start()` (React strict-mode mount/unmount/mount). */
  dispose() {
    this.disposed = true;
    this.abort();
    this.clearTimers();
    this.assessmentTraversal.clear();
  }

  // --- internals -----------------------------------------------------------------------------------

  private set(next: StoreSnapshot) {
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }

  private abort() {
    this.controller?.abort();
    this.controller = null;
  }

  private clearTimers() {
    this.clearExpiry();
    this.clearPoll();
  }

  private clearExpiry() {
    if (this.expiryTimer !== null) this.options.clock.clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
  }

  private clearPoll() {
    if (this.pollTimer !== null) this.options.clock.clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private cleared(error: ProjectionError | null, extra: Partial<StoreSnapshot> = {}): StoreSnapshot {
    return { ...INITIAL, state: 'unavailable', error, pageIndex: this.snapshot.pageIndex, hasPrevious: this.snapshot.pageIndex > 0, ...extra };
  }

  private async load(pageIndex: number, announce = false) {
    if (pageIndex >= this.stack.length) pageIndex = 0;
    this.abort();
    this.clearPoll();
    const controller = new AbortController();
    this.controller = controller;
    const previous = this.snapshot.state === 'ready' ? this.snapshot : null;
    // Moving between pages never keeps the previous page on screen. A background poll of the same page keeps
    // the rows (and their expiry timer) until the answer arrives; its failure then clears them.
    if (announce || pageIndex !== this.snapshot.pageIndex || !previous) {
      this.clearExpiry();
      this.set({ ...INITIAL, pageIndex, hasPrevious: pageIndex > 0, state: 'loading' });
    }
    const cursor = this.stack[pageIndex] ?? null;
    const result = await this.options.read(this.options.dataset, { ...this.options.params, cursor: cursor ?? undefined }, controller.signal);
    if (controller.signal.aborted || this.disposed || this.controller !== controller) return; // superseded: ignore
    this.controller = null;
    const dataset = this.options.dataset;
    if (!result.ok) {
      if (result.error.freshness) return this.freshnessMiss(result.error, pageIndex);
      this.clearExpiry();
      this.assessmentTraversal.clear();
      return this.fail(result.error, pageIndex);
    }
    const envelope = result.envelope;
    const clock = this.options.clock;
    const now = clock.now();
    let expiresAt = result.expiresAt;
    if (expiresAt === undefined) {
      const admission = this.freshness.observe(dataset, envelope, now, this.options.maxAgeMs);
      if (admission.miss) return this.freshnessMiss(freshnessError(admission.miss, envelope.snapshot_id), pageIndex);
      expiresAt = admission.expiresAt;
    }
    if (expiresAt !== null && expiresAt <= now) return this.freshnessMiss(freshnessError('expired', envelope.snapshot_id), pageIndex);
    this.admittedRevision = envelope.projection_revision;
    if (expiresAt === null) {
      this.clearExpiry();
      this.assessmentTraversal.clear();
      if (envelope.projection_revision === STAGE_B_REVISION) {
        this.stack = [null];
        pageIndex = 0;
      }
      this.set({ ...this.cleared(null, { pageIndex, hasPrevious: pageIndex > 0 }), envelope });
      return this.schedulePoll();
    }
    this.clearExpiry();
    const assessmentRelationships = dataset === 'assessments'
      ? this.assessmentTraversal.observe(envelope as ProjectionEnvelope<AssessmentRow | UnavailableRowStub>, pageIndex, cursor, this.options.params.idea_revision_id)
      : null;
    this.set({
      state: 'ready', envelope, error: null, pageIndex, hasNext: envelope.page.next_cursor !== null, hasPrevious: pageIndex > 0, snapshotChanged: false, expiresAt,
      assessmentRelationships,
    });
    this.expiryTimer = clock.setTimeout(() => this.expire(), Math.max(0, expiresAt - clock.now()));
    this.schedulePoll();
  }

  private freshnessMiss(error: ProjectionError, pageIndex: number) {
    const resumeIndex = this.resetFailedContinuation(pageIndex);
    if (this.snapshot.expiresAt === null || this.snapshot.expiresAt <= this.options.clock.now()) {
      this.clearExpiry();
      this.assessmentTraversal.clear();
      if (error.freshness === 'retired' && this.admittedRevision === STAGE_B_REVISION) return this.fail(error, resumeIndex);
      const state = error.freshness === 'expired' || this.snapshot.state === 'expired' ? 'expired' : 'unavailable';
      this.set(this.cleared(error, { state, pageIndex: resumeIndex, hasPrevious: resumeIndex > 0 }));
    } else if (resumeIndex !== pageIndex) {
      this.assessmentTraversal.clear();
      this.set({ ...this.snapshot, hasNext: false, assessmentRelationships: null });
    }
    this.schedulePoll();
  }

  private resetFailedContinuation(pageIndex: number) {
    if (pageIndex === 0 || this.admittedRevision !== STAGE_B_REVISION) return pageIndex;
    this.stack = [null];
    return 0;
  }

  /** The shown data is older than the contract allows: clear it. Polling continues so the page can recover. */
  private expire() {
    this.expiryTimer = null;
    this.assessmentTraversal.clear();
    this.set({ ...INITIAL, state: 'expired', pageIndex: this.snapshot.pageIndex, hasPrevious: this.snapshot.pageIndex > 0 });
    if (this.controller === null && this.pollTimer === null) this.schedulePoll();
  }

  private fail(error: ProjectionError, pageIndex: number) {
    if (error.unauthenticated) return this.clearForAuth();
    if (error.code === 'SNAPSHOT_CHANGED' || error.code === 'INVALID_CURSOR') {
      this.stack = [null]; // the old pages are gone; offer First, never restart on its own
      this.set({ ...INITIAL, state: 'unavailable', error, snapshotChanged: error.code === 'SNAPSHOT_CHANGED', pageIndex: 0 });
      return;
    }
    pageIndex = this.resetFailedContinuation(pageIndex);
    this.set(this.cleared(error, { pageIndex, hasPrevious: pageIndex > 0 }));
    this.schedulePoll();
  }

  private schedulePoll() {
    if (this.options.pollMs <= 0 || this.disposed) return;
    this.pollTimer = this.options.clock.setTimeout(() => { void this.load(this.snapshot.pageIndex); }, this.options.pollMs);
  }
}

export type { PagedDataset };
