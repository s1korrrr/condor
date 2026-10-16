import type { DisplayFrame } from "./presentation";
import type { MetricCohortSelection } from "./metric-cohort.mjs";

/** A display subset never changes the owner universe or admits unknown contributors. */
export function instrumentRows(frame: DisplayFrame | null, search: string, filter: MetricCohortSelection | null) {
  if (!frame || (filter && (filter.status !== "available" || filter.snapshotId !== frame.snapshot_id))) return [];
  const members = filter ? new Set(filter.instrumentIds) : null;
  return frame.assets.filter(asset => (!members || members.has(asset.instrument_id)) &&
    `${asset.symbol} ${asset.instrument_id}`.toLowerCase().includes(search.toLowerCase()));
}

export function instrumentExportMetadata(frame: DisplayFrame | null, filter: MetricCohortSelection | null, search: string, asOf: number) {
  return {
    snapshot_id: frame?.snapshot_id ?? null,
    cutoff_ms: frame?.cutoff_ms ?? null,
    available_at_ms: frame?.available_at_ms ?? null,
    expires_at_ms: frame?.expires_at_ms ?? null,
    assessed_at_ms: asOf,
    source_kind: frame?.source_kind ?? null,
    universe_id: frame?.universeId ?? null,
    universe_revision: frame?.universeRevision ?? null,
    membership_hash: frame?.membershipHash ?? null,
    filter_scope: filter ? "display_only" : "full_universe",
    metric_filter: filter ? JSON.stringify(filter.request) : null,
    metric_definition: filter?.definition ?? null,
    metric_status: filter?.status ?? null,
    metric_valid: filter?.valid ?? null,
    metric_expected: filter?.expected ?? frame?.expected ?? null,
    metric_reasons: filter?.reasons.join("; ") ?? null,
    symbol_search: search,
  };
}
