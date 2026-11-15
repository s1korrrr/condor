import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { frontendModules } from "./helpers/frontend-module.mjs";
import { ADVISOR_CONFIG_SCHEDULE, advisorAvailability, scheduledAgentLines } from "../src/v5/agent-status.ts";

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

function renderPage(page, read) {
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
  return renderToStaticMarkup(React.createElement(load("v5/V5Pages.tsx")[page]));
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

test("configured role schedule plus enabled owner reads and recent reports show running on schedule", () => {
  const data = scheduledWorkspace();
  const lines = scheduledAgentLines({ data }, now);
  for (const line of lines) {
    assert.equal(line.state, "Running on schedule");
    assert.match(line.reason, /Advisor config schedules this role; owner shared scheduler enabled: true/);
    assert.equal(line.schedule, "overdue when newest report > 60 min old (45 min rotation + one 15 min slot)");
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
    assert.equal(line.overdue, "overdue not determined (report time not published or clock mismatch)");
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
  assert.equal(line.state, "State not published");
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

test("the actual catalog renders three lines at the top with configured cadence, UTC, age and expiry", context => {
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
  assert.ok(section.includes(ADVISOR_CONFIG_SCHEDULE));
  assert.equal((section.match(/Rule: overdue when newest report &gt; 60 min old/g) || []).length, 3);
  assert.ok(html.indexOf(section) < html.indexOf('class="v5-agent-catalog"'));
});

test("45-minute cadence has one shared-slot grace, then actual report age marks overdue", () => {
  const data = scheduledWorkspace();
  const report = data.advisor.latest_by_task.market_context.record.result;
  for (const [age, state, overdue] of [
    [45 * 60_000, "Running on schedule", false],
    [45 * 60_000 + 1, "Awaiting next report", false],
    [60 * 60_000, "Awaiting next report", false],
    [60 * 60_000 + 1, "Overdue", true],
  ]) {
    report.received_at_ms = now - age;
    const line = scheduledAgentLines({ data }, now)[0];
    assert.equal(line.state, state);
    assert.equal(line.overdue, overdue ? "overdue" : "within 60 min overdue threshold");
    assert.equal(line.scheduleExpiry, age > 45 * 60_000 ? "expired (configured 45 min interval)" : null);
  }
});

test("the overdue rule uses each role's newest report, even for failed or disabled roles", () => {
  const data = scheduledWorkspace();
  const report = data.advisor.latest_by_task.source_quality.record.result;
  Object.assign(report, { received_at_ms: now - 61 * 60_000, status: "REJECTED" });
  let lines = scheduledAgentLines({ data }, now);
  assert.equal(lines[1].state, "Last run failed");
  assert.equal(lines[1].overdue, "overdue");
  assert.notEqual(lines[0].overdue, "overdue");
  data.advisor.task_profiles[1].enabled = false;
  lines = scheduledAgentLines({ data }, now);
  assert.equal(lines[1].state, "Disabled");
  assert.equal(lines[1].overdue, "overdue");
});

test("configured schedule alone does not turn missing scheduler or report state into running", () => {
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
