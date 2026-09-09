import test from "node:test";
import assert from "node:assert/strict";
import { componentLifecycle, visitElements } from "./helpers/research-lifecycle.mjs";

function fixture({ failFirst = false } = {}) {
  const mounts = [];
  let attempts = 0;
  const lifecycle = componentLifecycle(new URL("../src/features/research/ResearchNetwork.tsx", import.meta.url), {
    "./lab-network-engine": { mount() {
      if (failFirst && attempts++ === 0) throw new Error("Canvas failed");
      const handle = { selected: [], filters: [], focused: [], destroyed: false,
        select(id) { this.selected.push(id); },
        setFilters(value) { this.filters.push(value); },
        focus(id) { this.focused.push(id); },
        destroy() { this.destroyed = true; },
      };
      mounts.push(handle);
      return handle;
    } },
  });
  const props = { data: { revision: "same" }, selected: "idea:one", query: "alpha", kind: "idea", focus: "one",
    onSelect() {}, onFilters() {}, cameraStore: new Map(), cameraKey: "same:overview" };
  const render = patch => lifecycle.render(lifecycle.exports.ResearchNetwork, { ...props, ...patch });
  return { ...lifecycle, props, mounts, render };
}

test("Overview to Graph remount reapplies unchanged controlled selection, filters and focus", () => {
  const view = fixture();
  view.render();
  view.render({ cameraKey: "same:graph" });
  assert.equal(view.mounts.length, 2);
  assert.equal(view.mounts[0].destroyed, true);
  assert.deepEqual(view.mounts[1].selected, ["idea:one"]);
  assert.deepEqual(view.mounts[1].filters, [{ query: "alpha", kind: "idea" }]);
  assert.deepEqual(view.mounts[1].focused, ["idea:one"]);
  view.unmount();
  assert.equal(view.mounts[1].destroyed, true);
});

test("a successful renderer retry clears the previous mount error", () => {
  const view = fixture({ failFirst: true });
  view.render(); view.flushMicrotasks();
  const newData = { revision: "next" };
  view.render({ data: newData }); view.flushMicrotasks();
  const element = view.render({ data: newData });
  const alerts = [];
  visitElements(element, item => { if (item.props?.role === "alert") alerts.push(item); });
  assert.equal(alerts.length, 0);
  assert.equal(view.mounts.length, 1);
});

test("a failed mount does not publish a queued error after unmount", () => {
  const view = fixture({ failFirst: true });
  view.render();
  view.unmount();
  view.flushMicrotasks();
  assert.deepEqual(view.updates, []);
});
