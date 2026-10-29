export interface ReportPermissionInput {
  agentReady: boolean;
  advisorEnabled: boolean;
  taskEnabled: boolean;
  modelAvailable: boolean;
  mode: string;
  executionEnabled: boolean;
  agentExecutionEnabled: boolean;
}

export function canRequestReport(input: ReportPermissionInput): boolean {
  return input.agentReady &&
    input.advisorEnabled &&
    input.taskEnabled &&
    input.modelAvailable &&
    input.mode === "reports-only" &&
    input.executionEnabled === false &&
    input.agentExecutionEnabled === false;
}

export function boundedLoopParameters(frequencySec: number, maxTicks: number) {
  if (!Number.isFinite(frequencySec) || !Number.isFinite(maxTicks)) return null;
  return {
    frequency_sec: Math.max(900, Math.floor(frequencySec)),
    max_ticks: Math.min(96, Math.max(1, Math.floor(maxTicks))),
  };
}

const UNBOUND_BOTS_REASON = "The V5 native owner is unbound; bot registration, positions and performance are unavailable.";

/** The Bots page notice: none only for a fresh read-only paper owner; otherwise the owner's own reason. */
export function botsOwnerUnavailableReason(profile: { readiness?: { native_owner?: string; native_owner_reason?: string } } | undefined): string | undefined {
  const readiness = profile?.readiness;
  if (readiness?.native_owner === "PAPER_BOUND") return undefined;
  return readiness?.native_owner_reason || UNBOUND_BOTS_REASON;
}

export function paperWorkspaceLabel(profile: { readiness?: { paper_owner?: unknown } } | undefined): string | null {
  return profile?.readiness?.paper_owner ? "PAPER · simulated wallet · live disabled · advisor reports only" : null;
}

export function paperReadState(read: { schema?: string; state?: string; execution_mode?: string; simulated?: boolean; generated_at_ms?: number | null } | undefined, now: number): import("./contracts").PaperReadState {
  if (!read || read.schema !== "rsibot.v5-paper.read.v1" || read.execution_mode !== "paper" || read.simulated !== true) return "degraded";
  if (read.generated_at_ms != null && (!Number.isSafeInteger(read.generated_at_ms) || read.generated_at_ms > now + 5000)) return "degraded";
  if (read.generated_at_ms != null && now - read.generated_at_ms > 30_000) return "stale";
  return ["available", "collecting", "not_applicable", "degraded", "stale"].includes(read.state ?? "") ? read.state as import("./contracts").PaperReadState : "degraded";
}

export function paperSnapshotsAgree(reads: readonly { snapshot_id: string | null; generated_at_ms?: number | null }[]): boolean {
  return reads.length > 0 && reads.every(read => read.snapshot_id !== null && read.snapshot_id === reads[0].snapshot_id && read.generated_at_ms === reads[0].generated_at_ms);
}

export function paperRecordSummary(row: Record<string, unknown>): string {
  return [row.trade_id ?? row.position_id ?? row.executor_id ?? row.asset ?? "Owner record", row.trading_pair, row.side,
    row.quantity == null ? null : `quantity ${row.quantity}`, row.price == null ? null : `price ${row.price}`,
    row.fee_amount == null ? null : `fee ${row.fee_amount} ${row.fee_currency ?? "unit unavailable"}`,
    row.remaining_basis_quote == null ? null : `remaining basis ${row.remaining_basis_quote}`, row.state,
  ].filter(value => value !== null && value !== undefined).map(String).join(" · ");
}

export function paperControlState(_risk: unknown): string {
  return "Paper control not enabled";
}

export function paperReadiness(_owner: unknown) {
  return {
    production: "NOT_READY", live: "DISABLED", economics: "V5_NOT_SUPPORTED",
    openGates: [
      "P0 · Recovery with nonempty obligations: NOT_RUN in this dashboard",
      "P0 · Durable paper controls and protected exits: NOT_RUN in this dashboard",
      "P0 · Full route and screenshot qualification: NOT_RUN in this dashboard",
      "P0 · Continuous supervision and restore proof: NOT_RUN in this dashboard",
    ],
  };
}
