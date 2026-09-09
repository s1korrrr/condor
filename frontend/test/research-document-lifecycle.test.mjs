import test from "node:test";
import assert from "node:assert/strict";
import { componentLifecycle, visitElements } from "./helpers/research-lifecycle.mjs";

function fixture() {
  const reads = [];
  const dependencies = {
    "@/lib/auth-token": { authFetch() {} },
    "./research-detail": { documentPath: () => "/document", sourceFilename: name => name, isolatedDocument: value => value },
    "./research-document-pagination": { researchDocumentPage: items => ({ items, paginated: false }) },
    "./research-document-read": { readResearchDocument(_fetch, _path, signal) {
      let resolve;
      const result = new Promise(done => { resolve = done; });
      reads.push({ signal, resolve });
      return result;
    } },
  };
  const path = new URL("../src/features/research/ResearchDocument.tsx", import.meta.url);
  const wrapper = componentLifecycle(path, dependencies);
  let reader = null, key;
  const readers = [];
  return {
    reads,
    render(documents) {
      const child = wrapper.render(wrapper.exports.ResearchDocuments, { server: "native", scope: "receipt", id: "archive", documents });
      if (child.key !== key) {
        reader?.unmount();
        reader = componentLifecycle(path, dependencies, ["ResearchDocumentReader"]);
        readers.push(reader);
        key = child.key;
      }
      return reader.render(reader.exports.ResearchDocumentReader, child.props);
    },
    get updates() { return readers.flatMap(item => item.updates); },
    get key() { return key; },
  };
}
const reference = ref => ({ ref, label: "Frozen evidence", available: true });
function open(element) {
  let button;
  visitElements(element, item => { if (item.props?.["aria-label"] === "Open Frozen evidence") button = item; });
  assert.ok(button);
  button.props.onClick();
}

test("changed receipt reference generation aborts its pending source read", () => {
  const view = fixture();
  open(view.render([reference("old-revision")]));
  const oldKey = view.key;
  view.render([reference("new-revision")]);
  assert.notEqual(view.key, oldKey);
  assert.equal(view.reads[0].signal.aborted, true);
});

test("recreated or reordered identical reference sets preserve a pending read", () => {
  const view = fixture();
  open(view.render([reference("one"), reference("two")]));
  const oldKey = view.key;
  view.render([reference("two"), reference("one")]);
  assert.equal(view.key, oldKey);
  assert.equal(view.reads[0].signal.aborted, false);
});

test("a late response from a replaced source generation cannot publish a preview", async () => {
  const view = fixture();
  open(view.render([reference("old")]));
  view.render([reference("new")]);
  const updates = view.updates.length;
  view.reads[0].resolve({ mime: "text/plain", blob: new Blob(["Old source"]), disposition: "" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(view.updates.length, updates);
});
