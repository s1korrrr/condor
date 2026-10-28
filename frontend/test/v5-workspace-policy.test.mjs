import test from "node:test";
import assert from "node:assert/strict";
import { boundedLoopParameters, canRequestReport } from "../src/v5/policy.ts";

const readyReportsOnly = {
  agentReady: true,
  advisorEnabled: true,
  taskEnabled: true,
  modelAvailable: true,
  mode: "reports-only",
  executionEnabled: false,
  agentExecutionEnabled: false,
};

test("reports require every owner readiness condition", () => {
  assert.equal(canRequestReport(readyReportsOnly), true);
  assert.equal(canRequestReport({ ...readyReportsOnly, agentReady: false }), false);
  assert.equal(canRequestReport({ ...readyReportsOnly, advisorEnabled: false }), false);
  assert.equal(canRequestReport({ ...readyReportsOnly, taskEnabled: false }), false);
  assert.equal(canRequestReport({ ...readyReportsOnly, modelAvailable: false }), false);
  assert.equal(canRequestReport({ ...readyReportsOnly, mode: "canary" }), false);
  assert.equal(canRequestReport({ ...readyReportsOnly, executionEnabled: true }), false);
  assert.equal(canRequestReport({ ...readyReportsOnly, agentExecutionEnabled: true }), false);
});

test("report loops are bounded to at least 15 minutes and at most 96 ticks", () => {
  assert.deepEqual(boundedLoopParameters(1800, 48), { frequency_sec: 1800, max_ticks: 48 });
  assert.deepEqual(boundedLoopParameters(60, 120), { frequency_sec: 900, max_ticks: 96 });
  assert.deepEqual(boundedLoopParameters(3600, 0), { frequency_sec: 3600, max_ticks: 1 });
  assert.equal(boundedLoopParameters(Number.NaN, 10), null);
  assert.equal(boundedLoopParameters(1200, Number.POSITIVE_INFINITY), null);
});
