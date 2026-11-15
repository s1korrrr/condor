import type { V5Workspace } from "./contracts";

export interface WorkspaceRead {
  data?: V5Workspace;
  isPending?: boolean;
  isError?: boolean;
  error?: Error | null;
}

export function sourceFailure(read: WorkspaceRead, source: string): string | undefined {
  const errors = read.data?.source_error;
  return typeof errors === "string" ? errors.split(";").find(value => value.startsWith(`${source}:`))?.slice(source.length + 1) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function advisorUnread(reason: string) {
  return { state: "unavailable", message: `Advisor state not read: ${reason}` } as const;
}

export function advisorTaskProfile(read: WorkspaceRead, taskId: string | null | undefined) {
  if (taskId == null) return undefined;
  const profiles = read.data?.advisor?.task_profiles;
  return Array.isArray(profiles) ? profiles.find(profile => isRecord(profile) && profile.task_id === taskId) : undefined;
}

export function advisorAvailability(read: WorkspaceRead) {
  if (read.isPending) return { state: "loading", message: "Advisor state not read: loading advisor evidence." } as const;
  if (read.isError) return { state: "upstream_error", message: `Advisor state not read: upstream error: ${read.error?.message || "Workspace read failed"} · Source: /api/v5/workspace` } as const;
  const failure = sourceFailure(read, "advisor");
  if (failure) return { state: "upstream_error", message: `Advisor state not read: upstream error: ${failure} · Source: /v1/advice/status` } as const;
  const advisor = read.data?.advisor;
  if (!isRecord(advisor)) return advisorUnread("advisor is not published as an object · Source: /v1/advice/status");
  if (advisor.task_profiles !== undefined) {
    if (!Array.isArray(advisor.task_profiles)) return advisorUnread("task_profiles is not an array · Source: /api/v5/workspace");
    if (advisor.task_profiles.some(profile => !isRecord(profile))) return advisorUnread("task_profiles contains an invalid profile · Source: /api/v5/workspace");
    if (advisor.task_profiles.some(profile => profile.enabled !== undefined && typeof profile.enabled !== "boolean")) return advisorUnread("task_profiles.enabled is invalid · Source: /api/v5/workspace");
  }
  if (advisor.scheduler !== undefined && !isRecord(advisor.scheduler)) return advisorUnread("scheduler is not an object · Source: /api/v5/workspace");
  if (advisor.latest_by_task !== undefined && !isRecord(advisor.latest_by_task)) return advisorUnread("latest_by_task is not an object · Source: /api/v5/workspace");
  if (advisor.enabled === false) return { state: "disabled", message: "Advisor is disabled by the owner service." } as const;
  if (advisor.enabled === true) return { state: "enabled", message: "Advisor is enabled by the owner service." } as const;
  return advisorUnread("advisor.enabled is not published · Source: /v1/advice/status");
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

function elapsedTime(durationMs: number) {
  const seconds = Math.floor(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function reportAge(timestamp: number | null, nowMs: number) {
  if (timestamp === null) return "age not published";
  if (!Number.isFinite(nowMs) || nowMs < timestamp) return "age unavailable (clock mismatch)";
  return `${elapsedTime(nowMs - timestamp)} ago`;
}

function utcTime(timestamp: number) {
  return new Date(timestamp).toISOString().replace("T", " ").replace("Z", " UTC");
}

export function scheduledAgentLines(read: WorkspaceRead, nowMs = Date.now()) {
  const availability = advisorAvailability(read);
  const advisor = read.data?.advisor;
  const scheduler = advisor?.scheduler;
  return scheduledRoles.map(role => {
    const agent = Array.isArray(read.data?.agents) ? read.data.agents.find(value => isRecord(value) && value.id === role.id) : undefined;
    const profile = advisorTaskProfile(read, role.taskId);
    const latest = advisor?.latest_by_task?.[role.taskId];
    const result = latest?.record?.result;
    const malformedReport = latest != null && (!isRecord(latest) || (latest.record != null && !isRecord(result)) || (latest.status === "CURRENT_REPORT" && !isRecord(result)));
    const report = isRecord(result) && latest?.task_id === role.taskId && result.task_id === role.taskId ? result : undefined;
    const received = publishedTimestamp(report?.received_at_ms) ? report.received_at_ms : null;
    const expiry = publishedTimestamp(report?.expires_at_ms) ? report.expires_at_ms : null;
    const expired = expiry !== null && Number.isFinite(nowMs) && nowMs >= expiry;
    const failure = sourceFailure(read, `latest_${role.taskId}`) || sourceFailure(read, "task_profiles");
    let state = "State not published";
    let reason = "Owner scheduling state is not published.";
    if (availability.state !== "enabled") {
      state = availability.state === "disabled" ? "Disabled" : availability.state === "loading" ? "Loading" : availability.state === "upstream_error" ? "Upstream error" : "Unavailable";
      reason = availability.message;
    } else if (failure) {
      state = "Upstream error";
      reason = `${failure} · Source: /api/v5/workspace`;
    } else if (malformedReport) {
      state = "Unavailable";
      reason = advisorUnread(`latest_${role.taskId}.record.result is not an object · Source: /api/v5/workspace`).message;
    } else if (profile?.enabled === false) {
      state = "Disabled";
      reason = profile.reason || "Owner task enabled: false";
    } else if (scheduler?.enabled === false) {
      state = "Not scheduled";
      reason = `Owner scheduler enabled: false · ${scheduler.last_status ?? "scheduler status not published"}`;
    } else if (report?.status && failedReports.has(report.status)) {
      state = "Last run failed";
      reason = [report.status, report.reason, report.rejection].filter(Boolean).join(" · ");
    } else if (report?.status === "ACCEPTED" && expired) {
      state = `Last report expired at ${utcTime(expiry)} (${reportAge(expiry, nowMs)})`;
      reason = "The owner's published report expiry has passed.";
    } else if (scheduler?.enabled === true) {
      reason = "Owner shared scheduler enabled: true.";
      if (profile?.enabled === true && report?.status === "ACCEPTED" && latest?.status === "CURRENT_REPORT" && received !== null && expiry !== null && Number.isFinite(nowMs) && nowMs >= received) {
        state = "Last report accepted";
      }
      if (scheduler.task_id === role.taskId && scheduler.last_status) reason += ` Last scheduler status: ${scheduler.last_status}.`;
    }
    return {
      ...role, name: agent?.name || role.name, state, reason,
      reportTime: received === null ? null : new Date(received).toISOString(),
      reportAge: reportAge(received, nowMs),
      reportStatus: typeof report?.status === "string" ? report.status : "not published",
      reportState: expired && latest?.status === "CURRENT_REPORT" ? "was CURRENT_REPORT" : typeof latest?.status === "string" ? latest.status : "not published",
      expiry: expiry === null ? "expiry not published" : !Number.isFinite(nowMs) ? "expiry unavailable (clock mismatch)" : nowMs >= expiry ? "expired" : "not expired",
      expiryTime: expiry === null ? null : new Date(expiry).toISOString(),
      expiryRelative: expiry === null ? "expiry not published" : !Number.isFinite(nowMs) ? "relative time unavailable (clock mismatch)" : expired ? reportAge(expiry, nowMs) : `in ${elapsedTime(expiry - nowMs)}`,
      overdue: "overdue rule not published",
      schedule: "schedule not published",
    };
  });
}
