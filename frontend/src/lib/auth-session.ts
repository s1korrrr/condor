import { queryClient } from './queryClient.ts';

export const TOKEN_KEY = 'condor_token';
const USER_KEY = 'condor_user';
export const SERVER_KEY = 'condor_selected_server';
const RECOVERY_KEY = 'condor_auth_recovery';

export interface User {
  id: number;
  username: string;
  first_name: string;
  role: string;
}

export type RecoveryReason = 'expired' | 'invalid' | 'signed_out' | 'changed' | null;
interface SessionSnapshot {
  token: string | null;
  user: User | null;
  recoveryReason: RecoveryReason;
}

let snapshot: SessionSnapshot | undefined;
let storedUser: string | null = null;
let revision = 0;
const listeners = new Set<() => void>();

function storedToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

export function getToken(): string | null {
  // A different tab's JWT must never be used with this tab's user and cache.
  return snapshot ? snapshot.token : storedToken();
}

export function validSession(value: unknown): value is { token: string; user: User } {
  if (!value || typeof value !== 'object') return false;
  const { token, user } = value as { token?: unknown; user?: Partial<User> };
  return typeof token === 'string' && token.trim().length > 0 && !!user &&
    Number.isSafeInteger(user.id) && Number(user.id) > 0 &&
    typeof user.username === 'string' && typeof user.first_name === 'string' && typeof user.role === 'string';
}

function recoveryReason(): RecoveryReason {
  try {
    const value = sessionStorage.getItem(RECOVERY_KEY);
    return value === 'expired' || value === 'invalid' || value === 'signed_out' || value === 'changed' ? value : null;
  } catch { return null; }
}

function endSession(reason: Exclude<RecoveryReason, null>, removeStored: boolean) {
  revision += 1;
  if (removeStored) {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      localStorage.removeItem(SERVER_KEY);
      storedUser = null;
    } catch { /* The in-memory session still fails closed if browser storage is unavailable. */ }
  }
  try { sessionStorage.setItem(RECOVERY_KEY, reason); } catch { /* In-memory reason remains authoritative. */ }
  queryClient.clear();
  snapshot = { token: null, user: null, recoveryReason: reason };
  listeners.forEach(listener => listener());
}

export function clearSession(reason: Exclude<RecoveryReason, null>) {
  endSession(reason, !snapshot?.token || snapshot.token === storedToken());
}

function onStorage(event: StorageEvent) {
  if (event.storageArea !== localStorage || (event.key !== null && event.key !== TOKEN_KEY && event.key !== USER_KEY)) return;
  if (matchesStoredSession()) return;
  // Keep a newer session in the other tab intact; this tab must sign in again.
  endSession('changed', false);
}

function matchesStoredSession(): boolean {
  try { return snapshot?.token === storedToken() && storedUser === localStorage.getItem(USER_KEY); }
  catch { return false; }
}

/** Read once, then expose a stable snapshot for React's external-store contract. */
export function getSessionSnapshot(): SessionSnapshot {
  if (snapshot) return snapshot;
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const raw = localStorage.getItem(USER_KEY);
    storedUser = raw;
    if (!token && !raw) {
      snapshot = { token: null, user: null, recoveryReason: recoveryReason() };
      return snapshot;
    }
    const candidate = { token, user: raw ? JSON.parse(raw) : null };
    if (validSession(candidate)) {
      snapshot = { ...candidate, recoveryReason: null };
      return snapshot;
    }
  } catch { /* Malformed or unavailable browser storage is an invalid cached session. */ }
  clearSession('invalid');
  return snapshot!;
}

export function subscribeSession(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener('storage', onStorage);
  if (snapshot?.token && !matchesStoredSession()) endSession('changed', false);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener('storage', onStorage);
  };
}

export function sessionRevision() { return revision; }
export function beginLoginAttempt() { return ++revision; }

/** A logout, expiry or newer login attempt invalidates outstanding login responses. */
export function acceptSession(value: unknown, attempt: number): boolean {
  if (attempt !== revision) return false;
  if (!validSession(value)) throw new Error('Sign-in returned an invalid session');
  try {
    localStorage.setItem(TOKEN_KEY, value.token);
    storedUser = JSON.stringify(value.user);
    localStorage.setItem(USER_KEY, storedUser);
  } catch {
    // Remove our partial write, but never overwrite a newer other-tab session.
    endSession('invalid', storedToken() === value.token);
    throw new Error('Unable to save the session in browser storage. Enable site storage and try again.');
  }
  try { sessionStorage.removeItem(RECOVERY_KEY); } catch { /* Snapshot below records successful recovery. */ }
  revision += 1;
  queryClient.clear();
  snapshot = { ...value, recoveryReason: null };
  listeners.forEach(listener => listener());
  return true;
}

/** Only the session used by this request may be expired by its response. */
export function expireSession(token: string | null, requestRevision: number) {
  if (token && token === getToken() && requestRevision === revision) {
    const ownsStoredSession = token === storedToken();
    endSession(ownsStoredSession ? 'expired' : 'changed', ownsStoredSession);
  }
}
