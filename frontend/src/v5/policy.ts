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

export function paperSectionError(read: Partial<import("./contracts").PaperRead> | undefined): string | null {
  if (!read) return null;
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  const records = (value: unknown): value is Record<string, unknown>[] => Array.isArray(value) && value.every(object);
  const invalid = () => `${typeof read.section === "string" ? paperWords(read.section) : "Paper section"} owner schema invalid; this section is unavailable.`;
  const unbound = ["collecting", "degraded"].includes(read.state ?? "") && read.data == null && read.snapshot_id === null;
  if (!object(read) || read.schema !== "rsibot.v5-paper.read.v1" || typeof read.section !== "string" || !read.section ||
    !["available", "collecting", "not_applicable", "degraded", "stale"].includes(read.state ?? "") ||
    read.execution_mode !== "paper" || read.simulated !== true ||
    (typeof read.reason !== "string" && !(read.state === "available" && read.reason == null)) ||
    (typeof read.bot_id !== "string" || !read.bot_id) && !(unbound && read.bot_id === null) ||
    (typeof read.snapshot_id !== "string" || !read.snapshot_id) && !unbound ||
    (read.generated_at_ms == null && !unbound) ||
    ["generated_at_ms", "source_at_ms", "observed_at_ms"].some(key => {
      const value = read[key as "generated_at_ms" | "source_at_ms" | "observed_at_ms"];
      return value != null && (!Number.isSafeInteger(value) || value < 0) || key === "observed_at_ms" && key in read && value == null;
    }) ||
    (read.completeness !== undefined && !["complete", "partial", "unavailable"].includes(read.completeness)) ||
    (["positions", "fills", "executors", "orders"].includes(read.section) && read.completeness === undefined) ||
    (read.next_cursor != null && (typeof read.next_cursor !== "string" || !read.next_cursor)) ||
    ["source", "capabilities"].some(key => key in read && !object(read[key as "source" | "capabilities"])) ||
    read.state === "available" && read.data == null) return invalid();
  if (read.data == null) return null;
  if (["positions", "fills", "executors", "orders"].includes(read.section ?? "")) {
    if (!records(read.data) || read.data.some(row => ["executor_id", "controller_id", "trading_pair", "state"].some(key => row[key] != null && typeof row[key] !== "string"))) return invalid();
    const required: Record<string, string[]> = { positions: ["position_id", "controller_id", "trading_pair", "state", "quantity"], executors: ["executor_id", "controller_id", "state"], fills: ["trade_id", "order_id", "trading_pair", "side", "quantity", "price"], orders: ["order_id", "executor_id", "side"] };
    if (read.data.some(row => required[read.section!].some(key => typeof row[key] !== "string" || !row[key]))) return invalid();
    if (["positions", "executors"].includes(read.section) && read.data.some(row => {
      const decimal = (value: unknown) => typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value);
      if (["target_price", "remaining_target_amount"].some(key => row[key] != null && !decimal(row[key])) || ["target_basis", "target_reason"].some(key => row[key] != null && typeof row[key] !== "string")) return true;
      const order = row.protected_exit_order;
      return order != null && (!object(order) || !["pending", "open", "partially_filled", "filled", "cancelled"].includes(String(order.state)) || !decimal(order.price) || !decimal(order.remaining_amount) || order.order_id != null && typeof order.order_id !== "string" || order.placed_at_ms != null && (!Number.isSafeInteger(order.placed_at_ms) || Number(order.placed_at_ms) < 0));
    })) return invalid();
  } else {
    if (!object(read.data)) return invalid();
    for (const key of ["assets", "conditions", "rails", "segments", "gaps", ...(read.section === "decisions" ? ["controllers"] : [])]) {
      if (key in read.data && !records(read.data[key])) return invalid();
    }
  }
  return null;
}

export function paperReadState(read: Partial<import("./contracts").PaperRead> | undefined, now: number): import("./contracts").PaperReadState {
  if (!read || read.schema !== "rsibot.v5-paper.read.v1" || read.execution_mode !== "paper" || read.simulated !== true) return "degraded";
  if (paperSectionError(read)) return "degraded";
  if (read.state === "available" && ["partial", "unavailable"].includes(read.completeness ?? "")) return "degraded";
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

export function paperWords(value: unknown): string {
  if (value == null || value === "") return "Not published";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  const labels: Record<string, string> = {
    midpoint_fresh_book_only: "Mid of fresh book",
    controls_not_integrated: "Risk controls not yet connected to this paper bot",
    insufficient_comparable_history: "Collecting comparable history",
    fixed_target_recipe: "Fixed-target recipe; trailing exit does not apply",
    no_active_plan: "No active DCA plan",
    clock_persistence_failed: "Clock durability failed; new acquisitions are held",
    stop_persistence_failed: "Stop durability failed; new acquisitions are held",
    clock_invalid: "Invalid owner clock; clears and native advancement are held",
    native_placed_fixed_target_limit: "Native placed fixed-target limit",
    partially_filled: "Partially filled",
    partial_close: "Partially closed",
    degraded: "Incomplete", available: "Available", not_applicable: "Not applicable",
  };
  const text = String(value);
  const words = text.includes("_") || /^[A-Z_]+$/.test(text) ? text.toLowerCase().replaceAll("_", " ") : text;
  return labels[text] ?? words.replace(/^./, first => first.toUpperCase());
}

export function paperAmount(value: unknown, unit: string, places = 4): string {
  if (typeof value !== "string" || !/^-?\d+(\.\d+)?$/.test(value) || value.length > 128) return "Not published";
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  const digits = fraction.padEnd(places + 1, "0");
  const scaled = BigInt(whole + digits.slice(0, places)) + (digits[places] >= "5" ? 1n : 0n);
  const rounded = scaled.toString().padStart(places + 1, "0");
  const integer = places ? rounded.slice(0, -places) : rounded;
  return `${negative && scaled !== 0n ? "−" : ""}${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${places ? "." + rounded.slice(-places) : ""} ${unit}`;
}

export function paperExactAmount(value: unknown, unit: string): string {
  return typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value) && value.length <= 128 ? `${value} ${unit}` : "Not published";
}

export function paperTime(value: unknown, now: number): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > now + 5000) return "Not published";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Not published";
  const seconds = Math.max(0, Math.floor((now - value) / 1000));
  const age = seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h` : `${Math.floor(seconds / 86400)}d`;
  return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC · ${age} ago`;
}

export function paperCompleteRead(read: import("./contracts").PaperRead | undefined, now: number): boolean {
  return !!read && paperReadState(read, now) === "available" && read.completeness === "complete" && !read.next_cursor;
}

export function paperCompleteRecords(read: import("./contracts").PaperRead | undefined, now: number): Record<string, unknown>[] | null {
  return paperCompleteRead(read, now) && Array.isArray(read?.data) ? read.data : null;
}

export function paperWalletTotals(read: import("./contracts").PaperRead | undefined, now: number): { equity: unknown; cash: unknown } | null {
  if (!read || read.section !== "wallet" || !paperCompleteRead(read, now) || !read.data || typeof read.data !== "object" || Array.isArray(read.data)) return null;
  const wallet = read.data as Record<string, unknown>;
  const assets = Array.isArray(wallet.assets) ? wallet.assets as Record<string, unknown>[] : [];
  return { equity: wallet.equity_quote, cash: assets.find(asset => asset.asset === wallet.quote_asset)?.available };
}

export function paperRiskUsage(read: import("./contracts").PaperRead | undefined, now: number): Record<string, unknown>[] | null {
  if (!read || read.section !== "risk" || !paperCompleteRead(read, now)) return null;
  const risk = read.data as { rails?: Record<string, unknown>[] } | null;
  return Array.isArray(risk?.rails) ? risk.rails : null;
}

export function paperLifetimeTotals(read: import("./contracts").PaperRead | undefined, snapshot: import("./contracts").PaperRead | undefined, now: number): Record<string, unknown> | null {
  if (!read || !snapshot || read.section !== "accounting" || !paperCompleteRead(read, now) || !paperSnapshotsAgree([read, snapshot])) return null;
  const data = read.data as { program?: unknown } | null;
  return data?.program && typeof data.program === "object" && !Array.isArray(data.program) ? data.program as Record<string, unknown> : null;
}

export function paperOpenExecutorCount(read: import("./contracts").PaperRead | undefined, now: number): number | null {
  if (read?.section !== "executors") return null;
  const rows = paperCompleteRecords(read, now);
  if (!rows) return null;
  const terminal = new Set(["closed", "completed", "terminated"]);
  const active = new Set(["active", "running", "partial_close", "open", "not_started", "shutting_down"]);
  if (rows.some(row => row.terminal !== true && !terminal.has(String(row.state).toLowerCase()) && !active.has(String(row.state).toLowerCase()))) return null;
  return rows.filter(row => row.terminal !== true && !terminal.has(String(row.state).toLowerCase())).length;
}

export function paperRiskHold(read: import("./contracts").PaperRead | undefined): string | null {
  return paperRiskHolds(read).map(hold => hold.explanation).join(" ") || null;
}

export function paperRiskHolds(read: import("./contracts").PaperRead | undefined): { reason: string; explanation: string; action: string }[] {
  if (paperSectionError(read)) return [];
  const data = read?.data as Record<string, unknown> | null;
  const actions: Record<string, string> = {
    stop_persistence_failed: "Owner action: review retained stop evidence, then use the owner-only emergency reset; resume entries cannot clear this hold.",
    clock_persistence_failed: "Owner action: review retained clock evidence, then give explicit owner maintenance acknowledgement; resume entries cannot clear this hold.",
    clock_invalid: "Owner action: restore a valid clock, review retained clock evidence, then give owner maintenance acknowledgement; resume entries cannot clear this hold.",
  };
  const holds = Array.isArray(data?.holds) ? data.holds : data?.control_hold ? [{ reason: data.reason ?? data.control_hold, explanation: data.explanation }] : [];
  return holds.filter((hold): hold is Record<string, unknown> => !!hold && typeof hold === "object" && typeof hold.reason === "string" && hold.reason in actions).map(hold => ({ reason: String(hold.reason), explanation: typeof hold.explanation === "string" ? hold.explanation : "New acquisitions are held; protective exits remain enabled.", action: actions[String(hold.reason)] }));
}

export function paperExitProjection(position: Record<string, unknown> | undefined, executor: Record<string, unknown> | undefined) {
  const record = position && "target_price" in position ? position : executor;
  const order = record?.protected_exit_order;
  return {
    targetPrice: record?.target_price ?? null,
    basis: record?.target_basis ? paperWords(record.target_basis) : null,
    reason: record?.target_reason ? paperWords(record.target_reason) : "Owner exit target not published",
    remainingAmount: record?.remaining_target_amount ?? null,
    order: order && typeof order === "object" && !Array.isArray(order) ? order as Record<string, unknown> : null,
  };
}

export function paperWalletInventory(read: import("./contracts").PaperRead | undefined, now: number): { value: string; unit: string; basis: string; asOf: number } | null {
  if (!read || read.section !== "wallet" || !paperCompleteRead(read, now)) return null;
  const wallet = read.data as Record<string, unknown> | null;
  if (!wallet || typeof wallet.quote_asset !== "string" || !Array.isArray(wallet.assets)) return null;
  const inventory = (wallet.assets as Record<string, unknown>[]).filter(asset => asset.asset !== wallet.quote_asset);
  if (inventory.some(asset => typeof asset.marked_value_quote !== "string" || !/^\d+(\.\d+)?$/.test(asset.marked_value_quote) || asset.marked_value_quote.length > 128 || paperTime(asset.mark_at_ms, now) === "Not published")) return null;
  const values = inventory.map(asset => String(asset.marked_value_quote));
  const places = Math.max(0, ...values.map(value => value.split(".")[1]?.length ?? 0));
  const total = values.reduce((sum, value) => {
    const [whole, fraction = ""] = value.split(".");
    return sum + BigInt(whole + fraction.padEnd(places, "0"));
  }, 0n).toString().padStart(places + 1, "0");
  const asOf = inventory.length ? Math.min(...inventory.map(asset => Number(asset.mark_at_ms))) : read.source_at_ms ?? read.generated_at_ms;
  if (typeof asOf !== "number") return null;
  return { value: places ? total.slice(0, -places) + "." + total.slice(-places) : total, unit: wallet.quote_asset, basis: paperWords(wallet.valuation_policy), asOf };
}

export function paperPairObservation(pair: string, positions: import("./contracts").PaperRead | undefined, executors: import("./contracts").PaperRead | undefined, decisions: import("./contracts").PaperRead | undefined, now: number) {
  const rows = (read: import("./contracts").PaperRead | undefined): Record<string, unknown>[] => !paperSectionError(read) && Array.isArray(read?.data) ? read.data : [];
  const position = rows(positions).find(row => row.trading_pair === pair);
  const terminal = (row: Record<string, unknown>) => row.terminal === true || ["closed", "completed", "terminated"].includes(String(row.state).toLowerCase());
  const active = (row: Record<string, unknown>) => !terminal(row) && ["active", "running", "partial_close", "open", "not_started", "shutting_down"].includes(String(row.state).toLowerCase());
  const pairExecutors = rows(executors).filter(row => row.trading_pair === pair && active(row));
  const executor = position?.executor_id != null ? rows(executors).find(row => row.executor_id === position.executor_id && active(row)) : paperCompleteRead(executors, now) && pairExecutors.length === 1 ? pairExecutors[0] : undefined;
  const complete = (read: import("./contracts").PaperRead | undefined) => paperCompleteRead(read, now);
  const historicallyComplete = (read: import("./contracts").PaperRead | undefined) => !!read && ["available", "stale"].includes(paperReadState(read, now)) && read.completeness === "complete" && !read.next_cursor;
  const unmappedActive = rows(executors).some(row => !terminal(row) && !row.trading_pair && !rows(positions).some(position => position.executor_id != null && position.executor_id === row.executor_id));
  const activeForPair = rows(executors).some(row => row.trading_pair === pair && !terminal(row));
  const knownFlat = !position && !activeForPair && !unmappedActive && complete(positions) && complete(executors) && Array.isArray(positions?.data) && Array.isArray(executors?.data) && paperSnapshotsAgree([positions!, executors!]);
  const lastReportedFlat = !knownFlat && !position && !activeForPair && !unmappedActive && historicallyComplete(positions) && historicallyComplete(executors) && paperSnapshotsAgree([positions!, executors!]);
  const data = decisions?.data as { conditions?: unknown; controllers?: unknown } | null;
  const candidates = complete(decisions) && positions && paperSnapshotsAgree([positions, decisions!]) && Array.isArray(data?.conditions) ? data.conditions as Record<string, unknown>[] : [];
  const controller = complete(decisions) && positions && paperSnapshotsAgree([positions, decisions!]) && Array.isArray(data?.controllers) ? (data.controllers as Record<string, unknown>[]).find(row => row.pair === pair) : undefined;
  const info = controller?.custom_info && typeof controller.custom_info === "object" && !Array.isArray(controller.custom_info) ? controller.custom_info as Record<string, unknown> : {};
  const decision = candidates.filter(row => row.trading_pair === pair).sort((first, second) => Number(second.event_at_ms ?? 0) - Number(first.event_at_ms ?? 0))[0] ?? (info.modular_status != null ? { status: info.modular_status, reason: info.modular_reason, event_at_ms: decisions?.source_at_ms } : null);
  return { position, executor, knownFlat, lastReportedFlat, decision };
}

export function paperOrderCount(value: unknown, kind: "entry" | "exit"): string {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? `${value} ${value === 1 ? kind : kind === "entry" ? "entries" : "exits"}` : "Count not published";
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
    gates: [
      { id: "recovery", priority: "P0", label: "Recovery with open obligations", status: "NOT_RUN", evidence: null, next: "Restore a copied nonempty wallet and prove protective exits survive." },
      { id: "controls", priority: "P0", label: "Durable paper controls", status: "NOT_RUN", evidence: null, next: "Bind owner acknowledgements and prove entry halt preserves exits." },
      { id: "qualification", priority: "P0", label: "Route and visual qualification", status: "NOT_RUN", evidence: null, next: "Attach reviewed evidence for every production route and state." },
      { id: "supervision", priority: "P0", label: "Supervision and restore", status: "NOT_RUN", evidence: null, next: "Attach continuous supervision and bounded restore proof." },
      { id: "economics", priority: "P1", label: "Historical economic support", status: "NOT_RUN", evidence: null, next: "V5 historical economic support is not connected to this dashboard." },
    ],
  };
}
