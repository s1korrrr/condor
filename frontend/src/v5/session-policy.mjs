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

const heldForSession = new Set();

/** Whatever the dashboard keeps outside the query cache for one session registers its clear here; every session end calls it. */
export function onSessionEnd(clear) {
  heldForSession.add(clear);
}

/** Everything the dashboard holds for a session: every owner read except the live auth observer, and what was registered. */
export function dropSessionReads(client) {
  client.removeQueries({ predicate: query => query.queryKey[0] !== "v5-auth" });
  for (const clear of heldForSession) clear();
}

/** Preserve the live auth observer while removing every owner/session read. */
export function clearSessionCache(client) {
  client.setQueryData(["v5-auth"], { authenticated: false });
  dropSessionReads(client);
}

/**
 * The session is over only when the server says so: `authenticated: false` or a 401. Any other failure is a transient
 * reconnect, and what the session already read stays.
 */
export function sessionEnded(auth, isUnauthorized) {
  return auth.data?.authenticated === false || (auth.isError === true && isUnauthorized(auth.error));
}
