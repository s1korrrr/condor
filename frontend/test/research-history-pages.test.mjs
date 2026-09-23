import { relationshipEvidence } from "../src/features/research/research-detail.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { visitElements } from "./helpers/research-lifecycle.mjs";

const require = createRequire(import.meta.url);
function fixture() {
  let cursor = 0,
    revision = "r1",
    pageResult;
  const state = [],
    requests = [],
    reads = [],
    refetches = [];
  const page = (offset, total = 61, rev = revision) => ({
    revision: rev,
    node: {
      id: "campaign:one",
      title: "Campaign details",
      kind: "campaign",
      data: {},
    },
    documents: [{ ref: "source" }],
    relations_page: { offset, limit: 25, total },
    edges: Array.from(
      { length: Math.min(25, Math.max(0, total - offset)) },
      (_, index) => ({
        source: "campaign:one",
        target: `attempt:${offset + index}`,
        relation: "records",
        basis: "receipt",
      }),
    ),
    related: Array.from(
      { length: Math.min(25, Math.max(0, total - offset)) },
      (_, index) => ({
        id: `attempt:${offset + index}`,
        title: `Attempt ${offset + index}`,
        kind: "attempt",
      }),
    ),
  });
  const success = (data) => ({
    data: { data },
    isError: false,
    dataUpdatedAt: Date.now(),
  });
  const dependencies = {
    react: {
      useState(initial) {
        const i = cursor++;
        if (!(i in state))
          state[i] = typeof initial === "function" ? initial() : initial;
        return [
          state[i],
          (value) => {
            state[i] = value;
          },
        ];
      },
      useRef: () => ({ current: null }),
      useEffect() {},
      useMemo: (f) => f(),
    },
    "@tanstack/react-query": {
      useQuery(options) {
        requests.push(options);
        const offset = options.queryKey[4];
        return {
          ...success(page(0)),
          ...(offset > 0 ? (pageResult ?? success(page(offset))) : {}),
          refetch() {
            refetches.push(offset);
          },
        };
      },
    },
    "@/lib/auth-token": { authFetch() {} },
    "./read": {
      readResearch:
        () =>
        (...args) => {
          reads.push(args);
        },
    },
    "./model": {
      object: (v) => (v && typeof v === "object" ? v : {}),
      records: (v) => (Array.isArray(v) ? v : []),
      text: (v, fallback = "UNAVAILABLE") =>
        typeof v === "string" ? v : fallback,
      researchReadState: (data, _now, error) =>
        error ? "error" : data ? "available" : "loading",
    },
    "./ResearchResults": { ResearchResults() {} },
    "./ResearchDocument": { ResearchDocuments() {} },
    "./results": { sourceResultBars: () => [] },
    "./research-detail": {
      relationshipEvidence,
      safeSourceUrl: () => null,
      researchLabel: (v) => v,
      displayResearchValue: (v) => v,
      metricValue: (v) => v,
    },
  };
  const code = ts.transpileModule(
    fs.readFileSync(
      new URL(
        "../src/features/research/ResearchInspector.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", code)(
    (name) =>
      dependencies[name] ?? (name.endsWith(".css") ? {} : require(name)),
    module,
    module.exports,
  );
  return {
    requests,
    reads,
    refetches,
    page,
    success,
    set revision(value) {
      revision = value;
    },
    set pageResult(value) {
      pageResult = value;
    },
    render() {
      cursor = 0;
      return module.exports.ResearchInspector({
        server: "native",
        id: "campaign:one",
        onSelect() {},
        onFindInNetwork() {},
        onArchiveRecord() {},
      });
    },
  };
}
function content(tree) {
  let value = "";
  visitElements(tree, (item) => {
    for (const child of [item.props?.children].flat())
      if (typeof child === "string" || typeof child === "number")
        value += child;
  });
  return value;
}
function button(tree, name) {
  let found;
  visitElements(tree, (item) => {
    if (item.type === "button" && item.props.children === name) found = item;
  });
  assert.ok(found, name);
  return found.props;
}
function documents(tree) {
  let found;
  visitElements(tree, (item) => {
    if (item.props?.scope === "node" && item.props?.documents) found = item;
  });
  return found;
}

test("relationship pages reach the final edges without remounting source readers", () => {
  const view = fixture();
  let tree = view.render();
  const source = documents(tree);
  assert.match(content(tree), /Relationships 1–25 of 61/);
  assert.equal(button(tree, "Previous relationships").disabled, true);
  button(tree, "Next relationships").onClick();
  tree = view.render();
  assert.match(content(tree), /Relationships 26–50 of 61/);
  assert.doesNotMatch(content(tree), /Attempt 0(?:\D|$)/);
  assert.equal(documents(tree).key, source.key);
  const request = view.requests.findLast((item) => item.queryKey[4] === 25);
  request.queryFn({ signal: "signal" });
  assert.deepEqual(view.reads.at(-1), [
    "node",
    "native",
    { id: "campaign:one", relation_limit: "25", relation_offset: "25" },
    "signal",
  ]);
  button(tree, "Next relationships").onClick();
  tree = view.render();
  assert.match(content(tree), /Relationships 51–61 of 61/);
  assert.equal(button(tree, "Next relationships").disabled, true);
  button(tree, "Previous relationships").onClick();
  assert.match(content(view.render()), /Relationships 26–50 of 61/);
});

test("page loading and retry keep record and documents while withholding history", () => {
  const view = fixture();
  let tree = view.render();
  const key = documents(tree).key;
  button(tree, "Next relationships").onClick();
  view.pageResult = { data: undefined, isError: false };
  tree = view.render();
  assert.match(content(tree), /Loading relationship history/);
  assert.match(content(tree), /Campaign details/);
  assert.equal(documents(tree).key, key);
  assert.equal(button(tree, "Next relationships").disabled, true);
  view.pageResult = {
    data: undefined,
    isError: true,
    error: { message: "Page failed" },
  };
  tree = view.render();
  assert.match(content(tree), /Page failed/);
  button(tree, "Retry history").onClick();
  assert.deepEqual(view.refetches, [25]);
  assert.equal(documents(tree).key, key);
});

test("graph revision changes reset pagination and stale revision pages are withheld", () => {
  const view = fixture();
  button(view.render(), "Next relationships").onClick();
  view.pageResult = view.success(view.page(25, 61, "different"));
  let tree = view.render();
  assert.match(content(tree), /different graph revision/);
  assert.doesNotMatch(content(tree), /Attempt 25/);
  view.revision = "r2";
  tree = view.render();
  assert.match(content(tree), /Relationships 1–25 of 61/);
  assert.equal(button(tree, "Previous relationships").disabled, true);
});

test("out of range relationship pages offer previous navigation", () => {
  const view = fixture();
  button(view.render(), "Next relationships").onClick();
  view.pageResult = view.success(view.page(25, 20));
  const tree = view.render();
  assert.match(content(tree), /page is no longer available/);
  assert.equal(button(tree, "Previous relationships").disabled, false);
  assert.equal(button(tree, "Next relationships").disabled, true);
});

test("unresolved relationship targets remain explicit without claiming history is empty", () => {
  const view = fixture();
  button(view.render(), "Next relationships").onClick();
  view.pageResult = view.success({ ...view.page(25), related: [] });
  const tree = view.render();
  assert.match(content(tree), /linked records are unavailable/);
  assert.doesNotMatch(content(tree), /No linked history/);
  let raw;
  visitElements(tree, (item) => {
    if (
      item.props?.title ===
      "Recorded relations and provenance (current relationship page)"
    )
      raw = item.props.value;
  });
  assert.equal(raw[0].target, "attempt:25");
});
