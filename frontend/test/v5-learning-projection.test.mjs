import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const cache = new Map();
export function loadPanel(file) {
  const path = resolve(root, file);
  if (cache.has(path)) return cache.get(path).exports;
  const module = { exports: {} };
  cache.set(path, module);
  const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2023 } }).outputText;
  const localRequire = name => {
    if (name.endsWith('.css')) return {};
    if (!name.startsWith('.') && !name.startsWith('@/')) return require(name);
    const target = name.startsWith('@/') ? resolve(root, name.slice(2)) : resolve(dirname(path), name);
    const candidate = [target, `${target}.tsx`, `${target}.ts`, `${target}.mjs`].find(existsSync);
    if (!candidate) throw new Error(`Unresolved panel dependency ${name}`);
    return loadPanel(candidate);
  };
  new Function('require', 'module', 'exports', code)(localRequire, module, module.exports);
  return module.exports;
}
export const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));

const { LearningPanel, UtcTime } = loadPanel('v5/LearningPanel.tsx');
const { learningRead } = loadPanel('v5/api.ts');
test('learning states show unknown, empty, error and stale without false success', () => {
  const empty = render(LearningPanel, { data: { status: 'FIXTURE_ONLY', effect: 'NONE', lessons: [], releases: [], adoptions: [], retractions: [] } });
  assert.match(empty, /No lessons reported/);
  assert.match(empty, /Publication does not mean applied/);
  assert.match(empty, /No retraction reported/);
  assert.match(render(LearningPanel, { error: 'Owner unavailable' }), /role="alert"/);
  assert.match(render(LearningPanel, { data: { status: 'STALE', effect: 'NONE' } }), /Stale owner snapshot/);
  assert.match(render(UtcTime, { value: 1793275200000 }), /UTC<\/time>/);
  assert.equal(render(UtcTime, {}), '<span>Unknown</span>');
});
test('roles expose blockers and never offer a paid or execution control', () => {
  const markup = render(LearningPanel, { roles: [{ role_id: 'portfolio_manager', name: 'Portfolio Manager', status: 'BLOCKED', blockers: ['Owner task binding missing'], task_id: null, usage: 'NOT_DISPATCHED', provider_metered_usage: null }] });
  assert.match(markup, /Owner task binding missing/);
  assert.match(markup, /Binding missing/);
  assert.doesNotMatch(markup, />Run model<|>Activate<|>Delegate</);
  assert.match(markup, /aria-label="Role bindings"/);
  assert.match(markup, /role="separator"/);
  assert.match(markup, /Filter/);
});
test('missing role data never presents a measured zero blocked roles', () => {
  const markup = render(LearningPanel, {});
  assert.match(markup, /Roles blocked<\/span><p[^>]*>Unknown<\/p>/);
  assert.match(markup, /View provider calls/);
});
test('learning transport never accepts an authorizing result', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ effect: 'ORDER' }) });
  try { await assert.rejects(learningRead('manifest'), /Invalid non-authorizing/); }
  finally { globalThis.fetch = previous; }
});
