import test from "node:test";
import assert from "node:assert/strict";
import { botsOwnerUnavailableReason } from "../src/v5/policy.ts";

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
