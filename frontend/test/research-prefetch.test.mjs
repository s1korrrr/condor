import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

function prefetch(enabled) {
  const calls = [];
  const queryClient = {
    prefetchQuery: (q) => {
      calls.push(q.queryKey);
      return Promise.resolve();
    },
    fetchQuery: (q) => {
      calls.push(q.queryKey);
      return Promise.resolve([]);
    },
  };
  const source = fs.readFileSync(
    new URL("../src/hooks/usePrefetchData.ts", import.meta.url),
    "utf8",
  );
  const code = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  const imports = {
    "@tanstack/react-query": { useQueryClient: () => queryClient },
    react: { useEffect: (fn) => fn() },
    "@/hooks/useServer": { useServer: () => ({ server: "fixture" }) },
    "@/lib/api": { api: {} },
    "@/lib/queryClient": {
      candlesQuery: () => ({ queryKey: ["candles"], startTime: 1 }),
    },
  };
  const module = { exports: {} };
  new Function("require", "module", "exports", code)(
    (name) => {
      if (!(name in imports)) throw Error(name);
      return imports[name];
    },
    module,
    module.exports,
  );
  module.exports.usePrefetchData(enabled);
  return calls;
}

test("research-only shell can suppress unrelated trading and candle requests", () => {
  assert.deepEqual(prefetch(false), []);
});
test("ordinary operational pages retain eager prefetch behavior", () => {
  assert.ok(prefetch(true).some((key) => key[0] === "candles"));
  assert.ok(prefetch().some((key) => key[0] === "executors"));
});

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
function shellPrefetch(pathname) {
  const calls = [];
  const source = fs.readFileSync(
    new URL("../src/components/layout/AppShell.tsx", import.meta.url),
    "utf8",
  );
  const code = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const router = require("react-router-dom");
  const imports = {
    react: { useEffect: () => {} },
    "react/jsx-runtime": require("react/jsx-runtime"),
    "react-router-dom": {
      ...router,
      useLocation: () => ({ pathname }),
      useNavigate: () => () => {},
    },
    "@/hooks/useServer": { useServer: () => ({ server: "fixture" }) },
    "@/hooks/useTheme": {
      useTheme: () => ({ theme: "dark", toggleTheme: () => {} }),
    },
    "@/hooks/useCredentials": {
      useCredentials: () => ({ hasKeys: true, isLoading: false }),
    },
    "@/hooks/usePrefetchData": {
      usePrefetchData: (enabled) => calls.push(enabled),
    },
  };
  const module = { exports: {} };
  new Function("require", "module", "exports", code)(
    (name) => imports[name] ?? {},
    module,
    module.exports,
  );
  module.exports.AppShell().props.children.type();
  return calls;
}
test("Research route and trailing slash suppress trading prefetch while Bots retains it", () => {
  assert.deepEqual(shellPrefetch("/research"), [false]);
  assert.deepEqual(shellPrefetch("/research/"), [false]);
  assert.deepEqual(shellPrefetch("/bots"), [true]);
});
