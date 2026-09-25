/**
 * Server the picker should switch to, or null to keep the current selection.
 * A saved name that the server list no longer contains (a retired alias) is replaced by the
 * first online server, exactly like an empty selection. An unread list never changes anything.
 */
export function replacementServer(saved: string | null, servers: { name: string; online: boolean }[] | undefined): string | null {
  if (!servers || !servers.length) return null;
  if (saved && servers.some(server => server.name === saved)) return null;
  return servers.find(server => server.online)?.name ?? null;
}
