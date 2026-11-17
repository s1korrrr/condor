/**
 * Framework-free state machine behind `useProjectionPages` / `useManifest`.
 *
 * One store = one dataset + one filter. It owns the opaque cursor stack, request cancellation, the monotonic
 * expiry anchored to the owner's `verified_at_ms`, polling, and the "clear, never retain" rules:
 *   - any failure, rejection or expiry clears the rows (no last-good view);
 *   - 409 SNAPSHOT_CHANGED clears the pages and waits for an explicit `first()`;
 *   - 401 clears everything and the store stays `unauthenticated`;
 *   - a poll that returns the same `verified_at_ms` cannot extend expiry.
 */
import type {
  PagedDataset, ProjectionDataset, ProjectionEnvelope, ProjectionError, ProjectionParams, ProjectionViewState,
} from './learning-projection';

export type StoreRead = (
  dataset: ProjectionDataset, params: ProjectionParams, signal: AbortSignal,
) => Promise<{ ok: true; envelope: ProjectionEnvelope<unknown> } | { ok: false; error: ProjectionError }>;

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

interface Verification {
  verifiedAt: number;
  expiresAt: number;
}

export class ProjectionFreshness {
  private highWater = new Map<string, Verification>();
  private active = new Map<ProjectionDataset, Verification>();

  isStale(dataset: ProjectionDataset, snapshot: string, verifiedAt: number, now: number) {
    const receipt = this.highWater.get(`${dataset}:${snapshot}`);
    return receipt !== undefined && (verifiedAt < receipt.verifiedAt || (
      verifiedAt === receipt.verifiedAt && (this.active.get(dataset) !== receipt || now >= receipt.expiresAt)
    ));
  }

  observe(dataset: ProjectionDataset, snapshot: string, verifiedAt: number, expiresAt: number) {
    const key = `${dataset}:${snapshot}`;
    let receipt = this.highWater.get(key);
    if (!receipt || verifiedAt > receipt.verifiedAt) {
      receipt = { verifiedAt, expiresAt };
      this.highWater.set(key, receipt);
      this.active.set(dataset, receipt);
    }
    return { receipt, active: this.active.get(dataset) === receipt };
  }

  invalidate(dataset?: ProjectionDataset) {
    if (dataset === undefined) this.active.clear();
    else this.active.delete(dataset);
  }
}

export class ProjectionStore {
  private snapshot: StoreSnapshot = INITIAL;
  private listeners = new Set<() => void>();
  /** `stack[i]` is the opaque cursor that fetches page i (null = first page). Never decoded. */
  private stack: (string | null)[] = [null];
  private controller: AbortController | null = null;
  private expiryTimer: unknown = null;
  private pollTimer: unknown = null;
  private disposed = false;

  private options: StoreOptions;
  private freshness: ProjectionFreshness;

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
    this.set({ ...INITIAL });
  }

  /** Start (or restart from the current page). Idempotent for the caller; a new call supersedes the previous request. */
  start = () => {
    this.disposed = false;
    if (this.snapshot.state !== 'unauthenticated') void this.load(this.snapshot.pageIndex);
  };
  refresh = () => { void this.load(this.snapshot.pageIndex); };
  first = () => { this.stack = [null]; void this.load(0, true); };
  next = () => {
    const cursor = this.snapshot.envelope?.page.next_cursor;
    if (!cursor) return;
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
    this.freshness.invalidate();
    this.abort();
    this.clearTimers();
    this.stack = [null];
    this.set({ ...INITIAL, state: 'unauthenticated', error: { status: 401, code: 'authentication_required', retryable: false, snapshot_id: null, unauthenticated: true } });
  }

  /** Scope or revision changed under the page: drop data and re-read from the first page. */
  clearForScopeChange() {
    if (this.disposed || this.snapshot.state === 'unauthenticated') return;
    this.clearTimers();
    this.stack = [null];
    this.set({ ...INITIAL });
    void this.load(0, true);
  }

  /** Stops requests and timers. Reversible by `start()` (React strict-mode mount/unmount/mount). */
  dispose() {
    this.disposed = true;
    this.abort();
    this.clearTimers();
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
    const result = await this.options.read(this.options.dataset, { ...this.options.params, cursor: this.stack[pageIndex] ?? undefined }, controller.signal);
    if (controller.signal.aborted || this.disposed || this.controller !== controller) return; // superseded: ignore
    this.controller = null;
    const dataset = this.options.dataset;
    if (!result.ok) {
      this.clearExpiry();
      this.freshness.invalidate(dataset);
      return this.fail(result.error, pageIndex);
    }
    const envelope = result.envelope;
    if (envelope.status === 'UNAVAILABLE') {
      this.clearExpiry();
      this.freshness.invalidate(dataset);
      this.set({ ...this.cleared(null, { pageIndex }), envelope });
      return this.schedulePoll();
    }
    const clock = this.options.clock;
    const verifiedAt = envelope.verified_at_ms as number;
    const age = envelope.served_at_ms - verifiedAt;
    const now = clock.now();
    const snapshotId = envelope.snapshot_id as string;
    const displayed = this.snapshot.envelope;
    if (displayed?.snapshot_id !== snapshotId && this.snapshot.state === 'ready' && this.snapshot.expiresAt !== null
      && this.snapshot.expiresAt > now && this.freshness.isStale(dataset, snapshotId, verifiedAt, now)) {
      return this.schedulePoll();
    }
    const { receipt, active } = this.freshness.observe(dataset, snapshotId, verifiedAt, now + this.options.maxAgeMs - age);
    const { expiresAt } = receipt;
    if (this.snapshot.state === 'ready' && this.snapshot.expiresAt !== null && this.snapshot.expiresAt > clock.now()
      && this.snapshot.envelope?.snapshot_id === envelope.snapshot_id && verifiedAt <= (this.snapshot.envelope.verified_at_ms as number)
      && active) return this.schedulePoll();
    this.clearExpiry();
    if (expiresAt <= clock.now()) {
      this.set({ ...INITIAL, state: 'expired', pageIndex, hasPrevious: pageIndex > 0 });
      return this.schedulePoll();
    }
    if (!active || verifiedAt < receipt.verifiedAt) {
      this.set(this.cleared(null, { pageIndex }));
      return this.schedulePoll();
    }
    this.set({
      state: 'ready', envelope, error: null, pageIndex, hasNext: envelope.page.next_cursor !== null, hasPrevious: pageIndex > 0, snapshotChanged: false, expiresAt,
    });
    this.expiryTimer = clock.setTimeout(() => this.expire(), Math.max(0, expiresAt - clock.now()));
    this.schedulePoll();
  }

  /** The shown data is older than the contract allows: clear it. Polling continues so the page can recover. */
  private expire() {
    this.expiryTimer = null;
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
    this.set({ ...this.cleared(error, { pageIndex }) });
    this.schedulePoll();
  }

  private schedulePoll() {
    if (this.options.pollMs <= 0 || this.disposed) return;
    this.pollTimer = this.options.clock.setTimeout(() => { void this.load(this.snapshot.pageIndex); }, this.options.pollMs);
  }
}

export type { PagedDataset };
