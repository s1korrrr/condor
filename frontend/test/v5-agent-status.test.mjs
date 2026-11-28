import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import { frontendModules } from "./helpers/frontend-module.mjs";
import { advisorAvailability, scheduledAgentLines } from "../src/v5/agent-status.ts";

const agent = {
  id: "market_analyst", name: "Market Analyst", description: "Market reports",
  task_id: "market_context", model: null, mode: "reports-only", status: "ready",
  blockers: [], tools: [], loops: [], skills: [], playbook: "", notes: "",
  policy: { allowed_tools: [], execution_enabled: false, empty_allowlist_means: "deny_all" },
};
const workspace = {
  identity: { mode: "reports-only", execution_enabled: false },
  agents: [agent], sessions: [], source_error: null,
  advisor: { task_profiles: [{ task_id: "market_context", enabled: true, model: "owner-model" }] },
};

function pageModules(read) {
  const { load } = frontendModules({
    "@tanstack/react-query": {
      useQuery: ({ queryKey }) => queryKey[0] === "v5-agent" ? { data: agent } : read,
      useQueryClient: () => ({}),
      useMutation: () => ({ mutate() {}, isPending: false }),
    },
    "react-router-dom": {
      Link: ({ to, children, ...props }) => React.createElement("a", { href: to, ...props }, children),
      useNavigate: () => () => {}, useParams: () => ({ id: agent.id }),
    },
    "react-markdown": {},
  });
  return load("v5/V5Pages.tsx");
}

function renderPage(page, read) {
  return renderToStaticMarkup(React.createElement(pageModules(read)[page]));
}

test("agent action calls the advisor disabled only on explicit owner false", () => {
  const html = renderPage("AgentDetailPage", { data: { ...workspace, advisor: { ...workspace.advisor, enabled: false } } });
  assert.match(html, /Advisor is disabled by the owner service/);
});

test("agent action distinguishes loading advisor evidence from disabled", () => {
  const html = renderPage("AgentDetailPage", { isPending: true });
  assert.match(html, /Advisor state not read: loading advisor evidence/);
  assert.doesNotMatch(html, /Advisor is disabled/);
});

test("agent action names missing owner evidence without claiming disabled", () => {
  const html = renderPage("AgentDetailPage", { data: workspace });
  assert.match(html, /Advisor state not read:.*enabled.*not published/);
  assert.doesNotMatch(html, /Advisor is disabled/);
});

test("agent action names upstream advisor error, reason and source endpoint", () => {
  const html = renderPage("AgentDetailPage", { data: { ...workspace, source_error: "advisor:upstream_timeout" } });
  assert.match(html, /Advisor state not read: upstream error:.*upstream_timeout.*\/v1\/advice\/status/);
  assert.doesNotMatch(html, /Advisor is disabled/);
});

const now = Date.UTC(2026, 10, 15, 12);
const tasks = ["market_context", "source_quality", "decision_review"];

function scheduledWorkspace() {
  return {
    ...structuredClone(workspace),
    advisor: {
      enabled: true,
      task_profiles: tasks.map(task_id => ({ task_id, enabled: true })),
      scheduler: { enabled: true, task_id: "market_context", last_status: "NOT_DUE" },
      latest_by_task: Object.fromEntries(tasks.map(task_id => [task_id, {
        task_id, status: "CURRENT_REPORT", record: { result: {
          task_id, status: "ACCEPTED", received_at_ms: now - 120_000, expires_at_ms: now + 1000,
        } },
      }])),
    },
  };
}

test("line model includes exactly the three scheduled roles, even when a catalog row is absent", () => {
  const data = scheduledWorkspace();
  data.agents.push({ ...agent, id: "unrelated_role", name: "Unrelated role" });
  const lines = scheduledAgentLines({ data }, now);
  assert.deepEqual(lines.map(line => line.id), ["market_analyst", "source_auditor", "decision_reviewer"]);
  assert.deepEqual(lines.map(line => line.taskId), tasks);
  assert.equal(lines[0].name, "Market Analyst");
  assert.equal(lines[2].name, "Decision reviewer");
});

test("enabled scheduler and recent accepted reports do not publish a role schedule", () => {
  const data = scheduledWorkspace();
  const lines = scheduledAgentLines({ data }, now);
  for (const line of lines) {
    assert.equal(line.state, "Current until 12:00:01 UTC");
    assert.match(line.reason, /Owner shared scheduler enabled: true/);
    assert.equal(line.schedule, "schedule not published");
    assert.doesNotMatch(JSON.stringify(line), /Running on schedule|Advisor config schedules|15-minute|45 min/);
  }
  assert.match(lines[0].reason, /NOT_DUE/);
  assert.doesNotMatch(lines[1].reason, /NOT_DUE/);
});

test("each line retains owner report state, UTC report time, age and current expiry", () => {
  for (const line of scheduledAgentLines({ data: scheduledWorkspace() }, now)) {
    assert.equal(line.reportStatus, "ACCEPTED");
    assert.equal(line.reportTime, "2026-11-15T11:58:00.000Z");
    assert.equal(line.reportAge, "2m 0s ago");
    assert.equal(line.expiry, "not expired");
  }
});

test("owner task false is disabled with the owner's reason, without disabling the other roles", () => {
  const data = scheduledWorkspace();
  data.advisor.task_profiles[1] = { task_id: "source_quality", enabled: false, reason: "PAID_REPORTS_DISABLED" };
  const lines = scheduledAgentLines({ data }, now);
  assert.equal(lines[1].state, "Disabled");
  assert.equal(lines[1].reason, "PAID_REPORTS_DISABLED");
  assert.notEqual(lines[0].state, "Disabled");
  assert.notEqual(lines[2].state, "Disabled");
});

test("explicit advisor false disables all roles without losing historical report times", () => {
  const data = scheduledWorkspace();
  data.advisor.enabled = false;
  for (const line of scheduledAgentLines({ data }, now)) {
    assert.equal(line.state, "Disabled");
    assert.equal(line.reportTime, "2026-11-15T11:58:00.000Z");
  }
});

test("explicit scheduler false means not scheduled, retaining the owner status", () => {
  const data = scheduledWorkspace();
  data.advisor.scheduler = { enabled: false, last_status: "DISABLED" };
  for (const line of scheduledAgentLines({ data }, now)) {
    assert.equal(line.state, "Not scheduled");
    assert.match(line.reason, /Owner scheduler enabled: false · DISABLED/);
  }
});

for (const status of ["REJECTED", "NOT_SENT", "UNKNOWN_CHARGE", "CANCELLED_UNKNOWN_CHARGE", "LATE_OR_CLOCK_INVALID"]) {
  test(`last run failed retains the owner's ${status} rather than inferring success`, () => {
    const data = scheduledWorkspace();
    Object.assign(data.advisor.latest_by_task.source_quality.record.result, { status, reason: "owner_reason", rejection: "schema:invalid" });
    const lines = scheduledAgentLines({ data }, now);
    assert.equal(lines[1].state, "Last run failed");
    assert.equal(lines[1].reason, `${status} · owner_reason · schema:invalid`);
    assert.equal(lines[1].reportStatus, status);
    assert.notEqual(lines[0].state, "Last run failed");
  });
}

test("missing task, scheduler, report and expiry stay not published, not disabled or expired", () => {
  const data = scheduledWorkspace();
  data.advisor.task_profiles = [];
  delete data.advisor.scheduler;
  delete data.advisor.latest_by_task;
  for (const line of scheduledAgentLines({ data }, now)) {
    assert.equal(line.state, "State not published");
    assert.equal(line.reportTime, null);
    assert.equal(line.reportAge, "age not published");
    assert.equal(line.reportStatus, "not published");
    assert.equal(line.expiry, "expiry not published");
    assert.equal(line.overdue, "overdue rule not published");
    assert.equal(line.schedule, "schedule not published");
  }
});

test("a report becomes expired exactly at its own published expiry, not at the loop recipe interval", () => {
  const data = scheduledWorkspace();
  data.agents[0].loops = [{ id: "monitor", frequency_sec: 1800, max_ticks: 48 }];
  const report = data.advisor.latest_by_task.market_context.record.result;
  report.received_at_ms = now - 4_000_000;
  report.expires_at_ms = now + 1;
  assert.equal(scheduledAgentLines({ data }, now)[0].expiry, "not expired");
  report.expires_at_ms = now;
  assert.equal(scheduledAgentLines({ data }, now)[0].expiry, "expired");
  report.expires_at_ms = now - 1;
  assert.equal(scheduledAgentLines({ data }, now)[0].expiry, "expired");
  delete report.expires_at_ms;
  assert.equal(scheduledAgentLines({ data }, now)[0].expiry, "expiry not published");
});

test("historical ACCEPTED reports are not promoted to current by an unexpired timestamp", () => {
  const data = scheduledWorkspace();
  data.advisor.latest_by_task.market_context.status = "HISTORICAL_REPORT";
  const line = scheduledAgentLines({ data }, now)[0];
  assert.equal(line.expiry, "not expired");
  assert.equal(line.state, "Historical · not current");
  assert.equal(line.reportState, "HISTORICAL_REPORT");
});

test("future and malformed report timestamps do not fabricate an age", () => {
  const data = scheduledWorkspace();
  const report = data.advisor.latest_by_task.market_context.record.result;
  report.received_at_ms = now + 1;
  assert.equal(scheduledAgentLines({ data }, now)[0].reportAge, "age unavailable (clock mismatch)");
  for (const timestamp of [null, true, "123", -1, NaN, Infinity, 1e20]) {
    report.received_at_ms = timestamp;
    report.expires_at_ms = timestamp;
    const line = scheduledAgentLines({ data }, now)[0];
    assert.equal(line.reportTime, null);
    assert.equal(line.expiry, "expiry not published");
  }
});

test("cross-task reports cannot supply another role's time, expiry or failure", () => {
  const data = scheduledWorkspace();
  data.advisor.latest_by_task.market_context.record.result.task_id = "source_quality";
  const line = scheduledAgentLines({ data }, now)[0];
  assert.equal(line.reportTime, null);
  assert.equal(line.expiry, "expiry not published");
});

test("per-task upstream errors affect only that line and retain the reason", () => {
  const data = scheduledWorkspace();
  data.source_error = "context:unavailable;latest_source_quality:upstream_timeout";
  const lines = scheduledAgentLines({ data }, now);
  assert.equal(lines[1].state, "Upstream error");
  assert.match(lines[1].reason, /upstream_timeout/);
  assert.notEqual(lines[0].state, "Upstream error");
});

test("workspace transport errors override stale enabled evidence and identify the workspace endpoint", () => {
  const read = { data: scheduledWorkspace(), isError: true, error: new Error("read failed") };
  const availability = advisorAvailability(read);
  assert.equal(availability.state, "upstream_error");
  assert.match(availability.message, /read failed.*\/api\/v5\/workspace/);
  const html = renderPage("AgentDetailPage", read);
  assert.match(html, /disabled=""[^>]*>.*?Request report/);
  assert.match(html, /Advisor state not read: upstream error:/);
  assert.doesNotMatch(html, /Bounded to owner-model/);
});

test("embedded advisor errors override stale explicit true or false without a false disabled claim", () => {
  for (const enabled of [true, false]) {
    const data = scheduledWorkspace();
    Object.assign(data.advisor, { enabled });
    data.source_error = "advisor:upstream_timeout";
    const html = renderPage("AgentDetailPage", { data });
    assert.match(html, /Advisor state not read: upstream error:.*upstream_timeout.*\/v1\/advice\/status/);
    assert.doesNotMatch(html, /Advisor is disabled|Bounded to/);
  }
});

test("the actual catalog renders owner times and expiry with unpublished schedule and overdue policy", context => {
  context.mock.method(Date, "now", () => now);
  const data = scheduledWorkspace();
  data.advisor.latest_by_task.source_quality.record.result.expires_at_ms = 1;
  const html = renderPage("AgentsPage", { data });
  const section = html.match(/<section[^>]*aria-label="Scheduled agents"[\s\S]*?<\/section>/)?.[0];
  assert.ok(section);
  assert.equal((section.match(/<a /g) || []).length, 3);
  assert.match(section, /2026-11-15 11:58:00.000 UTC/);
  assert.match(section, /ago/);
  assert.match(section, / · expired · /);
  // Three role lines, plus the one expired role whose state names its unpublished schedule.
  assert.equal((section.match(/schedule not published/g) || []).length, 4);
  assert.equal((section.match(/overdue rule not published/g) || []).length, 3);
  assert.doesNotMatch(section, /Schedule \(advisor config\)|Running on schedule|15-minute|45 min|60 min/);
  assert.ok(html.indexOf(section) < html.indexOf('class="v5-agent-catalog"'));
});

test("a 61-minute-old report with future owner expiry has no inferred overdue or second expiry", context => {
  context.mock.method(Date, "now", () => now);
  const data = scheduledWorkspace();
  const report = data.advisor.latest_by_task.market_context.record.result;
  report.received_at_ms = now - 61 * 60_000;
  report.expires_at_ms = now + 30 * 60_000;
  const line = scheduledAgentLines({ data }, now)[0];
  assert.equal(line.expiry, "not expired");
  assert.equal(line.reportAge, "1h 1m ago");
  assert.equal(line.overdue, "overdue rule not published");
  assert.notEqual(line.state, "Overdue");
  assert.equal(Object.hasOwn(line, "scheduleExpiry"), false);
  assert.doesNotMatch(JSON.stringify(line), /configured 45 min|60 min|Awaiting next report/);
  const html = renderPage("AgentDetailPage", { data });
  const section = html.match(/<section[^>]*aria-label="Scheduled agents"[\s\S]*?<\/section>/)?.[0];
  assert.ok(section);
  assert.match(section, /1h 1m ago/);
  assert.match(section, /overdue rule not published/);
  assert.equal((section.match(/expired/g) || []).length, 1);
  assert.doesNotMatch(section, /Overdue| · expired · |configured 45 min|60 min/);
});

test("old reports retain observed ages without an overdue verdict for failed or disabled roles", () => {
  const data = scheduledWorkspace();
  const report = data.advisor.latest_by_task.source_quality.record.result;
  Object.assign(report, { received_at_ms: now - 61 * 60_000, status: "REJECTED" });
  let lines = scheduledAgentLines({ data }, now);
  assert.equal(lines[1].state, "Last run failed");
  assert.equal(lines[1].reportAge, "1h 1m ago");
  assert.equal(lines[1].overdue, "overdue rule not published");
  assert.equal(lines[0].reportAge, "2m 0s ago");
  assert.equal(lines[0].overdue, "overdue rule not published");
  data.advisor.task_profiles[1].enabled = false;
  lines = scheduledAgentLines({ data }, now);
  assert.equal(lines[1].state, "Disabled");
  assert.equal(lines[1].reportAge, "1h 1m ago");
  assert.equal(lines[1].overdue, "overdue rule not published");
});

test("missing scheduler or report state is not promoted to running", () => {
  const data = scheduledWorkspace();
  delete data.advisor.scheduler;
  assert.equal(scheduledAgentLines({ data }, now)[0].state, "State not published");
  data.advisor.scheduler = { enabled: true };
  delete data.advisor.latest_by_task.market_context;
  assert.equal(scheduledAgentLines({ data }, now)[0].state, "State not published");
});

test("missing task profiles do not crash agent lines or the actual agent detail route", () => {
  for (const [enabled, state] of [[false, "Disabled"], [true, "State not published"], [undefined, "Unavailable"]]) {
    const data = scheduledWorkspace();
    data.advisor.enabled = enabled;
    delete data.advisor.task_profiles;
    const lines = scheduledAgentLines({ data }, now);
    assert.equal(lines.length, 3);
    assert.ok(lines.every(line => line.state === state));
    const html = renderPage("AgentDetailPage", { data });
    assert.match(html, /Scheduled agents/);
    assert.doesNotMatch(html, /Bounded to/);
    if (enabled === true) assert.match(html, /task profile is unavailable: enabled state not published/);
  }
});

test("line model keeps loading, unavailable and upstream errors distinct without disabled", () => {
  for (const [read, state] of [
    [{ isPending: true }, "Loading"],
    [{ data: workspace }, "Unavailable"],
    [{ isError: true, error: new Error("offline") }, "Upstream error"],
  ]) {
    for (const line of scheduledAgentLines(read, now)) {
      assert.equal(line.state, state);
      assert.match(line.reason, /^Advisor state not read: /);
      assert.notEqual(line.state, "Disabled");
    }
  }
});

test("round2 current report expires between owner refreshes and becomes historical", () => {
  const data = scheduledWorkspace();
  const read = { data };
  const current = scheduledAgentLines(read, now)[0];
  assert.equal(current.state, "Current until 12:00:01 UTC");
  assert.equal(current.reportState, "CURRENT_REPORT");
  for (const [offset, age] of [[1000, "0s ago"], [2000, "1s ago"]]) {
    const expired = scheduledAgentLines(read, now + offset)[0];
    assert.equal(expired.state, `Expired ${age} · schedule not published`);
    assert.equal(expired.reportState, "was CURRENT_REPORT");
    assert.equal(expired.reportStatus, "ACCEPTED");
  }
  assert.equal(data.advisor.latest_by_task.market_context.status, "CURRENT_REPORT");
});

test("round2 owner expiry includes its UTC instant and relative time", context => {
  context.mock.method(Date, "now", () => now);
  const data = scheduledWorkspace();
  const current = scheduledAgentLines({ data }, now)[0];
  assert.equal(current.expiryTime, "2026-11-15T12:00:01.000Z");
  assert.equal(current.expiryRelative, "in 1s");
  const expired = scheduledAgentLines({ data }, now + 2000)[0];
  assert.equal(expired.expiryTime, current.expiryTime);
  assert.equal(expired.expiryRelative, "1s ago");
  assert.match(renderPage("AgentsPage", { data }), /Owner expiry:.*2026-11-15 12:00:01.000 UTC.*in 1s/);
});

for (const [code, wording] of [
  ["task_enablement_not_published", "Task enablement not published by the owner service"],
  ["task_enablement_invalid", "Task enablement invalid in the owner response"],
  ["task_disabled", "Task disabled by the owner service"],
]) {
  test(`round2 catalog explains ${code} in plain words`, () => {
    const data = scheduledWorkspace();
    data.agents[0] = { ...agent, status: "blocked", blockers: [code] };
    const html = renderPage("AgentsPage", { data });
    assert.ok(html.includes(wording));
    assert.ok(!html.includes(code));
    if (code !== "task_disabled") assert.doesNotMatch(html, /Task disabled by the owner service/);
  });
}

for (const [name, change] of [
  ["null advisor", data => { data.advisor = null; }],
  ["missing advisor", data => { delete data.advisor; }],
  ["object task profiles", data => { data.advisor.task_profiles = {}; }],
  ["null task profiles", data => { data.advisor.task_profiles = null; }],
  ["null profile row", data => { data.advisor.task_profiles = [null]; }],
]) {
  test(`round2 malformed ${name} stays unavailable without crashing`, () => {
    const data = scheduledWorkspace();
    change(data);
    const read = { data };
    assert.equal(advisorAvailability(read).state, "unavailable");
    for (const line of scheduledAgentLines(read, now)) {
      assert.equal(line.state, "Unavailable");
      assert.match(line.reason, /^Advisor state not read: /);
    }
    for (const page of ["AgentsPage", "AgentDetailPage"]) {
      const html = renderPage(page, read);
      assert.match(html, /Advisor state not read: /);
      assert.doesNotMatch(html, /Advisor is disabled|Bounded to/);
      if (page === "AgentDetailPage") assert.match(html, /disabled=""[^>]*>.*?Request report/);
    }
  });
}

for (const [name, record] of [["missing result", {}], ["null result", { result: null }], ["array result", { result: [] }]]) {
  test(`round2 malformed report with ${name} stays unavailable without crashing`, () => {
    const data = scheduledWorkspace();
    data.advisor.latest_by_task.market_context.record = record;
    const lines = scheduledAgentLines({ data }, now);
    assert.equal(lines[0].state, "Unavailable");
    assert.match(lines[0].reason, /^Advisor state not read: .*record.result/);
    assert.equal(lines[0].reportTime, null);
    assert.equal(lines[1].state, "Current until 12:00:01 UTC");
    assert.match(renderPage("AgentsPage", { data }), /Advisor state not read: .*record.result/);
  });
}

test("round2 mounted agent panels advance age and expiry without a new query result", async context => {
  let clockNow = now;
  context.mock.method(Date, "now", () => clockNow);
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const browser = new EventTarget();
  const intervals = new Map();
  let nextInterval = 0;
  browser.setInterval = (callback, delay) => {
    intervals.set(++nextInterval, { callback, delay });
    return nextInterval;
  };
  browser.clearInterval = timer => intervals.delete(timer);
  globalThis.window = browser;
  globalThis.document = new EventTarget();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const data = scheduledWorkspace();
  const { AgentsPage, AgentDetailPage } = pageModules({ data });
  let renderer;
  function textContent(node) {
    return typeof node === "string" ? node : node.children.map(textContent).join("");
  }
  const panelText = () => renderer.root.findAllByProps({ "aria-label": "Scheduled agents" }).map(textContent).join("\n");
  try {
    await act(async () => {
      renderer = create(React.createElement(React.Fragment, null, React.createElement(AgentsPage), React.createElement(AgentDetailPage)));
    });
    assert.match(panelText(), /2m 0s ago/);
    clockNow = now + 2000;
    await act(async () => { for (const { callback, delay } of intervals.values()) if (delay <= 2000) callback(); });
    const text = panelText();
    assert.ok(text.includes("2m 2s ago"), "mounted panel must advance age with unchanged query data");
    assert.match(text, /Expired 1s ago · schedule not published/);
    assert.match(text, /was CURRENT_REPORT/);
    assert.doesNotMatch(text, /Current until|Last report accepted|not expired/);
    assert.equal([...intervals.values()].filter(timer => timer.delay === 1000).length, 1, "both panels share one clock interval");
    assert.equal(data.advisor.latest_by_task.market_context.status, "CURRENT_REPORT");
  } finally {
    await act(async () => renderer?.unmount());
    assert.equal(intervals.size, 0, "clock interval is removed on unmount");
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    if (previousAct === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT; else globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
});
