/** Stack heartbeat and service observations for one bot, from the operations workspace read.
 *  Folded here from the removed Fleet page: the Bots page shows identity (boot id, sequence), heartbeat and
 *  restart counts beside each bot. Service-level detail and history stay in Operations. */

export type FleetService = { id: string; state: string; detail: string; restartCount: number | null; startedAt: string | null; observedAt: string | null };
export type FleetHealth = {
  state: string; mode: string; generatedAt: string;
  freshness: 'current' | 'stale';
  heartbeat: { state: string; bootId: string | null; lifecycleState: string | null; sequence: number | null };
  services: FleetService[]; expected: string[];
};

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | null => typeof value === 'string' && value ? value : null;
const count = (value: unknown): number | null => typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;

/** Operations workspace → bot health. Rejects another bot's payload and a future or unstamped generation. */
export function projectFleetHealth(payload: unknown, bot: string, now: number): FleetHealth | null {
  const root = object(payload);
  const health = object(root.health);
  if (root.schema_version !== 1 || root.bot_name !== bot || health.schema_version !== 1) return null;
  const generatedAt = text(health.generated_at);
  if (!generatedAt || !Number.isFinite(Date.parse(generatedAt)) || Date.parse(generatedAt) > now + 5000) return null;
  const heartbeat = object(health.heartbeat);
  const services = (Array.isArray(health.services) ? health.services : []).map(object).flatMap(row => {
    const id = text(row.id);
    return id ? [{ id, state: text(row.state) ?? 'unavailable', detail: text(row.detail) ?? '', restartCount: count(row.restart_count), startedAt: text(row.started_at), observedAt: text(row.observed_at) }] : [];
  });
  return {
    state: text(health.state) ?? 'unavailable', mode: text(health.mode) ?? 'intent unavailable', generatedAt,
    freshness: now - Date.parse(generatedAt) < 30_000 ? 'current' : 'stale',
    heartbeat: { state: text(heartbeat.state) ?? 'unavailable', bootId: text(heartbeat.boot_id), lifecycleState: text(heartbeat.lifecycle_state), sequence: count(heartbeat.sequence) },
    services, expected: (Array.isArray(health.expected_services) ? health.expected_services : []).filter((value): value is string => typeof value === 'string'),
  };
}

/** Restarts across the distinct stack services the bots observe. Bots on one stack report the same services,
 *  so a service id counts once (highest restart count wins). */
export function stackRestarts(healths: readonly (FleetHealth | null)[]): { services: number; restarts: number; restarted: number } | null {
  const seen = new Map<string, number>();
  let read = false;
  for (const health of healths) {
    if (!health) continue;
    read = true;
    for (const service of health.services) seen.set(service.id, Math.max(seen.get(service.id) ?? 0, service.restartCount ?? 0));
  }
  if (!read) return null;
  const counts = [...seen.values()];
  return { services: counts.length, restarts: counts.reduce((total, value) => total + value, 0), restarted: counts.filter(value => value > 0).length };
}
