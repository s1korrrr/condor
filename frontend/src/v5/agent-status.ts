import type { V5TaskReport, V5Workspace } from "./contracts";

export interface WorkspaceRead {
  data?: V5Workspace;
  isPending?: boolean;
  isError?: boolean;
  error?: Error | null;
  /** react-query's own stamps for the last good and the last failed read; they only date "refresh failed at". */
  dataUpdatedAt?: number;
  errorUpdatedAt?: number;
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

export const scheduledTaskIds = ["market_context", "source_quality", "decision_review"] as const;

const scheduledRoles = [
  { id: "market_analyst", taskId: "market_context", name: "Market analyst" },
  { id: "source_auditor", taskId: "source_quality", name: "Source auditor" },
  { id: "decision_reviewer", taskId: "decision_review", name: "Decision reviewer" },
] as const;

const failedReports = new Set(["REJECTED", "NOT_SENT", "UNKNOWN_CHARGE", "CANCELLED_UNKNOWN_CHARGE", "LATE_OR_CLOCK_INVALID"]);

function publishedTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000;
}

/** A report the dashboard can show and date: an object result for this task with a published receive time. */
export function usableReport(report: unknown, taskId: string): report is V5TaskReport {
  if (!isRecord(report) || !isRecord(report.record)) return false;
  const result = report.record.result;
  return isRecord(result) && result.task_id === taskId && publishedTimestamp(result.received_at_ms);
}

/**
 * The last good report per role, held in this browser tab, and when each role's read last failed.
 * It only bridges a failed read: an owner-published "no report" clears it, so an old report is never resurrected.
 */
export interface ReportStore { good: Map<string, V5TaskReport>; failedAt: Map<string, number> }
export const createReportStore = (): ReportStore => ({ good: new Map(), failedAt: new Map() });
export const agentReportStore = createReportStore();

export interface RetainedReports {
  /** What to show per role: the owner's current report, or the last good one while a read is failing. */
  reports: Record<string, V5TaskReport | undefined>;
  /** Roles whose advisor read failed, with the dashboard's time of that failed read. */
  failedAt: Record<string, number>;
}

/** The role's report read failed; a failing advisor status read only counts when there is no current report to show. */
function roleReadFailed(read: WorkspaceRead, taskId: string, usable: boolean) {
  if (read.isError) return true;
  const errors = typeof read.data?.source_error === "string" ? read.data.source_error.split(";") : [];
  return errors.some(value => value.startsWith(`latest_${taskId}:`) || (!usable && value.startsWith("advisor:")));
}

/** Called while rendering; it only records facts about reads already made and is safe to repeat. */
export function retainReports(store: ReportStore, read: WorkspaceRead, nowMs: number): RetainedReports {
  const advisor = read.data?.advisor;
  const latest: Record<string, unknown> = isRecord(advisor) && isRecord(advisor.latest_by_task) ? advisor.latest_by_task : {};
  const reports: RetainedReports["reports"] = {};
  const failedAt: Record<string, number> = {};
  // Still loading the first read: nothing is known yet, and what is held must survive until it answers.
  if (!read.data && !read.isError) return { reports, failedAt };
  for (const taskId of scheduledTaskIds) {
    const current = latest[taskId];
    const usable = usableReport(current, taskId);
    const failed = roleReadFailed(read, taskId, usable);
    const held = store.good.get(taskId);
    if (usable && (!held || (held.record?.result?.received_at_ms ?? 0) <= (current.record?.result?.received_at_ms ?? 0))) store.good.set(taskId, current);
    if (!failed) {
      if (!usable && read.data) store.good.delete(taskId);
      store.failedAt.delete(taskId);
      reports[taskId] = current as V5TaskReport | undefined;
      continue;
    }
    const stamp = read.isError ? read.errorUpdatedAt : read.dataUpdatedAt;
    const at = publishedTimestamp(stamp) ? stamp : store.failedAt.get(taskId) ?? nowMs;
    store.failedAt.set(taskId, at);
    failedAt[taskId] = at;
    reports[taskId] = usable ? current : store.good.get(taskId) ?? (current as V5TaskReport | undefined);
  }
  return { reports, failedAt };
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
 * What a source-change watermark means: reports requested before it cannot be current. It is not the time a report
 * stopped being current, and it says nothing about a report requested after it.
 */
export function watermarkNote(report: V5TaskReport | undefined, nowMs: number) {
  const watermark = report?.validity_watermark;
  if (!watermark || report?.status === "CURRENT_REPORT" || !publishedTimestamp(watermark.watermark_ms)) return null;
  const requested = report?.record?.result?.requested_at_ms;
  const at = clock(watermark.watermark_ms, nowMs);
  const applies = publishedTimestamp(requested) ? requested < watermark.watermark_ms : null;
  return {
    label: "Owner source-change mark",
    value: `${at} · ${watermark.reason} · reports requested before this time cannot be current`
      + (applies === false ? ". This report was requested after it, so the mark is not why it is not current" : applies === null ? ". The request time of this report is not published" : ""),
  };
}

export function scheduledAgentLines(read: WorkspaceRead, nowMs = Date.now(), retained?: RetainedReports) {
  const availability = advisorAvailability(read);
  const advisor = read.data?.advisor;
  const scheduler = advisor?.scheduler;
  return scheduledRoles.map(role => {
    const agent = Array.isArray(read.data?.agents) ? read.data.agents.find(value => isRecord(value) && value.id === role.id) : undefined;
    const profile = advisorTaskProfile(read, role.taskId);
    const latest = retained?.reports[role.taskId] ?? advisor?.latest_by_task?.[role.taskId];
    const result = latest?.record?.result;
    const malformedReport = latest != null && (!isRecord(latest) || (latest.record != null && !isRecord(result)) || (latest.status === "CURRENT_REPORT" && !isRecord(result)));
    const report = isRecord(result) && latest?.task_id === role.taskId && result.task_id === role.taskId ? result : undefined;
    const received = publishedTimestamp(report?.received_at_ms) ? report.received_at_ms : null;
    const expiry = publishedTimestamp(report?.expires_at_ms) ? report.expires_at_ms : null;
    const expired = expiry !== null && Number.isFinite(nowMs) && nowMs >= expiry;
    const failure = sourceFailure(read, `latest_${role.taskId}`) || sourceFailure(read, "task_profiles");
    // A failing read keeps the last good report: the validity below is that report's own, marked with the failure.
    const refreshFailed = retained?.failedAt[role.taskId];
    const held = refreshFailed !== undefined && received !== null;
    const roleFailure = sourceFailure(read, `latest_${role.taskId}`);
    const nextRun = scheduler?.next_run_by_task?.[role.taskId];
    const schedule = publishedTimestamp(nextRun) ? (nextRun > nowMs ? `next run ~${clock(nextRun, nowMs)}` : `next run was due ${clock(nextRun, nowMs)}`) : "schedule not published";
    let state = "State not published";
    let reason = "Owner scheduling state is not published.";
    if (availability.state !== "enabled" && !(held && availability.state === "upstream_error")) {
      state = availability.state === "disabled" ? "Disabled" : availability.state === "loading" ? "Loading" : availability.state === "upstream_error" ? "Upstream error" : "Unavailable";
      reason = availability.message;
    } else if (failure && !(held && !sourceFailure(read, "task_profiles"))) {
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
      state = `Expired ${elapsedTime(nowMs - expiry)} ago · ${schedule}`;
      reason = "The owner's published report expiry has passed. Expiry alone is not a run failure.";
    } else if (scheduler?.enabled === true) {
      reason = "Owner shared scheduler enabled: true.";
      if (profile?.enabled === true && report?.status === "ACCEPTED" && latest?.status === "CURRENT_REPORT" && received !== null && expiry !== null && Number.isFinite(nowMs) && nowMs >= received) {
        state = `Current until ${clock(expiry, nowMs)}`;
      }
      if (scheduler.task_id === role.taskId && scheduler.last_status) reason += ` Last scheduler status: ${scheduler.last_status}.`;
    }
    if (refreshFailed !== undefined) {
      const why = roleFailure ? `${roleFailure} · Source: /v1/advice/status` : availability.state === "upstream_error" ? availability.message.replace(/^Advisor state not read: /, "") : "advisor read failed";
      reason = held ? `Refresh failed at ${utcTime(refreshFailed)} (${why}); showing the last good report. ${reason}` : `Refresh failed at ${utcTime(refreshFailed)} (${why}); no earlier report is held in this tab. ${reason}`;
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
      refreshFailedAt: refreshFailed === undefined ? null : new Date(refreshFailed).toISOString(),
      conclusion: reportConclusion(latest),
    };
  });
}
