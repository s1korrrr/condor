import test from "node:test";
import assert from "node:assert/strict";
import {
  researchPath,
  catalogCount,
  researchReadState,
  parseResearchEnvelope,
} from "../src/features/research/model.ts";

test("research requests bind a server and encode opaque node IDs without allowing arbitrary endpoints", () => {
  assert.equal(
    researchPath("node", "native-ok-rsi", { id: "idea:a/b?x=1" }),
    "/api/v1/research/node?server=native-ok-rsi&id=idea%3Aa%2Fb%3Fx%3D1",
  );
  assert.throws(() => researchPath("../files", "native-ok-rsi", {}));
  assert.throws(() => researchPath("overview", "", {}));
});

test("catalog counts distinguish missing or invalid values from observed zero", () => {
  assert.equal(catalogCount({ ideas: 0 }, "ideas"), 0);
  for (const value of [undefined, null, "12", -1, NaN, Infinity])
    assert.equal(catalogCount({ ideas: value }, "ideas"), null);
});

test("research reads expire independently of the owner index CURRENT state", () => {
  const now = Date.parse("2026-09-08T20:00:00Z");
  const e = {
    data: { freshness: { state: "CURRENT" } },
    source: {
      owner: "research_os",
      server: "native",
      fetched_at: "2026-09-08T19:59:59Z",
      read_only: true,
    },
  };
  assert.equal(researchReadState(e, now, false), "available");
  assert.equal(researchReadState(e, now + 61000, false), "stale");
  assert.equal(researchReadState(e, now, true), "error");
  assert.equal(
    researchReadState(
      { ...e, source: { ...e.source, fetched_at: "2027-01-01" } },
      now,
      false,
    ),
    "stale",
  );
});

test("research envelopes require the expected owner/server and object data", () => {
  const e = {
    data: {},
    source: {
      owner: "research_os",
      server: "native",
      fetched_at: "2026-09-08T20:00:00Z",
      read_only: true,
    },
  };
  assert.deepEqual(parseResearchEnvelope(e, "native"), e);
  assert.throws(() => parseResearchEnvelope(e, "another"));
  assert.throws(() => parseResearchEnvelope({ ...e, data: null }, "native"));
});
