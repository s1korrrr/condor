import type { ServerStatus } from './server-capabilities';

/** Only transport failures may retain presentation; denial and malformed data do not. */
export function transientReadFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (!error || typeof error !== 'object') return false;
  if ('name' in error && error.name === 'TimeoutError') return true;
  const status = 'status' in error ? error.status : null;
  return typeof status === 'number' && (status >= 500 || status === 408 || status === 429);
}

/** Retain the verified read layout; status:error keeps every live permission false. */
export function retainReadProfile(next: ServerStatus, previous?: ServerStatus): ServerStatus {
  return next.status === 'error' && !next.profile && previous?.profile === 'native' && previous.capabilities?.native_status === true
    ? {...next, profile: 'native', capabilities: previous.capabilities} : next;
}
