import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const sourceRoot = fileURLToPath(new URL('../../src/', import.meta.url));

// Fresh module graph per scenario. Actual TS/TSX and dependencies run unchanged;
// callers replace only browser I/O or a component's external context boundary.
export function frontendModules(overrides = {}, privateExports = {}) {
  const modules = new Map();
  function load(relative) {
    const base = path.isAbsolute(relative) ? relative : path.join(sourceRoot, relative);
    const filename = [base, `${base}.ts`, `${base}.tsx`].find(candidate => fs.existsSync(candidate));
    if (!filename) throw new Error(`Cannot resolve ${relative}`);
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      fileName: filename,
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const expose = (privateExports[path.relative(sourceRoot, filename)] ?? []).map(name => `module.exports.${name} = ${name};`).join('\n');
    new Function('require', 'module', 'exports', `${code}\n${expose}`)(id => {
      if (Object.hasOwn(overrides, id)) return overrides[id];
      if (id.endsWith('.css')) return {};
      if (id.startsWith('@/')) return load(id.slice(2));
      if (id.startsWith('.')) return load(path.resolve(path.dirname(filename), id));
      return require(id);
    }, module, module.exports);
    return module.exports;
  }
  return { load };
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
