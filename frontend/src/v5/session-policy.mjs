/** A failed request cannot confirm that the secure session cookie was cleared. */
export async function confirmLogout(request, confirmed, failed) {
  try {
    await request();
  } catch {
    failed();
    return false;
  }
  confirmed();
  return true;
}

/** Everything the dashboard holds for a session: every owner read except the live auth observer, and the retained reports. */
export function dropSessionReads(client, clearRetained = () => {}) {
  client.removeQueries({ predicate: query => query.queryKey[0] !== "v5-auth" });
  clearRetained();
}

/** Preserve the live auth observer while removing every owner/session read. */
export function clearSessionCache(client, clearRetained = () => {}) {
  client.setQueryData(["v5-auth"], { authenticated: false });
  dropSessionReads(client, clearRetained);
}

/**
 * The session is over only when the server says so: `authenticated: false` or a 401. Any other failure is a transient
 * reconnect, and what the session already read stays.
 */
export function sessionEnded(auth, isUnauthorized) {
  return auth.data?.authenticated === false || (auth.isError === true && isUnauthorized(auth.error));
}
