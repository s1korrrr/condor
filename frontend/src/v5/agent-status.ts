import type { V5TaskReport, V5Workspace } from "./contracts";

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

/**
 * Why this role's report was not read, or undefined when it was. A failed read shows nothing from an earlier one:
 * the page says it did not read, never that the owner published no report.
 */
export function reportNotRead(read: WorkspaceRead, taskId: string): string | undefined {
  if (read.isError) return `${read.error?.message || "the workspace read failed"} · Source: /api/v5/workspace`;
  if (!read.data) return "the workspace read has not finished";
  const failure = sourceFailure(read, `latest_${taskId}`);
  return failure ? `${failure} · Source: /v1/advice/status` : undefined;
}

/** The owner's list leaves the decision review out when the dashboard has no paper status file to ask about. */
export function reportNotRequested(read: WorkspaceRead, taskId: string): string | undefined {
  const latest = read.data?.advisor?.latest_by_task;
  return taskId === "decision_review" && isRecord(latest) && latest[taskId] === undefined ? "not requested: no paper status file" : undefined;
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

/** "12:20:01 UTC", with the date only when it is not today (UTC). */
function clock(timestamp: number, nowMs: number) {
  const iso = new Date(timestamp).toISOString();
  const time = `${iso.slice(11, 19)} UTC`;
  return Number.isFinite(nowMs) && iso.slice(0, 10) === new Date(nowMs).toISOString().slice(0, 10) ? time : `${iso.slice(0, 10)} ${time}`;
}

/**
 * The advisor's one-line display text for a report, or null. It is the advisor's own words; no bot reads it.
 */
export function reportConclusion(report: V5TaskReport | undefined): string | null {
  const advice = report?.record?.result?.advice;
  const text = [advice?.assessment, advice?.summary].filter((part): part is string => typeof part === "string" && part.trim() !== "").map(part => part.trim());
  if (!text.length) return null;
  const line = text.join(" — ").replace(/\s+/g, " ");
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/**
 * What the owner's validity cutoff means: the owner rejects a report requested at or before it. The owner moves the cutoff
 * for several reasons (a source change, an observation gap, a source outage), so `reason` is its own code, not a guess.
 * It is not the time a report stopped being current, and it says nothing about a report requested after it.
 */
export function watermarkNote(report: V5TaskReport | undefined, nowMs: number) {
  const watermark = report?.validity_watermark;
  if (!watermark || report?.status === "CURRENT_REPORT" || !publishedTimestamp(watermark.watermark_ms)) return null;
  const requested = report?.record?.result?.requested_at_ms;
  const at = clock(watermark.watermark_ms, nowMs);
  const applies = publishedTimestamp(requested) ? requested <= watermark.watermark_ms : null;
  return {
    label: "Owner validity cutoff",
    value: `${at} · ${watermark.reason} · reports requested at or before this time cannot be current`
      + (applies === false ? ". This report was requested after it, so the cutoff is not why it is not current" : applies === null ? ". The request time of this report is not published" : ""),
  };
}

export function scheduledAgentLines(read: WorkspaceRead, nowMs = Date.now()) {
  const availability = advisorAvailability(read);
  // A failed read shows nothing from an earlier one: the line says the advisor was not read.
  const advisor = read.isError ? undefined : read.data?.advisor;
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
    const nextRun = scheduler?.next_run_by_task?.[role.taskId];
    const schedule = publishedTimestamp(nextRun) ? (nextRun > nowMs ? `next run ~${clock(nextRun, nowMs)}` : `next run was due ${clock(nextRun, nowMs)}`) : "schedule not published";
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
    } else if (latest?.status === "HISTORICAL_REPORT") {
      state = "Historical · not current";
      reason = "The owner published this report as HISTORICAL_REPORT: it is not the current report. Its published expiry is shown separately.";
    } else if (report?.status === "ACCEPTED" && expired) {
      state = `Expired ${elapsedTime(nowMs - expiry)} ago · ${schedule}`;
      reason = "The owner's published report expiry has passed. Expiry alone is not a run failure.";
    } else if (scheduler?.enabled === true) {
      reason = "Owner shared scheduler enabled: true.";
      if (profile?.enabled === true && report?.status === "ACCEPTED" && latest?.status === "CURRENT_REPORT" && received !== null && expiry !== null && Number.isFinite(nowMs) && nowMs >= received) {
        state = `Current until ${clock(expiry, nowMs)}`;
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
      schedule,
      conclusion: reportConclusion(latest),
    };
  });
}
