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

/** Preserve the live auth observer while removing every owner/session read. */
export function clearSessionCache(client) {
  client.setQueryData(["v5-auth"], { authenticated: false });
  client.removeQueries({ predicate: query => query.queryKey[0] !== "v5-auth" });
}
