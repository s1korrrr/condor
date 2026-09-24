import type { PanelState } from '@/features/quant-ops/panel-state';
import type { QuantBotSummary } from '@/features/bots/quant-roster';

/** Fleet projection for native (rsibot-stack) servers, which have no hummingbot-api catalogue.
 *  Every value comes from the owner's own reporting reads: quant-summary (registry identity,
 *  pairs, rails, wallet) and the operations workspace (stack services, heartbeat). */

export type FleetService = { id: string; state: string; detail: string; restartCount: number | null; startedAt: string | null; observedAt: string | null };
export type FleetHealth = {
  state: string; mode: string; generatedAt: string;
  heartbeat: { state: string; bootId: string | null; lifecycleState: string | null; sequence: number | null };
  services: FleetService[]; expected: string[];
};

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | null => typeof value === 'string' && value ? value : null;
const count = (value: unknown): number | null => typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;

/** Operations workspace → fleet health. Rejects another bot's payload and a future or unstamped generation. */
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
    heartbeat: { state: text(heartbeat.state) ?? 'unavailable', bootId: text(heartbeat.boot_id), lifecycleState: text(heartbeat.lifecycle_state), sequence: count(heartbeat.sequence) },
    services, expected: (Array.isArray(health.expected_services) ? health.expected_services : []).filter((value): value is string => typeof value === 'string'),
  };
}

/** One typed state per fleet card: the owner's freshness first, then the stack heartbeat. */
export function fleetCardState(summary: QuantBotSummary | null, health: FleetHealth | null, summaryIssue: string | null): PanelState {
  if (!summary) return { kind: summaryIssue?.startsWith('Access denied') ? 'unauthorized' : 'unavailable', reason: summaryIssue ?? 'No owner summary has been read yet.' };
  if (summary.freshness === 'stale' || summary.lastKnown) return { kind: 'stale', observedAt: summary.observedAt ?? summary.generatedAt, reason: 'Owner status is older than its freshness contract; values are the last publication.' };
  if (health && health.heartbeat.state !== 'healthy') return { kind: 'incomplete', observedAt: health.generatedAt, reason: `Stack heartbeat is ${health.heartbeat.state}.` };
  return { kind: 'fresh', observedAt: summary.observedAt ?? summary.generatedAt };
}

/** Service roll-up for the fleet strip: counts by observer state, in severity order. */
export function serviceRollup(health: FleetHealth | null): { total: number; healthy: number; attention: FleetService[] } {
  const services = health?.services ?? [];
  const attention = services.filter(row => row.state !== 'healthy').sort((a, b) => rank(a.state) - rank(b.state));
  return { total: services.length, healthy: services.filter(row => row.state === 'healthy').length, attention };
}
const ORDER = ['degraded', 'unavailable', 'stale', 'recovering'];
const rank = (state: string) => { const index = ORDER.indexOf(state); return index === -1 ? ORDER.length : index; };

export function tradingVisualsHref(bot: string, pair?: string | null): string {
  const params = new URLSearchParams({ bot, view: 'charts' });
  if (pair) params.set('pair', pair);
  return `/trading-visuals?${params.toString()}`;
}

export function operationsHref(bot: string): string {
  return `/operations?bot=${encodeURIComponent(bot)}`;
}
