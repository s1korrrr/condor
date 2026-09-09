import fs from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);

// React owns DOM mounting in the browser smoke. This harness runs the real
// component effects across renders, including their dependency and cleanup
// boundaries, while replacing only external I/O and the canvas engine.
export function componentLifecycle(source, dependencies = {}, privateExports = []) {
  let cursor = 0;
  const slots = [], effects = [], microtasks = [], updates = [];
  const changed = (previous, next) =>
    !previous || next.some((value, index) => !Object.is(value, previous[index]));
  const react = {
    useRef(initial) {
      const index = cursor++;
      return slots[index] ??= { current: initial };
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], value => { slots[index] = value; updates.push(value); }];
    },
    useMemo(factory, deps) {
      const index = cursor++;
      if (changed(slots[index]?.deps, deps)) slots[index] = { deps, value: factory() };
      return slots[index].value;
    },
    useEffect(create, deps) {
      const index = cursor++, previous = slots[index];
      if (changed(previous?.deps, deps)) effects.push(() => {
        previous?.cleanup?.();
        slots[index] = { deps, cleanup: create() };
      });
    },
  };
  const code = ts.transpileModule(fs.readFileSync(source, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const module = { exports: {} };
  const expose = privateExports.map(name => `module.exports.${name} = ${name};`).join("\n");
  new Function("require", "module", "exports", "queueMicrotask", "window", code + "\n" + expose)(
    name => name === "react" ? react : name in dependencies ? dependencies[name] : name.endsWith(".css") ? {} : require(name),
    module, module.exports, task => microtasks.push(task), {},
  );
  return {
    exports: module.exports,
    updates,
    render(component, props) {
      cursor = 0;
      const element = component(props);
      visitElements(element, item => {
        const ref = item.props?.ref;
        if (ref && typeof ref === "object" && ref.current === null) ref.current = {};
      });
      effects.splice(0).forEach(run => run());
      return element;
    },
    flushMicrotasks() { microtasks.splice(0).forEach(run => run()); },
    unmount() { slots.forEach(slot => slot?.cleanup?.()); },
  };
}

export function visitElements(element, visitor) {
  if (Array.isArray(element)) return element.forEach(item => visitElements(item, visitor));
  if (!element || typeof element !== "object") return;
  visitor(element);
  visitElements(element.props?.children, visitor);
}
