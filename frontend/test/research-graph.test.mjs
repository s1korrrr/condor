import test from "node:test";
import assert from "node:assert/strict";
import { layoutResearchGraph } from "../src/features/research/research-graph.ts";

const node = (id, kind = "idea") => ({
  id,
  kind,
  title: `Title ${id}`,
  status: "PROPOSED",
});
test("graph layout preserves exact identities and actual directed relations", () => {
  const data = {
    nodes: [node("b", "run"), node("a")],
    edges: [
      {
        id: "edge:1",
        source: "a",
        target: "b",
        relation: "evaluates",
        basis: "EXPLICIT",
      },
    ],
    truncated: false,
  };
  const result = layoutResearchGraph(data, "a");
  assert.equal(result.nodes[0].id, "a");
  assert.equal(result.nodes[0].x, 500);
  assert.equal(result.edges[0].source, "a");
  assert.equal(result.edges[0].target, "b");
  assert.equal(result.edges[0].relation, "evaluates");
  assert.deepEqual(
    result,
    layoutResearchGraph({ ...data, nodes: [...data.nodes].reverse() }, "a"),
  );
});
test("graph never invents links for isolated nodes or unresolved endpoints", () => {
  const result = layoutResearchGraph(
    {
      nodes: [node("a")],
      edges: [{ source: "a", target: "missing", relation: "evaluates" }],
      truncated: false,
    },
    "a",
  );
  assert.equal(result.edges.length, 0);
  assert.equal(result.omittedEdges, 1);
  assert.equal(result.nodes.length, 1);
});
test("large neighborhoods remain bounded and visibly marked as subsets", () => {
  const result = layoutResearchGraph(
    {
      nodes: Array.from({ length: 60 }, (_, i) => node(String(i))),
      edges: [],
      truncated: false,
    },
    "59",
  );
  assert.equal(result.nodes.length, 50);
  assert.equal(result.nodes[0].id, "59");
  assert.equal(result.truncated, true);
  assert.ok(
    result.nodes.every(
      (n) =>
        Number.isFinite(n.x) && Number.isFinite(n.y) && n.x >= 30 && n.x <= 970,
    ),
  );
});
test("malformed and duplicate node identities fail closed", () => {
  assert.throws(() =>
    layoutResearchGraph({ nodes: [node("a"), node("a")], edges: [] }, "a"),
  );
  assert.throws(() => layoutResearchGraph({ nodes: [{}], edges: [] }, "a"));
});
