import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as ReactQuery from '@tanstack/react-query';

const require = createRequire(import.meta.url);
const sourceRoot = fileURLToPath(new URL('../../src/', import.meta.url));
const workspaceRoot = process.env.V5_WORKSPACE_ROOT ?? path.resolve(sourceRoot, '../../..');
export const paperVisualStubs = { '@/v5/PaperPriceChart': { PaperPriceChart: () => null }, '@/v5/PaperPositions': { PaperPositions: () => null } };

// Fresh module graph per scenario. Actual TS/TSX and dependencies run unchanged;
// callers replace only browser I/O or a component's external context boundary.
export function frontendModules(overrides = {}, privateExports = {}, transform = (_filename, source) => source) {
  const modules = new Map();
  function load(relative) {
    const base = path.isAbsolute(relative) ? relative : path.join(sourceRoot, relative);
    const filename = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`].find(candidate => fs.existsSync(candidate));
    if (!filename) throw new Error(`Cannot resolve ${relative}`);
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    const code = ts.transpileModule(transform(filename, fs.readFileSync(filename, 'utf8')), {
      // This synchronous harness executes every source module as CommonJS.
      // TypeScript otherwise preserves ESM for .mjs despite ModuleKind.CommonJS.
      fileName: filename.replace(/\.mjs$/, '.js'),
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const expose = (privateExports[path.relative(sourceRoot, filename)] ?? []).map(name => `module.exports.${name} = ${name};`).join('\n');
    new Function('require', 'module', 'exports', `${code}\n${expose}`)(id => {
      if (Object.hasOwn(overrides, id)) return overrides[id];
      if (id.endsWith('.css')) return {};
      if (id.startsWith('@reporting/')) return load(path.resolve(workspaceRoot, 'dashboard/hummingbot-reporting-next/app', id.slice('@reporting/'.length)));
      if (id.startsWith('@/')) return load(id.slice(2));
      if (id.startsWith('.')) return load(path.resolve(path.dirname(filename), id));
      return require(id);
    }, module, module.exports);
    return module.exports;
  }
  return { load };
}

export function paperWorkspaceModules() {
  const overrides = Object.fromEntries(['@/components/bots/AggregatedPnlChart','@/components/bots/ControllerBrowser','@/components/bots/DeployBotDialog','@/components/bots/PnlSparkline','@/hooks/useWebSocket','@/hooks/useRates'].map(name => [name,{}]));
  return frontendModules({ ...overrides,
    '@tanstack/react-query': { ...ReactQuery, useQuery: () => ({ data: undefined, isError: false, isPending: true }), useQueries: ({queries}) => queries.map(() => ({data:undefined,isError:false,isPending:true})) },
    '@/components/charts/RecordedCandleChart': { RecordedCandleChart: () => null },
    './V5Money': { readMoney: () => { throw new Error('Unexpected Money read in static rendering'); } },
  });
}

export function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    clear: () => values.clear(),
  };
}
