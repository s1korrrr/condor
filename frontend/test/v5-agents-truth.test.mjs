import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { frontendModules } from "./helpers/frontend-module.mjs";
import * as agentStatus from "../src/v5/agent-status.ts";

// Namespace import: on a base without these exports each test fails on its own, not the whole file.
const { scheduledAgentLines, watermarkNote } = agentStatus;

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

// One module graph for the whole scenario; the mocked query read can change between renders.
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
  return { env, render, load };
}

const failedRead = taskId => {
  const data = workspace();
  data.advisor.latest_by_task[taskId] = noReport(taskId);
  data.source_error = `latest_${taskId}:upstream_timeout`;
  return { data };
};

for (const taskId of tasks) {
  test(`${taskId}: a failed advisor read says "Not read", holds no earlier report, and recovers on the next read`, context => {
    context.mock.method(Date, "now", () => now);
    const { env, render } = pageEnv({ data: workspace() }, roles[taskId]);
    assert.match(render("AgentDetailPage"), new RegExp(`${taskId} says wait`));
    env.read = failedRead(taskId);
    const html = render("AgentDetailPage");
    assert.match(html, /Not read: upstream_timeout · Source: \/v1\/advice\/status/);
    assert.doesNotMatch(html, new RegExp(`${taskId} says wait`));
    assert.doesNotMatch(html, /Last known|LAST KNOWN|Refresh failed|refresh failed|Published expiry|published expiry|No report is available|has published no report/);
    assert.doesNotMatch(html, /Current until/);
    env.read = { data: workspace() };
    assert.match(render("AgentDetailPage"), new RegExp(`${taskId} says wait`));
    assert.doesNotMatch(render("AgentDetailPage"), /Not read: upstream_timeout/);
  });
}

test("a failed workspace refresh keeps no report on the Agents, detail and Overview views", context => {
  context.mock.method(Date, "now", () => now);
  const { env, render } = pageEnv({ data: workspace() });
  assert.match(render("AgentDetailPage"), /market_context says wait/);
  // react-query keeps the last data on a failed refresh; the pages must not show it.
  env.read = { data: workspace(), isError: true, error: new Error("503") };
  const detail = render("AgentDetailPage");
  assert.match(detail, /Not read: 503 · Source: \/api\/v5\/workspace/);
  assert.doesNotMatch(detail, /market_context says wait|Current until|Last report: <time/);
  assert.doesNotMatch(detail, /Last known|LAST KNOWN|Refresh failed|refresh failed|Published expiry|published expiry/);
  const catalog = render("AgentsPage");
  assert.match(catalog, /Data is unavailable/);
  assert.doesNotMatch(catalog, /says wait|Current until|v5-agent-catalog/);
  const overview = render("AgentConclusions", "v5/AgentConclusions.tsx");
  assert.match(overview, /Not read: 503\. <button[^>]*>Refresh<\/button>/);
  assert.doesNotMatch(overview, /says wait|Current until|As read at|<q>/);
  env.read = { data: workspace() };
  assert.match(render("AgentDetailPage"), /Current until 12:13:00 UTC/);
});

test("a failed read says it was not read, never that no report exists", context => {
  context.mock.method(Date, "now", () => now);
  const { render } = pageEnv(failedRead("market_context"));
  const html = render("AgentDetailPage");
  assert.match(html, /Not read: upstream_timeout/);
  assert.doesNotMatch(html, /No report is available|has published no report/);
});

test("an owner that publishes no report is reported as exactly that", context => {
  context.mock.method(Date, "now", () => now);
  const data = workspace();
  data.advisor.latest_by_task.market_context = noReport("market_context");
  const html = pageEnv({ data }).render("AgentDetailPage");
  assert.match(html, /The owner has published no report for this task/);
  assert.doesNotMatch(html, /Not read:/);
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

test("the owner validity cutoff is inclusive and is not called a source-change mark", () => {
  const nov21 = Date.UTC(2026, 10, 21, 12, 30);
  const reportAt = Date.UTC(2026, 10, 21, 11, 50);
  const mark = { watermark_ms: Date.UTC(2026, 10, 18, 9), reason: "CHANGED:source_scope" };
  const after = { ...goodReport("market_context", { requested_at_ms: reportAt, received_at_ms: reportAt + 5000 }), status: "HISTORICAL_REPORT", validity_watermark: mark };
  const note = watermarkNote(after, nov21);
  assert.equal(note.label, "Owner validity cutoff");
  assert.match(note.value, /^2026-11-18 09:00:00 UTC · CHANGED:source_scope · reports requested at or before this time cannot be current/);
  assert.match(note.value, /This report was requested after it, so the cutoff is not why it is not current/);
  assert.doesNotMatch(JSON.stringify(note), /Not current since|source-change/i);
  const requestedAt = ms => ({ ...after, record: { result: { ...after.record.result, requested_at_ms: ms } } });
  // The owner rejects a request made at or before the cutoff: at the cutoff the cutoff may well be the reason.
  assert.doesNotMatch(watermarkNote(requestedAt(mark.watermark_ms), nov21).value, /not why it is not current/);
  assert.doesNotMatch(watermarkNote(requestedAt(mark.watermark_ms - 1), nov21).value, /not why it is not current/);
  assert.match(watermarkNote(requestedAt(mark.watermark_ms + 1), nov21).value, /not why it is not current/);
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
  assert.match(html, /Owner validity cutoff/);
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

test("the Overview agent block shows what the Agents views read, as read at, and never reads by itself", context => {
  context.mock.method(Date, "now", () => now);
  const refetches = [];
  const { env, render } = pageEnv({ data: workspace(), dataUpdatedAt: now, refetch: () => refetches.push("read") });
  const block = () => render("AgentConclusions", "v5/AgentConclusions.tsx");
  let html = block();
  assert.match(html, /aria-label="Agent conclusions"/);
  assert.match(html, /advisor.{1,6}s own display text for its latest report\. No bot reads it/);
  assert.match(html, /As read at 2026-11-15 12:00:00 UTC · <button[^>]*>Refresh<\/button>/);
  for (const taskId of tasks) {
    assert.match(html, new RegExp(`<q>CAUTION — ${taskId} says wait</q>`));
    assert.match(html, /<strong>Current until 12:13:00 UTC<\/strong> · report 11:58:00 UTC \(2m 0s ago\)/);
  }
  const data = workspace();
  data.advisor.latest_by_task.source_quality.record.result.advice = undefined;
  env.read = { data, dataUpdatedAt: now, refetch: env.read.refetch };
  assert.match(block(), /conclusion not published/);
  env.read = { data: workspace(), isError: true, error: new Error("503"), refetch: env.read.refetch };
  html = block();
  assert.match(html, /Not read: 503\. <button[^>]*>Refresh<\/button>/);
  assert.doesNotMatch(html, /says wait|Current until|As read at|<q>/);
  // Nothing cached yet: no read is made, the page points at Agents and offers one read on request.
  env.read = { isPending: true, refetch: env.read.refetch };
  html = block();
  assert.match(html, /Open <a href="\/agents">Agents<\/a> to read the latest reports\. <button[^>]*>Read now<\/button>/);
  assert.doesNotMatch(html, /Reading the agent reports|As read at/);
  env.read = { isPending: true, isFetching: true, refetch: env.read.refetch };
  assert.match(block(), /Reading the agent reports/);
  env.read = { isError: true, error: new Error("offline"), refetch: env.read.refetch };
  assert.match(block(), /Not read: offline\. <button[^>]*>Read now<\/button>/);
  assert.deepEqual(refetches, []);
});

test("mounting the Overview agent block makes no workspace read, and Refresh makes exactly one", async context => {
  context.mock.method(Date, "now", () => now);
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const browser = new EventTarget();
  const intervals = new Map();
  let nextInterval = 0;
  browser.setInterval = (callback, delay) => { intervals.set(++nextInterval, { callback, delay }); return nextInterval; };
  browser.clearInterval = timer => intervals.delete(timer);
  globalThis.window = browser;
  globalThis.document = new EventTarget();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { act, create } = await import("react-test-renderer");
  // The same CommonJS build the page modules load, so provider and hooks share one context.
  const { QueryClient, QueryClientProvider } = createRequire(import.meta.url)("@tanstack/react-query");
  let reads = 0;
  const { load } = frontendModules({
    "./api": { v5Api: { workspace: async () => { reads++; return workspace(); } } },
    "react-router-dom": { NavLink: ({ to, children }) => React.createElement("a", { href: to }, children) },
  });
  const { AgentConclusions } = load("v5/AgentConclusions.tsx");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const text = node => typeof node === "string" ? node : node.children.map(text).join("");
  let renderer;
  try {
    context.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    await act(async () => { renderer = create(React.createElement(QueryClientProvider, { client }, React.createElement(AgentConclusions))); });
    // The Overview's old poll fired on mount and every 60 s; a minute and a half of foreground time must read nothing.
    await act(async () => { context.mock.timers.tick(150_000); for (const { callback, delay } of intervals.values()) if (delay <= 2000) callback(); });
    assert.equal(reads, 0);
    assert.match(text(renderer.root), /Open Agents to read the latest reports\. Read now/);
    // What the Agents views cached is shown as read at its time, still without a read of its own.
    // react-query notifies observers on a zero-delay timer, which the mocked clock only runs when ticked.
    await act(async () => { client.setQueryData(["v5-workspace"], workspace()); context.mock.timers.tick(10); });
    assert.match(text(renderer.root), /As read at 2026-11-15 12:00:00 UTC · Refresh/);
    assert.match(text(renderer.root), /market_context says wait/);
    await act(async () => { context.mock.timers.tick(150_000); });
    assert.equal(reads, 0);
    await act(async () => { renderer.root.findByType("button").props.onClick(); context.mock.timers.tick(10); });
    assert.equal(reads, 1);
  } finally {
    await act(async () => renderer?.unmount());
    context.mock.timers.reset();
    client.clear();
    for (const [key, name] of [["window", "window"], ["document", "document"], ["act", "IS_REACT_ACT_ENVIRONMENT"]]) {
      if (previous[key] === undefined) delete globalThis[name]; else globalThis[name] = previous[key];
    }
  }
});

test("an owner-published HISTORICAL_REPORT is named on the catalog, the detail and the Overview, never 'State not published'", context => {
  context.mock.method(Date, "now", () => now);
  const data = workspace();
  for (const task of tasks) data.advisor.latest_by_task[task] = { ...goodReport(task), status: "HISTORICAL_REPORT", validity_watermark: { watermark_ms: now - 60_000, reason: "CHANGED:source_scope" } };
  const lines = scheduledAgentLines({ data }, now);
  for (const line of lines) assert.equal(line.state, "Historical · not current");
  const { render } = pageEnv({ data, dataUpdatedAt: now });
  const catalog = render("AgentsPage").match(/<div class="v5-agent-catalog">[\s\S]*<\/div><\/div>/)[0];
  assert.equal((catalog.match(/Historical · not current/g) || []).length, 3);
  assert.doesNotMatch(catalog, /State not published|>Ready</);
  assert.match(render("AgentDetailPage"), /Historical · not current/);
  const overview = render("AgentConclusions", "v5/AgentConclusions.tsx");
  assert.match(overview, /<strong>Historical · not current<\/strong>[^<]*(?:<[^q][^>]*>[^<]*)*<q>CAUTION — market_context says wait<\/q>/);
  assert.doesNotMatch(overview, /State not published|Current until/);
});

test("a decision review the dashboard never asked for says so, not that the owner published nothing", context => {
  context.mock.method(Date, "now", () => now);
  const data = workspace();
  delete data.advisor.latest_by_task.decision_review;
  const html = pageEnv({ data, dataUpdatedAt: now }, "decision_reviewer").render("AgentDetailPage");
  assert.match(html, /not requested: no paper status file/);
  assert.doesNotMatch(html, /has published no report/);
  // A task the owner was asked about and answered "none" for still says exactly that.
  data.advisor.latest_by_task.decision_review = noReport("decision_review");
  assert.match(pageEnv({ data, dataUpdatedAt: now }, "decision_reviewer").render("AgentDetailPage"), /The owner has published no report for this task/);
});
