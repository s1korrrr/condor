import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));

export function envelope(data, ageMs = 0) {
  return {
    data,
    source: {
      owner: "research_os",
      server: "fixture",
      read_only: true,
      fetched_at: new Date(Date.now() - ageMs).toISOString(),
    },
  };
}

export function selectedIdeaQueries() {
  const node = {
    id: "idea:one",
    title: "Fixture idea",
    kind: "idea",
    status: "PROPOSED",
    data: {},
  };
  return {
    "research-overview": {
      data: envelope({
        counts: { ideas: 1 },
        facets: {},
        freshness: { state: "CURRENT" },
      }),
    },
    "research-nodes": { data: envelope({ items: [node], total: 1 }) },
    "research-node": { data: envelope({ node }) },
    "research-graph": { data: envelope({ nodes: [node], edges: [] }) },
    "research-comparisons": { data: envelope({ items: [], limitations: [] }) },
  };
}

function childText(value) {
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (Array.isArray(value)) return value.map(childText).join("");
  return React.isValidElement(value) ? childText(value.props.children) : "";
}

// Render the real page and its research children. Only external I/O and charts
// are replaced; button handlers are captured from the actual JSX being rendered.
export function renderResearch(
  queries,
  { search = "", server = "fixture" } = {},
) {
  const requests = [],
    refetches = [],
    buttons = [],
    modules = new Map();
  const captureJsx =
    (name) =>
    (type, props, ...rest) => {
      const element = jsxRuntime[name](type, props, ...rest);
      if (type === "button")
        buttons.push({ text: childText(props.children), ...props });
      return element;
    };
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        target: ts.ScriptTarget.ES2022,
      },
      fileName: filename,
    }).outputText;
    function localRequire(id) {
      if (id === "react/jsx-runtime")
        return {
          ...jsxRuntime,
          jsx: captureJsx("jsx"),
          jsxs: captureJsx("jsxs"),
        };
      if (id === "@tanstack/react-query")
        return {
          useQuery(options) {
            requests.push(options);
            const key = options.queryKey[0];
            return {
              isError: false,
              isFetching: false,
              isPending: false,
              refetch: () => {
                refetches.push(key);
                return Promise.resolve();
              },
              ...queries[key],
            };
          },
        };
      if (id === "react-router-dom")
        return {
          Link: ({ children }) => React.createElement("a", null, children),
          useSearchParams: () => [new URLSearchParams(search), () => {}],
        };
      if (id === "@/hooks/useServer") return { useServer: () => ({ server }) };
      if (id === "@/lib/auth-token")
        return {
          authFetch: () => {
            throw new Error("Unexpected network request in controlled render");
          },
        };
      if (id === "recharts") return new Proxy({}, { get: () => () => null });
      if (id.endsWith(".css")) return {};
      if (id.startsWith("@/") || id.startsWith(".")) {
        const base = id.startsWith("@/")
          ? path.join(sourceRoot, id.slice(2))
          : path.resolve(path.dirname(filename), id);
        const target = [base, `${base}.ts`, `${base}.tsx`].find((candidate) =>
          fs.existsSync(candidate),
        );
        if (!target) throw new Error(`Cannot resolve ${id} from ${filename}`);
        return load(target);
      }
      return require(id);
    }
    new Function("require", "module", "exports", code)(
      localRequire,
      module,
      module.exports,
    );
    return module.exports;
  }
  const { Research } = load(path.join(sourceRoot, "pages/Research.tsx"));
  const html = renderToStaticMarkup(React.createElement(Research));
  return { html, requests, refetches, buttons };
}
