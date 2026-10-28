/** V5-only read transport for the existing Condor pages. No bearer token is stored. */
import { validateV5ReadRequest } from "./transport-policy.mjs";

export async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const original = validateV5ReadRequest(path, init.method ?? "GET", init.body !== undefined, window.location.origin);
  const query = new URLSearchParams({ path: original });
  const headers = new Headers(init.headers);
  headers.delete("Authorization");
  return fetch(`/api/v5/dashboard/read?${query}`, {
    ...init,
    method: "GET",
    body: undefined,
    headers,
    credentials: "include",
    redirect: "error",
  });
}
