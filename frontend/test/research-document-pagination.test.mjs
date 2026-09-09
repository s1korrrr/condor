import test from "node:test";
import assert from "node:assert/strict";
import { researchDocumentPage } from "../src/features/research/research-document-pagination.ts";
import {
  renderResearchComponent,
  envelope,
} from "./helpers/research-component-render.mjs";
const references = (count) =>
  Array.from({ length: count }, (_, i) => ({
    ref: `source-${i + 1}`,
    label: `Source ${i + 1}`,
    available: i !== 20,
    reason: i === 20 ? "Frozen source is unavailable" : undefined,
  }));

test("document pagination preserves access to every source across the 20-reference boundary", () => {
  for (const count of [0, 1, 20, 21, 40, 401, 2915]) {
    const items = references(count),
      seen = [];
    let page = researchDocumentPage(items, 0);
    assert.equal(page.previous, null);
    while (true) {
      assert.ok(page.items.length <= 20);
      seen.push(...page.items.map((item) => item.ref));
      if (page.next === null) break;
      page = researchDocumentPage(items, page.next);
    }
    assert.deepEqual(
      seen,
      items.map((item) => item.ref),
    );
    assert.equal(page.last, count);
  }
});
test("a shorter refreshed document list clamps the page without leaving its sources unreachable", () => {
  const page = researchDocumentPage(references(3), 20);
  assert.equal(page.first, 1);
  assert.equal(page.last, 3);
  assert.equal(page.previous, null);
  assert.equal(page.next, null);
});
test("shared document UI limits long lists, exposes paging count and retains Open and Download for visible sources", () => {
  const render = (count) =>
    renderResearchComponent(
      "ResearchArchive",
      { server: "fixture" },
      {
        "research-archive-overview": {
          data: envelope({
            revision: "same",
            coverage: { records: 0 },
            documents: references(count),
          }),
        },
      },
      { search: "archive_view=coverage" },
    );
  const compact = render(21);
  assert.equal(
    compact.buttons.filter((button) =>
      button["aria-label"]?.startsWith("Open Source"),
    ).length,
    20,
  );
  assert.equal(
    compact.buttons.filter((button) =>
      button["aria-label"]?.startsWith("Download Source"),
    ).length,
    20,
  );
  assert.match(compact.html, /1–20 of 21 sources/);
  assert.equal(
    compact.buttons.find((button) => button.text === "Previous sources")
      .disabled,
    true,
  );
  assert.equal(
    compact.buttons.find((button) => button.text === "Next sources").disabled,
    false,
  );
  assert.doesNotMatch(compact.html, />Source 21</);
  const short = render(20);
  assert.equal(
    short.buttons.filter((button) =>
      button["aria-label"]?.startsWith("Open Source"),
    ).length,
    20,
  );
  assert.ok(!short.buttons.some((button) => button.text === "Next sources"));
});

test("large supervisor descriptors and native payload do not populate the initial inspector DOM", () => {
  const result = renderResearchComponent(
    "ResearchInspector",
    {
      server: "fixture",
      id: "decision:supervisor",
      onSelect() {},
      onFindInNetwork() {},
      onArchiveRecord() {},
    },
    {
      "research-node": {
        data: envelope({
          revision: "same",
          node: {
            id: "decision:supervisor",
            kind: "decision",
            title: "Recorded supervisor",
            data: {
              native_payload: "x".repeat(1_400_000) + "FINAL_NATIVE_FIELD",
            },
          },
          documents: references(2915),
        }),
      },
    },
  );
  assert.equal(
    result.buttons.filter((button) =>
      button["aria-label"]?.startsWith("Open Source"),
    ).length,
    20,
  );
  assert.match(result.html, /1–20 of 2,915 sources/);
  assert.ok(result.html.length < 50_000);
  assert.doesNotMatch(result.html, /FINAL_NATIVE_FIELD/);
  assert.match(result.html, /Full graph node/);
});
