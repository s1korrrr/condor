import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
const require = createRequire(import.meta.url);

// Exercise the actual disclosure and toggle callback with controlled hook state.
// No browser source access or unrelated inspector queries run in this test.
function disclosure() {
  let expanded = false;
  const module = { exports: {} };
  const source = fs.readFileSync(
    new URL("../src/features/research/ResearchInspector.tsx", import.meta.url),
    "utf8",
  );
  const code = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  new Function("require", "module", "exports", code)(
    (name) => {
      if (name === "react")
        return {
          useState: () => [
            expanded,
            (value) => {
              expanded = value;
            },
          ],
          useMemo: (factory) => factory(),
        };
      if (name === "react/jsx-runtime") return require(name);
      if (name === "./read")
        return {
          readResearch: () => () => {
            throw new Error("Unexpected source read");
          },
        };
      return {};
    },
    module,
    module.exports,
  );
  return (value) =>
    module.exports.RawResearchData({ title: "Complete native fields", value });
}
test("collapsed native fields avoid serialization and retain complete content when opened, without truncation", () => {
  const render = disclosure();
  let serializations = 0;
  const complete = "x".repeat(1_400_000) + "FINAL_NATIVE_FIELD";
  const value = {
    toJSON() {
      serializations += 1;
      return { complete };
    },
  };
  let element = render(value);
  assert.equal(
    serializations,
    0,
    "Closed native records must not be serialized",
  );
  assert.doesNotMatch(renderToStaticMarkup(element), /<pre/);
  assert.match(renderToStaticMarkup(element), /Complete native fields/);
  element.props.onToggle({ currentTarget: { open: true } });
  element = render(value);
  assert.equal(serializations, 1);
  const opened = renderToStaticMarkup(element);
  assert.ok(
    opened.includes(complete),
    "All native bytes remain available after opening",
  );
  element.props.onToggle({ currentTarget: { open: false } });
  element = render(value);
  assert.equal(serializations, 1);
  assert.doesNotMatch(renderToStaticMarkup(element), /<pre/);
});

test("opening a deferred attempt-state disclosure preserves failures separately from completed attempts", () => {
  const render = disclosure(),
    value = { FAILED: 2, COMPLETED: 3 };
  render(value).props.onToggle({ currentTarget: { open: true } });
  const html = renderToStaticMarkup(render(value));
  assert.match(html, /FAILED/);
  assert.match(html, /COMPLETED/);
  assert.match(html, /: 2/);
  assert.match(html, /: 3/);
});
