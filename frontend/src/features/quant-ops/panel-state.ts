/** Typed panel states (spec §5.4). A panel renders exactly one; the footer reports the worst on the page. */
export type PanelStateKind = 'fresh' | 'stale' | 'collecting' | 'incomplete' | 'unavailable' | 'unauthorized' | 'error';

export type PanelState = {
  kind: PanelStateKind;
  /** Exact missing evidence or failure, shown in the glyph tooltip and evidence drawer. */
  reason?: string;
  /** Source observation time (ISO) when the value is an observation. */
  observedAt?: string | null;
  /** Collecting progress: samples held versus samples required. */
  sample?: { have: number; need: number };
};

export const PANEL_STATE_LABEL: Record<PanelStateKind, string> = {
  fresh: 'Fresh',
  stale: 'Stale',
  collecting: 'Sampling',
  incomplete: 'Incomplete',
  unavailable: 'No data',
  unauthorized: 'Unauthorized',
  error: 'Error',
};

export const FRESH: PanelState = { kind: 'fresh' };

export function describePanelState(state: PanelState): string {
  const parts = [PANEL_STATE_LABEL[state.kind]];
  if (state.sample) parts.push(`${state.sample.have}/${state.sample.need} samples`);
  if (state.observedAt) parts.push(`observed ${state.observedAt.replace('T', ' ').slice(0, 19)} UTC`);
  if (state.reason) parts.push(state.reason);
  return parts.join(' · ');
}

/**
 * State for a panel built from rows. Owners whose heartbeat is not current fall back to last-known rows, and
 * those rows must read as stale rather than fresh; an empty panel is unavailable, never "fresh with zero rows".
 */
export function rowsPanelState(count: number, emptyReason: string, staleOwners: { name: string; observedAt: string | null }[]): PanelState {
  if (!count) return { kind: 'unavailable', reason: emptyReason };
  if (!staleOwners.length) return { kind: 'fresh' };
  const oldest = staleOwners.map(owner => owner.observedAt).filter((at): at is string => Boolean(at)).sort()[0] ?? null;
  return {
    kind: 'stale', observedAt: oldest,
    reason: `Last-known rows: ${staleOwners.map(owner => owner.name).join(', ')} ${staleOwners.length === 1 ? 'has' : 'have'} no current owner heartbeat.`,
  };
}
