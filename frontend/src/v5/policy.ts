import { PAPER_SNAPSHOT_FRESH_MS, paperAge, paperTimestampIssue } from './snapshot-presentation.ts';

export interface ReportPermissionInput {
  agentReady: boolean;
  advisorEnabled: boolean;
  taskEnabled: boolean;
  modelAvailable: boolean;
  mode: string;
  executionEnabled: boolean;
  agentExecutionEnabled: boolean;
}

export async function paperBoundedRead<Result>(attempt: () => Promise<Result>, wait: (milliseconds: number) => Promise<void> = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))): Promise<Result> {
  for (let index = 0; ; index++) {
    try { return await attempt(); }
    catch (error) {
      const status = error && typeof error === "object" && "status" in error ? error.status : null;
      if (index >= 1 || (status !== 409 && status !== 503)) throw error;
      if (status === 503) await wait(200);
    }
  }
}

export async function paperCoherentRead(statusPath: string, sections: { section: string; path: string; paginate?: boolean }[], read: (path: string, section: string, status?: import("./contracts").PaperRead) => Promise<import("./contracts").PaperRead>, wait?: (milliseconds: number) => Promise<void>, progress: (reads: import("./contracts").PaperRead[]) => void = () => {}) {
  return paperBoundedRead(async () => {
    progress([]);
    try {
      const status = await read(statusPath, "status");
      if (!status.snapshot_id) throw new Error("Owner snapshot is unavailable. No sections or totals are inferred.");
      const reads: import("./contracts").PaperRead[] = [status];
      progress([...reads]);
      let nextIndex = 0;
      let failure: { error: unknown } | undefined;
      async function worker() {
        while (!failure && nextIndex < sections.length) {
          const index = nextIndex++;
          const section = sections[index];
          const path = section.path + `${section.path.includes("?") ? "&" : "?"}snapshot_id=${encodeURIComponent(status.snapshot_id!)}`;
          try {
            const value = section.paginate ? await paperObservationPages(path, page => read(page, section.section, status)) : await read(path, section.section, status);
            if (failure) return;
            if (!paperSnapshotsAgree([status, value])) throw new Error("Mixed owner snapshots were refused. Refresh; totals are not combined.");
            reads[index + 1] = value;
            progress(reads.filter(Boolean));
          } catch (error) {
            if (!failure) { failure = { error }; progress([]); }
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(3, sections.length) }, () => worker()));
      if (failure) throw failure.error;
      return reads;
    } catch (error) {
      progress([]);
      throw error;
    }
  }, wait);
}

export function paperWorkspaceReads(page: "capital" | "operations" | "tradepad") {
  if (page === "capital") return { presentation: "paper" as const, paperReadUrl: "/api/v1/servers/rsibot-v5/account-balances", paperHistoryReadUrl: "/api/v1/servers/rsibot-v5/controller-performance/history", paperAccountingReadUrl: "/api/v1/servers/rsibot-v5/fleet/accounting" };
  if (page === "operations") return { presentation: "paper" as const, paperReadUrl: "/api/v1/operations/workspace" };
  return { presentation: "paper" as const };
}

export function paperObservationSummary(reads: import("./contracts").PaperRead[], bot: string, now: number) {
  const required = ["status", "wallet", "positions", "executors", "risk"];
  if (reads.length !== required.length || required.some(section => reads.filter(read => read.section === section && read.bot_id === bot).length !== 1) || reads.some(read => paperSectionError(read)) || !paperSnapshotsAgree(reads)) return { label: "Unavailable", reason: "A complete, validated set of paper reads from one owner snapshot is not available." };
  const states = reads.map(read => paperReadState(read, now));
  if (states.includes("stale")) return { label: "Stale", reason: "The retained paper report has expired. Process heartbeat does not refresh its data." };
  if (!reads.every(read => paperCompleteRead(read, now))) return { label: "Incomplete", reason: "One or more owner sections are incomplete or unavailable. No qualification pass is inferred." };
  return { label: "Available", reason: "Required paper sections passed their read contracts at one snapshot. This is not production qualification." };
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

function paperNativeRecordValid(value: unknown, key = "", depth = 0, nativeFee = false): boolean {
  if (depth > 16) return false;
  if (value == null) return true;
  const object = (part: unknown): part is Record<string, unknown> => !!part && typeof part === "object" && !Array.isArray(part);
  const decimal = (part: unknown) => typeof part === "string" && part.length <= 128 && /^-?[0-9]+(?:\.[0-9]+)?$/.test(part);
  const currency = (part: unknown) => typeof part === "string" && /^[A-Za-z0-9_.-]{1,32}$/.test(part);
  const fields = (part: unknown, required: string[], allowed = required): part is Record<string, unknown> => object(part) && required.every(name => name in part) && Object.keys(part).every(name => allowed.includes(name));
  if (typeof value === "string" && (value.length > 4096 || /^(?:nan|-?inf|-?infinity)$/i.test(value))) return false;
  if (key.endsWith("_ms") || key.endsWith("_count")) return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (["count_basis", "fee_quote_valuation_basis", "target_basis", "pnl_scope"].includes(key) || nativeFee && key === "fee_type") return typeof value === "string" && !!value && (!["target_basis", "pnl_scope"].includes(key) || /^[A-Za-z0-9_.-]{1,128}$/.test(value));
  if (key === "fee") {
    if (!fields(value, ["fee_type", "flat_fees", "percent", "percent_token"]) || !["AddedToCost", "DeductedFromReturns"].includes(String(value.fee_type)) || !decimal(value.percent) || value.percent_token !== null && !currency(value.percent_token) || !Array.isArray(value.flat_fees) || value.flat_fees.length > 32 || !value.flat_fees.every(part => fields(part, ["amount", "token"]) && decimal(part.amount) && currency(part.token))) return false;
    return true;
  }
  if (key === "fees") return Array.isArray(value) && value.length <= 32 && value.every(part => fields(part, ["amount", "currency"]) && decimal(part.amount) && currency(part.currency));
  if (key === "fees_paid") return object(value) && Object.keys(value).length <= 32 && Object.entries(value).every(([asset, amount]) => /^[A-Z0-9]{1,20}$/.test(asset) && decimal(amount) && !String(amount).startsWith("-"));
  if (key === "close_quantity") return fields(value, [], ["owned_base", "available_base", "order_amount", "residual_base", "quantity_increment", "blocked_reason"]) && Object.entries(value).every(([name, amount]) => amount === null || typeof amount === "string" && (name === "blocked_reason" ? /^[A-Za-z0-9_.-]{1,128}$/.test(amount) : amount.length <= 128 && /^-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]{1,3})?$/.test(amount) && Number.isFinite(Number(amount)) && (Number(amount) === 0 || Math.abs(Math.floor(Math.log10(Math.abs(Number(amount))))) <= 128)));
  if ((object(value) || Array.isArray(value)) && key !== "fee" && /(?:^|_)(?:price|quantity|amount|balance|total|available|reserved|basis|fee|fees|pnl|exposure|funding|mark|cash|equity)(?:_|$)/.test(key) && !/_(?:currency|asset|unit|source|policy|reason|state|id|count|enabled|applicable|known)$/.test(key)) return false;
  if (object(value)) return Object.entries(value).every(([name, part]) => paperNativeRecordValid(part, key === "unavailable_reasons" ? name + "_reason" : name, depth + 1, nativeFee));
  if (Array.isArray(value)) return value.length <= 2000 && value.every(part => paperNativeRecordValid(part, "", depth + 1, nativeFee));
  if (/(?:^|_)(?:price|quantity|amount|balance|total|available|reserved|basis|fee|fees|pnl|exposure|funding|mark|cash|equity)(?:_|$)/.test(key) && !/_(?:currency|asset|unit|source|policy|reason|state|id|count|enabled|applicable|known)$/.test(key)) return decimal(value);
  return typeof value !== "number" || Number.isSafeInteger(value);
}

export async function paperObservationPages(path: string, fetchPage: (path: string) => Promise<import("./contracts").PaperRead>): Promise<import("./contracts").PaperRead> {
  const url = new URL(path, "https://paper.invalid");
  url.searchParams.set("limit", "200");
  let result = await fetchPage(url.pathname + url.search);
  const seen = new Set<string>();
  for (let page = 1; result.next_cursor && page < 5; page++) {
    if (seen.has(result.next_cursor)) throw new Error("Repeated owner history cursor was refused.");
    seen.add(result.next_cursor);
    url.searchParams.set("cursor", result.next_cursor);
    if (!result.snapshot_id) throw new Error("Owner history snapshot is unavailable.");
    url.searchParams.set("snapshot_id", result.snapshot_id);
    const next = await fetchPage(url.pathname + url.search);
    if (!paperSnapshotsAgree([result, next]) || result.section !== next.section || result.state !== next.state || result.completeness !== next.completeness) throw new Error("Mixed owner page snapshots or states were refused.");
    if (Array.isArray(result.data) && Array.isArray(next.data)) {
      result = { ...next, data: [...result.data, ...next.data] };
      continue;
    }
    const previousData = result.data as Record<string, unknown> | null;
    const nextData = next.data as Record<string, unknown> | null;
    if (!Array.isArray(previousData?.segments) || !Array.isArray(nextData?.segments)) throw new Error("Owner history page is invalid.");
    result = { ...next, data: { ...nextData, segments: [...previousData.segments, ...nextData.segments] } };
  }
  return result;
}

export function paperSectionError(read: Partial<import("./contracts").PaperRead> | undefined): string | null {
  if (!read) return null;
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  const records = (value: unknown): value is Record<string, unknown>[] => Array.isArray(value) && value.every(object);
  const invalid = () => `${typeof read.section === "string" ? paperWords(read.section) : "Paper section"} owner schema invalid; this section is unavailable.`;
  const unbound = ["collecting", "degraded"].includes(read.state ?? "") && read.snapshot_id === null;
  if (!object(read) || ["reason", "read_at_ms", "observed_at_ms", "source_at_ms", "capabilities", "source"].some(key => !Object.hasOwn(read, key)) || read.schema !== "rsibot.v5-paper.read.v1" || typeof read.section !== "string" || !read.section ||
    !["available", "collecting", "not_applicable", "degraded", "stale"].includes(read.state ?? "") ||
    read.execution_mode !== "paper" || read.simulated !== true ||
    (read.reason != null && typeof read.reason !== "string") ||
    (read.stale_reason != null && typeof read.stale_reason !== "string") ||
    (typeof read.bot_id !== "string" || !read.bot_id) && !(unbound && read.bot_id === null) ||
    (typeof read.snapshot_id !== "string" || !read.snapshot_id) && !unbound ||
    (read.generated_at_ms == null && !unbound) ||
    ["generated_at_ms", "source_at_ms", "observed_at_ms", "read_at_ms"].some(key => {
      const value = read[key as "generated_at_ms" | "source_at_ms" | "observed_at_ms" | "read_at_ms"];
      return value != null && (!Number.isSafeInteger(value) || value < 0) || key === "read_at_ms" && key in read && value == null;
    }) ||
    (read.completeness !== undefined && !["complete", "partial", "collecting", "unavailable"].includes(read.completeness)) ||
    (["positions", "fills", "executors", "orders"].includes(read.section) && read.completeness === undefined) ||
    (read.next_cursor != null && (typeof read.next_cursor !== "string" || !read.next_cursor)) ||
    ("source" in read && !object(read.source)) ||
    ("capabilities" in read && (!Array.isArray(read.capabilities) || read.capabilities.some(value => typeof value !== "string"))) ||
    read.state === "available" && read.data == null) return invalid();
  if (read.data == null) return null;
  if (!paperNativeRecordValid(read.data)) return invalid();
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
    if (read.section === "risk" && "controllers" in read.data) {
      const controllers = read.data.controllers;
      if (!object(controllers) || Object.keys(controllers).length > 5 || Object.entries(controllers).some(([id, row]) => !id || id.length > 128 || !object(row) || !object(row.operator) || !object(row.native))) return invalid();
    }
    if (read.section === "risk" && "native_entry_holds" in read.data && (!records(read.data.native_entry_holds) || read.data.native_entry_holds.length > 20 || read.data.native_entry_holds.some(hold => typeof hold.controller_id !== "string" || !hold.controller_id || typeof hold.explanation !== "string" || !hold.explanation.trim() || !["native_refusal_receipt_pending", "native_refusal_owner_ambiguous", "native_refusal_recovery_unavailable", "v5_risk_incomplete"].includes(String(hold.reason)) || hold.protected_exits !== "preserved"))) return invalid();
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
  if (read.generated_at_ms != null && paperTimestampIssue(read.generated_at_ms, now)) return "degraded";
  if (read.generated_at_ms != null && now - read.generated_at_ms > PAPER_SNAPSHOT_FRESH_MS) return "stale";
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
    PAPER_STATUS_FRESH: "Paper process heartbeat is current; owner read health is separate",
    stop_intent_log_damaged: "Stop intent log is damaged",
    ingress_unreadable: "Command ingress is unreadable",
    clock_anomaly: "Owner clock evidence conflicts",
    paper_controls_unavailable: "Paper controls could not be acquired",
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
  if (paperTimestampIssue(value, now)) return "Not published";
  const timestamp = value as number;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "Not published";
  const age = paperAge(now - timestamp);
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

export function paperRiskControllers(read: import("./contracts").PaperRead | undefined, now: number) {
  if (!read || read.section !== "risk" || paperSectionError(read)) return null;
  const risk = read.data as import("./contracts").PaperRiskData;
  return risk?.controllers ? Object.entries(risk.controllers).map(([id, controller]) => ({ id, ...controller, current: paperCompleteRead(read, now), holds: risk.native_entry_holds?.filter(hold => hold.controller_id === id) ?? [] })) : null;
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

export function paperRiskHold(read: import("./contracts").PaperRead | undefined): boolean {
  return paperRiskHolds(read).length > 0;
}

export function paperRiskHolds(read: import("./contracts").PaperRead | undefined): { reason: string; label: string; explanation: string; action: string }[] {
  const data = read?.data && typeof read.data === "object" && !Array.isArray(read.data) ? read.data as Record<string, unknown> : null;
  const actions: Record<string, string> = {
    stop_intent_log_damaged: "Owner action: review quarantined intent evidence, then use the owner-only emergency reset; resume entries cannot clear this hold.",
    ingress_unreadable: "Owner action: review ingress evidence, restore access, then use the owner-only ingress reset; resume and clock acknowledgement cannot clear this hold.",
    clock_anomaly: "Owner action: review retained clock anomalies, then use explicit owner clock maintenance; resume entries cannot clear this hold.",
    paper_controls_unavailable: "Owner action: resolve the control-store failure before restarting the runtime. This dashboard cannot acquire or repair the control store.",
    stop_persistence_failed: "Owner action: review retained stop evidence, then use the owner-only emergency reset; resume entries cannot clear this hold.",
    clock_persistence_failed: "Owner action: review retained clock evidence, then give explicit owner maintenance acknowledgement; resume entries cannot clear this hold.",
    clock_invalid: "Owner action: restore a valid clock, review retained clock evidence, then give owner maintenance acknowledgement; resume entries cannot clear this hold.",
  };
  const defaults: Record<string, string> = {
    stop_intent_log_damaged: "The stop intent log contains damaged or torn records. New acquisitions stay held; damaged evidence is retained for owner review.",
    ingress_unreadable: "Command ingress could not be read or enumerated. An unread stop cannot be excluded, so new acquisitions stay held.",
    clock_anomaly: "Retained clock evidence conflicts with provider samples. New acquisitions stay held; suspicious timestamps are quarantined, not adopted as clock authority.",
    paper_controls_unavailable: "Paper controls could not be acquired. The runtime refuses all native ticks and exits until the control-store failure is resolved.",
    stop_persistence_failed: "Stop durability is unproven. New acquisitions stay held pending the owner-only emergency reset.",
    clock_persistence_failed: "Owner clock continuity could not be persisted or proven. New acquisitions stay held pending owner maintenance acknowledgement.",
    clock_invalid: "The owner clock sample is invalid. Clears and native advancement stay held until the owner restores a valid clock and acknowledges recovery.",
  };
  const records = Array.isArray(data?.holds) ? data.holds.slice(0, 16).filter((hold): hold is Record<string, unknown> => !!hold && typeof hold === "object" && !Array.isArray(hold)) : [];
  if (data?.control_hold != null && !records.some(hold => hold.reason === data.control_hold)) records.push({ reason: data.control_hold, explanation: data.explanation });
  const unique = new Map<string, Record<string, unknown>>();
  for (const hold of records) {
    const reason = typeof hold.reason === "string" && hold.reason.trim() ? hold.reason.slice(0, 128) : "invalid owner hold";
    if (!unique.has(reason)) unique.set(reason, hold);
  }
  return [...unique].map(([reason, hold]) => {
    const known = Object.hasOwn(actions, reason);
    return { reason, label: known ? paperWords(reason) : `Unrecognised owner hold: ${reason} · entries held`, explanation: typeof hold.explanation === "string" && hold.explanation.trim() ? hold.explanation : known ? defaults[reason] : "The owner published an unrecognised safety hold. Treat entries as held; its clearing procedure is not published.", action: known ? actions[reason] : "Owner action: review the retained hold evidence and use the owner's documented recovery procedure. This dashboard cannot clear the hold." };
  });
}

export function paperExitProjection(position: Record<string, unknown> | undefined, positions: import("./contracts").PaperRead | undefined, executors: import("./contracts").PaperRead | undefined, now: number) {
  const rows = paperCompleteRecords(executors, now);
  const matches = rows?.filter(row => typeof position?.executor_id === "string" && row.executor_id === position.executor_id && row.terminal !== true && ["active", "running", "partial_close", "open", "not_started", "shutting_down"].includes(String(row.state).toLowerCase())) ?? [];
  const verified = !!position && positions?.section === "positions" && executors?.section === "executors" && positions.bot_id === executors.bot_id && !!paperCompleteRecords(positions, now)?.includes(position) && paperCompleteRead(executors, now) && paperSnapshotsAgree([positions, executors]) && matches.length === 1 && matches[0].controller_id === position.controller_id && (matches[0].trading_pair == null || matches[0].trading_pair === position.trading_pair) && (position.protected_exit == null || matches[0].protected_exit === position.protected_exit);
  if (!verified) {
    const issue = !paperCompleteRead(positions, now) ? positions : executors;
    const stale = paperReadState(issue, now) === "stale";
    const reportedAt = issue?.source_at_ms ?? issue?.generated_at_ms;
    const since = typeof reportedAt === "number" ? reportedAt + (stale && now - reportedAt > 30_000 ? 30_000 : 0) : null;
    return { verified: false, targetPrice: null, basis: null, reason: `Protection status unknown · ${issue === positions ? "position" : "executor"} data ${stale ? "stale" : "incomplete"} since ${paperTime(since, now)}`, remainingAmount: null, order: null, protectedExit: null };
  }
  const executor = matches[0];
  const record = position && "target_price" in position ? position : executor;
  const order = record?.protected_exit_order;
  return {
    verified: true,
    targetPrice: record?.target_price ?? null,
    basis: record?.target_basis ? paperWords(record.target_basis) : null,
    reason: record?.target_reason ? paperWords(record.target_reason) : "Owner exit target not published",
    remainingAmount: record?.remaining_target_amount ?? null,
    order: order && typeof order === "object" && !Array.isArray(order) ? order as Record<string, unknown> : null,
    protectedExit: typeof position?.protected_exit === "boolean" ? position.protected_exit : null,
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
  const staleTimes = [positions, executors].filter(read => paperReadState(read, now) === "stale").map(read => read?.source_at_ms ?? read?.generated_at_ms).filter((time): time is number => typeof time === "number").map(time => now - time > 30_000 ? time + 30_000 : time);
  const staleSince = staleTimes.length ? Math.min(...staleTimes) : null;
  return { position, executor, knownFlat, lastReportedFlat, staleSince, decision };
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
