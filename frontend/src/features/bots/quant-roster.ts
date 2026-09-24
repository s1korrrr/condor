type Row = Record<string, unknown>;

const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;
const instant = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? parsed : null;
};
const finite = (value: unknown): number | null => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
};
const nonnegativeInteger = (value: unknown): number | null => typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;

export type QuantMetric = {
  value: string | null;
  unit: string | null;
  availability: string;
  freshness: string;
  observedAt: string | null;
  feeBasis: string | null;
  reason: string | null;
};

export type QuantPair = {
  controllerId: string | null;
  pair: string;
  state: string;
  regime: string | null;
  units: string | null;
  entryCost: string | null;
  mark: string | null;
  markedValue: string | null;
  unrealized: string | null;
  realized: string | null;
  fees: string | null;
  workingOrders: number | null;
  dcaLevel: string | null;
  nextCondition: string | null;
  observationStatus: string | null;
};

export type QuantBotSummary = {
  generatedAt: string;
  observedAt: string | null;
  executionMode: string;
  ownershipBasis: string;
  freshness: 'current' | 'stale' | 'unknown';
  state: string;
  pairs: QuantPair[];
  ownedValue: QuantMetric;
  netLifecycle: QuantMetric;
  cycleCounts: { open: number | null; closedScored: number | null; ownershipTransfer: number | null; unclassified: number | null };
};

function metric(value: unknown, now: number): QuantMetric {
  const row = object(value);
  const availability = text(row.availability) ?? 'unavailable';
  const unit = text(row.unit);
  const observed = instant(row.observed_at);
  const threshold = row.stale_after_seconds === undefined ? 30 : finite(row.stale_after_seconds);
  const current = observed !== null && observed <= now + 5_000 && threshold !== null && threshold > 0 && now - observed < Math.min(threshold, 30) * 1000;
  const usable = current && availability === 'available' && row.freshness === 'fresh' && unit !== null && unit !== 'unknown';
  return {
    value: usable && finite(row.value) !== null ? String(row.value) : null,
    unit,
    availability,
    freshness: text(row.freshness) ?? 'unknown',
    observedAt: text(row.observed_at),
    feeBasis: text(row.fee_basis),
    reason: text(row.reason_code),
  };
}

/** Admit only identity-bound native projections; a fetched timestamp cannot refresh stale source data. */
export function projectQuantBotSummary(value: unknown, bot: string, now: number): QuantBotSummary | null {
  const envelope = object(value), scope = object(envelope.scope), data = object(envelope.data);
  const generatedAt = text(envelope.generated_at), generatedMs = instant(generatedAt);
  if (envelope.schema_version !== 'rsibot.quant_ops.v1' || envelope.execution_authorized !== false
      || scope.bot_key !== bot || data.bot_id !== bot || generatedAt === null || generatedMs === null
      || generatedMs > now + 5_000) return null;

  const executionMode = scope.execution_mode === 'live' || scope.execution_mode === 'paper' ? scope.execution_mode : 'unknown';
  const ownershipBasis = text(scope.ownership_basis) ?? 'unknown';
  const sourceTimes = object(envelope.source_times);
  const observedAt = text(data.heartbeat) ?? text(sourceTimes.runtime_status);
  const observedMs = instant(observedAt);
  const sourceCurrent = observedMs !== null && observedMs <= now + 5_000 && now - observedMs < 30_000;
  const state = text(data.operational_label) ?? 'UNKNOWN';
  const sourceAdmitted = sourceCurrent && executionMode !== 'unknown' && state !== 'UNKNOWN';
  const pairs: QuantPair[] = sourceAdmitted && Array.isArray(data.pairs) ? data.pairs.flatMap((item: unknown) => {
    const row = object(item), pair = text(row.pair);
    if (!pair || !/^[A-Z0-9]+-[A-Z0-9]+$/.test(pair)) return [];
    return [{
      controllerId: text(row.controller_id), pair,
      state: text(row.state) ?? 'UNKNOWN', regime: text(row.regime),
      units: text(row.units), entryCost: text(row.entry_cost), mark: text(row.mark),
      markedValue: text(row.marked_value), unrealized: text(row.unrealized),
      realized: text(row.realized), fees: text(row.fees),
      workingOrders: nonnegativeInteger(row.working_orders), dcaLevel: text(row.dca_level),
      nextCondition: text(row.next_condition), observationStatus: text(row.observation_status),
    }];
  }) : [];
  const counts = object(data.cycle_counts);
  return {
    generatedAt: generatedAt!, observedAt,
    executionMode, ownershipBasis,
    freshness: sourceAdmitted ? 'current' : observedAt ? 'stale' : 'unknown',
    state: sourceAdmitted ? state : 'UNKNOWN', pairs,
    ownedValue: sourceAdmitted ? metric(data.owned_value, now) : metric(null, now),
    netLifecycle: sourceAdmitted ? metric(data.net_lifecycle, now) : metric(null, now),
    cycleCounts: {
      open: sourceAdmitted ? nonnegativeInteger(counts.open) : null,
      closedScored: sourceAdmitted ? nonnegativeInteger(counts.closed_scored) : null,
      ownershipTransfer: sourceAdmitted ? nonnegativeInteger(counts.ownership_transfer) : null,
      unclassified: sourceAdmitted ? nonnegativeInteger(counts.unclassified) : null,
    },
  };
}

export type RecordedDecision = {
  ownerBootId: string;
  decisionId: string;
  occurredAt: string;
  action: string;
  pair: string | null;
  controllerId: string;
  reasonCodes: string[];
  gateResults: Row[];
  configRevision: string;
  orderIds: string[];
  fillIds: string[];
  linkage: 'owner' | 'unlinked';
};

/** Decisions require the event journal's stable owner and event identifiers. Runtime status is not a decision. */
export function projectRecordedDecisions(value: unknown, bot: string, now = Date.now()): RecordedDecision[] | null {
  const envelope = object(value), scope = object(envelope.scope), data = object(envelope.data);
  if (envelope.schema_version !== 'rsibot.quant_ops.v1' || envelope.execution_authorized !== false
      || scope.bot_key !== bot || data.bot_id !== bot || !Array.isArray(data.decisions)) return null;
  const generatedMs = instant(envelope.generated_at);
  if (generatedMs === null || generatedMs > now + 5_000 || (scope.execution_mode !== 'live' && scope.execution_mode !== 'paper')) return null;
  const decisions: RecordedDecision[] = [];
  const seen = new Set<string>();
  for (const item of data.decisions) {
    const row = object(item), decisionId = text(row.decision_id), bootId = text(row.owner_boot_id);
    const controllerId = text(row.controller_id), configRevision = text(row.config_revision);
    const action = text(row.action), occurredAt = text(row.occurred_at), occurredMs = instant(occurredAt);
    if (!decisionId || !bootId || !controllerId || !configRevision || !action || !occurredAt || occurredMs === null
        || occurredMs > generatedMs || !Number.isInteger(row.sequence) || (row.sequence as number) < 0
        || seen.has(`${bootId}:${decisionId}`)) continue;
    const orderIds = Array.isArray(row.order_ids) ? row.order_ids.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0) : [];
    const fillIds = Array.isArray(row.fill_ids) ? row.fill_ids.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0) : [];
    const reasonCodes = Array.isArray(row.reason_codes) ? row.reason_codes.filter((code: unknown): code is string => typeof code === 'string' && code.length > 0) : [];
    const gateResults = Array.isArray(row.gate_results) ? row.gate_results.map(object) : [];
    const linkage = row.linkage === 'owner' && (orderIds.length > 0 || fillIds.length > 0) ? 'owner' : 'unlinked';
    seen.add(`${bootId}:${decisionId}`);
    decisions.push({ ownerBootId: bootId!, decisionId, occurredAt: occurredAt!, action, pair: text(row.pair), controllerId, reasonCodes, gateResults, configRevision, orderIds, fillIds, linkage });
  }
  return decisions;
}

export type QuantExecution = { bins: { from: number; to: number; count: number }[]; sampleCount: number; excludedCount: number; paperExcluded: number };

/** Local syntax guard only; it cannot confirm the venue pair universe or owner schema. */
export function validDraftPairSyntax(input: string): boolean {
  const pairs = input.split(/[\s,]+/).filter(Boolean);
  return pairs.length > 0 && pairs.every(pair => /^[A-Z0-9]+-[A-Z0-9]+$/.test(pair)) && new Set(pairs).size === pairs.length;
}

/** Execution quality is only comparable when the owner supplies a compatible benchmark cohort. */
export function projectQuantExecution(value: unknown, bot: string): QuantExecution | null {
  const row = object(value), histogram = object(row.histogram);
  if (row.bot_id !== bot || row.execution_authorized !== false || histogram.availability !== 'available'
      || histogram.unit !== 'bps' || !Array.isArray(histogram.bins)) return null;
  const sampleCount = nonnegativeInteger(histogram.sample_count), excludedCount = nonnegativeInteger(histogram.excluded_count);
  const paperExcluded = nonnegativeInteger(histogram.paper_excluded);
  if (sampleCount === null || sampleCount === 0 || excludedCount === null || paperExcluded === null) return null;
  const bins = histogram.bins.flatMap((item: unknown) => {
    const bin = object(item), from = finite(bin.from), to = finite(bin.to), count = nonnegativeInteger(bin.count);
    return from !== null && to !== null && to > from && count !== null ? [{ from, to, count }] : [];
  });
  if (bins.length !== histogram.bins.length || bins.reduce((sum, bin) => sum + bin.count, 0) !== sampleCount) return null;
  return { bins, sampleCount, excludedCount, paperExcluded };
}
