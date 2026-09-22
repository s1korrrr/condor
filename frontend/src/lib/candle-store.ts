/**
 * Singleton candle data store.
 *
 * Manages candle collections keyed by WS channel, reference-counted WS
 * subscriptions with deferred teardown, and listener notifications for
 * React hooks.  Completely framework-agnostic — the React bridge lives
 * in `useCandleStore.ts`.
 */

import type { CandleData } from "./api";
import type { CondorWebSocket } from "./websocket";

export type CandleInsertKind = "live" | "history";

export type CandleQuality = {
  rejected: number;
  conflicts: number[];
};

interface CandleCollection {
  map: Map<number, CandleData>;
  sorted: CandleData[] | null;
  maxSize: number;
  lastAccessed: number;
}

interface Subscription {
  refCount: number;
  teardownTimer: ReturnType<typeof setTimeout> | null;
}

type Listener = (candles: CandleData[]) => void;

const MAX_COLLECTION_SIZE = 2000;
const MAX_COLLECTIONS = 20;
const TEARDOWN_DELAY_MS = 5 * 60 * 1000;
const IDLE_CLEANUP_MS = 10 * 60 * 1000;

function normalizeTimestamp(ts: number): number {
  return ts > 1e12 ? ts / 1000 : ts;
}

function sortedFromMap(map: Map<number, CandleData>): CandleData[] {
  return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp);
}

function evictOldest(col: CandleCollection): void {
  if (col.map.size <= col.maxSize) return;
  const timestamps = Array.from(col.map.keys()).sort((a, b) => a - b);
  const excess = timestamps.length - col.maxSize;
  for (let i = 0; i < excess; i++) {
    col.map.delete(timestamps[i]);
  }
  col.sorted = null;
}

function sameCandle(left: CandleData, right: CandleData): boolean {
  return left.open === right.open
    && left.high === right.high
    && left.low === right.low
    && left.close === right.close
    && left.volume === right.volume;
}

/** Reject invalid crypto spot OHLC before it can enter a collection. */
export function validateSpotCandle(candle: unknown): CandleData | null {
  if (!candle || typeof candle !== "object" || Array.isArray(candle)) return null;
  const row = candle as Record<string, unknown>;
  const timestamp = typeof row.timestamp === "number" && Number.isFinite(row.timestamp)
    ? normalizeTimestamp(row.timestamp)
    : NaN;
  const open = row.open;
  const high = row.high;
  const low = row.low;
  const close = row.close;
  const volume = row.volume;
  if (typeof open !== "number" || typeof high !== "number" || typeof low !== "number"
    || typeof close !== "number" || typeof volume !== "number"
    || ![timestamp, open, high, low, close, volume].every(Number.isFinite)) {
    return null;
  }
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0) return null;
  if (low > high) return null;
  if (open < low || open > high || close < low || close > high) return null;
  return { timestamp, open, high, low, close, volume };
}

export class CandleStore {
  collections = new Map<string, CandleCollection>();
  subscriptions = new Map<string, Subscription>();
  listeners = new Map<string, Set<Listener>>();
  /** Current stream/poll receipt time; not an exchange event-time guarantee. */
  lastUpdateTime = new Map<string, number>();
  private receiptAgeLimit = new Map<string, number>();
  historyReceiptTime = new Map<string, number>();
  quality = new Map<string, CandleQuality>();

  private ws: CondorWebSocket | null = null;
  private wsCleanup: (() => void) | null = null;
  private accessOrder: string[] = [];
  private readonly now: () => number;
  private readonly idleTimer: ReturnType<typeof setInterval> | null;

  constructor(options: { now?: () => number; idleCleanup?: boolean } = {}) {
    this.now = options.now ?? Date.now;
    const enableIdle = options.idleCleanup ?? typeof window !== 'undefined';
    if (!enableIdle) {
      this.idleTimer = null;
      return;
    }
    const timer = setInterval(() => this._cleanupIdle(), 60_000);
    this.idleTimer = timer;
  }

  attachWs(ws: CondorWebSocket): void {
    if (this.ws === ws) return;
    if (this.ws) this._unbindWs();
    this._bindWs(ws);
  }

  detachWs(ws: CondorWebSocket): void {
    if (this.ws !== ws) return;
    this._unbindWs();
  }

  private _unbindWs(): void {
    if (this.wsCleanup) {
      this.wsCleanup();
      this.wsCleanup = null;
    }
    this.ws = null;
    this._invalidateReceipts();
  }

  private _invalidateReceipts(): void {
    const keys = [...this.lastUpdateTime.keys()];
    this.lastUpdateTime.clear();
    this.receiptAgeLimit.clear();
    for (const key of keys) this._notify(key);
  }

  private _bindWs(ws: CondorWebSocket): void {
    this.ws = ws;

    const removeMessage = ws.onMessage((channel: string, data: unknown) => {
      if (typeof channel !== "string" || !channel.startsWith("candles:") || !data || typeof data !== "object") return;
      const payload = data as {
        type: string;
        kind?: CandleInsertKind;
        receipt_max_age_ms?: number;
        candle?: CandleData;
        data?: CandleData[];
        message?: string;
      };

      if (payload.type === "candle_update" && payload.candle) {
        this._upsertOne(channel, payload.candle, "live");
        this._notify(channel);
      } else if (payload.type === "candles" && Array.isArray(payload.data) && payload.data.length) {
        // Unmarked/older-server batches are conservatively historical. A
        // backend current poll or batched stream explicitly supplies kind.
        this._upsertMany(channel, payload.data, payload.kind === "live" ? "live" : "history", payload.receipt_max_age_ms);
        this._notify(channel);
      } else if (payload.type === "error") {
        this.lastUpdateTime.delete(channel);
        this.receiptAgeLimit.delete(channel);
        this._notify(channel);
      }
    });
    const removeConnect = ws.onConnect(() => this._invalidateReceipts());
    const removeDisconnect = ws.onDisconnect(() => this._invalidateReceipts());
    this.wsCleanup = () => { removeMessage(); removeConnect(); removeDisconnect(); };

    for (const [key, sub] of this.subscriptions) {
      if (sub.refCount > 0) {
        ws.subscribe(key);
      }
    }
  }

  subscribe(key: string): CandleData[] {
    let sub = this.subscriptions.get(key);
    if (!sub) {
      sub = { refCount: 0, teardownTimer: null };
      this.subscriptions.set(key, sub);
    }

    if (sub.teardownTimer !== null) {
      clearTimeout(sub.teardownTimer);
      sub.teardownTimer = null;
    }

    sub.refCount++;

    if (sub.refCount === 1 && this.ws) {
      this.ws.subscribe(key);
    }

    this._touchAccess(key);
    return this.getCandles(key);
  }

  unsubscribe(key: string): void {
    const sub = this.subscriptions.get(key);
    if (!sub) return;

    sub.refCount = Math.max(0, sub.refCount - 1);
    if (sub.refCount > 0) return;

    sub.teardownTimer = setTimeout(() => {
      sub.teardownTimer = null;
      if (sub.refCount === 0 && this.ws) {
        this.ws.unsubscribe(key);
        this.subscriptions.delete(key);
      }
    }, TEARDOWN_DELAY_MS);
  }

  mergeCandles(key: string, candles: CandleData[], kind: CandleInsertKind = "history"): void {
    this._upsertMany(key, candles, kind);
    this._notify(key);
  }

  setDuration(key: string, durationSeconds: number): void {
    if (this.ws) {
      this.ws.setCandleDuration(key, durationSeconds);
    }
  }

  getCandles(key: string): CandleData[] {
    const col = this.collections.get(key);
    if (!col) return [];
    this._touchAccess(key);
    if (col.sorted === null) {
      col.sorted = sortedFromMap(col.map);
    }
    return col.sorted;
  }

  getLastUpdateAge(key: string): number {
    const t = this.lastUpdateTime.get(key);
    return t === undefined ? Infinity : this.now() - t;
  }

  getStaleThreshold(key: string, defaultThreshold: number): number {
    return Math.max(defaultThreshold, this.receiptAgeLimit.get(key) ?? 0);
  }

  getQuality(key: string): CandleQuality {
    return this.quality.get(key) ?? { rejected: 0, conflicts: [] };
  }

  onUpdate(key: string, callback: Listener): () => void {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(callback);
    return () => {
      set!.delete(callback);
      if (set!.size === 0) this.listeners.delete(key);
    };
  }

  dispose(): void {
    this._unbindWs();
    if (this.idleTimer !== null) clearInterval(this.idleTimer);
    for (const sub of this.subscriptions.values()) {
      if (sub.teardownTimer !== null) {
        clearTimeout(sub.teardownTimer);
        sub.teardownTimer = null;
      }
    }
  }

  private _quality(key: string): CandleQuality {
    let current = this.quality.get(key);
    if (!current) {
      current = { rejected: 0, conflicts: [] };
      this.quality.set(key, current);
    }
    return current;
  }

  private _getOrCreateCollection(key: string): CandleCollection {
    let col = this.collections.get(key);
    if (!col) {
      this._enforceMaxCollections();
      col = {
        map: new Map(),
        sorted: null,
        maxSize: MAX_COLLECTION_SIZE,
        lastAccessed: this.now(),
      };
      this.collections.set(key, col);
      this._touchAccess(key);
    }
    return col;
  }

  private _accept(key: string, candle: unknown, kind: CandleInsertKind, ageLimit?: number): boolean {
    const normalized = validateSpotCandle(candle);
    if (!normalized) {
      this._quality(key).rejected += 1;
      return false;
    }
    const col = this._getOrCreateCollection(key);
    const latestTimestamp = Math.max(-Infinity, ...col.map.keys());
    const existing = col.map.get(normalized.timestamp);
    if (existing && !sameCandle(existing, normalized)) {
      if (kind === "history") {
        const quality = this._quality(key);
        if (!quality.conflicts.includes(normalized.timestamp)) quality.conflicts.push(normalized.timestamp);
        col.lastAccessed = this.now();
        return false;
      }
    }
    col.map.set(normalized.timestamp, normalized);
    col.sorted = null;
    col.lastAccessed = this.now();
    const receipt = this.now();
    if (kind === "live") {
      if (normalized.timestamp >= latestTimestamp) {
        this.lastUpdateTime.set(key, receipt);
        // Gecko polls can be 60s apart. Permit the declared two-poll deadline,
        // bounded by the existing longest freshness category (120 seconds).
        if (typeof ageLimit === "number" && Number.isFinite(ageLimit) && ageLimit > 0 && ageLimit <= 120000) {
          this.receiptAgeLimit.set(key, ageLimit);
        } else this.receiptAgeLimit.delete(key);
      }
    } else this.historyReceiptTime.set(key, receipt);
    evictOldest(col);
    return true;
  }

  private _upsertOne(key: string, candle: CandleData, kind: CandleInsertKind): void {
    this._accept(key, candle, kind);
  }

  private _upsertMany(key: string, candles: CandleData[], kind: CandleInsertKind, ageLimit?: number): void {
    if (!candles.length) return;
    for (const candle of candles) this._accept(key, candle, kind, ageLimit);
  }

  private _notify(key: string): void {
    const set = this.listeners.get(key);
    if (!set || set.size === 0) return;
    const candles = this.getCandles(key);
    for (const cb of set) {
      cb(candles);
    }
  }

  private _touchAccess(key: string): void {
    const idx = this.accessOrder.indexOf(key);
    if (idx >= 0) this.accessOrder.splice(idx, 1);
    this.accessOrder.push(key);
  }

  private _dropInactive(key: string): void {
    this.collections.delete(key);
    this.listeners.delete(key);
    this.lastUpdateTime.delete(key);
    this.receiptAgeLimit.delete(key);
    this.historyReceiptTime.delete(key);
    this.quality.delete(key);
  }

  private _enforceMaxCollections(): void {
    if (this.collections.size < MAX_COLLECTIONS) return;
    const survivors: string[] = [];
    for (const key of this.accessOrder) {
      if (this.collections.size >= MAX_COLLECTIONS) {
        const sub = this.subscriptions.get(key);
        if (!sub || sub.refCount === 0) {
          this._dropInactive(key);
          continue;
        }
      }
      survivors.push(key);
    }
    this.accessOrder = survivors;
  }

  _cleanupIdle(): void {
    const now = this.now();
    for (const [key, col] of this.collections) {
      if (now - col.lastAccessed > IDLE_CLEANUP_MS) {
        const sub = this.subscriptions.get(key);
        if (!sub || sub.refCount === 0) {
          this._dropInactive(key);
          const idx = this.accessOrder.indexOf(key);
          if (idx >= 0) this.accessOrder.splice(idx, 1);
        }
      }
    }
  }
}

export const candleStore = new CandleStore();
