import test from "node:test";
import assert from "node:assert/strict";
import {
  envelope,
  renderResearch,
  selectedIdeaQueries,
} from "./helpers/research-render.mjs";

function click(result, pattern) {
  const button = result.buttons.find((button) => pattern.test(button.text));
  assert.ok(button, `Expected actionable button matching ${pattern}`);
  assert.ok(!button.disabled, `Button ${button.text} must be enabled`);
  assert.equal(typeof button.onClick, "function");
  button.onClick();
}

test("successful empty search does not leave a disabled graph request showing loading", () => {
  const queries = selectedIdeaQueries();
  queries["research-lab-records"] = { data: envelope({ items: [], total: 0 }) };
  delete queries["research-node"];
  delete queries["research-graph"];
  delete queries["research-comparisons"];
  const result = renderResearch(queries, {
    search: "view=ideas&q=no-matching-record",
  });
  assert.match(result.html, /No records match these filters/);
  assert.equal(
    result.requests.some((q) => q.queryKey[0] === "research-node"),
    false,
  );
  assert.doesNotMatch(
    result.html,
    /Loading research connections|Connecting to knowledge graph/,
  );
});

test("comparison failure is visible and its retry invokes the comparison query", () => {
  const queries = selectedIdeaQueries();
  queries["research-comparisons"] = {
    isError: true,
    error: new Error("Comparison fixture upstream 503"),
  };
  const result = renderResearch(queries);
  assert.match(result.html, /Comparison fixture upstream 503/);
  click(result, /Retry comparison/i);
  assert.deepEqual(result.refetches, ["research-comparisons"]);
});

test("Refresh includes comparisons for the selected idea", () => {
  const result = renderResearch(selectedIdeaQueries());
  click(result, /^Refresh$/);
  assert.deepEqual(
    [...new Set(result.refetches)].sort(),
    [
      "research-overview",
      "research-lab-records",
      "research-node",
      "research-comparisons",
    ].sort(),
  );
});

test("stale overview prevents a cached full network being presented as current", () => {
  const queries = selectedIdeaQueries();
  queries["research-overview"].dataUpdatedAt = Date.now() - 120000;
  const result = renderResearch(queries, { search: "view=graph" });
  assert.match(result.html, /stale|has not refreshed/i);
  assert.equal(
    result.requests.find((q) => q.queryKey[0] === "research-network").enabled,
    false,
  );
  click(result, /Retry records/i);
  assert.deepEqual(result.refetches, ["research-overview"], "Network remains gated until a current overview is received");
});

test("stale comparisons are disclosed without displaying old values", () => {
  const queries = selectedIdeaQueries();
  queries["research-comparisons"] = {
    dataUpdatedAt: Date.now() - 120000,
    data: envelope(
      {
        items: [
          {
            id: "assessment:stale",
            label: "STALE_COMPARISON_MUST_NOT_RENDER",
            value: 10,
            unit: "USDC",
            metric: "net_pnl",
            baseline: "old-baseline",
            comparable_group: "old",
            validity: "VALID",
            attribution: "ISOLATED",
            source_refs: [{ sha256: "old" }],
            conditions: {},
          },
        ],
        limitations: [],
      },
      120_000,
    ),
  };
  const result = renderResearch(queries);
  assert.doesNotMatch(
    result.html,
    /STALE_COMPARISON_MUST_NOT_RENDER|Delta against old-baseline/,
  );
  assert.match(result.html, /stale|has not refreshed|expired/i);
  click(result, /Retry comparison/i);
  assert.deepEqual(result.refetches, ["research-comparisons"]);
});

test("stale detail is disclosed and can be retried without showing the old record", () => {
  const queries = selectedIdeaQueries();
  queries["research-node"] = {
    dataUpdatedAt: Date.now() - 120000,
    data: envelope(
      {
        node: {
          id: "idea:one",
          kind: "idea",
          title: "STALE_DETAIL_MUST_NOT_RENDER",
          status: "PROPOSED",
          data: {},
        },
      },
      120000,
    ),
  };
  const result = renderResearch(queries);
  assert.doesNotMatch(result.html, /STALE_DETAIL_MUST_NOT_RENDER/);
  assert.match(result.html, /stale|has not refreshed|expired/i);
  click(result, /Retry detail/i);
  assert.deepEqual(result.refetches, ["research-node"]);
});

test("all research panels remain visible with a skewed host clock", () => {
  for (const skew of [-86400000, 86400000]) {
    const queries = selectedIdeaQueries();
    for (const query of Object.values(queries)) {
      query.data.source.fetched_at = new Date(Date.now() + skew).toISOString();
      query.dataUpdatedAt = Date.now() - 1000;
    }
    const result = renderResearch(queries);
    assert.match(result.html, /Fixture idea/);
    assert.match(result.html, /Index unavailable/);
    assert.match(result.html, /Event-scan verification unavailable/);
    assert.doesNotMatch(
      result.html,
      /has not refreshed|expired|connection stale/i,
    );
    assert.ok(
      result.requests.find((q) => q.queryKey[0] === "research-comparisons")
        .enabled,
    );
    click(result, /^Refresh$/);
    assert.equal(new Set(result.refetches).size, 4);
  }
});

test("canonical event-scan freshness is shown with its as-of age and bound", () => {
  const queries = selectedIdeaQueries();
  queries["research-overview"].data.data.freshness = {
    state: "CURRENT",
    freshness_basis: "verified_event_scan",
    verification_checked_at: "2026-09-30T12:00:00Z",
    verification_age_seconds: 5,
    max_verification_age_seconds: 90,
  };
  const result = renderResearch(queries);
  assert.match(result.html, /Index current · verified as of scan/);
  assert.match(result.html, /Event scan · .* · 5s old \/ ≤90s detection bound/);
  assert.doesNotMatch(result.html, /Event-scan verification unavailable/);
});

test("missing or expired event-scan metadata never renders as verified", () => {
  const missing = selectedIdeaQueries();
  missing["research-overview"].data.data.freshness = {
    state: "CURRENT",
    freshness_basis: "verified_event_scan",
    verification_checked_at: "not-a-timestamp",
    max_verification_age_seconds: 90,
  };
  const missingResult = renderResearch(missing);
  assert.match(missingResult.html, /Event-scan verification unavailable/);
  assert.match(missingResult.html, /Index unavailable/);
  assert.doesNotMatch(missingResult.html, /Index current/);
  assert.doesNotMatch(missingResult.html, /verified as of scan|Event scan ·/);

  const expired = selectedIdeaQueries();
  expired["research-overview"].data.data.freshness = {
    state: "CURRENT",
    freshness_basis: "verified_event_scan",
    verification_checked_at: "2026-09-30T12:00:00Z",
    verification_age_seconds: 91,
    max_verification_age_seconds: 90,
  };
  const expiredResult = renderResearch(expired);
  assert.match(expiredResult.html, /Event-scan verification unavailable/);
  assert.match(expiredResult.html, /Index unavailable/);
  assert.doesNotMatch(expiredResult.html, /Index current/);
  assert.doesNotMatch(expiredResult.html, /verified as of scan|Event scan ·/);
});

test("event-scan proof expires while a query response is still readable", (t) => {
  const now = Date.parse("2026-09-30T12:01:31Z");
  t.mock.method(Date, "now", () => now);
  const queries = selectedIdeaQueries();
  queries["research-overview"].dataUpdatedAt = now - 11000;
  queries["research-overview"].data.data.freshness = {
    state: "CURRENT",
    freshness_basis: "verified_event_scan",
    verification_checked_at: "2026-09-30T12:00:00Z",
    verification_age_seconds: 80,
    max_verification_age_seconds: 90,
  };
  const result = renderResearch(queries, { search: "" });
  assert.match(result.html, /Recorded conclusions/);
  assert.match(result.html, /Index unavailable/);
  assert.match(result.html, /Event-scan verification unavailable/);
  assert.doesNotMatch(result.html, /verified as of scan|Event scan ·/);
});

test("each library filter clears the previously selected record", () => {
  const result = renderResearch(selectedIdeaQueries(), {
    search: "view=ideas&q=RSI&id=spot-record",
  });
  assert.equal(result.selects.length, 2);
  for (const select of result.selects)
    select.onChange({ target: { value: "FUTURES" } });
  assert.deepEqual(result.searchUpdates, [
    "view=ideas&q=RSI&lane=FUTURES",
    "view=ideas&q=RSI&lane=FUTURES&family=FUTURES",
  ]);
});

test("full native fields remain available in a lazy disclosure beyond the former preview limit", () => {
  const queries = selectedIdeaQueries();
  queries["research-node"].data.data.node.data = {
    native_receipt: "x".repeat(25000),
  };
  const result = renderResearch(queries);
  assert.ok(!result.html.includes("x".repeat(25000)));
  assert.match(result.html, /Full graph node/);
  assert.doesNotMatch(result.html, /Preview truncated/);
});


test("hidden graph selection and topology updates compose in one event", () => {
  const queries = selectedIdeaQueries();
  queries["research-overview"].data.data.revision = "r1";
  queries["research-network"] = { data: { network: envelope({ revision: "r1", nodes: [], edges: [], total_nodes: 0, total_edges: 0, unresolved_edges: 0 }) } };
  const result = renderResearch(queries, { search: "view=graph&id=previous" });
  assert.equal(result.networks.length, 1);
  result.networks[0].onSelect("idea:hidden");
  result.networks[0].onTopology("all", "idea:hidden");
  const final = new URLSearchParams(result.searchUpdates.at(-1));
  assert.equal(final.get("id"), "idea:hidden");
  assert.equal(final.get("network_topology"), "all");
  assert.ok(final.get("network_focus").startsWith("idea:hidden:"));
  result.networks[0].onTopology("dependencies");
  const manual = new URLSearchParams(result.searchUpdates.at(-1));
  assert.equal(manual.get("id"), "idea:hidden");
  assert.equal(manual.has("network_focus"), false);
});

test("a stale or failed overview leaves independent panels rendering their own state", () => {
  // Live 2026-10-05: overview stale and /queue 503 blanked the whole page behind one notice.
  const overview = { ...selectedIdeaQueries()["research-overview"], dataUpdatedAt: Date.now() - 120000 };
  const queue = { isError: true, error: new Error("Queue fixture upstream 503") };
  const page = renderResearch({ "research-overview": overview, "research-queue-preview": queue }, { search: "" });
  assert.match(page.html, /has not refreshed/, "the overview notice stays visible");
  assert.match(page.html, /Next evidence checks/, "the queue panel renders without a current overview");
  assert.match(page.html, /Queue fixture upstream 503/, "the failed panel shows its own error");
  assert.equal(page.requests.some((q) => q.queryKey[0] === "research-recent-assessments"), false,
    "revision-bound conclusions still wait for a current overview");
  for (const button of page.buttons.filter((button) => /Retry records/i.test(button.text))) button.onClick();
  assert.deepEqual([...new Set(page.refetches)].sort(), ["research-overview", "research-queue-preview"],
    "each notice retries only its own read");
  const records = renderResearch({ ...selectedIdeaQueries(), "research-overview": { isError: true, error: new Error("Overview fixture failure") } });
  assert.match(records.html, /Overview fixture failure/);
  assert.match(records.html, /Fixture idea/, "record lists keep their own read and stay visible");
  assert.ok(records.requests.some((q) => q.queryKey[0] === "research-node"), "the selected record inspector still opens");
});
