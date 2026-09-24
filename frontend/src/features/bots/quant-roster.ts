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
const decimalText = (value: unknown): string | null => finite(value) === null ? null : String(value);
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];

export type QuantMetric = {
  value: string | null;
  unit: string | null;
  availability: string;
  freshness: string;
  observedAt: string | null;
  feeBasis: string | null;
  reason: string | null;
  /** The owner's last published value when the metric is stale; never presented as current. */
  lastKnown?: string | null;
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
  planMode: string | null;
  planTarget: string | null;
  planAnchor: string | null;
  planNext: string | null;
  gate: string | null;
  score: string | null;
  execs: string | null;
  unrealizedPct: string | null;
};

export type RiskRail = {
  name: string; scope: string; limit: string | null; used: string | null; remaining: string | null;
  utilization: number | null; unit: string | null; state: string; observedAt: string | null; source: string | null;
};

export type QuantWallet = {
  availability: string; reason: string | null; value: string | null; currency: string | null; scope: string | null;
  observedAt: string | null; balances: { asset: string; total: string | null; available: string | null; value: string | null }[];
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
  riskRails: { availability: string; rails: RiskRail[]; tightest: RiskRail | null };
  wallet: QuantWallet | null;
  controllerName: string | null;
  profile: string | null;
  /** True when every value above comes from the owner's last publication rather than a current one. */
  lastKnown: boolean;
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

function rail(value: unknown): RiskRail | null {
  const row = object(value), name = text(row.name);
  if (!name) return null;
  return {
    name, scope: text(row.scope) ?? 'bot', limit: decimalText(row.limit), used: decimalText(row.used), remaining: decimalText(row.remaining),
    utilization: finite(row.utilization), unit: text(row.unit), state: text(row.state) ?? 'unknown', observedAt: text(row.observed_at), source: text(row.source),
  };
}

function wallet(value: unknown, sourceAdmitted: boolean): QuantWallet | null {
  const row = object(value);
  if (!Object.keys(row).length) return null;
  const currency = text(row.currency);
  const declared = row.availability === 'available' && currency !== null && finite(row.value) !== null;
  const available = sourceAdmitted && declared;
  // A declared but no-longer-current wallet keeps its value and balances in the stale state.
  const keep = available || (declared && !sourceAdmitted);
  return {
    availability: available ? 'available' : keep ? 'stale' : 'unavailable',
    reason: available ? null : keep ? 'RUNTIME_NOT_CURRENT' : text(row.reason_code) ?? (sourceAdmitted ? 'WALLET_UNAVAILABLE' : 'RUNTIME_NOT_CURRENT'),
    value: keep ? String(row.value) : null,
    currency: keep ? currency : null,
    scope: text(row.scope),
    observedAt: text(row.observed_at),
    balances: Array.isArray(row.balances) && keep ? row.balances.flatMap((item: unknown) => {
      const balance = object(item), asset = text(balance.asset);
      return asset ? [{ asset, total: decimalText(balance.total), available: decimalText(balance.available), value: decimalText(balance.value) }] : [];
    }) : [],
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
      planMode: text(row.plan_mode), planTarget: text(row.plan_target), planAnchor: text(row.plan_anchor), planNext: text(row.plan_next),
      gate: text(row.gate), score: text(row.score), execs: text(row.execs), unrealizedPct: decimalText(row.unrealized_pct),
    }];
  }) : [];
  const counts = object(data.cycle_counts);
  const railsRow = object(data.risk_rails);
  const rails = sourceAdmitted && Array.isArray(railsRow.rails) ? railsRow.rails.map(rail).filter((row): row is RiskRail => row !== null) : [];
  // What the owner last published, verbatim, when it is no longer current. Rendered as stale, never as current.
  const known = object(data.last_known);
  const knownObserved = text(known.observed_at);
  const knownPairs: QuantPair[] = !sourceAdmitted && Array.isArray(known.pairs) ? known.pairs.flatMap((item: unknown) => {
    const row = object(item), pair = text(row.pair);
    if (!pair || !/^[A-Z0-9]+-[A-Z0-9]+$/.test(pair)) return [];
    return [{
      controllerId: text(row.controller_id), pair, state: text(row.state) ?? 'UNKNOWN', regime: text(row.regime),
      units: text(row.units), entryCost: text(row.entry_cost), mark: text(row.mark), markedValue: text(row.marked_value), unrealized: text(row.unrealized),
      realized: text(row.realized), fees: text(row.fees), workingOrders: nonnegativeInteger(row.working_orders), dcaLevel: text(row.dca_level),
      nextCondition: text(row.next_condition), observationStatus: text(row.observation_status),
      planMode: text(row.plan_mode), planTarget: text(row.plan_target), planAnchor: text(row.plan_anchor), planNext: text(row.plan_next),
      gate: text(row.gate), score: text(row.score), execs: text(row.execs), unrealizedPct: decimalText(row.unrealized_pct),
    }];
  }) : [];
  const knownRailsRow = object(known.risk_rails);
  const knownRails = !sourceAdmitted && Array.isArray(knownRailsRow.rails) ? knownRailsRow.rails.map(rail).filter((row): row is RiskRail => row !== null) : [];
  const knownCounts = object(known.cycle_counts);
  const knownQuote = text(known.quote_currency);
  const staleMetric = (value: unknown): QuantMetric => ({ value: null, unit: knownQuote, availability: 'unavailable', freshness: 'stale', observedAt: knownObserved, feeBasis: null, reason: 'RUNTIME_NOT_CURRENT', lastKnown: decimalText(value) });
  const lastKnown = !sourceAdmitted && knownObserved !== null && (knownPairs.length > 0 || knownRails.length > 0);
  return {
    generatedAt: generatedAt!, observedAt: observedAt ?? knownObserved,
    executionMode, ownershipBasis,
    freshness: sourceAdmitted ? 'current' : (observedAt ?? knownObserved) ? 'stale' : 'unknown',
    state: sourceAdmitted ? state : lastKnown ? text(known.operational_label) ?? 'UNKNOWN' : 'UNKNOWN',
    pairs: sourceAdmitted ? pairs : knownPairs,
    ownedValue: sourceAdmitted ? metric(data.owned_value, now) : staleMetric(known.owned_value_value),
    netLifecycle: sourceAdmitted ? metric(data.net_lifecycle, now) : staleMetric(known.net_lifecycle_value),
    cycleCounts: {
      open: sourceAdmitted ? nonnegativeInteger(counts.open) : nonnegativeInteger(knownCounts.open),
      closedScored: sourceAdmitted ? nonnegativeInteger(counts.closed_scored) : nonnegativeInteger(knownCounts.closed_scored),
      ownershipTransfer: sourceAdmitted ? nonnegativeInteger(counts.ownership_transfer) : nonnegativeInteger(knownCounts.ownership_transfer),
      unclassified: sourceAdmitted ? nonnegativeInteger(counts.unclassified) : nonnegativeInteger(knownCounts.unclassified),
    },
    riskRails: {
      availability: (sourceAdmitted ? rails : knownRails).some(row => row.limit !== null) ? 'available' : 'unavailable',
      rails: sourceAdmitted ? rails : knownRails,
      tightest: rail(sourceAdmitted ? railsRow.tightest : knownRailsRow.tightest),
    },
    wallet: sourceAdmitted ? wallet(data.wallet, true) : wallet(known.wallet, false),
    controllerName: text(data.controller_name),
    profile: text(data.profile),
    lastKnown,
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
    const orderIds = strings(row.order_ids);
    const fillIds = strings(row.fill_ids);
    const reasonCodes = strings(row.reason_codes);
    const gateResults = Array.isArray(row.gate_results) ? row.gate_results.map(object) : [];
    const linkage = row.linkage === 'owner' && (orderIds.length > 0 || fillIds.length > 0) ? 'owner' : 'unlinked';
    seen.add(`${bootId}:${decisionId}`);
    decisions.push({ ownerBootId: bootId!, decisionId, occurredAt: occurredAt!, action, pair: text(row.pair), controllerId, reasonCodes, gateResults, configRevision, orderIds, fillIds, linkage });
  }
  return decisions;
}

export type LifecycleDecision = {
  decisionId: string; executorId: string; action: string; occurredAt: string; pair: string | null; controllerId: string | null;
  orderIds: string[]; fillIds: string[]; linkage: 'owner' | 'unlinked'; reasonCodes: string[]; outcome: string | null;
  decisionPrice: string | null; netPnl: string | null; amountBase: string | null;
};

/** Entry/exit records the reporting owner derived from executor rows and their ID-linked orders and fills. */
export function projectLifecycleDecisions(value: unknown, bot: string, now = Date.now()): LifecycleDecision[] | null {
  const envelope = object(value), scope = object(envelope.scope), data = object(envelope.data);
  if (envelope.schema_version !== 'rsibot.quant_ops.v1' || envelope.execution_authorized !== false
      || scope.bot_key !== bot || data.bot_id !== bot || !Array.isArray(data.lifecycle_decisions)) return null;
  const generatedMs = instant(envelope.generated_at);
  if (generatedMs === null || generatedMs > now + 5_000) return null;
  const rows: LifecycleDecision[] = [];
  const seen = new Set<string>();
  for (const item of data.lifecycle_decisions) {
    const row = object(item), decisionId = text(row.decision_id), executorId = text(row.executor_id), action = text(row.action);
    const occurredAt = text(row.occurred_at), occurredMs = instant(occurredAt);
    if (!decisionId || !executorId || !action || !occurredAt || occurredMs === null || occurredMs > generatedMs + 5_000 || row.source !== 'executor_lifecycle' || seen.has(decisionId)) continue;
    seen.add(decisionId);
    const orderIds = strings(row.order_ids), fillIds = strings(row.fill_ids);
    rows.push({
      decisionId, executorId, action, occurredAt, pair: text(row.pair), controllerId: text(row.controller_id),
      orderIds, fillIds, linkage: row.linkage === 'owner' && orderIds.length > 0 ? 'owner' : 'unlinked',
      reasonCodes: strings(row.reason_codes), outcome: text(row.outcome), decisionPrice: decimalText(row.decision_price),
      netPnl: decimalText(row.net_pnl_quote), amountBase: decimalText(row.amount_base),
    });
  }
  return rows;
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

export type ExecutionStats = {
  meanBps: string | null; medianBps: string | null; sampleCount: number; excludedReasons: Record<string, number>; minSample: number;
  latencyMedianSeconds: number | null; latencySamples: number; fillRatio: number | null; cancelRate: number | null; rejectRate: number | null;
  orderSampleSufficient: boolean; makerCount: number | null; takerCount: number | null; funnel: { stage: string; count: number }[]; benchmarkBasis: string | null;
};

/** Lifecycle-derived execution statistics. Present even when the slippage cohort is still empty. */
export function projectExecutionStats(value: unknown, bot: string): ExecutionStats | null {
  const row = object(value), histogram = object(row.histogram), latency = object(row.latency);
  if (row.bot_id !== bot || row.execution_authorized !== false || !Array.isArray(row.funnel)) return null;
  const funnel = row.funnel.flatMap((item: unknown) => {
    const stage = object(item), name = text(stage.stage), count = nonnegativeInteger(stage.count);
    return name && count !== null ? [{ stage: name, count }] : [];
  });
  const reasons = object(histogram.excluded_reasons);
  return {
    meanBps: decimalText(row.mean_bps), medianBps: decimalText(row.median_bps),
    sampleCount: nonnegativeInteger(histogram.sample_count) ?? 0,
    excludedReasons: Object.fromEntries(Object.entries(reasons).flatMap(([key, count]) => nonnegativeInteger(count) === null ? [] : [[key, count as number]])),
    minSample: nonnegativeInteger(histogram.min_sample) ?? 20,
    latencyMedianSeconds: finite(latency.median_seconds), latencySamples: nonnegativeInteger(latency.sample_count) ?? 0,
    fillRatio: finite(row.fill_ratio), cancelRate: finite(row.cancel_rate), rejectRate: finite(row.reject_rate),
    orderSampleSufficient: row.order_sample_sufficient === true,
    makerCount: nonnegativeInteger(row.maker_count), takerCount: nonnegativeInteger(row.taker_count),
    funnel, benchmarkBasis: text(row.benchmark_basis),
  };
}

export type CycleRow = {
  cycleId: string; pair: string | null; controllerId: string | null; side: string | null; outcome: string; result: string | null;
  openedAt: string | null; firstFillAt: string | null; closedAt: string | null; holdingSeconds: number | null;
  netPnl: string | null; fees: string | null; grossVolume: string | null; fillCount: number; closeType: string | null; closeReason: string | null;
};

export type QuantCycles = {
  quote: string | null;
  counts: Record<string, number>;
  cycles: CycleRow[];
  stats: {
    scored: number; minSample: number; sufficient: boolean; wins: number; losses: number; breakeven: number;
    winRate: number | null; profitFactor: string | null; profitFactorReason: string | null; expectancy: string | null;
    averageWin: string | null; averageLoss: string | null; payoffRatio: string | null; averageHoldingSeconds: number | null;
    fees: string | null; grossVolume: string | null; fillCount: number;
  };
  inventoryAge: {
    availability: string; reason: string | null; oldestAt: string | null; oldestSeconds: number | null; weightedSeconds: number | null;
    lots: { executorId: string; pair: string | null; acquiredAt: string | null; basis: string | null; ageSeconds: number | null; value: string | null }[];
  };
};

/** Scored cycles and lot ages from the reporting lifecycle projection. Unscored cycles never count as wins or losses. */
export function projectQuantCycles(value: unknown, bot: string): QuantCycles | null {
  const row = object(value);
  if (row.bot_id !== bot || row.execution_authorized !== false || row.source !== 'executor_lifecycle' || !Array.isArray(row.cycles)) return null;
  const stats = object(row.statistics), age = object(row.inventory_age), counts = object(row.cycle_counts);
  return {
    quote: text(row.quote_currency),
    counts: Object.fromEntries(Object.entries(counts).flatMap(([key, count]) => nonnegativeInteger(count) === null ? [] : [[key, count as number]])),
    cycles: row.cycles.flatMap((item: unknown) => {
      const cycle = object(item), cycleId = text(cycle.cycle_id), outcome = text(cycle.outcome);
      if (!cycleId || !outcome) return [];
      return [{
        cycleId, pair: text(cycle.pair), controllerId: text(cycle.controller_id), side: text(cycle.side), outcome, result: text(cycle.result),
        openedAt: text(cycle.opened_at), firstFillAt: text(cycle.first_fill_at), closedAt: text(cycle.closed_at), holdingSeconds: finite(cycle.holding_seconds),
        netPnl: decimalText(cycle.net_pnl_quote), fees: decimalText(cycle.fees_quote), grossVolume: decimalText(cycle.gross_volume_quote),
        fillCount: nonnegativeInteger(cycle.fill_count) ?? 0, closeType: text(cycle.close_type), closeReason: text(cycle.close_reason),
      }];
    }),
    stats: {
      scored: nonnegativeInteger(stats.scored) ?? 0, minSample: nonnegativeInteger(stats.min_sample) ?? 10, sufficient: stats.sufficient === true,
      wins: nonnegativeInteger(stats.wins) ?? 0, losses: nonnegativeInteger(stats.losses) ?? 0, breakeven: nonnegativeInteger(stats.breakeven) ?? 0,
      winRate: finite(stats.win_rate), profitFactor: decimalText(stats.profit_factor), profitFactorReason: text(stats.profit_factor_reason),
      expectancy: decimalText(stats.expectancy_quote), averageWin: decimalText(stats.average_win_quote), averageLoss: decimalText(stats.average_loss_quote),
      payoffRatio: decimalText(stats.payoff_ratio), averageHoldingSeconds: finite(stats.average_holding_seconds),
      fees: decimalText(stats.fees_quote), grossVolume: decimalText(stats.gross_volume_quote), fillCount: nonnegativeInteger(stats.fill_count) ?? 0,
    },
    inventoryAge: {
      availability: text(age.availability) ?? 'unavailable', reason: text(age.reason_code), oldestAt: text(age.oldest_at),
      oldestSeconds: finite(age.oldest_seconds), weightedSeconds: finite(age.value_weighted_seconds),
      lots: Array.isArray(age.lots) ? age.lots.flatMap((item: unknown) => {
        const lot = object(item), executorId = text(lot.executor_id);
        return executorId ? [{ executorId, pair: text(lot.pair), acquiredAt: text(lot.acquired_at), basis: text(lot.acquired_basis), ageSeconds: finite(lot.age_seconds), value: decimalText(lot.value_quote) }] : [];
      }) : [],
    },
  };
}

export type FillRow = { fillId: string; pair: string | null; side: string | null; amount: string | null; price: string | null; volume: string | null; fee: string | null; orderType: string | null; timestamp: string | null; orderId: string | null };

/** Native fills for one bot. Exact receipt strings are preferred over float projections. */
export function projectFills(value: unknown, bot: string): FillRow[] {
  const row = object(value);
  if (!Array.isArray(row.rows)) return [];
  return row.rows.flatMap((item: unknown) => {
    const fill = object(item), fillId = text(fill.fill_id);
    if (!fillId || fill.bot_name !== bot) return [];
    return [{
      fillId, pair: text(fill.pair), side: text(fill.side), amount: decimalText(fill.exact_amount ?? fill.amount_base), price: decimalText(fill.exact_price ?? fill.price_quote),
      volume: decimalText(fill.gross_volume_quote), fee: decimalText(fill.exact_trade_fee_in_quote ?? fill.fee_quote), orderType: text(fill.order_type),
      timestamp: text(fill.timestamp), orderId: text(fill.order_id),
    }];
  });
}
