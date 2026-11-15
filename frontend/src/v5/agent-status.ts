import type { V5Workspace } from "./contracts";

export interface WorkspaceRead {
  data?: V5Workspace;
  isPending?: boolean;
  isError?: boolean;
  error?: Error | null;
}

export function sourceFailure(read: WorkspaceRead, source: string): string | undefined {
  return read.data?.source_error?.split(";").find(value => value.startsWith(`${source}:`))?.slice(source.length + 1);
}

export function advisorAvailability(read: WorkspaceRead) {
  if (read.isPending) return { state: "loading", message: "Advisor state not read: loading advisor evidence." } as const;
  if (read.isError) return { state: "upstream_error", message: `Advisor state not read: upstream error: ${read.error?.message || "Workspace read failed"} · Source: /api/v5/workspace` } as const;
  const failure = sourceFailure(read, "advisor");
  if (failure) return { state: "upstream_error", message: `Advisor state not read: upstream error: ${failure} · Source: /v1/advice/status` } as const;
  if (read.data?.advisor.enabled === false) return { state: "disabled", message: "Advisor is disabled by the owner service." } as const;
  if (read.data?.advisor.enabled === true) return { state: "enabled", message: "Advisor is enabled by the owner service." } as const;
  return { state: "unavailable", message: "Advisor state not read: advisor.enabled is not published · Source: /v1/advice/status" } as const;
}

const scheduledRoles = [
  { id: "market_analyst", taskId: "market_context", name: "Market analyst" },
  { id: "source_auditor", taskId: "source_quality", name: "Source auditor" },
  { id: "decision_reviewer", taskId: "decision_review", name: "Decision reviewer" },
] as const;

const failedReports = new Set(["REJECTED", "NOT_SENT", "UNKNOWN_CHARGE", "CANCELLED_UNKNOWN_CHARGE", "LATE_OR_CLOCK_INVALID"]);

function publishedTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000;
}

function reportAge(timestamp: number | null, nowMs: number) {
  if (timestamp === null) return "age not published";
  if (!Number.isFinite(nowMs) || nowMs < timestamp) return "age unavailable (clock mismatch)";
  const seconds = Math.floor((nowMs - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

export function scheduledAgentLines(read: WorkspaceRead, nowMs = Date.now()) {
  const availability = advisorAvailability(read);
  const advisor = read.data?.advisor;
  const scheduler = advisor?.scheduler;
  return scheduledRoles.map(role => {
    const agent = read.data?.agents.find(value => value.id === role.id);
    const profile = advisor?.task_profiles?.find(value => value.task_id === role.taskId);
    const latest = advisor?.latest_by_task?.[role.taskId];
    const report = latest?.task_id === role.taskId && latest.record?.result.task_id === role.taskId ? latest.record.result : undefined;
    const received = publishedTimestamp(report?.received_at_ms) ? report.received_at_ms : null;
    const expiry = publishedTimestamp(report?.expires_at_ms) ? report.expires_at_ms : null;
    const failure = sourceFailure(read, `latest_${role.taskId}`) || sourceFailure(read, "task_profiles");
    let state = "State not published";
    let reason = "Owner scheduling state is not published.";
    if (availability.state !== "enabled") {
      state = availability.state === "disabled" ? "Disabled" : availability.state === "loading" ? "Loading" : availability.state === "upstream_error" ? "Upstream error" : "Unavailable";
      reason = availability.message;
    } else if (failure) {
      state = "Upstream error";
      reason = `${failure} · Source: /api/v5/workspace`;
    } else if (profile?.enabled === false) {
      state = "Disabled";
      reason = profile.reason || "Owner task enabled: false";
    } else if (scheduler?.enabled === false) {
      state = "Not scheduled";
      reason = `Owner scheduler enabled: false · ${scheduler.last_status ?? "scheduler status not published"}`;
    } else if (report?.status && failedReports.has(report.status)) {
      state = "Last run failed";
      reason = [report.status, report.reason, report.rejection].filter(Boolean).join(" · ");
    } else if (scheduler?.enabled === true) {
      reason = "Owner shared scheduler enabled: true.";
      if (profile?.enabled === true && report?.status === "ACCEPTED" && latest?.status === "CURRENT_REPORT" && received !== null && Number.isFinite(nowMs) && nowMs >= received) {
        state = "Last report accepted";
      }
      if (scheduler.task_id === role.taskId && scheduler.last_status) reason += ` Last scheduler status: ${scheduler.last_status}.`;
    }
    return {
      ...role, name: agent?.name || role.name, state, reason,
      reportTime: received === null ? null : new Date(received).toISOString(),
      reportAge: reportAge(received, nowMs),
      reportStatus: report?.status ?? latest?.status ?? "not published",
      reportState: latest?.status ?? "not published",
      expiry: expiry === null ? "expiry not published" : !Number.isFinite(nowMs) ? "expiry unavailable (clock mismatch)" : nowMs >= expiry ? "expired" : "not expired",
      overdue: "overdue rule not published",
      schedule: "schedule not published",
    };
  });
}
