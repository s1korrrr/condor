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
