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
  queries["research-nodes"] = { data: envelope({ items: [], total: 0 }) };
  delete queries["research-node"];
  delete queries["research-graph"];
  delete queries["research-comparisons"];
  const result = renderResearch(queries, { search: "q=no-matching-record" });
  assert.match(result.html, /No records match these filters/);
  assert.equal(
    result.requests.find((q) => q.queryKey[0] === "research-graph").enabled,
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
    [...result.refetches].sort(),
    [
      "research-overview",
      "research-nodes",
      "research-node",
      "research-graph",
      "research-comparisons",
    ].sort(),
  );
});

test("stale graph is disclosed and retry targets the graph query", () => {
  const queries = selectedIdeaQueries();
  queries["research-graph"] = {
    dataUpdatedAt: Date.now() - 120000,
    data: envelope({ nodes: [], edges: [] }, 120_000),
  };
  const result = renderResearch(queries);
  assert.doesNotMatch(
    result.html,
    /Loading research connections|Connecting to knowledge graph/,
  );
  assert.match(result.html, /stale|has not refreshed|expired/i);
  click(result, /Retry (?:graph|connections)/i);
  assert.deepEqual(result.refetches, ["research-graph"]);
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
    assert.match(result.html, /Index current/);
    assert.doesNotMatch(
      result.html,
      /has not refreshed|expired|connection stale/i,
    );
    assert.ok(
      result.requests.find((q) => q.queryKey[0] === "research-comparisons")
        .enabled,
    );
    click(result, /^Refresh$/);
    assert.equal(result.refetches.length, 5);
  }
});


test("each library filter clears the previously selected record", () => {
  const result = renderResearch(selectedIdeaQueries(), { search: "q=RSI&id=spot-record" });
  assert.equal(result.selects.length, 3);
  for (const select of result.selects) select.onChange({target:{value:"FUTURES"}});
  assert.deepEqual(result.searchUpdates, ["q=RSI", "q=RSI", "q=RSI"]);
});

test("long native fields display a visible truncation notice", () => {
  const queries = selectedIdeaQueries();
  queries["research-node"].data.data.node.data = { native_receipt: "x".repeat(25000) };
  const result = renderResearch(queries);
  assert.match(result.html, /Preview truncated to 20,000 of/);
  assert.match(result.html, /Full native fields remain in the owner source/);
});
