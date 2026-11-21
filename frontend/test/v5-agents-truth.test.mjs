import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { frontendModules } from "./helpers/frontend-module.mjs";
import * as agentStatus from "../src/v5/agent-status.ts";

// Namespace import: on a base without these exports each test fails on its own, not the whole file.
const { createReportStore, retainReports, scheduledAgentLines, usableReport, watermarkNote } = agentStatus;

const now = Date.UTC(2026, 10, 15, 12);
const tasks = ["market_context", "source_quality", "decision_review"];
const roles = { market_context: "market_analyst", source_quality: "source_auditor", decision_review: "decision_reviewer" };

const agentFor = taskId => ({
  id: roles[taskId], name: roles[taskId].replace("_", " "), description: "Reports", task_id: taskId, model: null, mode: "reports-only",
  status: "ready", blockers: [], tools: [], loops: [], skills: [], playbook: "", notes: "",
  policy: { allowed_tools: [], execution_enabled: false, empty_allowlist_means: "deny_all" },
});

const goodReport = (taskId, result = {}) => ({
  task_id: taskId, status: "CURRENT_REPORT", effect: "NONE",
  record: { request_id: `request-${taskId}`, result: {
    task_id: taskId, status: "ACCEPTED", requested_at_ms: now - 130_000, received_at_ms: now - 120_000, expires_at_ms: now + 780_000,
    advice: { assessment: "CAUTION", summary: `${taskId} says wait` }, ...result,
  } },
});
const noReport = taskId => ({ task_id: taskId, status: "UNAVAILABLE", effect: "NONE", record: null });

function workspace() {
  return {
    schema_version: "v5-workspace.v1",
    identity: { name: "RSI V5", host: "razer", mode: "reports-only", execution_enabled: false, baseline_binding: null },
    context: null, agents: tasks.map(agentFor), sessions: [], source_error: null,
    advisor: {
      enabled: true, model: null,
      task_profiles: tasks.map(task_id => ({ task_id, enabled: true, model: "owner-model" })),
      scheduler: { enabled: true, task_id: "market_context", last_status: "NOT_DUE" },
      latest_by_task: Object.fromEntries(tasks.map(task => [task, goodReport(task)])),
    },
  };
}

// One module graph for the whole scenario, so the tab's held reports survive between renders like a real session.
function pageEnv(read, id = "market_analyst") {
  const env = { read, id };
  const link = ({ to, children, ...props }) => React.createElement("a", { href: to, ...props }, children);
  const { load } = frontendModules({
    "@tanstack/react-query": {
      useQuery: ({ queryKey }) => queryKey[0] === "v5-agent" ? { data: agentFor(tasks.find(task => roles[task] === env.id)) } : env.read,
      useQueryClient: () => ({}), useMutation: () => ({ mutate() {}, isPending: false }),
    },
    "react-router-dom": { Link: link, NavLink: link, useNavigate: () => () => {}, useParams: () => ({ id: env.id }) },
    "react-markdown": {},
  });
  const render = (name, module = "v5/V5Pages.tsx") => renderToStaticMarkup(React.createElement(load(module)[name]));
  return { env, render };
}

const failedRead = (taskId, extra = {}) => {
  const data = workspace();
  data.advisor.latest_by_task[taskId] = noReport(taskId);
  data.source_error = `latest_${taskId}:upstream_timeout`;
  return { data, dataUpdatedAt: now - 1000, ...extra };
};

for (const taskId of tasks) {
  test(`${taskId}: one failed advisor read keeps the last good report, then recovers`, context => {
    context.mock.method(Date, "now", () => now);
    const { env, render } = pageEnv({ data: workspace(), dataUpdatedAt: now - 31_000 }, roles[taskId]);
    assert.match(render("AgentDetailPage"), new RegExp(`${taskId} says wait`));
    env.read = failedRead(taskId);
    const html = render("AgentDetailPage");
    assert.match(html, /Refresh failed at 2026-11-15 11:59:59 UTC/);
    assert.match(html, /Showing the last good report below/);
    assert.match(html, new RegExp(`${taskId} says wait`));
    assert.match(html, /Current until 12:13:00 UTC/);
    assert.doesNotMatch(html, /No report is available|has published no report|Not read:/);
    env.read = { data: workspace(), dataUpdatedAt: now };
    assert.doesNotMatch(render("AgentDetailPage"), /Refresh failed/);
  });
}

test("a failed workspace read after a good one keeps the report on the detail page and the catalog", context => {
  context.mock.method(Date, "now", () => now);
  const { env, render } = pageEnv({ data: workspace() });
  render("AgentDetailPage");
  env.read = { data: workspace(), isError: true, error: new Error("503"), errorUpdatedAt: now - 2000 };
  let html = render("AgentDetailPage");
  assert.match(html, /Refresh failed at 2026-11-15 11:59:58 UTC/);
  assert.match(html, /market_context says wait/);
  html = render("AgentsPage");
  assert.match(html, /Refresh failed: 503\. Showing the last read\./);
  assert.match(html, /Scheduled agents/);
  assert.match(html, /v5-agent-catalog/);
  // The read no longer has data at all: the held report is still the one shown.
  env.read = { isError: true, error: new Error("503"), errorUpdatedAt: now - 2000 };
  html = render("AgentDetailPage");
  assert.match(html, /market_context says wait/);
  assert.match(html, /Refresh failed at 2026-11-15 11:59:58 UTC/);
});

test("a failed read with no earlier report says it was not read, never that no report exists", context => {
  context.mock.method(Date, "now", () => now);
  const { render } = pageEnv(failedRead("market_context"));
  const html = render("AgentDetailPage");
  assert.match(html, /Not read: the advisor read failed, so this page cannot say whether a report exists/);
  assert.match(html, /No earlier report is held in this tab/);
  assert.doesNotMatch(html, /No report is available|has published no report/);
});

test("an owner that publishes no report is reported as exactly that", context => {
  context.mock.method(Date, "now", () => now);
  const data = workspace();
  data.advisor.latest_by_task.market_context = noReport("market_context");
  const html = pageEnv({ data }).render("AgentDetailPage");
  assert.match(html, /The owner has published no report for this task/);
  assert.doesNotMatch(html, /Refresh failed|Not read:/);
});

test("retention: only a failed read is bridged, an owner-published none or a status failure alone is not", () => {
  const store = createReportStore();
  const good = { data: workspace(), dataUpdatedAt: now - 60_000 };
  assert.deepEqual(retainReports(store, good, now).failedAt, {});
  // Loading holds the store as it is.
  assert.deepEqual(retainReports(store, { isPending: true }, now).reports, {});
  // The advisor status read failing does not mark a role whose report was read and is current.
  const statusOnly = workspace();
  statusOnly.source_error = "advisor:upstream_timeout";
  assert.deepEqual(retainReports(store, { data: statusOnly, dataUpdatedAt: now }, now).failedAt, {});
  // A failed read for one role bridges only that role, stamped with the read's own time.
  const bridged = retainReports(store, failedRead("source_quality"), now);
  assert.deepEqual(Object.keys(bridged.failedAt), ["source_quality"]);
  assert.equal(bridged.failedAt.source_quality, now - 1000);
  assert.equal(bridged.reports.source_quality.record.result.advice.summary, "source_quality says wait");
  assert.equal(usableReport(bridged.reports.market_context, "market_context"), true);
  // The owner publishing "no report" with no failure clears the held one.
  const none = workspace();
  none.advisor.latest_by_task.source_quality = noReport("source_quality");
  const cleared = retainReports(store, { data: none }, now);
  assert.deepEqual(cleared.failedAt, {});
  assert.equal(cleared.reports.source_quality.record, null);
  assert.equal(retainReports(store, failedRead("source_quality"), now).reports.source_quality.record, null);
});

test("retention: the status of a failing read cannot move a role onto another role's report", () => {
  const store = createReportStore();
  retainReports(store, { data: workspace() }, now);
  const swapped = failedRead("source_quality");
  swapped.data.advisor.latest_by_task.source_quality = goodReport("market_context");
  const kept = retainReports(store, swapped, now);
  assert.equal(kept.reports.source_quality.record.result.task_id, "source_quality");
});

test("catalog state comes from report validity: current, expired with an unpublished schedule, expired with a published one", context => {
  context.mock.method(Date, "now", () => now);
  const data = workspace();
  data.advisor.latest_by_task.market_context.record.result.expires_at_ms = now - 300_000;
  const html = pageEnv({ data }).render("AgentsPage");
  const catalog = html.match(/<div class="v5-agent-catalog">[\s\S]*<\/div><\/div>/)?.[0] ?? html;
  assert.match(catalog, /is-unknown"><i><\/i>Expired 5m 0s ago · schedule not published</);
  assert.match(catalog, /is-ready"><i><\/i>Current until 12:13:00 UTC</);
  assert.doesNotMatch(catalog, />Ready</);
  const lines = scheduledAgentLines({ data }, now);
  assert.equal(lines[0].state, "Expired 5m 0s ago · schedule not published");
  data.advisor.scheduler.next_run_by_task = { market_context: now + 600_000, source_quality: now - 60_000 };
  data.advisor.latest_by_task.source_quality.record.result.expires_at_ms = now - 1000;
  const published = scheduledAgentLines({ data }, now);
  assert.equal(published[0].state, "Expired 5m 0s ago · next run ~12:10:00 UTC");
  assert.equal(published[1].state, "Expired 1s ago · next run was due 11:59:00 UTC");
  assert.equal(published[2].state, "Current until 12:13:00 UTC");
});

test("a blocked agent stays Blocked and an agent without a schedule line keeps its readiness label", context => {
  context.mock.method(Date, "now", () => now);
  const data = workspace();
  data.agents[1] = { ...data.agents[1], status: "blocked", blockers: ["task_disabled"] };
  data.agents.push({ ...agentFor("market_context"), id: "other_role", name: "Other role", task_id: "other_task" });
  const html = pageEnv({ data }).render("AgentsPage");
  assert.match(html, /is-blocked"><i><\/i>Blocked</);
  assert.match(html, /is-ready"><i><\/i>Ready</);
});

test("the detail header shows report validity, not Ready, for an expired report", context => {
  context.mock.method(Date, "now", () => now);
  const data = workspace();
  data.advisor.latest_by_task.market_context.record.result.expires_at_ms = now - 300_000;
  const html = pageEnv({ data }).render("AgentDetailPage");
  assert.match(html, /v5-page-heading[\s\S]*is-unknown"><i><\/i>Expired 5m 0s ago · schedule not published</);
  assert.doesNotMatch(html, />Ready</);
});

test("the source-change watermark is relabelled and never reads as a not-current time before the report", () => {
  const nov21 = Date.UTC(2026, 10, 21, 12, 30);
  const reportAt = Date.UTC(2026, 10, 21, 11, 50);
  const mark = { watermark_ms: Date.UTC(2026, 10, 18, 9), reason: "CHANGED:source_scope" };
  const after = { ...goodReport("market_context", { requested_at_ms: reportAt, received_at_ms: reportAt + 5000 }), status: "HISTORICAL_REPORT", validity_watermark: mark };
  const note = watermarkNote(after, nov21);
  assert.equal(note.label, "Owner source-change mark");
  assert.match(note.value, /^2026-11-18 09:00:00 UTC · CHANGED:source_scope · reports requested before this time cannot be current/);
  assert.match(note.value, /This report was requested after it, so the mark is not why it is not current/);
  assert.doesNotMatch(JSON.stringify(note), /Not current since/);
  const before = { ...after, record: { result: { ...after.record.result, requested_at_ms: mark.watermark_ms - 1 } } };
  assert.doesNotMatch(watermarkNote(before, nov21).value, /not why it is not current/);
  const unknown = { ...after, record: { result: { ...after.record.result, requested_at_ms: undefined } } };
  assert.match(watermarkNote(unknown, nov21).value, /request time of this report is not published/);
  assert.equal(watermarkNote({ ...after, status: "CURRENT_REPORT" }, nov21), null);
  assert.equal(watermarkNote({ ...after, validity_watermark: undefined }, nov21), null);
});

test("the agent page never prints Not current since for a report issued after the mark", context => {
  context.mock.method(Date, "now", () => now);
  const data = workspace();
  data.advisor.latest_by_task.market_context = { ...goodReport("market_context"), status: "HISTORICAL_REPORT", validity_watermark: { watermark_ms: now - 3 * 86_400_000, reason: "CHANGED:source_scope" } };
  const html = pageEnv({ data }).render("AgentDetailPage");
  assert.match(html, /Owner source-change mark/);
  assert.match(html, /2026-11-12 12:00:00 UTC · CHANGED:source_scope/);
  assert.doesNotMatch(html, /Not current since/);
});

test("the latest-reports list includes the decision reviewer", context => {
  context.mock.method(Date, "now", () => now);
  const html = pageEnv({ data: workspace() }).render("OverviewPage");
  for (const name of ["Market analyst", "Source auditor", "Decision reviewer"]) assert.match(html, new RegExp(`<h3>${name}</h3>`));
  assert.match(html, /decision_review says wait/);
});

test("each scheduled agent shows one advisor-text conclusion, or says it is not published", context => {
  context.mock.method(Date, "now", () => now);
  const data = workspace();
  data.advisor.latest_by_task.source_quality.record.result.advice = {};
  Object.assign(data.advisor.latest_by_task.decision_review.record.result, { status: "REJECTED", advice: undefined });
  const lines = scheduledAgentLines({ data }, now);
  assert.equal(lines[0].conclusion, "CAUTION — market_context says wait");
  assert.equal(lines[1].conclusion, null);
  assert.equal(lines[2].conclusion, null);
  const html = pageEnv({ data }).render("AgentsPage");
  assert.match(html, /Advisor display text, no bot reads it: <q>CAUTION — market_context says wait<\/q>/);
  assert.equal((html.match(/Advisor display text, no bot reads it: not published/g) || []).length, 2);
  const long = workspace();
  long.advisor.latest_by_task.market_context.record.result.advice = { assessment: "CAUTION", summary: "x".repeat(500) };
  const clipped = scheduledAgentLines({ data: long }, now)[0].conclusion;
  assert.equal(clipped.length, 200);
  assert.ok(clipped.endsWith("…"));
});

test("the Overview agent block names each agent's state, report time and conclusion", context => {
  context.mock.method(Date, "now", () => now);
  const { env, render } = pageEnv({ data: workspace(), dataUpdatedAt: now });
  const block = () => render("AgentConclusions", "v5/AgentConclusions.tsx");
  let html = block();
  assert.match(html, /aria-label="Agent conclusions"/);
  assert.match(html, /advisor.{1,6}s own display text for its latest report\. No bot reads it/);
  for (const taskId of tasks) {
    assert.match(html, new RegExp(`<q>CAUTION — ${taskId} says wait</q>`));
    assert.match(html, /<strong>Current until 12:13:00 UTC<\/strong> · report 11:58:00 UTC \(2m 0s ago\)/);
  }
  const data = workspace();
  data.advisor.latest_by_task.source_quality.record.result.advice = undefined;
  env.read = { data, dataUpdatedAt: now };
  assert.match(block(), /conclusion not published/);
  env.read = failedRead("market_context");
  html = block();
  assert.match(html, /refresh failed at 11:59:59 UTC/);
  assert.match(html, /<q>CAUTION — market_context says wait<\/q>/);
  env.read = { isPending: true };
  assert.match(block(), /Reading the agent reports/);
  env.read = { isError: true, error: new Error("offline") };
  assert.match(block(), /Agent reports unavailable: offline/);
});
