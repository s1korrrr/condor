/**
 * Typed client for the server-side fleet summary, `GET /api/v1/servers/{server}/fleet/summary` (schema
 * `fleet-summary.v1`, documented in docs/reference/fleet-summary-v1.md of the rsibot workspace).
 *
 * The server computes fleet PnL, wallet equity, per-bot cards and the Market verdict once; this module only
 * validates the wire shape and exposes it. Nothing here recomputes a number. A section that the server could not
 * produce is `null` and is explained in `missing` / `sections`; callers render only what is present.
 */

export const FLEET_SUMMARY_SCHEMA = 'fleet-summary.v1';

export type FleetSummaryView = 'full' | 'glance';
export type SectionName = 'wallet' | 'pnl' | 'market' | 'bots' | 'fills' | 'incidents';
export type SectionStatus = 'ok' | 'stale' | 'partial' | 'missing';

export type SectionMeta = { status: SectionStatus; observed_at_ms: number | null; stale_after_ms: number | null; reason: string | null };
/** `reason` is an upper-case code (see the contract's reason-code table); `section`-level entries carry no `field`. */
export type MissingItem = { section: SectionName; field?: string; bot?: string; reason: string };

export type Wallet = { equity: string; unit: string; observed_at_ms: number; source_bot: string; valuation_complete: true; stale: boolean };

export type WindowMissing = { bot: string; reason: string; samples?: number; quote?: string | null };
export type WindowBot = {
  bot: string; change: string | null; realized: string | null; unrealized: string | null;
  first_at_ms: number | null; last_at_ms: number | null; samples: number; restarts: number; full: boolean; stale: boolean;
};
/** One fleet PnL window. `total` is the SUM of per-bot changes (deposit independent); decimals are strings. */
export type PnlWindow = {
  span_ms: number | null; unit: string | null; total: string | null; realized: string | null; unrealized: string | null;
  counted: number; expected: number; partial: boolean; since_ms: number | null; latest_at_ms: number | null; stale: boolean;
  missing: WindowMissing[]; bots?: WindowBot[];
};
export type PnlWindowName = 'day' | 'week' | 'month' | 'all';
export type Pnl = { unit: string | null } & Record<PnlWindowName, PnlWindow>;

export type VerdictState = 'risk-on' | 'mixed' | 'risk-off';
export type Verdict = {
  state: VerdictState; label: string; score: number; instant_score: number; smoothed: boolean; smoothed_frames: number;
  smoothing_minutes: number; held: boolean; horizon: string; horizon_label: string; components: { id: string; score: number }[];
  advancing: number | null; declining: number | null; unchanged: number | null; valid: number | null; expected: number | null;
};
export type Market = {
  verdict: Verdict;
  frame: { snapshot_id: string; cutoff_ms: number; available_at_ms: number; expires_at_ms: number; source_kind: string; freshness: 'fresh' | 'lagging' | 'stale' | 'future' };
  history_points: number | null;
};

export type Money = { amount: string; unit: string };
export type BotCard = {
  bot: string; display_name: string; generation: 'V1' | 'V2' | 'V3' | null; paper: boolean; status: string | null; controllers: number | null;
  report_at_ms: number | null; report_stale: boolean;
  positions: { held: number; registered: number; current: boolean } | null;
  executors: number | null; executors_basis: 'open_lifecycle_cycles' | null;
  pnl_day: { change: string | null; unit: string | null; partial: boolean; stale: boolean } | null;
  net_now: { value: string | null; unit: string; source: 'controller' | 'history' } | null;
  fees: Money | null;
  trades: { lifetime: number | null; opened_24h: number; closed_24h: number } | null;
  missing: { field: string; reason: string }[];
};
export type Fill = { bot: string; fill_id: string; pair: string | null; side: string | null; amount: string | null; price: string | null; volume: string | null; fee: string | null; time_ms: number | null };
export type Incidents = { state: 'healthy' | 'degraded' | 'critical' | 'unknown'; open: number; critical: number; warning: number; monitor: 'healthy' | 'degraded' | null; generated_at_ms: number; observed_at_ms: number };

export type FleetSummary = {
  schema_version: typeof FLEET_SUMMARY_SCHEMA; view: 'full'; server: string; generated_at_ms: number;
  sections: Record<SectionName, SectionMeta>; missing: MissingItem[];
  wallet: Wallet | null; pnl: Pnl | null; market: Market | null; bots: BotCard[]; fills: Fill[] | null; incidents: Incidents | null;
};

export type GlanceWindow = Pick<PnlWindow, 'total' | 'partial' | 'counted' | 'expected' | 'stale'>;
/** The Watch view: headline numbers only, under 8 KB. `bots` is capped; `bots_total` / `missing_total` say what was cut. */
export type FleetGlance = {
  schema_version: typeof FLEET_SUMMARY_SCHEMA; view: 'glance'; server: string; generated_at_ms: number;
  sections: Record<SectionName, SectionMeta>; missing: MissingItem[]; missing_total: number;
  wallet: Wallet | null;
  pnl: ({ unit: string | null } & Record<PnlWindowName, GlanceWindow>) | null;
  market: { state: VerdictState; label: string; score: number; horizon_label: string; held: boolean; freshness: Market['frame']['freshness']; cutoff_ms: number } | null;
  bots: { bot: string; display_name: string; generation: BotCard['generation']; paper: boolean; status: string | null; report_stale: boolean; pnl_day: string | null }[];
  bots_total: number;
  fills: Pick<Fill, 'bot' | 'pair' | 'side' | 'volume' | 'time_ms'>[] | null;
  incidents: Pick<Incidents, 'state' | 'open' | 'critical'> | null;
};

const SECTIONS: SectionName[] = ['wallet', 'pnl', 'market', 'bots', 'fills', 'incidents'];
const STATUSES = ['ok', 'stale', 'partial', 'missing'];
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const decimal = (value: unknown): value is string => typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value);

export class FleetSummaryError extends Error {}

/**
 * Validate the envelope and the parts every client relies on. Throws `FleetSummaryError` for a different major
 * schema (the caller should tell the user to update rather than guess) or a malformed body; unknown extra fields
 * are ignored, because `fleet-summary.v1` only ever adds fields.
 */
export function parseFleetSummary(payload: unknown, view: 'full'): FleetSummary;
export function parseFleetSummary(payload: unknown, view: 'glance'): FleetGlance;
export function parseFleetSummary(payload: unknown, view: FleetSummaryView): FleetSummary | FleetGlance {
  if (!object(payload)) throw new FleetSummaryError('Fleet summary is not an object.');
  if (payload.schema_version !== FLEET_SUMMARY_SCHEMA) throw new FleetSummaryError(`Unsupported fleet summary schema ${String(payload.schema_version)}.`);
  if (payload.view !== view) throw new FleetSummaryError(`Fleet summary view ${String(payload.view)} does not match the requested ${view}.`);
  if (typeof payload.server !== 'string' || !integer(payload.generated_at_ms)) throw new FleetSummaryError('Fleet summary identity is invalid.');
  const sections = payload.sections;
  if (!object(sections) || !SECTIONS.every(name => {
    const meta = sections[name];
    return object(meta) && STATUSES.includes(meta.status as string) && (meta.observed_at_ms === null || integer(meta.observed_at_ms)) && (meta.reason === null || typeof meta.reason === 'string');
  })) throw new FleetSummaryError('Fleet summary sections are invalid.');
  if (!Array.isArray(payload.missing) || !payload.missing.every(item => object(item) && SECTIONS.includes(item.section as SectionName) && typeof item.reason === 'string')) throw new FleetSummaryError('Fleet summary missing list is invalid.');
  if (!Array.isArray(payload.bots)) throw new FleetSummaryError('Fleet summary bots are invalid.');
  // A section the server says is present must have its headline number in the documented type.
  const wallet = payload.wallet;
  if (wallet !== null && (!object(wallet) || !decimal(wallet.equity) || typeof wallet.unit !== 'string' || !integer(wallet.observed_at_ms))) throw new FleetSummaryError('Fleet summary wallet is invalid.');
  const pnl = payload.pnl;
  if (pnl !== null) {
    if (!object(pnl)) throw new FleetSummaryError('Fleet summary PnL is invalid.');
    for (const name of ['day', 'week', 'month', 'all']) {
      const window = pnl[name];
      if (!object(window) || !(window.total === null || decimal(window.total)) || !integer(window.counted) || !integer(window.expected) || typeof window.partial !== 'boolean') throw new FleetSummaryError(`Fleet summary PnL window ${name} is invalid.`);
    }
  }
  return payload as unknown as FleetSummary | FleetGlance;
}

export function fleetSummaryPath(server: string, view: FleetSummaryView = 'full'): string {
  return `/api/v1/servers/${encodeURIComponent(server)}/fleet/summary${view === 'full' ? '' : `?view=${view}`}`;
}

/** Age of a section's observation at `now`, or null when the server has none. Ages are computed by the client, never sent. */
export function sectionAgeMs(meta: SectionMeta, now: number): number | null {
  return meta.observed_at_ms === null ? null : Math.max(0, now - meta.observed_at_ms);
}

/** True when the server marked the section stale or its observation is older than the section's own threshold at `now`. */
export function sectionIsStale(meta: SectionMeta, now: number): boolean {
  const age = sectionAgeMs(meta, now);
  return meta.status === 'stale' || (age !== null && meta.stale_after_ms !== null && age > meta.stale_after_ms);
}
