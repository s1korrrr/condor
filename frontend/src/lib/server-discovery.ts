import type { ServerInfo } from './api';

/** Reject ambiguous identities instead of choosing an owner from malformed discovery. */
export function parseServerDiscovery(value: unknown): ServerInfo[] {
  if (!Array.isArray(value)) throw new Error('Server discovery returned an invalid list');
  const names = new Set<string>();
  for (const server of value) {
    if (!server || typeof server !== 'object' || typeof server.name !== 'string' ||
        !server.name.trim() || typeof server.online !== 'boolean') {
      throw new Error('Server discovery returned an invalid server identity');
    }
    if (names.has(server.name)) throw new Error('Server discovery returned duplicate server identities');
    names.add(server.name);
  }
  return value as ServerInfo[];
}
