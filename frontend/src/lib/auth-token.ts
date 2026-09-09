// Single source of truth for the JWT auth surface: storage key, header builder
// and a low-level authenticated fetch. Anything that talks to the API should go
// through `apiFetch` (lib/api.ts) for JSON; use `authFetch` for FormData uploads
// or binary/blob responses where forcing `Content-Type: application/json` is wrong.

import { expireSession, getToken, sessionRevision } from './auth-session.ts';
export { TOKEN_KEY, getToken } from './auth-session.ts';

/** Authorization header for the current JWT, or `{}` if not logged in. */
export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Low-level fetch that injects the auth header without forcing a Content-Type.
 * Use for FormData uploads (transcribe) or blob responses (authenticated images).
 */
export async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = getToken();
  const requestRevision = sessionRevision();
  const headers = new Headers(init?.headers);
  headers.delete('Authorization');
  const response = await fetch(path, {
    ...init,
    headers: { ...Object.fromEntries(headers), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (response.status === 401) {
    expireSession(token, requestRevision);
  } else if (requestRevision !== sessionRevision() || token !== getToken()) {
    throw new Error('Session changed while the request was in flight. Reload this view.');
  }
  return response;
}
