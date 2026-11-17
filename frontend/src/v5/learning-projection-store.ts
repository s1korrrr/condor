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
}

const INITIAL: StoreSnapshot = {
  state: 'loading', envelope: null, error: null, pageIndex: 0, hasNext: false, hasPrevious: false, snapshotChanged: false, expiresAt: null,
};

export class ProjectionStore {
  private snapshot: StoreSnapshot = INITIAL;
  private listeners = new Set<() => void>();
  /** `stack[i]` is the opaque cursor that fetches page i (null = first page). Never decoded. */
  private stack: (string | null)[] = [null];
  private controller: AbortController | null = null;
  private expiryTimer: unknown = null;
  private pollTimer: unknown = null;
  private disposed = false;

  private readonly options: StoreOptions;

  constructor(options: StoreOptions) { this.options = options; }

  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly getSnapshot = () => this.snapshot;

  /** Start (or restart from the current page). Idempotent for the caller; a new call supersedes the previous request. */
  start = () => {
    this.disposed = false;
    if (this.snapshot.state !== 'unauthenticated') void this.load(this.snapshot.pageIndex);
  };
  refresh = () => { void this.load(this.snapshot.pageIndex, true); };
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
    this.clearExpiry();
    if (!result.ok) return this.fail(result.error, pageIndex);
    const envelope = result.envelope;
    if (envelope.status === 'UNAVAILABLE') {
      this.set({ ...this.cleared(null, { pageIndex }), envelope });
      return this.schedulePoll();
    }
    const clock = this.options.clock;
    const age = envelope.served_at_ms - (envelope.verified_at_ms as number);
    let expiresAt = clock.now() + (this.options.maxAgeMs - age);
    if (previous && previous.pageIndex === pageIndex && previous.expiresAt !== null && previous.envelope
      && previous.envelope.snapshot_id === envelope.snapshot_id && previous.envelope.verified_at_ms === envelope.verified_at_ms) {
      expiresAt = Math.min(expiresAt, previous.expiresAt); // same verification: a poll cannot renew it
    }
    if (expiresAt <= clock.now()) {
      this.set({ ...INITIAL, state: 'expired', pageIndex, hasPrevious: pageIndex > 0 });
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
