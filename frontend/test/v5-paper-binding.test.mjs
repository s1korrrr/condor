import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { botsOwnerUnavailableReason } from "../src/v5/policy.ts";
import { frontendModules } from "./helpers/frontend-module.mjs";

test("Bots notice stays unbound until a fresh paper owner is bound", () => {
  const unbound = "The V5 native owner is unbound; bot registration, positions and performance are unavailable.";
  assert.equal(botsOwnerUnavailableReason(undefined), unbound);
  assert.equal(botsOwnerUnavailableReason({ readiness: { native_owner: "UNBOUND", native_owner_reason: "" } }), unbound);
  assert.equal(botsOwnerUnavailableReason({ readiness: { native_owner: "PAPER_BOUND" } }), undefined);
  assert.equal(
    botsOwnerUnavailableReason({ readiness: { native_owner: "STALE", native_owner_reason: "The paper status is stale (40s old)." } }),
    "The paper status is stale (40s old).",
  );
});

// Payloads are the Condor paper bootstrap projection, pinned by
// tests/test_v5_paper_binding.py::test_frontend_bootstrap_fixture_is_the_current_projection.
const bootstrap = JSON.parse(readFileSync(new URL("./fixtures/v5-paper-bootstrap.json", import.meta.url), "utf8"));
const { load } = frontendModules();
const { buildBotPositionView } = load("features/bots/position-view.ts");
const { projectBotStats } = load("features/bots/fleet-tiles.ts");

function botsTableExecutors({ payload, now_ms }) {
  let view = null;
  // The Bots roster's own handling: a view that cannot be built is unavailable.
  try { view = buildBotPositionView(payload, bootstrap.bot, now_ms, { allowStale: true }); } catch { view = null; }
  const stats = projectBotStats({ bot: bootstrap.bot, name: bootstrap.bot, status: "running", view, quant: null, cycles: null, execution: null, health: null }, now_ms);
  return { view, executors: stats.executors };
}

test("Unavailable or retained paper reports never become a fresh zero executor count", () => {
  const { view, executors } = botsTableExecutors(bootstrap.cases.retained_all);
  assert.equal(view, null);
  assert.equal(executors, null);
});

test("A current paper status from the qualification run shows its five controllers", () => {
  const { view, executors } = botsTableExecutors(bootstrap.cases.current_qualification);
  assert.equal(view.stale, false);
  assert.equal(view.pairs.length, 5);
  assert.equal(executors, 0);
});
